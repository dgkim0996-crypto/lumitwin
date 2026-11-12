import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { STATIONS, type BoxStats, type FactorAnalysis, type FactorCandidate, type LotQuality, type LotSkew, type LotTrace, type ProcessRecordView, type TraceNode } from '@lumitwin/shared';
import type { ProcessRecord } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionWriter } from './production.writer';

const MAX_DEPTH = 5;
/** 요인 분석: 불량·양품 표본 수 상한과 하위 부품을 따라 내려가는 깊이 */
const FACTOR_NG = 200;
const FACTOR_OK = 400;
/** 양품을 고르는 구간: 불량 구간 앞뒤로 구간 길이의 절반만큼 (가상 시간 30분~6시간) */
const FACTOR_PAD_MIN_MS = 30 * 60_000;
const FACTOR_PAD_MAX_MS = 6 * 3_600_000;
const FACTOR_DEPTH = 3;
/** 한 집단에 이만큼은 있어야 비교한다 */
const FACTOR_MIN_N = 5;
const FACTOR_TOP = 12;
/** 자재 LOT 편중: 불량품과 양품의 LOT 사용 비율 차이가 이 z 이상이면 보인다 */
const LOT_SKEW_Z = 3;
const LOT_SKEW_TOP = 5;

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function boxStats(values: number[]): BoxStats {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, min: s[0], q1: quantile(s, 0.25), median: quantile(s, 0.5), q3: quantile(s, 0.75), max: s[n - 1], mean, sd };
}

export function toView(r: ProcessRecord): ProcessRecordView {
  return {
    serial: r.serial, item: r.item, line: r.line, step: r.step, station: r.station, result: r.result as 'OK' | 'NG', defect: r.defect,
    cycleSec: r.cycleSec, values: r.values as Record<string, number>, attrs: (r.attrs as Record<string, number> | null) ?? null,
    lots: (r.lots as Record<string, string> | null) ?? null, comps: r.comps, escaped: r.escaped,
    startedAt: r.startedAt.toISOString(), endedAt: r.endedAt.toISOString(),
  };
}

