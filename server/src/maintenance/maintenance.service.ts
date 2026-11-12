import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { MaintenanceReport } from '@lumitwin/shared';
import { LiveService } from '../live/live.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionWriter } from '../production/production.writer';
import { buildMaintenance, type HaltRow } from './maintenance';

/**
 * 설비 보전 조회. 고장 이력·MTBF·MTTR은 DB의 상태 기록(state_event)에서 계산한다.
 * 메모리 집계는 상태별 누적 시간만 들고 있어 고장 건별 이력이 없고, DB 기준이라 서버를 다시 띄워도 값이 같다.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: ProductionWriter,
    private readonly live: LiveService,
  ) {}

  async report(run?: number): Promise<MaintenanceReport> {
    const runId = run ?? this.writer.currentRunId;
    if (runId == null) throw new BadRequestException('아직 기록된 실행이 없습니다. 시뮬레이터를 켜 주세요');
    const simRun = await this.prisma.simRun.findUnique({ where: { id: runId } });
    if (!simRun) throw new NotFoundException(`실행 ${runId}이(가) 없습니다`);

    // 상태 기록 전체에서 다음 기록 시각을 끝으로 붙인 뒤, 멈춘 구간(고장·계획 정지·셋업)만 가져온다
    const [rows, checks, last] = await Promise.all([
      this.prisma.$queryRaw<HaltRow[]>`
        SELECT station, state, reason, at, "end" FROM (
          SELECT station, state, reason, at, lead(at) OVER (PARTITION BY station ORDER BY at, id) AS "end"
          FROM state_event WHERE run_id = ${runId}
        ) e
        WHERE state IN ('DOWN', 'STOP', 'SETUP')
        ORDER BY at`,
      this.prisma.$queryRaw<{ station: string; at: Date; ng_count: number }[]>`
        SELECT DISTINCT ON (station) station, at, ng_count
        FROM check_record WHERE run_id = ${runId}
        ORDER BY station, at DESC`,
      this.prisma.stateEvent.aggregate({ where: { runId }, _max: { at: true } }),
    ]);

    // 지금 실행이면 실시간 가상 시각(시뮬레이터 시계 기준)까지, 지난 실행이면 마지막 기록까지 센다.
    // 지금 실행에 DB 최댓값을 섞지 않는다: 예전 버전에서 초기화 직전 실행의 늦은 메시지가 새 실행으로 기록된 일이 있어 한참 뒤 시각이 남아 있을 수 있다
    const runStartMs = simRun.startedAt.getTime();
    const liveMs = Date.parse(this.live.virtualNow ?? '');
    const isCurrent = runId === this.writer.currentRunId && Date.parse(this.live.currentRun ?? '') === runStartMs && Number.isFinite(liveMs);
    const nowMs = Math.max(runStartMs, isCurrent ? liveMs : (last._max.at?.getTime() ?? 0));
    return buildMaintenance(rows, {
      runStartMs,
      nowMs,
      checks: new Map(checks.map((c) => [c.station, { at: c.at, ngCount: c.ng_count }])),
    });
  }
}
