'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FACTORY,
  LINES,
  PM_PLANS,
  STATIONS,
  WHATIF_EVENT_NAMES,
  WHATIF_LIMITS,
  type LineCode,
  type WhatIfApply,
  type WhatIfApplyResult,
  type WhatIfBase,
  type WhatIfBaseLine,
  type WhatIfBaseSource,
  type WhatIfDist,
  type WhatIfEvent,
  type WhatIfLineKpi,
  type WhatIfOrder,
  type WhatIfRequest,
  type WhatIfRunSummary,
  type WhatIfRunView,
  type WhatIfScenarioInput,
  type WhatIfStatus,
} from '@lumitwin/shared';
import { ApiError, api } from './api';
import { pct } from './format';
import { POWER_COLOR, kwh } from './insights';

/**
 * What-if 계획 시뮬레이션 화면 공용 (P11): 조회·실행 훅, 계획 편집 초안 ↔ 요청 변환, 비교 지표 정의, 계획 색.
 * 서버 API는 server/src/whatif (계약 3장)
 */

export const WHATIF_KEYS = {
  base: ['whatif', 'base'] as const,
  runs: ['whatif', 'runs'] as const,
  run: ['whatif', 'run'] as const,
};

export const isRunBusy = (s: WhatIfStatus | undefined) => s === 'QUEUED' || s === 'RUNNING';

/** 400(검증·시뮬레이터 없음)은 다시 불러도 같으니 한 번만 */
const retryServerOnly = (n: number, e: unknown) => !(e instanceof ApiError && e.status < 500) && n < 1;

/** 기준 상태 미리 보기. 편집하는 동안 바뀌면 곤란하니 저절로 다시 부르지 않는다 ('다시 읽기'로만) */
export function useWhatIfBase(source: WhatIfBaseSource) {
  return useQuery({
    queryKey: [...WHATIF_KEYS.base, source],
    queryFn: () => api.get<WhatIfBase>(`/whatif/base?source=${source}`),
    staleTime: Infinity,
    retry: retryServerOnly,
  });
}

export function useWhatIfRuns(limit = 10) {
  return useQuery({
    queryKey: [...WHATIF_KEYS.runs, limit],
    queryFn: () => api.get<WhatIfRunSummary[]>(`/whatif/runs?limit=${limit}`),
    refetchInterval: (q) => (q.state.data?.some((r) => isRunBusy(r.status)) ? 2_000 : 15_000),
    placeholderData: keepPreviousData,
  });
}

/**
 * 실행 하나: 대기·계산 중이면 1초마다 다시 부른다.
 * 계산을 걸고 다른 탭으로 가도 끝난 것을 알아채게 숨은 탭에서도 계속 부른다 (계산 중일 때만, 길어야 몇 분)
 */
export function useWhatIfRun(id: number | null) {
  return useQuery({
    queryKey: [...WHATIF_KEYS.run, id],
    queryFn: () => api.get<WhatIfRunView>(`/whatif/runs/${id}`),
    enabled: id != null,
    refetchInterval: (q) => (isRunBusy(q.state.data?.status) ? 1_000 : false),
    refetchIntervalInBackground: true,
    retry: retryServerOnly,
  });
}

export function useWhatIfStart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: WhatIfRequest) => api.post<WhatIfRunView>('/whatif/runs', req),
    onSuccess: (v) => {
      qc.setQueryData([...WHATIF_KEYS.run, v.id], v);
      void qc.invalidateQueries({ queryKey: WHATIF_KEYS.runs });
    },
  });
}

/** 계획 하나의 라인 순서를 MES 대기 순서에 반영: 성공하면 실행 MES 조회(작업지시)를 다시 부른다 */
export function useWhatIfApply(runId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: WhatIfApply) => api.post<WhatIfApplyResult>(`/whatif/runs/${runId}/apply`, b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['exec'] }),
  });
}

// ─────────────────────────── 고르는 값·색 ───────────────────────────

