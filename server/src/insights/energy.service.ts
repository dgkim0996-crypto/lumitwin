import { BadRequestException, Injectable } from '@nestjs/common';
import { LINES, type EnergyReport, type LineCode } from '@lumitwin/shared';
import { PrismaService } from '../prisma/prisma.service';
import { buildEnergy } from './calc';
import { InsightsData } from './insights.data';

const HOUR = 3_600_000;
/** 구간을 주지 않으면 지금부터 거슬러 이만큼 (가상 시간) */
const DEFAULT_SPAN_H = 24;
/** 한 번에 보는 가장 긴 구간 (가상 시간). 넘으면 앞을 자른다 */
const MAX_SPAN_H = 31 * 24;

/** 에너지: 상태 구간(state_event) × 설비 소비 전력(StationDef.power) */
@Injectable()
export class EnergyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly data: InsightsData,
  ) {}

  async report(q: { from?: string; to?: string; hours?: string; line?: string; run?: number }): Promise<EnergyReport> {
    if (q.line && !LINES.some((l) => l.code === q.line)) throw new BadRequestException(`라인 코드가 아닙니다: ${q.line}`);
    const ctx = await this.data.run(q.run);
    const parse = (v: string | undefined, name: string) => {
      if (!v) return undefined;
      const ms = Date.parse(v);
      if (!Number.isFinite(ms)) throw new BadRequestException(`${name} 시각을 읽을 수 없습니다: ${v}`);
      return ms;
    };
    const hours = q.hours ? Number(q.hours) : undefined;
    if (hours != null && !(hours > 0)) throw new BadRequestException(`hours는 0보다 큰 수여야 합니다: ${q.hours}`);
    const toMs = Math.min(parse(q.to, 'to') ?? ctx.nowMs, ctx.nowMs);
    // from이 없으면 to에서 hours(기본 24시간)만큼 거슬러 간다. 실행 시작 전은 자른다
    // 아주 긴 실행은 최근 MAX_SPAN_H만 센다 (조회가 너무 무거워지지 않게)
    const fromMs = Math.max(parse(q.from, 'from') ?? toMs - (hours ?? DEFAULT_SPAN_H) * HOUR, ctx.startMs, toMs - MAX_SPAN_H * HOUR);

    const lines = LINES.filter((l) => !q.line || l.code === q.line);
    const stations = lines.flatMap((l) => l.stations.map((s) => s.code));
    const lo = Math.min(fromMs, toMs);
    const [rows, counts] = await Promise.all([
      this.data.stateRows(ctx.runId, lo, toMs, stations),
      this.prisma.processRecord.groupBy({
        by: ['line', 'station', 'step'],
        where: { runId: ctx.runId, result: 'OK', endedAt: { gte: new Date(lo), lt: new Date(toMs) }, ...(q.line ? { line: q.line } : {}) },
        _count: { _all: true },
      }),
    ]);
    const okByStation = new Map<string, number>();
    const goodByLine = new Map<string, number>();
    for (const c of counts) {
      okByStation.set(c.station, (okByStation.get(c.station) ?? 0) + c._count._all);
      if (LINES.find((l) => l.code === c.line)?.finalStep === c.step) goodByLine.set(c.line, (goodByLine.get(c.line) ?? 0) + c._count._all);
    }
    return buildEnergy({
      runId: ctx.runId,
      runStartMs: ctx.startMs,
      nowMs: ctx.nowMs,
      fromMs: lo,
      toMs,
      rows,
      okByStation,
      goodByLine,
      line: q.line as LineCode | undefined,
    });
  }
}
