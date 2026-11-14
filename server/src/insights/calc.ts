// 분석 (P9) 순수 계산: 상태 구간 자르기, 에너지 적분, 라인 OEE·직행률, 비가동 사유, 교대 목록, 교대 일보 조립, CSV.
// DB를 모르는 함수만 둔다 (서비스가 행을 모아 넘기고, 테스트가 같은 함수를 확인한다).

import {
  CHANGE_KIND_CATEGORY,
  DEFECT_NAMES,
  LINES,
  STATIONS,
  inProductScope,
  powerMode,
  shiftLabel,
  shiftOf,
  type ChangeCategory,
  type EnergyBucket,
  type EnergyReport,
  type InspectionType,
  type InterlockCode,
  type Kwh,
  type LineCode,
  type LineDef,
  type LineEnergy,
  type Oee,
  type PowerMode,
  type ShiftCount,
  type ShiftDowntime,
  type ShiftLineReport,
  type ShiftOrderRow,
  type ShiftReport,
  type ShiftSlot,
  type StationEnergy,
  type StationState,
  type WoStatus,
} from '@lumitwin/shared';
import { stationLosses } from '../live/losses';
import type { StateTimes } from '../live/oee';
import { failureReason } from '../maintenance/maintenance';

const HOUR = 3_600_000;
const KST = 9 * HOUR;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;

// ─────────────────────────── 상태 구간 ───────────────────────────

/** DB 상태 기록 한 줄. end = 같은 설비의 다음 기록 시각(없으면 그때 상태가 이어짐), first = 그 설비의 이번 실행 첫 기록 */
export interface StateRow {
  station: string;
  state: string;
  reason: string | null;
  at: Date;
  end: Date | null;
  first: boolean;
}

export interface Span {
  station: string;
  state: StationState;
  reason: string | null;
  s: number;
  e: number;
}

/** 센 구간: 실행 시작·요청 구간·지금 (ms) */
export interface Window {
  runStartMs: number;
  fromMs: number;
  toMs: number;
  nowMs: number;
}

const STATES = new Set<StationState>(['RUN', 'IDLE', 'BLOCKED', 'DOWN', 'SETUP', 'STOP']);

/** 첫 상태 기록 전의 상태: 실시간 집계(LiveService)와 같게 유틸리티·보조 설비는 가동, 나머지는 투입 대기 */
export function initialState(code: string): StationState {
  const d = STATIONS[code];
  return d && (d.cycle <= 0 || d.aux) ? 'RUN' : 'IDLE';
}

/** 실제로 센 구간 [lo, hi): 실행 시작 전과 지금 뒤는 뺀다 */
export function clampWindow(w: Window): { lo: number; hi: number } {
  const lo = Math.max(w.fromMs, w.runStartMs);
  return { lo, hi: Math.max(lo, Math.min(w.toMs, w.nowMs)) };
}

/**
 * 상태 기록을 구간으로 바꿔 [lo, hi)로 자른다.
 * - 첫 기록 전은 초기 상태로 채운다. 구간 안에 기록이 하나도 없는 설비는 구간 전체가 초기 상태다
 * - 다음 기록이 없는 구간(지금 상태)은 hi까지 이어진다
 */
export function clipSpans(rows: StateRow[], w: Window, stations: string[] = Object.keys(STATIONS)): Span[] {
  const { lo, hi } = clampWindow(w);
  const out: Span[] = [];
  if (hi <= lo) return out;
  const seen = new Set<string>();
  for (const r of rows) {
    if (!STATIONS[r.station] || !STATES.has(r.state as StationState)) continue;
    seen.add(r.station);
    const at = r.at.getTime();
    if (r.first && at > lo) {
      const e = Math.min(at, hi);
      if (e > lo) out.push({ station: r.station, state: initialState(r.station), reason: null, s: lo, e });
    }
    const s = Math.max(at, lo);
    const e = Math.min(r.end ? r.end.getTime() : hi, hi);
    if (e > s) out.push({ station: r.station, state: r.state as StationState, reason: r.reason, s, e });
  }
  for (const code of stations) {
    if (!seen.has(code) && STATIONS[code]) out.push({ station: code, state: initialState(code), reason: null, s: lo, e: hi });
  }
  return out;
}

