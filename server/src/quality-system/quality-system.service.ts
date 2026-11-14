import { BadRequestException, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  CHANGE_CATEGORY_NAMES,
  INSPECTION_NAMES,
  STATIONS,
  type ActorInfo,
  type ChangeMsg,
  type ChangePointView,
  type ChangeSource,
  type FaStationView,
  type InspMsg,
  type InspectionView,
  type LineCode,
  type SimEventMsg,
  type SimStatusMsg,
} from '@lumitwin/shared';
import { Prisma, type ChangePoint, type Inspection } from '../generated/prisma/client';
import { LiveService } from '../live/live.service';
import { outOfRun } from '../live/run-clock';
import { MqttBrokerService, type MqttInbound } from '../mqtt/mqtt-broker.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionWriter } from '../production/production.writer';
import {
  CATEGORIES,
  FaLedger,
  INSPECTION_TYPES,
  InputError,
  KINDS,
  LINE_CODES,
  approveBlockReason,
  asFaStatus,
  clampLimit,
  parseChangeRequest,
  parseTime,
  pick,
  type FaEntry,
} from './quality-system.logic';

/** 이 설비에서 아직 초물 합격이 안 난 변경점 (인터록 FA 판정용) */
export interface PendingFirstArticle {
  /** ChangePoint.id (DB에 쓰기 전 아주 잠깐은 0) */
  changeId: number;
  /** 시뮬레이터 변경점 번호 ('S12') 또는 MES 번호 ('U3') */
  simId: string | null;
  /** 변경점 시각 (가상, ISO) */
  since: string;
  detail: string;
}

/** 실행을 확인하기 전(첫 상태 메시지 전)에 붙잡아 둘 최대 메시지 수 */
const MAX_HELD = 5_000;
const MAX_DETAIL = 300;

export interface ChangeFilter {
  line?: string;
  station?: string;
  category?: string;
  from?: string;
  to?: string;
  limit?: string;
}

export interface InspectionFilter {
  line?: string;
  station?: string;
  type?: string;
  from?: string;
  to?: string;
  limit?: string;
}

function toChangeView(r: ChangePoint): ChangePointView {
  return {
    id: r.id,
    at: r.at.toISOString(),
    line: r.line as LineCode,
    station: r.station,
    category: r.category as ChangePointView['category'],
    kind: r.kind as ChangePointView['kind'],
    detail: r.detail,
    source: (r.source === 'USER' ? 'USER' : 'SIM') as ChangeSource,
    simId: r.simId,
    createdBy: r.createdBy,
    faStatus: asFaStatus(r.faStatus),
    faSerial: r.faSerial,
    faAt: r.faAt?.toISOString() ?? null,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt?.toISOString() ?? null,
  };
}

function toInspectionView(r: Inspection, simIds: Map<number, string | null>): InspectionView {
  return {
    id: r.id,
    at: r.at.toISOString(),
    line: r.line as LineCode,
    station: r.station,
    type: r.type as InspectionView['type'],
    serial: r.serial,
    result: r.result === 'NG' ? 'NG' : 'OK',
    values: (r.values ?? {}) as Record<string, number>,
    variant: r.variant,
    changeId: r.changeId,
    changeSimId: r.changeId != null ? (simIds.get(r.changeId) ?? null) : null,
    by: r.by,
  };
}

const badInput = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof InputError) throw new BadRequestException(e.message);
    throw e;
  }
};

/**
 * 품질 시스템 (P9): 4M 변경점, 초·중·종물 검사, 관리계획서.
 * 실행 모듈(인터록)이 firstArticlePending()을 부른다 — 응답은 메모리에서 바로 (DB를 기다리지 않는다).
 * 변경점·검사 메시지는 받은 순서대로 메모리를 먼저 바꾸고, DB 기록은 한 줄로 세운 비동기 작업으로 뒤따른다
 * (초물 검사가 가리키는 변경점 줄이 먼저 써져 있어야 번호를 이을 수 있다)
 */