/** 시간·반복 고르기. 2시간·2회는 빠른 확인용 (E2E도 이 값으로 돈다) */
export const HORIZON_OPTIONS = [2, 4, 8, 12, 24] as const;
export const REPS_OPTIONS = [2, 3, 5, 10] as const;

/**
 * 계획 색 (범주형 고정 순서: 첫째 = 기준). 에너지 화면의 POWER_COLOR와 같은 검증된 세 색을 그대로 쓴다
 * (어두운 차트 바탕 #0e141e에서 dataviz 검증 통과: 밝기 띠·채도·색각 이웃 ΔE ≥ 17·대비 3:1)
 */
export const PLAN_COLORS = [POWER_COLOR.run, POWER_COLOR.idle, POWER_COLOR.off] as const;
export const planColor = (i: number) => PLAN_COLORS[i] ?? 'var(--color-sub)';

export const SOURCE_NAMES: Record<WhatIfBaseSource, string> = { live: '지금 공장 상태', clean: '초기화한 공장' };
export const SOURCE_DESC: Record<WhatIfBaseSource, string> = {
  live: '지금 재공·고장·보전·마모·공정 이상을 복사해 이어서 돌립니다',
  clean: '재공 절반·마모 무작위로 새로 시작합니다 (고장·공정 이상 없이)',
};

export const RUN_STATUS_TONE: Record<WhatIfStatus, string> = {
  QUEUED: 'border-line bg-white/5 text-sub',
  RUNNING: 'border-info/40 bg-info/10 text-info',
  DONE: 'border-run/40 bg-run/10 text-run',
  FAILED: 'border-down/40 bg-down/10 text-down',
};

export const lineName = (code: string) => LINES.find((l) => l.code === code)?.name ?? code;
export const lineColor = (code: string) => LINES.find((l) => l.code === code)?.color;
export const variantShort = (line: LineCode, code: string) => LINES.find((l) => l.code === line)?.variants.find((v) => v.code === code)?.name ?? code;

/** 이벤트 고르기 목록: 라인별 설비 (보조 설비 포함 — 건조기도 고장 난다) */
export const STATION_GROUPS = LINES.map((l) => ({ line: l.code, name: l.name, stations: l.stations.map((s) => s.code) }));
export const SCENARIO_GROUPS = LINES.map((l) => ({ line: l.code, name: l.name, scenarios: FACTORY.scenarios.filter((s) => s.line === l.code) }));
export const scenarioName = (id: string) => FACTORY.scenarios.find((s) => s.id === id)?.name ?? id;
export const stationLabel = (code: string) => `${code} ${STATIONS[code]?.name ?? ''}`.trim();
export const pmMinutes = (code: string) => {
  const s = STATIONS[code];
  return s ? (PM_PLANS[s.kind]?.minutes ?? null) : null;
};

// ─────────────────────────── 숫자·시각 ───────────────────────────

const KST = 9 * 3_600_000;
const p2 = (n: number) => String(n).padStart(2, '0');

/** 가상 시작 시각 + 분 → 한국 시각 'HH:MM' (시작과 날짜가 다르면 'M/D HH:MM') */
export function vclock(startIso: string | null | undefined, min = 0): string {
  if (!startIso) return '-';
  const s = new Date(Date.parse(startIso) + KST);
  const d = new Date(Date.parse(startIso) + KST + min * 60_000);
  const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return s.getUTCDate() === d.getUTCDate() && s.getUTCMonth() === d.getUTCMonth() ? hm : `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hm}`;
}

/** 실제·가상 시각 → 'M/D HH:MM' (한국 시각) */
export function mdhm(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(Date.parse(iso) + KST);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** 분 → '35분' · '2.5시간' */
export const mins = (m: number | null | undefined) => (m == null || !Number.isFinite(m) ? '-' : Math.abs(m) >= 120 ? `${(m / 60).toFixed(1)}시간` : `${Math.round(m)}분`);
export const int = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '-' : Math.round(v).toLocaleString('ko-KR'));
export const perUnitNum = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '-' : String(Number(v.toPrecision(3))));
/** 차이 글자: +12 · −3 · ±0 (빼기는 수학 기호) */
export function signed(d: number, fmt: (v: number) => string): string {
  if (!Number.isFinite(d)) return '-';
  if (d === 0) return '±0';
  return `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}`;
}

