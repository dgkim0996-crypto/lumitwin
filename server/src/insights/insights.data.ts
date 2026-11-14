import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LiveService } from '../live/live.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionWriter } from '../production/production.writer';
import type { StateRow } from './calc';

export interface RunCtx {
  runId: number;
  startMs: number;
  /** 지금 실행이면 실시간 가상 시각, 지난 실행이면 마지막 기록 시각 */
  nowMs: number;
  current: boolean;
}

/** 분석 조회가 같이 쓰는 DB 읽기: 실행 고르기, 구간의 상태 기록 */
@Injectable()
export class InsightsData {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: ProductionWriter,
    private readonly live: LiveService,
  ) {}

  /** 실행 번호(없으면 지금 실행)와 그 실행의 시작·지금 시각 */
  async run(run?: number): Promise<RunCtx> {
    const runId = run ?? this.writer.currentRunId;
    if (runId == null) throw new BadRequestException('아직 기록된 실행이 없습니다. 시뮬레이터를 켜 주세요');
    const simRun = await this.prisma.simRun.findUnique({ where: { id: runId } });
    if (!simRun) throw new NotFoundException(`실행 ${runId}이(가) 없습니다`);
    const startMs = simRun.startedAt.getTime();
    const liveMs = Date.parse(this.live.virtualNow ?? '');
    // 설비 보전 화면과 같은 기준: 지금 실행이면 실시간 가상 시각, 지난 실행이면 마지막 기록까지
    const current = runId === this.writer.currentRunId && Date.parse(this.live.currentRun ?? '') === startMs && Number.isFinite(liveMs);
    let nowMs = liveMs;
    if (!current) {
      const [st, rec] = await Promise.all([
        this.prisma.stateEvent.aggregate({ where: { runId }, _max: { at: true } }),
        this.prisma.processRecord.aggregate({ where: { runId }, _max: { endedAt: true } }),
      ]);
      nowMs = Math.max(st._max.at?.getTime() ?? 0, rec._max.endedAt?.getTime() ?? 0);
    }
    return { runId, startMs, nowMs: Math.max(startMs, nowMs), current };
  }

  /**
   * [from, to) 구간의 상태 기록 + 설비마다 from 직전 기록 한 건 (from 때의 상태).
   * end = 같은 설비의 다음 기록 시각 (to 전의 마지막 기록은 null: 그 상태가 이어진다), first = 그 설비의 이번 실행 첫 기록
   */
  async stateRows(runId: number, fromMs: number, toMs: number, stations: string[]): Promise<StateRow[]> {
    const from = new Date(fromMs);
    const to = new Date(toMs);
    return this.prisma.$queryRaw<StateRow[]>`
      WITH w AS (
        SELECT id, station, state, reason, at FROM state_event
        WHERE run_id = ${runId} AND at >= ${from} AND at < ${to}
        UNION ALL
        SELECT p.id, p.station, p.state, p.reason, p.at
        FROM unnest(${stations}::text[]) AS s(code)
        CROSS JOIN LATERAL (
          SELECT id, station, state, reason, at FROM state_event
          WHERE run_id = ${runId} AND station = s.code AND at < ${from}
          ORDER BY at DESC, id DESC LIMIT 1
        ) p
      )
      SELECT station, state, reason, at,
             lead(at) OVER (PARTITION BY station ORDER BY at, id) AS "end",
             (row_number() OVER (PARTITION BY station ORDER BY at, id) = 1) AS first
      FROM w
      ORDER BY station, at, id`;
  }
}
