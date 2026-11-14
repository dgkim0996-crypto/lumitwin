import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { LINES, type AlarmLive, type StationState, type UnitMsg } from '@lumitwin/shared';
import { Prisma } from '../generated/prisma/client';
import { LiveService } from '../live/live.service';
import { PrismaService } from '../prisma/prisma.service';

const FLUSH_MS = 1_000;
/** DB가 멈췄을 때 메모리에 쌓아 둘 최대 건수. 넘치면 오래된 것부터 버린다 */
const MAX_QUEUE = 50_000;

const FINAL_STEPS = new Set(LINES.map((l) => `${l.code}.${l.finalStep}`));

type Queued =
  | { kind: 'unit'; run: string; msg: UnitMsg }
  | { kind: 'state'; run: string; station: string; state: StationState; reason?: string; t: string }
  | { kind: 'alarm'; run: string; alarm: AlarmLive }
  | { kind: 'ack'; run: string; id: number; t: string; alarmAt: string }
  | { kind: 'status'; run: string; serial: string; status: UnitStatus };

/** 실행 모듈(P9)이 바꾸는 개체 상태: 폐기·격리·수리대, 특채·Hold 해제 뒤 공정 중 */
export type UnitStatus = 'SCRAP' | 'HOLD' | 'REPAIR' | 'WIP' | 'NG';

/**
 * 실시간 계층의 이벤트를 모아 1초마다 한 번에 DB에 쓴다.
 * 수집(MQTT) 경로는 DB를 기다리지 않는다: DB가 느리거나 잠깐 죽어도 화면은 계속 움직이고, 기록은 큐에서 다시 시도한다.
 */