/** 분포 → '평균 (p10 ~ p90)'의 범위 부분 */
export const range = (d: WhatIfDist, fmt: (v: number) => string) => (d.p10 === d.p90 ? fmt(d.p10) : `${fmt(d.p10)} ~ ${fmt(d.p90)}`);

// ─────────────────────────── 비교 지표 ───────────────────────────

export type DistKey = 'out' | 'oee' | 'availability' | 'performance' | 'quality' | 'scrap' | 'changeovers' | 'downMin' | 'setupMin' | 'kwh' | 'kwhPerUnit';

export interface MetricDef {
  key: DistKey;
  label: string;
  /** 클수록 좋음(up) · 작을수록 좋음(down) · 좋고 나쁨이 없음(null: 전력량은 생산량을 따라 늘어난다) */
  better: 'up' | 'down' | null;
  /** 핵심 지표 (기본으로 보이는 것) */
  core: boolean;
  fmt: (v: number) => string;
  /** 범위(p10 ~ p90)에 쓸 짧은 글자 (단위를 두 번 쓰지 않게). 없으면 fmt */
  short?: (v: number) => string;
  diff: (d: number) => string;
  /** 이보다 작은 차이는 같다고 본다 (절대값) */
  eps: number;
  hint: string;
}

const pctp = (d: number) => signed(d * 100, (x) => `${x.toFixed(1)}%p`);

export const METRICS: MetricDef[] = [
  { key: 'out', label: '양품', better: 'up', core: true, fmt: int, diff: (d) => signed(d, int), eps: 0.5, hint: '최종 공정 양품 수 (개)' },
  { key: 'oee', label: 'OEE', better: 'up', core: true, fmt: (v) => pct(v), diff: pctp, eps: 0.0005, hint: '라인 OEE (라이브 화면과 같은 계산)' },
  { key: 'availability', label: '시간 가동률', better: 'up', core: false, fmt: (v) => pct(v), diff: pctp, eps: 0.0005, hint: 'OEE의 가동률 요소' },
  { key: 'performance', label: '성능 가동률', better: 'up', core: false, fmt: (v) => pct(v), diff: pctp, eps: 0.0005, hint: 'OEE의 성능 요소' },
  { key: 'quality', label: '양품률', better: 'up', core: false, fmt: (v) => pct(v), diff: pctp, eps: 0.0005, hint: 'OEE의 품질 요소' },
  { key: 'scrap', label: '폐기', better: 'down', core: true, fmt: int, diff: (d) => signed(d, int), eps: 0.5, hint: '폐기한 개수' },
  { key: 'downMin', label: '고장 시간', better: 'down', core: true, fmt: mins, diff: (d) => signed(d, mins), eps: 0.5, hint: '라인 설비 고장 시간 합' },
  { key: 'setupMin', label: '셋업 시간', better: 'down', core: true, fmt: mins, diff: (d) => signed(d, mins), eps: 0.5, hint: '라인 설비 셋업 시간 합 (기종 변경)' },
  { key: 'changeovers', label: '기종 변경', better: 'down', core: false, fmt: (v) => `${Number(v.toFixed(1))}회`, diff: (d) => signed(d, (x) => `${Number(x.toFixed(1))}회`), eps: 0.05, hint: '기종이 바뀐 횟수' },
  { key: 'kwh', label: '전력량', better: null, core: false, fmt: (v) => kwh(v), short: (v) => kwh(v, false), diff: (d) => signed(d, (x) => kwh(x)), eps: 0.05, hint: '라인 설비 전력량 합 (생산량을 따라 늘어 좋고 나쁨을 매기지 않습니다)' },
  { key: 'kwhPerUnit', label: '개당 전력량', better: 'down', core: true, fmt: (v) => `${perUnitNum(v)} kWh/개`, short: perUnitNum, diff: (d) => signed(d, perUnitNum), eps: 0.0005, hint: '양품 1개당 kWh (불량이 늘면 같이 오릅니다)' },
];

