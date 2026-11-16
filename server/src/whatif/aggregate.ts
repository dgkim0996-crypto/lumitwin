import {
  LINES,
  dist,
  type LineCode,
  type LineDef,
  type Oee,
  type WhatIfBase,
  type WhatIfDist,
  type WhatIfLineKpi,
  type WhatIfOrderKpi,
  type WhatIfRep,
  type WhatIfRequest,
  type WhatIfResult,
  type WhatIfScenarioResult,
} from '@lumitwin/shared';
import { schedule, type PlanOrder } from '../execution/planner';
import { kwOf, kwhOf, lineOee, type KwLookup } from '../insights/calc';
import type { StateTimes } from '../live/oee';
import { NEW_ID_BASE, type SimOrder, type SimScenario } from './validate';

// What-if 집계 (순수 함수): 시뮬레이터가 돌려준 반복 원자료(WhatIfRep[])를 계획별 분포(평균·10/90 백분위)로 모은다.
// KPI는 라이브 화면과 같은 함수로 계산한다: 라인 OEE = lineOee, 전력량 = kwOf × kwhOf (insights/calc.ts).

const ZERO_OEE: Oee = { availability: 0, performance: 0, quality: 0, oee: 0 };
const HALT = ['DOWN', 'SETUP', 'STOP'] as const;
const FAILURE_TOP = 5;

const round = (v: number, d: number) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** 분포를 d자리로 반올림 (결과 JSON을 줄이고 화면에 그대로 쓰게) */
export function rdist(xs: number[], d = 2): WhatIfDist {
  const x = dist(xs);
  return { mean: round(x.mean, d), p10: round(x.p10, d), p90: round(x.p90, d), min: round(x.min, d), max: round(x.max, d) };
}

export interface AggregateInput {
  request: WhatIfRequest;
  base: WhatIfBase;
  /** 시뮬레이터에 보낸 계획 (모든 라인을 채운 것) */
  sim: SimScenario[];
  seed: number;
  runs: WhatIfRep[];
  /** 계산 시작부터 집계까지 (실제 ms) */
  elapsedMs: number;
  /** 시험용: 설비 소비 전력 (기본 공장 정의) */
  kw?: KwLookup;
}

/**
 * 계산식 예상 끝 시각 (planner.schedule: 투입 간격 × 수량 + 셋업, 시작에서 분). 시뮬레이션의 finishMin과 나란히 둔다.
 * 투입 중 지시는 남은 수만, 라인에 걸린 기종과 첫 지시 기종이 다르면 셋업을 더한다
 */
export function planEnds(line: LineDef, orders: SimOrder[], base: WhatIfBase): Map<number, number> {
  const startMs = Date.parse(base.startAt);
  const bl = base.lines[line.code];
  const runningId = bl?.orders.find((o) => o.status === 'RUNNING')?.id ?? null;
  const plan: PlanOrder[] = orders.map((o, i) => ({
    id: o.id,
    variant: o.variant,
    qty: o.qty,
    seq: i,
    status: o.id === runningId ? 'RUNNING' : 'PLANNED',
    released: o.released,
    startedAt: null,
  }));
  const has = runningId != null && orders.some((o) => o.id === runningId);
  const slots = schedule(line, plan, startMs, has ? runningId : null, bl?.variant ?? null);
  return new Map([...slots].map(([id, s]) => [id, round((Date.parse(s.end) - startMs) / 60_000, 1)]));
}