/** 설비별 상태 시간 (초) */
export function timesBy(spans: Span[]): Map<string, StateTimes> {
  const m = new Map<string, StateTimes>();
  for (const x of spans) {
    const t = m.get(x.station) ?? {};
    t[x.state] = (t[x.state] ?? 0) + (x.e - x.s) / 1000;
    m.set(x.station, t);
  }
  return m;
}

// ─────────────────────────── 에너지 ───────────────────────────

export type Kw = { run: number; idle: number; off: number };
/** 설비 → 소비 전력 (테스트는 공장 정의 대신 넣어 쓴다) */
export type KwLookup = (code: string) => Kw | null;

/** 공장 정의의 소비 전력 (없으면 null: 자료 없음) */
export function kwOf(code: string): Kw | null {
  const p = STATIONS[code]?.power;
  if (!p || ![p.run, p.idle, p.off].every((v) => Number.isFinite(v) && v >= 0)) return null;
  return { run: p.run, idle: p.idle, off: p.off };
}

/** 상태 시간(초)을 구분별 시간(시간)으로 */
export function modeHours(times: StateTimes): Record<PowerMode, number> {
  const h: Record<PowerMode, number> = { run: 0, idle: 0, off: 0 };
  for (const [state, sec] of Object.entries(times) as [StationState, number][]) h[powerMode(state)] += (sec ?? 0) / 3600;
  return h;
}

/** 전력량 (kWh) = Σ 구분별 소비 전력(kW) × 시간(h) */
export function kwhOf(times: StateTimes, kw: Kw): Kwh {
  const h = modeHours(times);
  const run = kw.run * h.run;
  const idle = kw.idle * h.idle;
  const off = kw.off * h.off;
  return { run, idle, off, total: run + idle + off };
}

const zeroKwh = (): Kwh => ({ run: 0, idle: 0, off: 0, total: 0 });
const addKwh = (a: Kwh, b: Kwh) => {
  a.run += b.run;
  a.idle += b.idle;
  a.off += b.off;
  a.total += b.total;
};
const roundKwh = <T extends Kwh>(x: T): T => ({ ...x, run: r3(x.run), idle: r3(x.idle), off: r3(x.off), total: r3(x.total) });
const share = (part: number, total: number) => (total > 0 ? r3(part / total) : null);
const per = (kwh: number, n: number) => (n > 0 ? r3(kwh / n) : null);

/** 시간대 칸 크기: 칸이 max개 이하가 되는 가장 작은 단위 (시간) */
export function bucketHours(spanMs: number, max = 48): number {
  for (const h of [1, 2, 3, 4, 6, 12, 24]) if (spanMs / (h * HOUR) <= max) return h;
  return 48;
}

/** 한국 시각 정시(칸 크기의 배수)에 맞춘 시간대 칸 */
export function makeBuckets(lo: number, hi: number, hours: number, nowMs: number): { s: number; e: number; partial: boolean }[] {
  const size = hours * HOUR;
  const out: { s: number; e: number; partial: boolean }[] = [];
  if (hi <= lo) return out;
  for (let s = Math.floor((lo + KST) / size) * size - KST; s < hi; s += size) out.push({ s, e: s + size, partial: s + size > Math.min(hi, nowMs) || s < lo });
  return out;
}

/** 시간대별 전력량: 구간마다 겹치는 칸에 소비 전력 × 겹친 시간을 더한다 */
export function energyBuckets(spans: Span[], buckets: { s: number; e: number; partial: boolean }[], kwLookup: KwLookup = kwOf): EnergyBucket[] {
  const out = buckets.map((b) => ({ t: new Date(b.s).toISOString(), end: new Date(b.e).toISOString(), run: 0, idle: 0, off: 0, partial: b.partial }));
  if (!buckets.length) return out;
  const size = buckets[0].e - buckets[0].s;
  const base = buckets[0].s;
  for (const x of spans) {
    const kw = kwLookup(x.station);
    if (!kw) continue;
    const mode = powerMode(x.state);
    const i0 = Math.max(0, Math.floor((x.s - base) / size));
    const i1 = Math.min(buckets.length - 1, Math.floor((x.e - 1 - base) / size));
    for (let i = i0; i <= i1; i++) {
      const ov = Math.min(x.e, buckets[i].e) - Math.max(x.s, buckets[i].s);
      if (ov > 0) out[i][mode] += (kw[mode] * ov) / HOUR;
    }
  }
  return out.map((b) => ({ ...b, run: r3(b.run), idle: r3(b.idle), off: r3(b.off) }));
}