export type Judge = 'better' | 'worse' | 'same' | 'neutral';

/** 기준 대비 좋아졌나: 지표마다 좋은 방향이 다르다. 기준 평균의 0.5% 또는 eps보다 작은 차이는 같다고 본다 */
export function judge(m: Pick<MetricDef, 'better' | 'eps'>, base: number, v: number): Judge {
  const d = v - base;
  if (Math.abs(d) <= Math.max(m.eps, Math.abs(base) * 0.005)) return 'same';
  if (!m.better) return 'neutral';
  return (d > 0) === (m.better === 'up') ? 'better' : 'worse';
}

export const JUDGE_TONE: Record<Judge, string> = { better: 'text-run', worse: 'text-down', same: 'text-dim', neutral: 'text-sub' };
export const JUDGE_NAMES: Record<Judge, string> = { better: '좋아짐', worse: '나빠짐', same: '차이 없음', neutral: '좋고 나쁨 없음' };

export const lineKpi = (lines: WhatIfLineKpi[], code: string) => lines.find((l) => l.line === code);

/** 사건 한 줄 설명 */
export function eventText(ev: WhatIfEvent, startIso?: string | null): string {
  const at = startIso ? `${vclock(startIso, ev.atMin)} (+${mins(ev.atMin)})` : `+${mins(ev.atMin)}`;
  if (ev.kind === 'down') return `${WHATIF_EVENT_NAMES.down} ${stationLabel(ev.station)} · ${at}부터 ${mins(ev.minutes)}`;
  if (ev.kind === 'pm') return `${WHATIF_EVENT_NAMES.pm} ${stationLabel(ev.station)} · ${at}`;
  return `${WHATIF_EVENT_NAMES.scenario} ${ev.on ? '켜기' : '끄기'} ${scenarioName(ev.id)} · ${at}`;
}

// ─────────────────────────── 계획 편집 초안 ───────────────────────────

/** 편집 중인 작업지시 (수량은 입력 글자 그대로 둔다) */
export interface DraftOrder {
  /** 화면 키. 기준 지시는 'wo-<id>'라 계획끼리 같은 지시를 알아본다 (납기 공유) */
  key: string;
  id?: number;
  code?: string;
  variant: string;
  qty: string;
  /** 투입 중 (맨 앞 고정·수정 불가) */
  running?: boolean;
  released?: number;
}

export type DraftEvent =
  | { key: string; kind: 'down'; station: string; at: string; minutes: string }
  | { key: string; kind: 'pm'; station: string; at: string }
  | { key: string; kind: 'scenario'; id: string; on: boolean; at: string };

export interface DraftPlan {
  key: string;
  name: string;
  orders: Record<LineCode, DraftOrder[]>;
  events: DraftEvent[];
  autoFill: boolean;
}

/** 납기 입력: 지시 키 → '시작 뒤 몇 시간' 글자. 같은 지시면 모든 계획에 같은 납기 */
export type Dues = Record<string, string>;

let seq = 0;
export const uid = (p = 'k') => `${p}${++seq}`;

const LINE_CODES = LINES.map((l) => l.code as LineCode);
export const emptyLine: WhatIfBaseLine = { variant: null, orders: [] };
const baseLine = (base: WhatIfBase | undefined, line: LineCode) => base?.lines?.[line] ?? emptyLine;

/** 기준 상태 그대로의 계획 ('지금 계획') */
export function planFromBase(base: WhatIfBase, name = '지금 계획'): DraftPlan {
  const orders = Object.fromEntries(
    LINE_CODES.map((l) => [
      l,
      baseLine(base, l).orders.map((o) => ({ key: `wo-${o.id}`, id: o.id, code: o.code, variant: o.variant, qty: String(o.qty), running: o.status === 'RUNNING', released: o.released })),
    ]),
  ) as Record<LineCode, DraftOrder[]>;
  return { key: uid('p'), name, orders, events: [], autoFill: true };
}