/** 반복 하나의 라인 값 */
function lineRep(line: LineDef, rep: WhatIfRep, kw: KwLookup) {
  const times = new Map<string, StateTimes>();
  const counts = new Map<string, { ok: number; ng: number }>();
  let kwh = 0;
  let down = 0;
  let setup = 0;
  const halt = new Map<string, number>();
  for (const s of line.stations) {
    const st = rep.stations?.[s.code];
    const sec: StateTimes = st?.sec ?? {};
    times.set(s.code, sec);
    counts.set(s.code, { ok: st?.ok ?? 0, ng: st?.ng ?? 0 });
    const p = kw(s.code);
    if (p) kwh += kwhOf(sec, p).total;
    down += sec.DOWN ?? 0;
    setup += sec.SETUP ?? 0;
    halt.set(s.code, HALT.reduce((a, k) => a + (sec[k] ?? 0), 0) / 60);
  }
  const oee = lineOee(line, times, counts) ?? ZERO_OEE;
  const l = rep.lines?.[line.code];
  const out = l?.out ?? 0;
  return { oee, kwh, out, scrap: l?.scrap ?? 0, changeovers: l?.changeovers ?? 0, hourly: l?.hourly ?? [], downMin: down / 60, setupMin: setup / 60, halt };
}

function lineKpi(line: LineDef, reps: WhatIfRep[], hours: number, kw: KwLookup): { kpi: WhatIfLineKpi; out: number[]; kwh: number[] } {
  const rs = reps.map((r) => lineRep(line, r, kw));
  const hourly = { mean: [] as number[], p10: [] as number[], p90: [] as number[] };
  for (let i = 0; i < hours; i++) {
    const d = rdist(rs.map((r) => r.hourly[i] ?? r.hourly.at(-1) ?? 0), 1);
    hourly.mean.push(d.mean);
    hourly.p10.push(d.p10);
    hourly.p90.push(d.p90);
  }
  // 가장 오래 멈춘 설비 (고장+셋업+정지, 반복 평균 분)
  let topLoss: WhatIfLineKpi['topLoss'] = null;
  for (const s of line.stations) {
    const m = mean(rs.map((r) => r.halt.get(s.code) ?? 0));
    if (m > 0 && (!topLoss || m > topLoss.minutes)) topLoss = { station: s.code, minutes: round(m, 1) };
  }
  const out = rs.map((r) => r.out);
  const kwh = rs.map((r) => r.kwh);
  return {
    kpi: {
      line: line.code,
      out: rdist(out, 1),
      oee: rdist(rs.map((r) => r.oee.oee), 3),
      availability: rdist(rs.map((r) => r.oee.availability), 3),
      performance: rdist(rs.map((r) => r.oee.performance), 3),
      quality: rdist(rs.map((r) => r.oee.quality), 3),
      scrap: rdist(rs.map((r) => r.scrap), 1),
      changeovers: rdist(rs.map((r) => r.changeovers), 1),
      downMin: rdist(rs.map((r) => r.downMin), 1),
      setupMin: rdist(rs.map((r) => r.setupMin), 1),
      kwh: rdist(kwh, 1),
      kwhPerUnit: rdist(rs.map((r) => (r.out > 0 ? r.kwh / r.out : 0)), 3),
      hourly,
      topLoss,
    },
    out,
    kwh,
  };
}

type RepOrder = WhatIfRep['orders'][number];

/**
 * 작업지시별 결과: (라인, 코드)로 반복끼리 묶는다. 순서는 라인 순 → 계획 순 → 자동 계획이 채운 지시(먼저 만든 것부터).
 * display = 라인 계획의 표시 코드 (계획에서 새로 더한 지시는 화면이 붙인 이름)
 */