export interface EnergyInput {
  runId: number | null;
  runStartMs: number;
  nowMs: number;
  fromMs: number;
  toMs: number;
  rows: StateRow[];
  /** 설비별 양품 처리 수 (구간 안) */
  okByStation: Map<string, number>;
  /** 라인별 최종 공정 양품 (구간 안) */
  goodByLine: Map<string, number>;
  line?: LineCode;
  kw?: KwLookup;
}

/** 에너지 보고: 상태 구간 × 소비 전력 (run = RUN · idle = IDLE·BLOCKED·SETUP · off = STOP·DOWN) */
export function buildEnergy(i: EnergyInput): EnergyReport {
  const w: Window = { runStartMs: i.runStartMs, fromMs: i.fromMs, toMs: i.toMs, nowMs: i.nowMs };
  const { lo, hi } = clampWindow(w);
  const lines = LINES.filter((l) => !i.line || l.code === i.line);
  const codes = lines.flatMap((l) => l.stations.map((s) => s.code));
  const inScope = new Set(codes);
  const spans = clipSpans(
    i.rows.filter((r) => inScope.has(r.station)),
    w,
    codes,
  );
  const times = timesBy(spans);
  const kwLookup = i.kw ?? kwOf;

  const stations: StationEnergy[] = codes.map((code) => {
    const def = STATIONS[code];
    const t = times.get(code) ?? {};
    const h = modeHours(t);
    const kw = kwLookup(code);
    const e = kw ? kwhOf(t, kw) : zeroKwh();
    const ok = i.okByStation.get(code) ?? 0;
    return roundKwh({
      station: code,
      line: def.line,
      kw: kw ? { ...kw, grade: def.power?.grade ?? 'assumed' } : null,
      hours: { run: r3(h.run), idle: r3(h.idle), off: r3(h.off) },
      ok,
      perUnit: kw ? per(e.total, ok) : null,
      idleShare: kw ? share(e.idle, e.total) : null,
      ...e,
    });
  });

  const lineRows: LineEnergy[] = lines.map((l) => {
    const own = stations.filter((s) => s.line === l.code);
    const sum = zeroKwh();
    for (const s of own) if (s.kw) addKwh(sum, s);
    const good = i.goodByLine.get(l.code) ?? 0;
    const has = own.some((s) => s.kw);
    return roundKwh({
      line: l.code,
      good,
      perUnit: has ? per(sum.total, good) : null,
      idleShare: has ? share(sum.idle, sum.total) : null,
      stations: own.filter((s) => s.kw).length,
      missing: own.filter((s) => !s.kw).map((s) => s.station),
      ...sum,
    });
  });

  const total = zeroKwh();
  for (const l of lineRows) addKwh(total, l);
  const hours = bucketHours(hi - lo);
  return {
    runId: i.runId,
    from: new Date(lo).toISOString(),
    to: new Date(hi).toISOString(),
    now: Number.isFinite(i.nowMs) ? new Date(i.nowMs).toISOString() : null,
    runStartedAt: new Date(i.runStartMs).toISOString(),
    bucketHours: hours,
    total: roundKwh({ ...total, idleShare: lineRows.some((l) => l.stations > 0) ? share(total.idle, total.total) : null }),
    lines: lineRows,
    stations,
    hourly: energyBuckets(spans, makeBuckets(lo, hi, hours, i.nowMs), kwLookup),
    missing: stations.filter((s) => !s.kw).map((s) => s.station),
  };
}

// ─────────────────────────── 라인 OEE · 직행률 ───────────────────────────

/** 한 개당 이상 사이클 (초): 실시간 집계와 같은 정의 (동시 투입·배치·연배 분할로 나눈다) */
export function idealSecOf(code: string): { idealSec: number; utility: boolean } {
  const d = STATIONS[code];
  if (!d) return { idealSec: 0, utility: true };
  const utility = d.cycle <= 0 || !!d.aux;
  const split = LINES.find((l) => l.code === d.line)?.steps.find((s) => s.code === d.step)?.split ?? 1;
  return { idealSec: utility ? 0 : d.cycle / ((d.slots ?? 1) * (d.batch ?? 1) * split), utility };
}