/** 계획 복사 (사건·새 지시까지). 새 지시의 키는 그대로 둬 납기를 같이 쓴다 */
export function copyPlan(p: DraftPlan, name: string): DraftPlan {
  return {
    key: uid('p'),
    name,
    orders: Object.fromEntries(LINE_CODES.map((l) => [l, p.orders[l].map((o) => ({ ...o }))])) as Record<LineCode, DraftOrder[]>,
    events: p.events.map((e) => ({ ...e, key: uid('e') })),
    autoFill: p.autoFill,
  };
}

/** 새 계획 이름: '계획 2', '계획 3' … 겹치지 않게 */
export function nextPlanName(plans: DraftPlan[]): string {
  for (let n = plans.length + 1; ; n++) if (!plans.some((p) => p.name === `계획 ${n}`)) return `계획 ${n}`;
}

/** 라인 하나가 지금 계획(기준 상태)과 어떻게 다른가 */
export interface LineDiff {
  added: Set<string>;
  moved: Set<string>;
  /** 지시 키 → 원래 수량 */
  qty: Map<string, number>;
  /** 기준 순서 (1부터) */
  basePos: Map<string, number>;
  removed: WhatIfBaseLine['orders'];
  count: number;
}

export function lineDiff(base: WhatIfBaseLine, orders: DraftOrder[]): LineDiff {
  const basePos = new Map(base.orders.map((o, i) => [`wo-${o.id}`, i + 1]));
  const inPlan = new Set(orders.filter((o) => o.id != null).map((o) => o.id!));
  const kept = base.orders.filter((o) => inPlan.has(o.id)).map((o) => `wo-${o.id}`);
  const planKept = orders.filter((o) => o.id != null).map((o) => o.key);
  const moved = new Set(planKept.filter((k, i) => kept[i] !== k));
  const added = new Set(orders.filter((o) => o.id == null).map((o) => o.key));
  const qty = new Map<string, number>();
  for (const o of orders) {
    const b = o.id != null ? base.orders.find((x) => x.id === o.id) : undefined;
    if (b && Number(o.qty) !== b.qty) qty.set(o.key, b.qty);
  }
  const removed = base.orders.filter((o) => !inPlan.has(o.id));
  return { added, moved, qty, basePos, removed, count: added.size + moved.size + qty.size + removed.length };
}

/** 계획 전체의 바꾼 점 수 (라인별 지시 + 사건 + 자동 채우기 끔) */
export function planChanges(base: WhatIfBase | undefined, p: DraftPlan): { total: number; byLine: Record<LineCode, number> } {
  const byLine = Object.fromEntries(LINE_CODES.map((l) => [l, lineDiff(baseLine(base, l), p.orders[l]).count])) as Record<LineCode, number>;
  const total = Object.values(byLine).reduce((a, b) => a + b, 0) + p.events.length + (p.autoFill ? 0 : 1);
  return { total, byLine };
}

/** 납기 입력(시간) → 분. 비었거나 잘못이면 undefined */
export function dueMinOf(text: string | undefined): number | undefined {
  if (!text?.trim()) return undefined;
  const h = Number(text);
  return Number.isFinite(h) && h > 0 ? Math.round(h * 60) : undefined;
}

/** 새 지시 표시 이름: 서버가 붙이는 NEW-{line}-{n}과 같은 규칙 (라인 안 순서) */
export function newCode(line: LineCode, orders: DraftOrder[], key: string): string {
  const n = orders.filter((o) => o.id == null).findIndex((o) => o.key === key) + 1;
  return `NEW-${line}-${n}`;
}

function toEvent(e: DraftEvent): WhatIfEvent {
  if (e.kind === 'down') return { kind: 'down', station: e.station, atMin: Number(e.at), minutes: Number(e.minutes) };
  if (e.kind === 'pm') return { kind: 'pm', station: e.station, atMin: Number(e.at) };
  return { kind: 'scenario', id: e.id, on: e.on, atMin: Number(e.at) };
}

