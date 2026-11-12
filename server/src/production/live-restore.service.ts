import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { AlarmLive } from '@lumitwin/shared';
import { LiveService, type LiveHydration, type RestoreRecord } from '../live/live.service';
import { PrismaService } from '../prisma/prisma.service';

/** 복원이 이보다 오래 걸리면 포기하고 0부터 센다 (서버 기동을 너무 오래 막지 않게) */
const RESTORE_TIMEOUT_MS = 20_000;
const HOUR_MS = 3_600_000;

/**
 * 서버를 다시 띄울 때 마지막 시뮬레이터 실행의 실시간 집계(설비 처리·불량 수, 상태 시간, 라인 완성 수·FPY,
 * SPC 관리도, 최근 불량률 창, 알람)를 DB 기록에서 다시 계산해 LiveService에 채운다.
 * MQTT 브로커는 모든 모듈 초기화가 끝난 뒤 접속을 받으므로, 여기서 복원하는 동안 새 값이 섞이지 않는다.
 */
@Injectable()
export class LiveRestoreService implements OnModuleInit {
  private readonly logger = new Logger('Restore');

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
  ) {}

  async onModuleInit(): Promise<void> {
    const t0 = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${RESTORE_TIMEOUT_MS / 1000}초 안에 끝나지 않음`)), RESTORE_TIMEOUT_MS);
      });
      const loaded = await Promise.race([this.load(), timeout]);
      if (!loaded) {
        this.logger.log('복원할 실행 기록이 없어 0부터 셉니다');
        return;
      }
      const { runId, h } = loaded;
      this.live.hydrate(h);
      const units = h.counts.reduce((a, c) => a + c.n, 0);
      this.logger.log(`실시간 집계 복원: 실행 #${runId} · 가공 기록 ${units}건 · 알람 ${this.live.alarmList.length}건 · ${Date.now() - t0}ms`);
    } catch (e) {
      this.logger.warn(`실시간 집계를 복원하지 못해 0부터 셉니다: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async load(): Promise<{ runId: number; h: LiveHydration } | null> {
    const run = await this.prisma.simRun.findFirst({ orderBy: { id: 'desc' } });
    if (!run) return null;
    const r = run.id;
    const plan = this.live.restorePlan();

    // 예전 버전은 서버를 다시 띄우면 알람 번호를 1부터 다시 매겨 같은 실행 안에서 번호가 겹쳤다.
    // 아직 아무도 쓰지 않는 지금, 겹친 것 중 오래된 쪽에 새 번호를 준다 (겹친 것이 없으면 아무것도 바꾸지 않는다)
    const renumbered = await this.prisma.$executeRaw`
      WITH d AS (
        SELECT id, row_number() OVER (PARTITION BY live_id ORDER BY at DESC, id DESC) AS rk FROM alarm WHERE run_id = ${r}
      ), n AS (
        SELECT d.id, (SELECT max(live_id) FROM alarm WHERE run_id = ${r}) + row_number() OVER (ORDER BY d.id) AS live_id
        FROM d WHERE d.rk > 1
      )
      UPDATE alarm a SET live_id = n.live_id FROM n WHERE a.id = n.id`;
    if (renumbered) this.logger.log(`겹친 알람 번호 ${renumbered}건에 새 번호를 줬습니다`);

    const [counts, recentRows, states, alarms, seq, limitAlarms] = await Promise.all([
      this.prisma.$queryRaw<{ station: string; step: string; result: string; defect: string | null; n: number; first_start: Date }[]>`
        SELECT station, step, result, defect, count(*)::int AS n, min(started_at) AS first_start
        FROM process_record WHERE run_id = ${r}
        GROUP BY station, step, result, defect`,
      // 설비마다 최근 기록 N건 (인덱스 run_id, station, ended_at을 탄다)
      this.prisma.$queryRaw<{ station: string; serial: string; result: string; defect: string | null; values: Record<string, number>; cycle_sec: number; started_at: Date; ended_at: Date }[]>`
        SELECT s.code AS station, p.serial, p.result, p.defect, p.values, p.cycle_sec, p.started_at, p.ended_at
        FROM unnest(${plan.stations}::text[], ${plan.depth}::int[]) AS s(code, lim)
        CROSS JOIN LATERAL (
          SELECT serial, result, defect, values, cycle_sec, started_at, ended_at, id FROM process_record
          WHERE run_id = ${r} AND station = s.code
          ORDER BY ended_at DESC, id DESC LIMIT s.lim
        ) p
        ORDER BY s.code, p.ended_at, p.id`,
      // 상태 이벤트를 다음 이벤트까지의 구간으로 바꿔 상태별로 더한다. 다음 이벤트가 없는 것이 지금 상태
      this.prisma.$queryRaw<{ station: string; state: string; sec: number; open_at: Date | null; open_reason: string | null; up_at: Date | null; first_at: Date }[]>`
        WITH e AS (
          SELECT station, state, reason, at, lead(at) OVER (PARTITION BY station ORDER BY at, id) AS next_at
          FROM state_event WHERE run_id = ${r}
        )
        SELECT station, state,
               coalesce(sum(extract(epoch FROM next_at - at)), 0)::float8 AS sec,
               max(at) FILTER (WHERE next_at IS NULL) AS open_at,
               max(reason) FILTER (WHERE next_at IS NULL) AS open_reason,
               max(next_at) FILTER (WHERE state = 'DOWN') AS up_at,
               min(at) AS first_at
        FROM e GROUP BY station, state`,
      this.prisma.alarm.findMany({ where: { runId: r }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: plan.maxAlarms }),
      this.prisma.alarm.aggregate({ where: { runId: r }, _max: { liveId: true } }),
      this.prisma.alarm.findMany({ where: { runId: r, kind: 'LIMIT' }, distinct: ['station', 'title'], select: { station: true, title: true } }),
    ]);

    const recent = new Map<string, RestoreRecord[]>();
    let nowMs = run.startedAt.getTime();
    for (const x of recentRows) {
      const rec: RestoreRecord = {
        serial: x.serial, result: x.result === 'NG' ? 'NG' : 'OK', defect: x.defect, values: x.values ?? {},
        cycle: x.cycle_sec, start: x.started_at, end: x.ended_at,
      };
      const list = recent.get(x.station);
      if (list) list.push(rec);
      else recent.set(x.station, [rec]);
      nowMs = Math.max(nowMs, x.ended_at.getTime());
    }
    for (const s of states) if (s.open_at) nowMs = Math.max(nowMs, s.open_at.getTime());
    if (alarms[0]) nowMs = Math.max(nowMs, alarms[0].at.getTime());

    const finals = await this.prisma.$queryRaw<{ station: string; step: string; at: Date }[]>`
      SELECT station, step, ended_at AS at FROM process_record
      WHERE run_id = ${r} AND result = 'OK' AND step = ANY(${plan.finalSteps}::text[]) AND ended_at >= ${new Date(nowMs - HOUR_MS)}
      ORDER BY ended_at, id`;

    return {
      runId: r,
      h: {
        startedAt: run.startedAt.toISOString(),
        nowMs,
        counts: counts.map((c) => ({ station: c.station, step: c.step, result: c.result, defect: c.defect, n: c.n, firstStart: c.first_start })),
        recent,
        finals,
        states: states.map((s) => ({ station: s.station, state: s.state, sec: s.sec, openAt: s.open_at, openReason: s.open_reason, upAt: s.up_at, firstAt: s.first_at })),
        alarms: alarms.map(
          (a): AlarmLive => ({
            id: a.liveId, t: a.at.toISOString(), station: a.station, severity: a.severity as AlarmLive['severity'], kind: a.kind as AlarmLive['kind'],
            title: a.title, detail: a.detail ?? undefined, acked: a.ackedAt != null,
          }),
        ),
        alarmSeq: seq._max.liveId ?? 0,
        limitAlarms,
      },
    };
  }
}