@Injectable()
export class QualitySystemService implements OnModuleInit {
  private readonly logger = new Logger('Quality');
  private readonly ledger = new FaLedger();
  /** 메모리 장부가 속한 실행 (시뮬레이터 startedAt, ms) */
  private runMs: number | null = null;
  /** 마지막으로 받은 시뮬레이터 상태 (실행 구간 판정용). 초기화 뒤 새 상태가 올 때까지 null */
  private sim: Pick<SimStatusMsg, 'startedAt' | 't' | 'speed'> | null = null;
  private held: MqttInbound[] = [];
  /** 이 실행에서 받은 변경점 번호 → ChangePoint.id (0 = 아직 저장 전). 중복 수신을 거르고 초물을 변경점에 잇는다 */
  private ids = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private staleDropped = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly writer: ProductionWriter,
    private readonly mqtt: MqttBrokerService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.mqtt.onMessage((m) => this.receive(m));
    try {
      await this.restore();
    } catch (e) {
      this.logger.warn(`초물 대기 장부를 복원하지 못해 비운 채 시작합니다: ${(e as Error).message}`);
    }
  }

  // ───────────── 인터록이 부르는 것 ─────────────

  /** 이 설비에 초물 판정을 기다리는 변경점이 있으면 가장 오래된 것, 없으면 null */
  firstArticlePending(station: string): PendingFirstArticle | null {
    const e = this.ledger.oldest(station);
    return e ? { changeId: e.changeId, simId: e.simId, since: e.since, detail: e.detail } : null;
  }

  faStatus(): FaStationView[] {
    return this.ledger.view();
  }

  // ───────────── 복원 ─────────────

  /** 서버 기동 때 마지막 실행의 초물 대기(PENDING·NG)와 설비별 마지막 초물을 DB에서 되살린다 */
  private async restore(): Promise<void> {
    const run = await this.prisma.simRun.findFirst({ orderBy: { id: 'desc' } });
    if (!run) return;
    this.newRun(run.startedAt.getTime());
    const rows = await this.prisma.changePoint.findMany({
      where: { runId: run.id },
      select: { id: true, simId: true, station: true, at: true, category: true, kind: true, detail: true, faStatus: true },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });
    const simIds = new Map<number, string | null>();
    let pending = 0;
    for (const r of rows) {
      simIds.set(r.id, r.simId);
      if (r.simId) this.ids.set(r.simId, r.id);
      if ((r.faStatus === 'PENDING' || r.faStatus === 'NG') && r.simId) {
        this.ledger.add({
          simId: r.simId, changeId: r.id, station: r.station, since: r.at.toISOString(),
          category: r.category as FaEntry['category'], kind: r.kind as FaEntry['kind'], detail: r.detail, status: r.faStatus as FaEntry['status'],
        });
        pending++;
      }
    }
    const firsts = await this.prisma.inspection.findMany({
      where: { runId: run.id, type: 'FIRST' },
      distinct: ['station'],
      orderBy: [{ station: 'asc' }, { at: 'desc' }],
    });
    for (const f of firsts) {
      this.ledger.setLastFirst(f.station, {
        at: f.at.toISOString(), serial: f.serial, result: f.result === 'NG' ? 'NG' : 'OK', changeSimId: f.changeId != null ? (simIds.get(f.changeId) ?? null) : null,
      });
    }
    this.logger.log(`초물 대기 장부 복원: 실행 #${run.id} · 변경점 ${rows.length}건 · 초물 대기 ${pending}건`);
  }

  // ───────────── 수집 ─────────────

  private receive(m: MqttInbound): void {
    const [a, b, kind] = m.parts;
    if (a === 'edge') return;
    if (a === 'sim') {
      if (b === 'status') this.onStatus(m.payload as SimStatusMsg);
      else if (b === 'event' && (m.payload as SimEventMsg | null)?.kind === 'reset') this.sim = null;
      return;
    }
    if (kind !== 'change' && kind !== 'insp') return;
    if (!this.sim) {
      // 어느 실행의 변경점인지 모르면 시뮬레이터 상태가 올 때까지 붙잡아 둔다 (LiveService와 같은 방식)
      if (this.held.length < MAX_HELD) this.held.push(m);
      return;
    }
    this.ingest(m);
  }

  private onStatus(msg: SimStatusMsg): void {
    const ms = Date.parse(msg.startedAt);
    if (!Number.isFinite(ms)) return;
    this.sim = { startedAt: msg.startedAt, t: msg.t, speed: msg.speed };
    if (this.runMs !== ms) this.newRun(ms);
    if (this.held.length) {
      const held = this.held;
      this.held = [];
      for (const x of held) this.ingest(x);
    }
  }

  /** 새 실행: 초물 대기·변경점 번호는 실행 안에서만 뜻이 있다 */
  private newRun(ms: number): void {
    if (this.runMs != null) this.logger.log('시뮬레이터 실행이 바뀌어 초물 대기 장부를 비웁니다');
    this.runMs = ms;
    this.ledger.reset();
    this.ids.clear();
    this.staleDropped = 0;
  }

  private ingest(m: MqttInbound): void {
    const sim = this.sim;
    const payload = m.payload as { t?: string } | null;
    if (!sim || !payload) return;
    if (outOfRun(Date.parse(payload.t ?? ''), sim)) {
      if (this.staleDropped++ === 0) this.logger.warn(`지금 실행의 시각이 아닌 변경점·검사 메시지를 버렸습니다: ${m.parts.join('/')} ${payload.t}`);
      return;
    }
    if (m.parts[2] === 'change') this.onChange(payload as ChangeMsg, m.parts, sim.startedAt);
    else this.onInsp(payload as InspMsg, m.parts, sim.startedAt);
  }

  private onChange(msg: ChangeMsg, parts: string[], run: string): void {
    const station = msg.station ?? parts[1];
    const st = STATIONS[station];
    if (!st || typeof msg.id !== 'string' || !msg.id || !CATEGORIES.includes(msg.category) || !KINDS.includes(msg.kind)) return;
    if (this.ids.has(msg.id)) return; // 같은 변경점을 두 번 받음 (엣지 재전송)
    this.ids.set(msg.id, 0);
    const detail = typeof msg.detail === 'string' ? msg.detail.slice(0, MAX_DETAIL) : '';
    const entry = msg.fa
      ? this.ledger.add({ simId: msg.id, changeId: 0, station, since: msg.t, category: msg.category, kind: msg.kind, detail })
      : null;
    const runMs = this.runMs;
    this.enqueue(async () => {
      const runId = await this.writer.resolveRun(run);
      const row = await this.prisma.changePoint.create({
        data: {
          runId, at: new Date(msg.t), line: st.line, station, category: msg.category, kind: msg.kind, detail,
          source: 'SIM', simId: msg.id, faStatus: msg.fa ? 'PENDING' : 'NONE',
        },
      });
      if (entry) entry.changeId = row.id;
      if (this.runMs === runMs) this.ids.set(msg.id, row.id);
    });
  }

  private onInsp(msg: InspMsg, parts: string[], run: string): void {
    const station = msg.station ?? parts[1];
    const st = STATIONS[station];
    if (!st || !INSPECTION_TYPES.includes(msg.type) || typeof msg.serial !== 'string') return;
    const result = msg.result === 'NG' ? 'NG' : 'OK';
    const change = msg.type === 'FIRST' && typeof msg.change === 'string' ? msg.change : null;
    let resolved: FaEntry[] = [];
    let target: FaEntry | null = null;
    if (msg.type === 'FIRST') ({ resolved, target } = this.ledger.applyFirst(station, change, result, msg.t, msg.serial));
    if (result === 'NG') {
      const what = target?.detail ?? resolved[resolved.length - 1]?.detail;
      const title = `${st.name} ${INSPECTION_NAMES[msg.type]} 불합격`;
      const detail =
        msg.type === 'FIRST'
          ? `${what ? `변경점: ${what} · ` : ''}시리얼 ${msg.serial} · 다음 개체를 다시 초물로 검사합니다 (합격 전 후속 투입 대기)`
          : `시리얼 ${msg.serial} · 직전 합격 검사 이후 생산품 범위를 확인하세요 (필요 시 Hold)`;
      this.live.raiseAlarm(station, 'warn', 'FA', title, detail, msg.t);
    }
    this.enqueue(async () => {
      const runId = await this.writer.resolveRun(run);
      let changeId = change ? this.ids.get(change) || null : null;
      if (change && !changeId) changeId = (await this.prisma.changePoint.findFirst({ where: { runId, simId: change }, select: { id: true } }))?.id ?? null;
      await this.prisma.inspection.create({
        data: {
          runId, at: new Date(msg.t), line: st.line, station, type: msg.type, serial: msg.serial, result,
          values: (msg.values ?? {}) as Prisma.InputJsonValue, variant: msg.variant ?? null, changeId, by: null,
        },
      });
      if (msg.type !== 'FIRST') return;
      const ids = new Set(resolved.map((e) => e.changeId).filter((x) => x > 0));
      if (changeId) ids.add(changeId);
      if (ids.size) {
        await this.prisma.changePoint.updateMany({ where: { runId, id: { in: [...ids] } }, data: { faStatus: result, faSerial: msg.serial, faAt: new Date(msg.t) } });
      }
    });
  }

  /** DB 기록은 받은 순서대로 한 줄로. 하나가 실패해도 뒤 기록은 계속한다 */
  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((e) => this.logger.error(`변경점·검사 기록 실패: ${(e as Error).message}`));
  }

  /** 지금까지 줄 선 DB 기록이 끝날 때까지 (테스트·조회 직전) */
  flushed(): Promise<void> {
    return this.chain;
  }

  // ───────────── 사람 신고·승인 ─────────────

  private async runId(): Promise<number | null> {
    const run = this.live.currentRun;
    if (run) return this.writer.resolveRun(run);
    return this.writer.currentRunId;
  }

  /** 작업자·담당자 신고 → ChangePoint(USER, 'U<id>') + 시뮬레이터에 change 명령 (초물 대기를 건다) */
  async register(body: unknown, actor: ActorInfo): Promise<ChangePointView> {
    const input = badInput(() => parseChangeRequest(body));
    const run = this.live.currentRun;
    if (!run) throw new BadRequestException('시뮬레이터가 아직 실행을 알리지 않았습니다. 시뮬레이터를 켠 뒤 신고하세요');
    const runId = await this.writer.resolveRun(run);
    const at = this.live.virtualNow ?? new Date().toISOString();
    const row = await this.prisma.changePoint.create({
      data: {
        runId, at: new Date(at), line: input.line, station: input.station, category: input.category, kind: input.kind, detail: input.detail,
        source: 'USER', createdBy: actor.login, faStatus: input.fa ? 'PENDING' : 'NONE',
      },
    });
    const simId = `U${row.id}`;
    let saved = await this.prisma.changePoint.update({ where: { id: row.id }, data: { simId } });
    this.ids.set(simId, row.id);
    if (input.fa) {
      this.ledger.add({ simId, changeId: row.id, station: input.station, since: at, category: input.category, kind: input.kind, detail: input.detail });
    }
    try {
      await this.mqtt.sendCommand({ action: 'change', id: simId, code: input.station, category: input.category, kind: input.kind, detail: input.detail, fa: input.fa });
    } catch (e) {
      // 시뮬레이터가 모르는 초물 대기는 영영 풀리지 않아 인터록이 라인을 세운다. 명령을 못 보냈으면 초물 대기를 거둔다
      this.logger.warn(`변경점 명령을 보내지 못했습니다 (${simId}): ${(e as Error).message}`);
      if (input.fa) {
        this.ledger.remove(input.station, simId);
        saved = await this.prisma.changePoint.update({ where: { id: row.id }, data: { faStatus: 'NONE' } });
      }
    }
    const st = STATIONS[input.station];
    this.live.raiseAlarm(
      input.station, 'info', 'CHANGE', `${st.name} 변경점 신고 · ${CHANGE_CATEGORY_NAMES[input.category]}`,
      `${input.detail} · ${actor.name}${saved.faStatus === 'PENDING' ? ' · 초물 검사 대기' : ''}`, at,
    );
    return toChangeView(saved);
  }

  /** 품질 확인 서명. 초물 판정이 끝난(합격·대상 아님) 변경점만 */
  async approve(id: number, actor: ActorInfo): Promise<ChangePointView> {
    const row = await this.prisma.changePoint.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`변경점 ${id}이(가) 없습니다`);
    const block = approveBlockReason(row.faStatus, row.approvedAt);
    if (block) throw new BadRequestException(block);
    const at = this.live.virtualNow ?? new Date().toISOString();
    const saved = await this.prisma.changePoint.update({ where: { id }, data: { approvedBy: actor.login, approvedAt: new Date(at) } });
    return toChangeView(saved);
  }

  /**
   * 품질 담당 수동 초물 판정 (설비 단위). 시뮬레이터가 초물을 못 내는 상황(시뮬레이터 정지, 사람 신고 뒤 설비가 멈춤 등)에서
   * 사람이 직접 초물을 확인하고 대기를 푼다. 그 설비의 지금까지 쌓인 대기를 모두 이 결과로 본다 (시뮬레이터 초물과 같은 묶음 규칙)
   */
  async manualFirst(station: string, body: unknown, actor: ActorInfo): Promise<{ station: string; result: 'OK' | 'NG'; resolved: number; serial: string }> {
    const st = STATIONS[station];
    if (!st) throw new NotFoundException(`설비 ${station}이(가) 없습니다`);
    const b = (body ?? {}) as { result?: unknown; serial?: unknown; note?: unknown };
    if (b.result !== 'OK' && b.result !== 'NG') throw new BadRequestException('판정은 OK 또는 NG입니다');
    const result = b.result;
    const serial = typeof b.serial === 'string' && b.serial.trim() ? b.serial.trim().slice(0, 40) : '수동 확인';
    const run = this.live.currentRun;
    if (!run) throw new BadRequestException('시뮬레이터가 아직 실행을 알리지 않았습니다');
    const list = this.ledger.list(station);
    if (!list.length) throw new BadRequestException(`${st.name}에 초물 대기가 없습니다`);
    const last = list[list.length - 1];
    const at = this.live.virtualNow ?? new Date().toISOString();
    const { resolved } = this.ledger.applyFirst(station, last.simId, result, at, serial);
    if (result === 'NG') {
      this.live.raiseAlarm(station, 'warn', 'FA', `${st.name} 초물 불합격 (수동 판정)`, `${last.detail} · ${actor.name} · 다시 초물을 확인할 때까지 투입 대기`, at);
    }
    this.enqueue(async () => {
      const runId = await this.writer.resolveRun(run);
      const ids = new Set<number>();
      for (const e of resolved) {
        let id = e.changeId || (e.simId ? this.ids.get(e.simId) || 0 : 0);
        if (!id && e.simId) id = (await this.prisma.changePoint.findFirst({ where: { runId, simId: e.simId }, select: { id: true } }))?.id ?? 0;
        if (id) ids.add(id);
      }
      const changeId = last.changeId || (last.simId ? this.ids.get(last.simId) || null : null);
      await this.prisma.inspection.create({
        data: { runId, at: new Date(at), line: st.line, station, type: 'FIRST', serial, result, values: {} as Prisma.InputJsonValue, variant: null, changeId, by: actor.login },
      });
      if (ids.size) await this.prisma.changePoint.updateMany({ where: { runId, id: { in: [...ids] } }, data: { faStatus: result, faSerial: serial, faAt: new Date(at) } });
    });
    return { station, result, resolved: resolved.length, serial };
  }

  // ───────────── 조회 ─────────────

  /** 지금 실행의 변경점 (새것부터) */
  async changes(f: ChangeFilter): Promise<ChangePointView[]> {
    const where = badInput(() => ({
      line: pick(f.line, LINE_CODES, '라인'),
      station: f.station || undefined,
      category: pick(f.category, CATEGORIES, '4M 분류'),
      from: parseTime(f.from, '시작'),
      to: parseTime(f.to, '끝'),
    }));
    const runId = await this.runId();
    if (runId == null) return [];
    const rows = await this.prisma.changePoint.findMany({
      where: {
        runId, line: where.line, station: where.station, category: where.category,
        ...(where.from || where.to ? { at: { gte: where.from, lte: where.to } } : {}),
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: clampLimit(f.limit, 300, 1000),
    });
    return rows.map(toChangeView);
  }

  /** 지금 실행의 초·중·종물 검사 기록 (새것부터) */
  async inspections(f: InspectionFilter): Promise<InspectionView[]> {
    const where = badInput(() => ({
      line: pick(f.line, LINE_CODES, '라인'),
      station: f.station || undefined,
      type: pick(f.type, INSPECTION_TYPES, '검사 종류'),
      from: parseTime(f.from, '시작'),
      to: parseTime(f.to, '끝'),
    }));
    const runId = await this.runId();
    if (runId == null) return [];
    const rows = await this.prisma.inspection.findMany({
      where: {
        runId, line: where.line, station: where.station, type: where.type,
        ...(where.from || where.to ? { at: { gte: where.from, lte: where.to } } : {}),
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: clampLimit(f.limit, 200, 1000),
    });
    const changeIds = [...new Set(rows.map((r) => r.changeId).filter((x): x is number => x != null))];
    const simIds = new Map<number, string | null>();
    if (changeIds.length) {
      const cps = await this.prisma.changePoint.findMany({ where: { id: { in: changeIds } }, select: { id: true, simId: true } });
      for (const c of cps) simIds.set(c.id, c.simId);
    }
    return rows.map((r) => toInspectionView(r, simIds));
  }
}