/** 생산 이력 조회: 시리얼 계보(정·역추적), LOT 추적, 설비별 최근 기록 */
@Injectable()
export class ProductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: ProductionWriter,
  ) {}

  private runId(run?: number): number {
    const id = run ?? this.writer.currentRunId;
    if (id == null) throw new BadRequestException('아직 기록된 실행이 없습니다. 시뮬레이터를 켜 주세요');
    return id;
  }

  async runs() {
    return this.prisma.simRun.findMany({ orderBy: { id: 'desc' }, take: 20 });
  }

  /** 정추적: 제품 시리얼 → 거친 공정 + 들어간 부품(하위로 재귀) */
  async trace(serial: string, run?: number): Promise<TraceNode> {
    const runId = this.runId(run);
    const build = async (s: string, depth: number): Promise<TraceNode> => {
      const [unit, records, kids] = await Promise.all([
        this.prisma.productionUnit.findUnique({ where: { runId_serial: { runId, serial: s } } }),
        this.prisma.processRecord.findMany({ where: { runId, serial: s }, orderBy: { endedAt: 'asc' } }),
        this.prisma.productionUnit.findMany({ where: { runId, parentSerial: s }, select: { serial: true } }),
      ]);
      const comps = new Set([...records.flatMap((r) => r.comps), ...kids.map((k) => k.serial)]);
      const children = depth < MAX_DEPTH ? await Promise.all([...comps].map((c) => build(c, depth + 1))) : [];
      return {
        serial: s, item: unit?.item ?? records[0]?.item ?? null, status: unit?.status ?? null, defect: unit?.defect ?? null,
        parentSerial: unit?.parentSerial ?? null, records: records.map(toView), children,
      };
    };
    return build(serial, 0);
  }

  /** 역추적: 부품 시리얼 → 최종 제품까지 위로 */
  async ancestors(serial: string, run?: number): Promise<string[]> {
    const runId = this.runId(run);
    const chain: string[] = [];
    let cur: string | null = serial;
    for (let i = 0; cur && i < MAX_DEPTH; i++) {
      const u: { parentSerial: string | null } | null = await this.prisma.productionUnit.findUnique({
        where: { runId_serial: { runId, serial: cur } }, select: { parentSerial: true },
      });
      cur = u?.parentSerial ?? null;
      if (cur) chain.push(cur);
    }
    return chain;
  }

  /** LOT 추적: 자재 LOT → 그 LOT를 쓴 부품 → 그 부품이 들어간 최종 제품 */
  async lot(lot: string, run?: number): Promise<LotTrace> {
    const runId = this.runId(run);
    // 부품마다 parent_serial을 맨 위까지 따라 올라간다 (재귀 CTE 한 번, 부품 수와 무관하게 쿼리 1회)
    const tops = await this.prisma.$queryRaw<{ top: string; item: string | null; line: string | null; status: string | null; defect: string | null; parts: bigint; last_at: Date | null }[]>`
      WITH RECURSIVE base AS (
        SELECT DISTINCT serial FROM material_lot_use WHERE run_id = ${runId} AND lot = ${lot}
      ),
      chain AS (
        SELECT b.serial AS base, b.serial AS cur, 0 AS depth FROM base b
        UNION ALL
        SELECT c.base, u.parent_serial, c.depth + 1
        FROM chain c JOIN production_unit u ON u.run_id = ${runId} AND u.serial = c.cur
        WHERE u.parent_serial IS NOT NULL AND c.depth < ${MAX_DEPTH}::int
      ),
      top AS (
        SELECT DISTINCT ON (base) base, cur AS top FROM chain ORDER BY base, depth DESC
      )
      SELECT t.top, u.item, u.line, u.status, u.defect, count(*) AS parts, u.last_at
      FROM top t LEFT JOIN production_unit u ON u.run_id = ${runId} AND u.serial = t.top
      GROUP BY t.top, u.item, u.line, u.status, u.defect, u.last_at
      ORDER BY u.last_at DESC NULLS LAST
      LIMIT 3000`;
    const byStation = await this.prisma.materialLotUse.groupBy({
      by: ['station', 'material'], where: { runId, lot }, _count: { _all: true }, _min: { usedAt: true }, _max: { usedAt: true },
    });
    if (!byStation.length) throw new NotFoundException(`이 실행에서 쓰인 기록이 없는 LOT입니다: ${lot}`);
    const first = byStation.reduce<Date | null>((m, r) => (r._min.usedAt && (!m || r._min.usedAt < m) ? r._min.usedAt : m), null);
    const last = byStation.reduce<Date | null>((m, r) => (r._max.usedAt && (!m || r._max.usedAt > m) ? r._max.usedAt : m), null);
    return {
      lot,
      material: byStation[0].material,
      byStation: byStation.map((r) => ({ station: r.station, parts: r._count._all })).sort((a, b) => b.parts - a.parts),
      parts: byStation.reduce((a, r) => a + r._count._all, 0),
      firstUsedAt: first?.toISOString() ?? null,
      lastUsedAt: last?.toISOString() ?? null,
      finished: tops.map((r) => ({
        serial: r.top, item: r.item, line: r.line, status: r.status, defect: r.defect, parts: Number(r.parts), lastAt: r.last_at?.toISOString() ?? null,
      })),
    };
  }

  async lots(material?: string, run?: number) {
    const runId = this.runId(run);
    const rows = await this.prisma.materialLotUse.groupBy({
      by: ['material', 'lot'], where: { runId, ...(material ? { material } : {}) },
      _count: { _all: true }, _min: { usedAt: true }, _max: { usedAt: true }, orderBy: { _max: { usedAt: 'desc' } }, take: 100,
    });
    return rows.map((r) => ({ material: r.material, lot: r.lot, units: r._count._all, firstUsedAt: r._min.usedAt, lastUsedAt: r._max.usedAt }));
  }

  async records(station: string, limit = 50, result?: 'OK' | 'NG', run?: number) {
    const runId = this.runId(run);
    const rows = await this.prisma.processRecord.findMany({
      where: { runId, station, ...(result ? { result } : {}) }, orderBy: { endedAt: 'desc' }, take: Math.min(500, Math.max(1, limit)),
    });
    return rows.map(toView);
  }

  async units(line?: string, status?: string, limit = 50, run?: number) {
    const runId = this.runId(run);
    return this.prisma.productionUnit.findMany({
      where: { runId, ...(line ? { line } : {}), ...(status ? { status } : {}) }, orderBy: { lastAt: 'desc' }, take: Math.min(500, Math.max(1, limit)),
    });
  }

  /** 시간대별 생산·불량 (가상 시각 1시간 단위) */
  async hourly(line: string, run?: number) {
    const runId = this.runId(run);
    const rows = await this.prisma.$queryRaw<{ hour: Date; station: string; ok: bigint; ng: bigint }[]>`
      SELECT date_trunc('hour', ended_at) AS hour, station,
             count(*) FILTER (WHERE result = 'OK') AS ok, count(*) FILTER (WHERE result = 'NG') AS ng
      FROM process_record WHERE run_id = ${runId} AND line = ${line}
      GROUP BY 1, 2 ORDER BY 1`;
    return rows.map((r) => ({ hour: r.hour.toISOString(), station: r.station, ok: Number(r.ok), ng: Number(r.ng) }));
  }

  /** 설비·불량 코드별 불량 건수 (실행 시작부터, DB 기록 기준이라 서버를 재시작해도 그대로다) */
  async defects(line?: string, run?: number) {
    const runId = this.runId(run);
    const rows = await this.prisma.processRecord.groupBy({
      by: ['station', 'defect'], where: { runId, result: 'NG', ...(line ? { line } : {}) }, _count: { _all: true },
    });
    return rows.map((r) => ({ station: r.station, defect: r.defect ?? 'UNKNOWN', n: r._count._all }));
  }

  /** 출하 유출: 최종 검사를 OK로 통과했지만 시뮬레이터가 잠재 불량을 알고 있는 제품 */
  async escapes(run?: number) {
    const runId = this.runId(run);
    const rows = await this.prisma.processRecord.findMany({
      where: { runId, NOT: { escaped: { isEmpty: true } } }, orderBy: { endedAt: 'desc' }, take: 200,
    });
    return rows.map(toView);
  }

  /**
   * LOT별 품질. LOT를 쓴 부품마다 parent_serial을 따라 위로 올라가며, 부품 자신이나 상위 제품이
   * 불량(NG)을 받았는지, 최종 공정까지 양품으로 끝났는지(DONE)를 본다.
   * 같은 시기에 쓴 LOT끼리 불량률을 비교하면 자재 문제인지 공정 문제인지 가르는 첫 단서가 된다.
   */
  async lotQuality(material?: string, run?: number): Promise<LotQuality[]> {
    const runId = this.runId(run);
    const mat = material || null;
    const rows = await this.prisma.$queryRaw<{ material: string; lot: string; parts: bigint; ng: bigint; done: bigint; first_used: Date; last_used: Date }[]>`
      WITH RECURSIVE base AS (
        SELECT material, lot, serial, min(used_at) AS used_at
        FROM material_lot_use
        WHERE run_id = ${runId} AND (${mat}::text IS NULL OR material = ${mat}::text)
        GROUP BY material, lot, serial
      ),
      chain AS (
        SELECT b.lot, b.serial AS base, b.serial AS cur, 0 AS depth FROM base b
        UNION ALL
        SELECT c.lot, c.base, u.parent_serial, c.depth + 1
        FROM chain c JOIN production_unit u ON u.run_id = ${runId} AND u.serial = c.cur
        WHERE u.parent_serial IS NOT NULL AND c.depth < ${MAX_DEPTH}::int
      ),
      judged AS (
        SELECT c.lot, c.base, bool_or(u.status = 'NG') AS ng, bool_or(u.status = 'DONE') AS done
        FROM chain c JOIN production_unit u ON u.run_id = ${runId} AND u.serial = c.cur
        GROUP BY c.lot, c.base
      )
      SELECT b.material, b.lot, count(*) AS parts,
             count(*) FILTER (WHERE j.ng) AS ng,
             count(*) FILTER (WHERE j.done AND NOT j.ng) AS done,
             min(b.used_at) AS first_used, max(b.used_at) AS last_used
      FROM base b LEFT JOIN judged j ON j.lot = b.lot AND j.base = b.serial
      GROUP BY b.material, b.lot
      ORDER BY max(b.used_at) DESC
      LIMIT 1000`;
    return rows.map((r) => ({
      material: r.material, lot: r.lot, parts: Number(r.parts), ng: Number(r.ng), done: Number(r.done),
      firstUsedAt: r.first_used.toISOString(), lastUsedAt: r.last_used.toISOString(),
    }));
  }

  /**
   * 불량 요인 분석. 한 설비에서 불량 판정을 받은 부품과 양품을 모아, 그 부품이 앞서 거친 공정과
   * 조립돼 들어간 하위 부품의 공정 값(조건·속성·검사값)을 두 집단으로 나눠 비교한다.
   * 표준화 평균 차가 큰 값일수록 불량과 함께 움직인 원인 후보다 (상관이지 인과의 증명은 아니다).
   */
  async factors(station: string, defect?: string, run?: number): Promise<FactorAnalysis> {
    const runId = this.runId(run);
    const def = STATIONS[station];
    if (!def) throw new NotFoundException(`설비 ${station}이(가) 없습니다`);
    const ngRecs = await this.prisma.processRecord.findMany({
      where: { runId, station, result: 'NG', ...(defect ? { defect } : {}) },
      orderBy: { endedAt: 'desc' }, take: FACTOR_NG, select: { serial: true, endedAt: true },
    });
    const from = ngRecs.length ? ngRecs[ngRecs.length - 1].endedAt : null;
    // 양품은 불량이 나온 구간(앞뒤로 여유를 둔다)에서 시간에 고르게 뽑는다. 최근 양품만 고르면 불량이 오래 전에 몰린 경우
    // 그때 쓰던 자재 LOT·조건이 전부 "불량 쪽"으로 보이는 착시가 생기고, 구간 앞뒤가 없으면 LOT가 바뀐 효과를 못 본다
    const to = ngRecs[0]?.endedAt ?? null;
    let okRecs: { serial: string; endedAt: Date }[] = [];
    if (from && to) {
      const span = to.getTime() - from.getTime();
      const pad = Math.min(Math.max(span * 0.5, FACTOR_PAD_MIN_MS), FACTOR_PAD_MAX_MS);
      const lo = new Date(from.getTime() - pad).toISOString();
      const hi = new Date(to.getTime() + pad).toISOString();
      okRecs = await this.prisma.$queryRaw<{ serial: string; endedAt: Date }[]>`
        SELECT serial, "endedAt" FROM (
          SELECT serial, ended_at AS "endedAt", row_number() OVER (ORDER BY ended_at) - 1 AS rn, count(*) OVER () AS cnt
          FROM process_record
          WHERE run_id = ${runId} AND station = ${station} AND result = 'OK' AND ended_at BETWEEN ${lo}::timestamptz AND ${hi}::timestamptz
        ) x
        WHERE rn % ((cnt + ${FACTOR_OK - 1}::int) / ${FACTOR_OK}::int) = 0
        LIMIT ${FACTOR_OK}::int`;
    }
    const empty: FactorAnalysis = { station, defect: defect ?? null, ngCount: ngRecs.length, okCount: okRecs.length, from: from?.toISOString() ?? null, to: null, factors: [], lots: [] };
    if (ngRecs.length < FACTOR_MIN_N || okRecs.length < FACTOR_MIN_N) return empty;

    const judgedAt = new Map<string, Date>();
    const ngSet = new Set<string>();
    for (const r of ngRecs) {
      judgedAt.set(r.serial, r.endedAt);
      ngSet.add(r.serial);
    }
    for (const r of okRecs) if (!judgedAt.has(r.serial)) judgedAt.set(r.serial, r.endedAt);
    const roots = [...judgedAt.keys()];

    // 대상 부품 + 그 안에 조립된 하위 부품 (parent_serial을 따라 아래로)
    const rel = await this.prisma.$queryRaw<{ root: string; serial: string }[]>`
      WITH RECURSIVE d AS (
        SELECT s AS root, s AS serial, 0 AS depth FROM unnest(${roots}::text[]) AS s
        UNION ALL
        SELECT d.root, u.serial, d.depth + 1
        FROM d JOIN production_unit u ON u.run_id = ${runId} AND u.parent_serial = d.serial
        WHERE d.depth < ${FACTOR_DEPTH}::int
      )
      SELECT root, serial FROM d`;
    const serials = [...new Set(rel.map((r) => r.serial))];
    const recs = await this.prisma.processRecord.findMany({
      where: { runId, serial: { in: serials } },
      select: { serial: true, station: true, values: true, attrs: true, lots: true, endedAt: true },
    });
    const bySerial = new Map<string, typeof recs>();
    for (const r of recs) {
      const list = bySerial.get(r.serial);
      if (list) list.push(r);
      else bySerial.set(r.serial, [r]);
    }

    const measureKeys = (code: string) => new Set((STATIONS[code]?.measures ?? []).map((m) => m.key));
    const symptomKeys = measureKeys(station);
    interface Feature { station: string; key: string; kind: FactorCandidate['kind']; relation: FactorCandidate['relation'] }
    const featureInfo = new Map<string, Feature>();
    // root → featureId → 값 목록 (하위 부품이 여럿이면 평균)
    const perRoot = new Map<string, Map<string, number[]>>();
    const put = (root: string, f: Feature, v: unknown) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return;
      const id = `${f.station}.${f.key}`;
      const prev = featureInfo.get(id);
      // 같은 값이 자기 공정에서도, 하위 부품에서도 나오면 자기 공정 쪽으로 본다
      if (!prev || (prev.relation === 'component' && f.relation === 'self')) featureInfo.set(id, f);
      let m = perRoot.get(root);
      if (!m) perRoot.set(root, (m = new Map()));
      const arr = m.get(id);
      if (arr) arr.push(v);
      else m.set(id, [v]);
    };
    // root → 그 제품(하위 부품 포함)에 들어간 자재 LOT
    const lotKey = (material: string, lot: string, st: string) => `${material}\u0000${lot}\u0000${st}`;
    const rootLots = new Map<string, Set<string>>();
    for (const { root, serial } of rel) {
      const relation: Feature['relation'] = serial === root ? 'self' : 'component';
      const at = judgedAt.get(root)!;
      for (const r of bySerial.get(serial) ?? []) {
        // 판정 뒤에 일어난 공정은 원인이 될 수 없다
        if (relation === 'self' && r.endedAt > at) continue;
        for (const [m, l] of Object.entries((r.lots ?? {}) as Record<string, string>)) {
          let s = rootLots.get(root);
          if (!s) rootLots.set(root, (s = new Set()));
          s.add(lotKey(m, l, r.station));
        }
        const isTarget = relation === 'self' && r.station === station;
        const mk = measureKeys(r.station);
        for (const [k, v] of Object.entries((r.values ?? {}) as Record<string, unknown>)) {
          // 판정 설비 자신의 검사값은 증상 그 자체라서 뺀다
          if (isTarget && symptomKeys.has(k)) continue;
          put(root, { station: r.station, key: k, kind: mk.has(k) ? 'measure' : 'tag', relation }, v);
        }
        for (const [k, v] of Object.entries((r.attrs ?? {}) as Record<string, unknown>)) put(root, { station: r.station, key: k, kind: 'attr', relation }, v);
      }
    }

    const factors: FactorCandidate[] = [];
    for (const [id, info] of featureInfo) {
      const ng: number[] = [];
      const ok: number[] = [];
      for (const root of roots) {
        const arr = perRoot.get(root)?.get(id);
        if (!arr?.length) continue;
        const v = arr.reduce((a, b) => a + b, 0) / arr.length;
        (ngSet.has(root) ? ng : ok).push(v);
      }
      if (ng.length < FACTOR_MIN_N || ok.length < FACTOR_MIN_N) continue;
      const a = boxStats(ng);
      const b = boxStats(ok);
      const pooled = Math.sqrt(((a.n - 1) * a.sd ** 2 + (b.n - 1) * b.sd ** 2) / (a.n + b.n - 2));
      if (!(pooled > 1e-9)) continue;
      factors.push({ ...info, effect: (a.mean - b.mean) / pooled, ng: a, ok: b });
    }
    factors.sort((x, y) => Math.abs(y.effect) - Math.abs(x.effect));

    // 자재 LOT 편중: 불량품 중 그 LOT를 쓴 비율 vs 양품 중 비율 (두 비율 z 검정)
    const lotCount = new Map<string, { ng: number; ok: number }>();
    for (const [root, set] of rootLots) {
      const isNg = ngSet.has(root);
      for (const k of set) {
        const c = lotCount.get(k) ?? { ng: 0, ok: 0 };
        if (isNg) c.ng++;
        else c.ok++;
        lotCount.set(k, c);
      }
    }
    const n1 = ngSet.size;
    const n2 = roots.length - n1;
    const lots: LotSkew[] = [];
    for (const [k, c] of lotCount) {
      const [material, lot, st] = k.split('\u0000');
      const p1 = c.ng / n1;
      const p2 = c.ok / n2;
      const p = (c.ng + c.ok) / (n1 + n2);
      const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
      const z = se > 0 ? (p1 - p2) / se : 0;
      if (c.ng >= FACTOR_MIN_N && z >= LOT_SKEW_Z) lots.push({ material, lot, station: st, ng: c.ng, ok: c.ok, ngShare: p1, okShare: p2, z });
    }
    lots.sort((a, b) => b.z - a.z);
    return { ...empty, to: ngRecs[0].endedAt.toISOString(), factors: factors.slice(0, FACTOR_TOP), lots: lots.slice(0, LOT_SKEW_TOP) };
  }

  /** 설비 상태 이력 (가동 타임라인) */
  async states(station: string, run?: number) {
    const runId = this.runId(run);
    const rows = await this.prisma.stateEvent.findMany({ where: { runId, station }, orderBy: { at: 'desc' }, take: 300 });
    return rows.map((r) => ({ state: r.state, reason: r.reason, at: r.at.toISOString() })).reverse();
  }
}