function orderKpis(sim: SimScenario, display: Partial<Record<LineCode, (string | undefined)[]>>, reps: WhatIfRep[], base: WhatIfBase): WhatIfOrderKpi[] {
  const maps = reps.map((r) => new Map((r.orders ?? []).map((o) => [`${o.line}|${o.code}`, o])));
  const out: WhatIfOrderKpi[] = [];
  const done = new Set<string>();
  const finish = (line: LineCode, code: string, info: { id?: number; auto?: boolean; label: string; variant: string; qty: number; dueMin?: number; planEndMin: number | null }) => {
    const key = `${line}|${code}`;
    done.add(key);
    const per = maps.map((m) => m.get(key) ?? null);
    const fin = per.filter((o): o is RepOrder => o?.finishedSec != null).map((o) => (o.finishedSec as number) / 60);
    out.push({
      line,
      ...(info.id != null ? { id: info.id } : {}),
      ...(info.auto ? { auto: true } : {}),
      code: info.label,
      variant: info.variant,
      qty: info.qty,
      ...(info.dueMin != null ? { dueMin: info.dueMin } : {}),
      finishedReps: fin.length,
      finishMin: fin.length ? rdist(fin, 1) : null,
      ...(info.dueMin != null ? { onTimeReps: fin.filter((m) => m <= info.dueMin!).length } : {}),
      planEndMin: info.planEndMin,
      doneMean: round(mean(per.map((o) => o?.done ?? 0)), 1),
    });
  };
  for (const l of LINES) {
    const orders = sim.orders[l.code] ?? [];
    const ends = planEnds(l, orders, base);
    orders.forEach((o, i) => {
      finish(l.code, o.code, {
        id: o.id < NEW_ID_BASE ? o.id : undefined,
        label: display[l.code]?.[i] ?? o.code,
        variant: o.variant,
        qty: o.qty,
        dueMin: o.dueMin,
        planEndMin: ends.get(o.id) ?? null,
      });
    });
    // 자동 계획이 채운 지시 (반복마다 생긴 수가 다를 수 있다)
    const extra = new Map<string, RepOrder>();
    for (const m of maps) for (const [k, o] of m) if (o.line === l.code && !done.has(k) && !extra.has(k)) extra.set(k, o);
    const sorted = [...extra.values()].sort((a, b) => (a.id < 0 && b.id < 0 ? b.id - a.id : a.id - b.id));
    for (const o of sorted) {
      finish(l.code, o.code, { id: o.id > 0 && o.id < NEW_ID_BASE ? o.id : undefined, auto: o.id < 0, label: o.code, variant: o.variant, qty: o.qty, planEndMin: null });
    }
  }
  return out;
}

/** 고장이 많이 난 설비 (반복 평균 횟수, 상위 5) */
function failureTop(reps: WhatIfRep[]): { station: string; mean: number }[] {
  const codes = new Set(reps.flatMap((r) => Object.keys(r.stations ?? {})));
  return [...codes]
    .map((station) => ({ station, mean: round(mean(reps.map((r) => r.stations?.[station]?.failures ?? 0)), 2) }))
    .filter((x) => x.mean > 0)
    .sort((a, b) => b.mean - a.mean || a.station.localeCompare(b.station))
    .slice(0, FAILURE_TOP);
}

export function aggregate(a: AggregateInput): WhatIfResult {
  const kw = a.kw ?? kwOf;
  const hours = Math.ceil(a.request.horizonH);
  const scenarios: WhatIfScenarioResult[] = a.request.scenarios.map((req, si) => {
    const sim = a.sim[si];
    const reps = a.runs.filter((r) => r.scenario === si).sort((x, y) => x.rep - y.rep);
    const lines: WhatIfLineKpi[] = [];
    const outSum = reps.map(() => 0);
    const kwhSum = reps.map(() => 0);
    for (const l of LINES) {
      const k = lineKpi(l, reps, hours, kw);
      lines.push(k.kpi);
      k.out.forEach((v, i) => (outSum[i] += v));
      k.kwh.forEach((v, i) => (kwhSum[i] += v));
    }
    const display = Object.fromEntries(Object.entries(req.orders ?? {}).map(([line, list]) => [line, (list ?? []).map((o) => o.code)]));
    return {
      name: req.name,
      events: req.events ?? [],
      autoFill: req.autoFill !== false,
      lines,
      total: { out: rdist(outSum, 1), kwh: rdist(kwhSum, 1) },
      orders: orderKpis(sim, display, reps, a.base),
      failures: failureTop(reps),
    };
  });
  return {
    horizonH: a.request.horizonH,
    reps: a.request.reps,
    seeds: Array.from({ length: a.request.reps }, (_, r) => a.seed + r),
    computeMs: Math.round(a.runs.reduce((s, r) => s + (r.wallMs ?? 0), 0)),
    elapsedMs: Math.round(a.elapsedMs),
    scenarios,
  };
}