/**
 * 라인 OEE (설비 시간 합, 6대 로스 화면과 같은 정의): 가공 설비의 계획 시간·가동 가능 시간·순가동 시간·가치 시간을 더해
 * 가동률 = 가동 가능 ÷ 계획 · 성능 = 순가동 ÷ 가동 가능 · 양품률 = 가치 ÷ 순가동. 곱하면 가치 ÷ 계획 = OEE
 */
export function lineOee(line: LineDef, times: Map<string, StateTimes>, counts: Map<string, { ok: number; ng: number }>): Oee | null {
  let planned = 0;
  let operating = 0;
  let net = 0;
  let valuable = 0;
  for (const s of line.stations) {
    const { idealSec, utility } = idealSecOf(s.code);
    if (utility) continue;
    const c = counts.get(s.code) ?? { ok: 0, ng: 0 };
    const lt = stationLosses(times.get(s.code) ?? {}, { ok: c.ok, ng: c.ng, startupNg: 0, idealSec, utility: false });
    const op = lt.planned - lt.loss.breakdown - lt.loss.setup;
    planned += lt.planned;
    operating += op;
    net += op - lt.loss.minorStop - lt.loss.speed;
    valuable += lt.valuable;
  }
  if (planned <= 0) return null;
  const availability = operating / planned;
  const performance = operating > 0 ? net / operating : 0;
  const quality = net > 0 ? valuable / net : 1;
  return { availability: r3(availability), performance: r3(performance), quality: r3(quality), oee: r3(valuable / planned) };
}

/** 직행률 = 공정별 첫 판정 합격률의 곱. 판정이 하나도 없으면 null */
export function fpyOf(steps: Iterable<{ ok: number; ng: number }>): number | null {
  let fpy = 1;
  let any = false;
  for (const { ok, ng } of steps) {
    if (ok + ng <= 0) continue;
    any = true;
    fpy *= ok / (ok + ng);
  }
  return any ? r3(fpy) : null;
}

// ─────────────────────────── 비가동 사유 ───────────────────────────

const HALT = new Set<StationState>(['DOWN', 'SETUP', 'STOP']);

/** 비가동(고장·셋업·정지) 사유별 설비 시간 합, 큰 순 */
export function downtimeTop(spans: Span[], n = 8): ShiftDowntime[] {
  const m = new Map<string, { state: StationState; reason: string; sec: number; count: number; stations: Set<string> }>();
  for (const x of spans) {
    if (!HALT.has(x.state)) continue;
    const reason = x.state === 'DOWN' ? failureReason(x.reason).reason : x.reason || '사유 없음';
    const k = `${x.state}|${reason}`;
    const r = m.get(k) ?? { state: x.state, reason, sec: 0, count: 0, stations: new Set<string>() };
    r.sec += (x.e - x.s) / 1000;
    r.count++;
    r.stations.add(x.station);
    m.set(k, r);
  }
  return [...m.values()]
    .sort((a, b) => b.sec - a.sec)
    .slice(0, n)
    .map((r) => ({ state: r.state, reason: r.reason, sec: Math.round(r.sec), count: r.count, stations: [...r.stations] }));
}

// ─────────────────────────── 교대 목록 ───────────────────────────

/** 실행 시작부터 지금까지 걸친 교대 (새것부터, 최대 max개) */
export function shiftsBetween(startMs: number, nowMs: number, max = 90): ShiftSlot[] {
  const out: ShiftSlot[] = [];
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs) || nowMs < startMs) return out;
  let cur = shiftOf(startMs);
  // 아주 긴 실행이면 뒤쪽 max개만 센다
  const skip = Math.floor((nowMs - Date.parse(cur.start)) / (12 * HOUR)) - max;
  if (skip > 0) cur = shiftOf(Date.parse(cur.start) + skip * 12 * HOUR);
  while (Date.parse(cur.start) <= nowMs) {
    out.push(cur);
    cur = shiftOf(Date.parse(cur.end));
  }
  return out.reverse().slice(0, max);
}

// ─────────────────────────── 교대 일보 ───────────────────────────

/** 공정 기록 묶음 (process_record를 이 열로 group by 한 것) */
export interface RecordGroup {
  line: string;
  step: string;
  station: string;
  result: string;
  defect: string | null;
  workOrder: number | null;
  reinspect: boolean;
  n: number;
}