/**
 * 초안 → 요청. 지금 계획과 같은 라인(납기도 없는)은 보내지 않는다: 서버가 그 순간의 기준 상태 순서를 쓰므로
 * 미리 보기 뒤에 MES 작업지시가 바뀌어도(투입 끝·자동 계획) 어긋나지 않는다
 */
export function toScenarioInput(p: DraftPlan, base: WhatIfBase | undefined, dues: Dues): WhatIfScenarioInput {
  const orders: Partial<Record<LineCode, WhatIfOrder[]>> = {};
  for (const l of LINE_CODES) {
    const list = p.orders[l];
    const d = lineDiff(baseLine(base, l), list);
    const hasDue = list.some((o) => dueMinOf(dues[o.key]) != null);
    if (!d.count && !hasDue) continue;
    orders[l] = list.map((o) => {
      const dueMin = dueMinOf(dues[o.key]);
      return { ...(o.id != null ? { id: o.id, code: o.code } : {}), variant: o.variant, qty: Number(o.qty), ...(dueMin != null ? { dueMin } : {}) };
    });
  }
  return {
    name: p.name.trim(),
    ...(Object.keys(orders).length ? { orders } : {}),
    ...(p.events.length ? { events: p.events.map(toEvent) } : {}),
    autoFill: p.autoFill,
  };
}

const isInt = (s: string) => /^\d+$/.test(s.trim());

/** 실행 전에 막을 것 (서버 검증 4장과 같은 규칙을 화면에서 먼저 본다) */
export function planProblems(p: DraftPlan, idx: number, horizonH: number, dues: Dues): string[] {
  const out: string[] = [];
  const who = `${idx + 1}번 계획`;
  const name = p.name.trim();
  if (name.length < 1 || name.length > 30) out.push(`${who}: 이름은 1~30자입니다`);
  for (const l of LINE_CODES) {
    const list = p.orders[l];
    if (list.length > WHATIF_LIMITS.ordersPerLine) out.push(`${who} ${l}: 작업지시는 라인마다 ${WHATIF_LIMITS.ordersPerLine}건까지입니다`);
    list.forEach((o, i) => {
      const q = Number(o.qty);
      if (!isInt(o.qty) || q < WHATIF_LIMITS.qty.min || q > WHATIF_LIMITS.qty.max) out.push(`${who} ${l} ${i + 1}번째 지시: 수량은 ${WHATIF_LIMITS.qty.min}~${WHATIF_LIMITS.qty.max} 정수입니다`);
      const due = dues[o.key];
      if (due?.trim() && dueMinOf(due) == null) out.push(`${who} ${l} ${i + 1}번째 지시: 납기는 0보다 큰 시간입니다`);
    });
  }
  if (p.events.length > WHATIF_LIMITS.events) out.push(`${who}: 사건은 ${WHATIF_LIMITS.events}개까지입니다`);
  p.events.forEach((e, i) => {
    const at = Number(e.at);
    if (!isInt(e.at) || at >= horizonH * 60) out.push(`${who} 사건 ${i + 1}: 시작은 0 ~ ${horizonH * 60 - 1}분 (실행 시간 ${horizonH}시간 안)입니다`);
    if (e.kind === 'down' && (!isInt(e.minutes) || Number(e.minutes) < 1 || Number(e.minutes) > 720)) out.push(`${who} 사건 ${i + 1}: 고장 시간은 1~720분입니다`);
  });
  return out;
}

/** 사건 기본값: 지금 보고 있는 라인의 설비·시나리오로 시작 60분 뒤 */
export function newEvent(kind: DraftEvent['kind'], line: LineCode): DraftEvent {
  const l = LINES.find((x) => x.code === line)!;
  const main = l.stations.find((s) => !s.aux) ?? l.stations[0];
  if (kind === 'down') return { key: uid('e'), kind, station: main.code, at: '60', minutes: '60' };
  if (kind === 'pm') return { key: uid('e'), kind, station: (l.stations.find((s) => s.health) ?? main).code, at: '60' };
  return { key: uid('e'), kind, id: FACTORY.scenarios.find((s) => s.line === line)?.id ?? FACTORY.scenarios[0].id, on: true, at: '60' };
}