@Injectable()
export class ProductionWriter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Writer');
  private queue: Queued[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private runIds = new Map<string, number>();
  private runPending = new Map<string, Promise<number>>();
  private dropped = 0;
  written = 0;
  /** 마지막으로 확인한 실행 번호 (조회 API의 기본값) */
  currentRunId: number | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
  ) {}

  async onModuleInit(): Promise<void> {
    const last = await this.prisma.simRun.findFirst({ orderBy: { id: 'desc' } });
    if (last) {
      this.runIds.set(last.startedAt.toISOString(), last.id);
      this.currentRunId = last.id;
    }
    const ev = this.live.events;
    const run = () => this.live.currentRun;
    ev.on('run', (startedAt) => void this.resolveRun(startedAt).catch((e) => this.logger.error(`실행 등록 실패: ${(e as Error).message}`)));
    ev.on('unit', (msg) => this.push({ kind: 'unit', run: run() ?? '', msg }));
    ev.on('state', (station, state, reason, t) => this.push({ kind: 'state', run: run() ?? '', station, state, reason, t }));
    ev.on('alarm', (alarm) => this.push({ kind: 'alarm', run: run() ?? '', alarm }));
    ev.on('ack', (id, t, alarmAt) => this.push({ kind: 'ack', run: run() ?? '', id, t, alarmAt }));
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  /**
   * 개체 상태 바꾸기 (P9 실행 모듈). 실적과 같은 큐로 순서대로 쓰므로, 같은 묶음에 뒤따르는 실적이 있으면 그 실적이 이긴다.
   * 실행을 아직 모르면 버린다
   */
  setStatus(serial: string, status: UnitStatus): void {
    this.push({ kind: 'status', run: this.live.currentRun ?? '', serial, status });
  }

  private push(q: Queued): void {
    if (!q.run) return; // 실행을 아직 모르면(시뮬레이터 상태 메시지 전) 버린다
    this.queue.push(q);
    if (this.queue.length > MAX_QUEUE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE);
      if (++this.dropped % 1000 === 1) this.logger.warn('DB 기록이 밀려 오래된 기록을 버렸습니다');
    }
  }

  /** 가상 시계 시작 시각 → 실행 번호 (처음 보는 실행이면 만든다) */
  async resolveRun(startedAt: string): Promise<number> {
    const hit = this.runIds.get(startedAt);
    if (hit) return hit;
    // 새 실행 알림을 실행·품질·기록 모듈이 거의 동시에 받아 같이 부른다. 하나만 DB에 가게 진행 중 요청을 나눠 쓴다
    // (upsert 둘이 겹치면 둘 다 INSERT를 시도해 고유 키 충돌이 난다)
    let p = this.runPending.get(startedAt);
    if (!p) {
      p = this.prisma.simRun
        .upsert({ where: { startedAt: new Date(startedAt) }, create: { startedAt: new Date(startedAt) }, update: {} })
        .catch(async (e: unknown) => {
          // 다른 프로세스가 먼저 만든 경우 (고유 키 충돌) 그 줄을 읽는다
          const row = await this.prisma.simRun.findUnique({ where: { startedAt: new Date(startedAt) } });
          if (!row) throw e;
          return row;
        })
        .then((row) => {
          this.runIds.set(startedAt, row.id);
          this.currentRunId = row.id;
          return row.id;
        })
        .finally(() => this.runPending.delete(startedAt));
      this.runPending.set(startedAt, p);
    }
    return p;
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.queue.length) return;
    this.flushing = true;
    const batch = this.queue;
    this.queue = [];
    try {
      const byRun = new Map<string, Queued[]>();
      for (const q of batch) byRun.set(q.run, [...(byRun.get(q.run) ?? []), q]);
      for (const [run, items] of byRun) await this.write(await this.resolveRun(run), items);
      this.written += batch.length;
    } catch (e) {
      this.logger.error(`DB 기록 실패, 다시 시도합니다: ${(e as Error).message}`);
      this.queue = [...batch, ...this.queue].slice(-MAX_QUEUE);
    } finally {
      this.flushing = false;
    }
  }

  private async write(runId: number, items: Queued[]): Promise<void> {
    const units = items.filter((q): q is Extract<Queued, { kind: 'unit' }> => q.kind === 'unit').map((q) => q.msg);
    const states = items.filter((q): q is Extract<Queued, { kind: 'state' }> => q.kind === 'state');
    const alarms = items.filter((q): q is Extract<Queued, { kind: 'alarm' }> => q.kind === 'alarm').map((q) => q.alarm);
    const acks = items.filter((q): q is Extract<Queued, { kind: 'ack' }> => q.kind === 'ack');
    // 상태 바꾸기: 같은 묶음에서 그 뒤에 같은 시리얼의 실적이 오면 실적이 이긴다
    const lastUnitAt = new Map<string, number>();
    items.forEach((q, i) => q.kind === 'unit' && lastUnitAt.set(q.msg.serial, i));
    const statusSet = new Map<string, UnitStatus>();
    items.forEach((q, i) => {
      if (q.kind === 'status' && !((lastUnitAt.get(q.serial) ?? -1) > i)) statusSet.set(q.serial, q.status);
    });

    // 시리얼 마지막 상태 (같은 묶음 안에서 여러 번 나오면 마지막 것)
    const unitRows = new Map<string, { item: string; line: string; step: string; station: string; status: string; defect: string | null; first: string; last: string; variant: string | null; wo: number | null }>();
    const links: { child: string; parent: string }[] = [];
    const lotRows: Prisma.MaterialLotUseCreateManyInput[] = [];
    for (const u of units) {
      const prev = unitRows.get(u.serial);
      const status = u.result === 'NG' ? 'NG' : FINAL_STEPS.has(`${u.line}.${u.step}`) ? 'DONE' : 'WIP';
      unitRows.set(u.serial, {
        item: u.item, line: u.line, step: u.step, station: u.station, status, defect: u.defect ?? null, first: prev?.first ?? u.start, last: u.t,
        variant: u.variant ?? prev?.variant ?? null, wo: u.wo ?? prev?.wo ?? null,
      });
      for (const c of u.comps ?? []) links.push({ child: c, parent: u.serial });
      for (const [material, lot] of Object.entries(u.lots ?? {})) lotRows.push({ runId, material, lot, serial: u.serial, station: u.station, usedAt: new Date(u.t) });
    }
    const serials = [...unitRows.keys()];
    const rows = [...unitRows.values()];

    await this.prisma.$transaction(async (tx) => {
      if (units.length) {
        await tx.processRecord.createMany({
          data: units.map((u) => ({
            runId, serial: u.serial, item: u.item, line: u.line, step: u.step, station: u.station, result: u.result, defect: u.defect ?? null,
            cycleSec: u.cycle, values: u.values, attrs: u.attrs ?? Prisma.DbNull, lots: u.lots ?? Prisma.DbNull,
            comps: u.comps ?? [], escaped: u.escaped ?? [], startedAt: new Date(u.start), endedAt: new Date(u.t),
            variant: u.variant ?? null, workOrder: u.wo ?? null, fa: !!u.fa, reinspect: !!u.reinspect, ilkSkip: !!u.ilkSkip,
          })),
        });
        await tx.$executeRaw`
          INSERT INTO production_unit (run_id, serial, item, line, last_step, last_station, status, defect, first_at, last_at, variant, work_order)
          SELECT ${runId}, s, i, l, st, sn, stat, d, f, la, v, w
          FROM unnest(${serials}::text[], ${rows.map((r) => r.item)}::text[], ${rows.map((r) => r.line)}::text[],
                      ${rows.map((r) => r.step)}::text[], ${rows.map((r) => r.station)}::text[], ${rows.map((r) => r.status)}::text[],
                      ${rows.map((r) => r.defect)}::text[], ${rows.map((r) => new Date(r.first))}::timestamptz[], ${rows.map((r) => new Date(r.last))}::timestamptz[],
                      ${rows.map((r) => r.variant)}::text[], ${rows.map((r) => r.wo)}::int[])
               AS x(s, i, l, st, sn, stat, d, f, la, v, w)
          ON CONFLICT (run_id, serial) DO UPDATE SET
            item = EXCLUDED.item, line = EXCLUDED.line, last_step = EXCLUDED.last_step, last_station = EXCLUDED.last_station,
            status = CASE WHEN production_unit.status = 'CONSUMED' THEN 'CONSUMED' ELSE EXCLUDED.status END,
            defect = COALESCE(EXCLUDED.defect, production_unit.defect), last_at = EXCLUDED.last_at,
            variant = COALESCE(EXCLUDED.variant, production_unit.variant), work_order = COALESCE(EXCLUDED.work_order, production_unit.work_order)`;
        if (links.length) {
          await tx.$executeRaw`
            UPDATE production_unit p SET parent_serial = x.parent, status = 'CONSUMED'
            FROM unnest(${links.map((l) => l.child)}::text[], ${links.map((l) => l.parent)}::text[]) AS x(child, parent)
            WHERE p.run_id = ${runId} AND p.serial = x.child`;
        }
        if (lotRows.length) await tx.materialLotUse.createMany({ data: lotRows });
      }
      if (statusSet.size) {
        const ss = [...statusSet];
        await tx.$executeRaw`
          UPDATE production_unit p SET status = x.status
          FROM unnest(${ss.map(([s]) => s)}::text[], ${ss.map(([, st]) => st)}::text[]) AS x(serial, status)
          WHERE p.run_id = ${runId} AND p.serial = x.serial AND p.status <> 'CONSUMED'`;
      }
      if (states.length) {
        await tx.stateEvent.createMany({ data: states.map((s) => ({ runId, station: s.station, state: s.state, reason: s.reason ?? null, at: new Date(s.t) })) });
      }
      if (alarms.length) {
        await tx.alarm.createMany({
          data: alarms.map((a) => ({ runId, liveId: a.id, station: a.station, severity: a.severity, kind: a.kind, title: a.title, detail: a.detail ?? null, at: new Date(a.t) })),
        });
      }
      // 알람 번호는 실행 안에서 유일하지만, 예전 기록에는 서버 재시작으로 번호가 겹친 것이 있어 난 시각까지 맞춘다
      for (const a of acks) await tx.alarm.updateMany({ where: { runId, liveId: a.id, at: new Date(a.alarmAt) }, data: { ackedAt: new Date(a.t) } });
    });
  }

  get stats() {
    return { queued: this.queue.length, written: this.written, dropped: this.dropped, runId: this.currentRunId };
  }
}