export interface OrderRow {
  id: number;
  code: string;
  line: string;
  variant: string;
  qty: number;
  status: string;
  released: number;
  doneQty: number;
  scrapQty: number;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface NcrRow {
  line: string;
  openedAt: Date;
  closedAt: Date | null;
  disposition: string | null;
  repairOk: boolean | null;
}

export interface ShiftInput {
  slot: ShiftSlot;
  runId: number;
  runStartMs: number;
  nowMs: number;
  current: boolean;
  rows: StateRow[];
  records: RecordGroup[];
  orders: OrderRow[];
  ncr: NcrRow[];
  changes: { line: string; category: string; kind: string; faStatus: string; n: number }[];
  inspections: { line: string; type: string; result: string; n: number }[];
  interlock: { line: string; verdict: string; code: string; n: number }[];
  /** Hold 판정으로 폐기한 개체 수 (라인별) */
  holdScrap: Map<string, number>;
  line?: LineCode;
  kw?: KwLookup;
}

const CATEGORIES: ChangeCategory[] = ['MAN', 'MACHINE', 'MATERIAL', 'METHOD'];
const within = (d: Date | null | undefined, lo: number, hi: number) => !!d && d.getTime() >= lo && d.getTime() < hi;

/** 교대 일보 조립: 교대 구간(실행 시작·지금으로 자른 것)의 기록을 라인별로 모은다 */
export function buildShiftReport(i: ShiftInput): ShiftReport {
  const w: Window = { runStartMs: i.runStartMs, fromMs: Date.parse(i.slot.start), toMs: Date.parse(i.slot.end), nowMs: i.nowMs };
  const { lo, hi } = clampWindow(w);
  const spans = clipSpans(i.rows, w);
  const times = timesBy(spans);
  const lines = LINES.filter((l) => !i.line || l.code === i.line);

  const out: ShiftLineReport[] = lines.map((l) => {
    const recs = i.records.filter((r) => r.line === l.code);
    const counts = new Map<string, { ok: number; ng: number }>();
    const steps = new Map<string, { ok: number; ng: number }>();
    const defects = new Map<string, { count: number; stations: Set<string> }>();
    const woIn = new Map<number, number>();
    const woGood = new Map<number, number>();
    let input = 0;
    let ok = 0;
    let ng = 0;
    let outScopeNg = 0;
    for (const r of recs) {
      const isNg = r.result === 'NG';
      const c = counts.get(r.station) ?? { ok: 0, ng: 0 };
      if (isNg) c.ng += r.n;
      else c.ok += r.n;
      counts.set(r.station, c);
      if (!r.reinspect) {
        const s = steps.get(r.step) ?? { ok: 0, ng: 0 };
        if (isNg) s.ng += r.n;
        else s.ok += r.n;
        steps.set(r.step, s);
      }
      if (r.step === l.release && !r.reinspect) {
        input += r.n;
        if (r.workOrder != null) woIn.set(r.workOrder, (woIn.get(r.workOrder) ?? 0) + r.n);
      }
      if (r.step === l.finalStep && !isNg) {
        ok += r.n;
        if (r.workOrder != null) woGood.set(r.workOrder, (woGood.get(r.workOrder) ?? 0) + r.n);
      }
      if (isNg) {
        ng += r.n;
        if (!inProductScope(l, r.step)) outScopeNg += r.n;
        const code = r.defect ?? '(코드 없음)';
        const d = defects.get(code) ?? { count: 0, stations: new Set<string>() };
        d.count += r.n;
        d.stations.add(r.station);
        defects.set(code, d);
      }
    }

    // 작업지시: 교대 구간과 진행 기간이 겹치거나 교대 중 실적이 있는 것
    const orders: ShiftOrderRow[] = i.orders
      .filter((o) => o.line === l.code)
      .filter((o) => {
        if (woIn.has(o.id) || woGood.has(o.id)) return true;
        if (!o.startedAt) return false;
        const s = o.startedAt.getTime();
        const e = o.endedAt ? o.endedAt.getTime() : hi;
        return s < hi && e >= lo;
      })
      .sort((a, b) => (a.startedAt?.getTime() ?? Infinity) - (b.startedAt?.getTime() ?? Infinity) || a.id - b.id)
      .map((o) => ({
        id: o.id, code: o.code, variant: o.variant, qty: o.qty, status: o.status as WoStatus, released: o.released, doneQty: o.doneQty, scrapQty: o.scrapQty,
        input: woIn.get(o.id) ?? 0, good: woGood.get(o.id) ?? 0,
        startedAt: o.startedAt?.toISOString() ?? null, endedAt: o.endedAt?.toISOString() ?? null,
      }));

    const ncr = i.ncr.filter((n) => n.line === l.code);
    const ncrScrap = ncr.filter((n) => within(n.closedAt, lo, hi) && (n.disposition === 'SCRAP' || n.repairOk === false)).length;

    const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<ChangeCategory, number>;
    let faNg = 0;
    for (const c of i.changes.filter((x) => x.line === l.code)) {
      const cat = (CATEGORIES as string[]).includes(c.category) ? (c.category as ChangeCategory) : (CHANGE_KIND_CATEGORY[c.kind as keyof typeof CHANGE_KIND_CATEGORY] ?? 'METHOD');
      byCategory[cat] += c.n;
      if (c.faStatus === 'NG') faNg += c.n;
    }
    const insp = { FIRST: 0, MID: 0, LAST: 0, ng: 0 } as Record<InspectionType, number> & { ng: number };
    for (const x of i.inspections.filter((y) => y.line === l.code)) {
      if (x.type === 'FIRST' || x.type === 'MID' || x.type === 'LAST') insp[x.type] += x.n;
      if (x.result === 'NG') insp.ng += x.n;
    }
    const ilk = { ng: 0, wait: 0, byCode: {} as Partial<Record<InterlockCode, number>> };
    for (const x of i.interlock.filter((y) => y.line === l.code)) {
      if (x.verdict === 'NG') {
        ilk.ng += x.n;
        ilk.byCode[x.code as InterlockCode] = (ilk.byCode[x.code as InterlockCode] ?? 0) + x.n;
      } else if (x.verdict === 'WAIT') ilk.wait += x.n;
    }

    // 전력량: 소비 전력 정의가 있는 설비만
    let kwh = 0;
    let has = 0;
    let missing = 0;
    for (const s of l.stations) {
      const kw = (i.kw ?? kwOf)(s.code);
      if (!kw) {
        missing++;
        continue;
      }
      has++;
      kwh += kwhOf(times.get(s.code) ?? {}, kw).total;
    }

    const lineSpans = spans.filter((x) => STATIONS[x.station]?.line === l.code);
    const defectRows: ShiftCount[] = [...defects.entries()]
      .map(([code, d]) => ({ code, name: DEFECT_NAMES[code] ?? code, count: d.count, stations: [...d.stations] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    return {
      line: l.code,
      target: Math.floor((hi - lo) / 1000 / l.taktSec),
      orders,
      input,
      ok,
      ng,
      scrap: outScopeNg + ncrScrap + (i.holdScrap.get(l.code) ?? 0),
      fpy: fpyOf(steps.values()),
      oee: lineOee(l, times, counts),
      downtime: downtimeTop(lineSpans),
      defects: defectRows,
      ncr: {
        opened: ncr.filter((n) => within(n.openedAt, lo, hi)).length,
        closed: ncr.filter((n) => within(n.closedAt, lo, hi)).length,
        openAtEnd: ncr.filter((n) => n.openedAt.getTime() < hi && (!n.closedAt || n.closedAt.getTime() >= hi)).length,
      },
      changes: { total: CATEGORIES.reduce((a, c) => a + byCategory[c], 0), byCategory, faNg },
      inspections: insp,
      interlock: ilk,
      energy: { kwh: has ? r2(kwh) : null, perUnit: has && ok > 0 ? r3(kwh / ok) : null, missing },
    };
  });

  return {
    runId: i.runId,
    key: i.slot.key,
    code: i.slot.code,
    name: shiftLabel(i.slot.date, i.slot.code),
    date: i.slot.date,
    start: i.slot.start,
    end: i.slot.end,
    from: new Date(lo).toISOString(),
    to: new Date(hi).toISOString(),
    current: i.current,
    now: Number.isFinite(i.nowMs) ? new Date(i.nowMs).toISOString() : null,
    lines: out,
  };
}

// ─────────────────────────── CSV ───────────────────────────

/** 한국 시각 'YYYY-MM-DD HH:mm' */
export function kstText(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(Date.parse(iso) + KST).toISOString().slice(0, 16).replace('T', ' ');
}

/** CSV 칸: 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싸고 따옴표는 두 번 쓴다. 수식으로 읽힐 글자(= + - @)로 시작하는 글은 앞에 '를 붙인다 */
export function csvCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const pctText = (v: number | null | undefined) => (v == null ? '' : `${(v * 100).toFixed(1)}%`);
const STATE_NAMES: Record<StationState, string> = { RUN: '가동', IDLE: '투입 대기', BLOCKED: '배출 대기', DOWN: '고장', SETUP: '셋업', STOP: '계획 정지' };

/** 교대 일보 CSV (엑셀이 한글을 바로 읽게 UTF-8 BOM, 줄바꿈 CRLF) */
export function shiftCsv(r: ShiftReport): string {
  const rows: unknown[][] = [];
  const lineName = (code: string) => LINES.find((l) => l.code === code)?.name ?? code;
  rows.push(['교대 일보', `${r.date} ${r.code === 'D' ? '주간' : '야간'}`, `${kstText(r.start)} ~ ${kstText(r.end)}`, `실행 #${r.runId}`]);
  rows.push(['집계 구간', `${kstText(r.from)} ~ ${kstText(r.to)}`, r.current ? '진행 중 (지금까지)' : '']);
  rows.push([]);
  rows.push(['항목', ...r.lines.map((l) => lineName(l.line))]);
  const add = (name: string, f: (l: ShiftLineReport) => unknown) => rows.push([name, ...r.lines.map(f)]);
  add('목표 (택트 기준)', (l) => l.target);
  add('투입', (l) => l.input);
  add('생산 OK (최종 양품)', (l) => l.ok);
  add('달성률 (OK ÷ 목표)', (l) => (l.target > 0 ? pctText(l.ok / l.target) : ''));
  add('NG 판정', (l) => l.ng);
  add('폐기', (l) => l.scrap);
  add('직행률 (FPY)', (l) => pctText(l.fpy));
  add('OEE', (l) => pctText(l.oee?.oee));
  add('가동률', (l) => pctText(l.oee?.availability));
  add('성능', (l) => pctText(l.oee?.performance));
  add('양품률', (l) => pctText(l.oee?.quality));
  add('NCR 발생', (l) => l.ncr.opened);
  add('NCR 종결', (l) => l.ncr.closed);
  add('NCR 미결 (교대 끝)', (l) => l.ncr.openAtEnd);
  add('4M 변경점', (l) => l.changes.total);
  for (const c of CATEGORIES) add(`  ${c}`, (l) => l.changes.byCategory[c]);
  add('초물 불합격 변경점', (l) => l.changes.faNg);
  add('초물 검사', (l) => l.inspections.FIRST);
  add('중물 검사', (l) => l.inspections.MID);
  add('종물 검사', (l) => l.inspections.LAST);
  add('초중종물 불합격', (l) => l.inspections.ng);
  add('인터록 거부', (l) => l.interlock.ng);
  add('인터록 대기', (l) => l.interlock.wait);
  add('전력량 (kWh)', (l) => l.energy.kwh ?? '자료 없음');
  add('개당 전력량 (kWh/개)', (l) => l.energy.perUnit ?? '');
  rows.push([]);
  rows.push(['작업지시']);
  rows.push(['라인', '작업지시', '기종', '지시 수량', '상태', '누계 투입', '누계 양품', '누계 폐기', '교대 투입', '교대 양품', '시작', '끝']);
  for (const l of r.lines) {
    for (const o of l.orders) rows.push([lineName(l.line), o.code, o.variant, o.qty, o.status, o.released, o.doneQty, o.scrapQty, o.input, o.good, kstText(o.startedAt), kstText(o.endedAt)]);
  }
  rows.push([]);
  rows.push(['비가동 사유 상위']);
  rows.push(['라인', '구분', '사유', '시간 (분)', '건수', '설비']);
  for (const l of r.lines) for (const d of l.downtime) rows.push([lineName(l.line), STATE_NAMES[d.state], d.reason, Math.round(d.sec / 6) / 10, d.count, d.stations.join(' ')]);
  rows.push([]);
  rows.push(['불량 상위']);
  rows.push(['라인', '불량 코드', '불량명', '수량', '설비']);
  for (const l of r.lines) for (const d of l.defects) rows.push([lineName(l.line), d.code, d.name, d.count, d.stations.join(' ')]);
  return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

