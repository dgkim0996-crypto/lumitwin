import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LINES, STATIONS, shiftByKey, shiftLabel, shiftOf, type LineCode, type ShiftList, type ShiftReport } from '@lumitwin/shared';
import { PrismaService } from '../prisma/prisma.service';
import { buildShiftReport, shiftCsv, shiftsBetween } from './calc';
import { InsightsData } from './insights.data';

const LINE_CODES = new Set<string>(LINES.map((l) => l.code));

/** 교대 일보: 교대 구간(shiftByKey)의 DB 기록으로 라인별 생산·품질·설비·에너지를 모은다 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly data: InsightsData,
  ) {}

  /** 고를 수 있는 교대: 실행 시작부터 지금까지 걸친 교대 (새것부터) */
  async shifts(run?: number): Promise<ShiftList> {
    let ctx;
    try {
      ctx = await this.data.run(run);
    } catch (e) {
      if (e instanceof BadRequestException) return { runId: null, runStartedAt: null, now: null, shifts: [] };
      throw e;
    }
    const cur = shiftOf(ctx.nowMs).key;
    return {
      runId: ctx.runId,
      runStartedAt: new Date(ctx.startMs).toISOString(),
      now: new Date(ctx.nowMs).toISOString(),
      shifts: shiftsBetween(ctx.startMs, ctx.nowMs).map((s) => ({
        key: s.key, code: s.code, name: shiftLabel(s.date, s.code), date: s.date, start: s.start, end: s.end, current: ctx.current && s.key === cur,
      })),
    };
  }

  async shift(key: string, line?: string, run?: number): Promise<ShiftReport> {
    const slot = shiftByKey(key ?? '');
    if (!slot) throw new BadRequestException('교대 키 형식이 아닙니다 (예: 2026-11-13-D)');
    if (line && !LINE_CODES.has(line)) throw new BadRequestException(`라인 코드가 아닙니다: ${line}`);
    const ctx = await this.data.run(run);
    const s = Date.parse(slot.start);
    const e = Date.parse(slot.end);
    if (e <= ctx.startMs || s > ctx.nowMs) throw new NotFoundException(`이 실행에서 지나지 않은 교대입니다: ${key}`);
    const lo = Math.max(s, ctx.startMs);
    const hi = Math.min(e, ctx.nowMs);
    const from = new Date(lo);
    const to = new Date(hi);
    const runId = ctx.runId;
    const lineWhere = line ? { line } : {};
    const stations = Object.keys(STATIONS).filter((c) => !line || STATIONS[c].line === line);

    const [rows, records, ncr, changes, inspections, interlock, holds] = await Promise.all([
      this.data.stateRows(runId, lo, hi, stations),
      this.prisma.processRecord.groupBy({
        by: ['line', 'step', 'station', 'result', 'defect', 'workOrder', 'reinspect'],
        where: { runId, endedAt: { gte: from, lt: to }, ...lineWhere },
        _count: { _all: true },
      }),
      this.prisma.ncr.findMany({
        where: { runId, openedAt: { lt: to }, OR: [{ closedAt: null }, { closedAt: { gte: from } }], ...lineWhere },
        select: { line: true, openedAt: true, closedAt: true, disposition: true, repairOk: true },
      }),
      this.prisma.changePoint.groupBy({ by: ['line', 'category', 'kind', 'faStatus'], where: { runId, at: { gte: from, lt: to }, ...lineWhere }, _count: { _all: true } }),
      this.prisma.inspection.groupBy({ by: ['line', 'type', 'result'], where: { runId, at: { gte: from, lt: to }, ...lineWhere }, _count: { _all: true } }),
      this.prisma.interlockLog.groupBy({ by: ['line', 'verdict', 'code'], where: { runId, at: { gte: from, lt: to }, ...lineWhere }, _count: { _all: true } }),
      this.prisma.hold.findMany({ where: { runId, result: 'SCRAP', releasedAt: { gte: from, lt: to } }, select: { serials: true } }),
    ]);

    // 작업지시: 교대 중에 시작했거나 그 전부터 이어진 것 + 교대 중 실적이 있는 것 (겹침 판정은 buildShiftReport)
    const woIds = [...new Set(records.map((r) => r.workOrder).filter((x): x is number => x != null))];
    const orders = await this.prisma.workOrder.findMany({
      where: { runId, ...lineWhere, OR: [{ startedAt: { lt: to } }, ...(woIds.length ? [{ id: { in: woIds } }] : [])] },
      select: { id: true, code: true, line: true, variant: true, qty: true, status: true, released: true, doneQty: true, scrapQty: true, startedAt: true, endedAt: true },
    });

    // Hold 폐기: 개체의 라인은 production_unit에서 찾는다
    const holdScrap = new Map<string, number>();
    const serials = [...new Set(holds.flatMap((h) => h.serials))];
    if (serials.length) {
      const units = await this.prisma.productionUnit.findMany({ where: { runId, serial: { in: serials } }, select: { line: true } });
      for (const u of units) holdScrap.set(u.line, (holdScrap.get(u.line) ?? 0) + 1);
    }

    return buildShiftReport({
      slot,
      runId,
      runStartMs: ctx.startMs,
      nowMs: ctx.nowMs,
      current: ctx.current && shiftOf(ctx.nowMs).key === slot.key,
      rows,
      records: records.map((r) => ({ ...r, n: r._count._all })),
      orders,
      ncr,
      changes: changes.map((c) => ({ ...c, n: c._count._all })),
      inspections: inspections.map((c) => ({ ...c, n: c._count._all })),
      interlock: interlock.map((c) => ({ ...c, n: c._count._all })),
      holdScrap,
      line: line as LineCode | undefined,
    });
  }

  async csv(key: string, run?: number): Promise<string> {
    return shiftCsv(await this.shift(key, undefined, run));
  }
}
