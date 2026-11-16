// What-if 계획 시뮬레이션 (P11) 공용 계약.
// 지금 공장 상태(작업지시·재공·고장·마모·공정 이상)를 복사해 시뮬레이터를 최대 속도로 여러 번 돌리고,
// 계획 몇 개(작업지시 순서·고장·보전·공정 이상)의 생산량·OEE·납기·에너지를 분포로 비교한다.
// 화면(입력·결과), 서버(기준 상태·집계), 시뮬레이터(sim/lumisim/whatif.py 입출력)가 이 파일 하나를 본다.

import type { LineCode, StationState } from './types';

// ─────────────────────────── 한도·기본값 ───────────────────────────

export const WHATIF_LIMITS = {
  /** 내다볼 시간 (가상, 시) */
  horizonH: { min: 1, max: 24 },
  /** 계획마다 반복 횟수 (난수 씨앗만 바꿔 돌린다) */
  reps: { min: 1, max: 10 },
  /** 비교할 계획 수 (첫째가 기준) */
  scenarios: { min: 1, max: 3 },
  /** 계획 하나에 넣는 사건 수 */
  events: 12,
  /** 라인 하나의 작업지시 수 */
  ordersPerLine: 12,
  qty: { min: 1, max: 2000 },
  /** 한 번 실행의 가상 시간 총량 (계획 수 × 반복 × 시간). 넘으면 거절 (2 OCPU 서버에서 1분 안팎) */
  budgetH: 240,
  /** 계산이 이보다 오래 걸리면 끊는다 (초, 실제) */
  timeoutSec: 300,
} as const;

export const WHATIF_DEFAULTS = { horizonH: 8, reps: 5 } as const;

// ─────────────────────────── 입력 ───────────────────────────

/** 계획에 넣는 사건. atMin = 시작에서 몇 분 뒤 (가상) */
export type WhatIfEvent =
  /** 설비 고장: minutes 동안 멈췄다가 수리된다 */
  | { kind: 'down'; station: string; atMin: number; minutes: number }
  /** 계획·예지 보전 실시 (보전 시간은 공장 정의 pmMinutes, 끝나면 마모가 줄어든다) */
  | { kind: 'pm'; station: string; atMin: number }
  /** 공정 이상 시나리오 켜기·끄기 (factory.scenarios의 id) */
  | { kind: 'scenario'; id: string; on: boolean; atMin: number };

export type WhatIfEventKind = WhatIfEvent['kind'];

export const WHATIF_EVENT_NAMES: Record<WhatIfEventKind, string> = {
  down: '설비 고장',
  pm: '보전 실시',
  scenario: '공정 이상',
};

/** 계획 안의 작업지시 한 건 */
export interface WhatIfOrder {
  /** MES 작업지시 id. 이 계획에서 새로 더한 가상 지시면 없다 */
  id?: number;
  /** 화면 표시용 (없으면 서버가 'NEW-1'처럼 붙인다) */
  code?: string;
  variant: string;
  qty: number;
  /** 납기: 시작에서 몇 분 뒤까지 마쳐야 하나 (선택, 가상 분) */
  dueMin?: number;
}

/** 비교할 계획 하나 */
export interface WhatIfScenarioInput {
  name: string;
  /** 라인별 작업지시 순서 (지금 투입 중인 지시가 있으면 그 지시가 맨 앞이어야 한다). 빠진 라인은 지금 계획 그대로 */
  orders?: Partial<Record<LineCode, WhatIfOrder[]>>;
  events?: WhatIfEvent[];
  /** 계획이 바닥나면 자동 계획처럼 기종을 번갈아 채운다 (기본 true). false면 그 라인은 투입을 멈춘다 */
  autoFill?: boolean;
}

/** POST /whatif/runs */
export interface WhatIfRequest {
  horizonH: number;
  reps: number;
  /** live = 지금 공장 상태에서 시작 · clean = 초기화한 공장(재공 절반·마모 무작위)에서 시작 */
  base: WhatIfBaseSource;
  /** 첫째가 비교 기준 (보통 '지금 계획' = 바꾼 것 없음) */
  scenarios: WhatIfScenarioInput[];
}

export type WhatIfBaseSource = 'live' | 'clean';

// ─────────────────────────── 기준 상태 (서버가 만들어 시뮬레이터에 넘긴다) ───────────────────────────

/** 기준 상태의 작업지시 (MES에서 가져온 것) */
export interface WhatIfBaseOrder {
  id: number;
  code: string;
  variant: string;
  qty: number;
  status: 'RUNNING' | 'PLANNED';
  /** 이미 투입한 수 (RUNNING만 의미) */
  released: number;
  /** 이미 끝낸 양품 수 */
  done: number;
}

export interface WhatIfBaseLine {
  /** 라인에 걸린 기종 (투입 중인 작업지시 또는 마지막 기종) */
  variant: string | null;
  /** 투입 순서대로 (RUNNING이 있으면 맨 앞) */
  orders: WhatIfBaseOrder[];
}

export interface WhatIfBaseStation {
  /** 기준 시각의 상태. DOWN = 고장 중 · PM = 보전 중 · RUN 등은 그대로 이어서 돈다 */
  state: StationState | 'PM';
  /** 마모 추정 0~1 (예지 보전 설비만): 평활 진동으로 마모 모델을 거꾸로 풀어 얻는다 */
  wear?: number;
}

export interface WhatIfBase {
  source: WhatIfBaseSource;
  /** 가상 시작 시각 (라이브면 지금 가상 시각, clean이면 서버 시각) */
  startAt: string;
  lines: Record<LineCode, WhatIfBaseLine>;
  /** `${line}.${step}` → 출력 버퍼 개수 (live만) */
  buffers?: Record<string, number>;
  /** 이송 도착 버퍼 (live만). AMR이 싣고 가는 중인 묶음은 도착 버퍼에 더해 둔다 */
  inbound?: Record<string, number>;
  /** 설비 안 개체: 설비 코드 → 슬롯마다 [묶음 개수, 남은 가공 초] (live만, 시뮬레이터 상태 메시지 그대로) */
  inproc?: Record<string, [number, number][]>;
  /** 설비 코드 → 상태·마모 (live만, 고장·보전 중이거나 마모를 아는 설비) */
  stations?: Record<string, WhatIfBaseStation>;
  /** 켜져 있는 공정 이상과 시작한 지 몇 분 됐는지 (live만) */
  scenarios?: { id: string; elapsedMin: number }[];
  /** 기준 상태를 만들며 어림한 것 (화면에 그대로 보인다) */
  notes: string[];
}

// ─────────────────────────── 시뮬레이터 입출력 (sim/lumisim/whatif.py) ───────────────────────────

/**
 * 서버 → 시뮬레이터 (표준 입력 JSON 한 덩어리).
 * orders는 서버가 모든 라인을 채워 보낸다 (계획에서 빠진 라인 = 기준 상태 순서). released는 투입 중인 지시만 0보다 크다
 */
export interface WhatIfSimInput {
  horizonSec: number;
  reps: number;
  /** 반복 r의 씨앗 = seed + r. 계획끼리 같은 씨앗을 써서 운(고장 시각·불량)을 맞춘다 (공통 난수) */
  seed: number;
  /** 동시에 돌릴 프로세스 수 */
  workers: number;
  base: WhatIfBase;
  scenarios: {
    orders: Record<LineCode, (WhatIfOrder & { id: number; code: string; released: number })[]>;
    events: WhatIfEvent[];
    autoFill: boolean;
  }[];
}

/** 시뮬레이터 → 서버 (표준 출력, 줄마다 JSON 하나) */
export type WhatIfSimLine =
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; runs: WhatIfRep[] }
  | { type: 'error'; message: string };

/** 반복 1회의 원자료. KPI(OEE·에너지)는 서버가 라이브 화면과 같은 함수로 계산한다 */
export interface WhatIfRep {
  scenario: number;
  rep: number;
  seed: number;
  /** 계산에 걸린 실제 시간 (ms) */
  wallMs: number;
  stations: Record<string, {
    ok: number;
    ng: number;
    /** 상태별 시간 (초, 가상) */
    sec: Partial<Record<StationState, number>>;
    failures: number;
    /** 끝났을 때 마모 (예지 보전 설비만) */
    wearEnd?: number;
  }>;
  lines: Record<LineCode, {
    /** 최종 공정 양품 수 */
    out: number;
    scrap: number;
    repaired: number;
    changeovers: number;
    /** 시작부터 h시간까지 누적 양품 수 (길이 = ceil(horizonH)) */
    hourly: number[];
  }>;
  /** 작업지시별 진행 (자동 계획이 채운 지시는 id가 음수) */
  orders: {
    line: LineCode;
    id: number;
    code: string;
    variant: string;
    qty: number;
    released: number;
    done: number;
    scrap: number;
    /** 투입을 마치고 마지막 개체가 최종 공정을 나온 시각 (초, 가상). 시간 안에 못 끝내면 null */
    finishedSec: number | null;
  }[];
}

// ─────────────────────────── 결과 (서버가 집계해 화면에 준다) ───────────────────────────

/** 반복 결과의 분포 */
export interface WhatIfDist {
  mean: number;
  p10: number;
  p90: number;
  min: number;
  max: number;
}

export interface WhatIfLineKpi {
  line: LineCode;
  out: WhatIfDist;
  /** 0~1 (라인 OEE = 라이브 화면과 같은 lineOee) */
  oee: WhatIfDist;
  availability: WhatIfDist;
  performance: WhatIfDist;
  quality: WhatIfDist;
  scrap: WhatIfDist;
  changeovers: WhatIfDist;
  /** 라인 설비 상태 시간 합 (분) */
  downMin: WhatIfDist;
  setupMin: WhatIfDist;
  kwh: WhatIfDist;
  /** 양품 1개당 전력량 (kWh, 양품이 없으면 0) */
  kwhPerUnit: WhatIfDist;
  /** 시간별 누적 양품 (평균·10·90 백분위) */
  hourly: { mean: number[]; p10: number[]; p90: number[] };
  /** 이 라인에서 가장 오래 멈춘 설비 (고장+셋업+정지, 평균 분) */
  topLoss: { station: string; minutes: number } | null;
}

export interface WhatIfOrderKpi {
  line: LineCode;
  /** MES 작업지시 id (가상 지시는 없음, 자동 계획이 채운 지시는 auto) */
  id?: number;
  auto?: boolean;
  code: string;
  variant: string;
  qty: number;
  dueMin?: number;
  /** 시간 안에 끝낸 반복 수 / 전체 반복 수 */
  finishedReps: number;
  /** 끝낸 반복들의 끝난 시각 (시작에서 분). 하나도 못 끝냈으면 null */
  finishMin: WhatIfDist | null;
  /** 납기를 지킨 반복 수 (dueMin이 있을 때) */
  onTimeReps?: number;
  /** 계산식 예상 (planner.schedule: 투입 간격 × 수량 + 셋업). 시뮬레이션과 비교하려고 함께 준다 */
  planEndMin: number | null;
  /** 시간 끝까지 끝낸 양품 수 평균 */
  doneMean: number;
}

export interface WhatIfScenarioResult {
  name: string;
  events: WhatIfEvent[];
  autoFill: boolean;
  lines: WhatIfLineKpi[];
  total: { out: WhatIfDist; kwh: WhatIfDist };
  orders: WhatIfOrderKpi[];
  /** 고장이 많이 난 설비 (반복 평균 횟수, 상위 5) */
  failures: { station: string; mean: number }[];
}

export interface WhatIfResult {
  horizonH: number;
  reps: number;
  seeds: number[];
  /** 시뮬레이터 계산 시간 합 (ms, 실제) · 전체 걸린 시간 (ms) */
  computeMs: number;
  elapsedMs: number;
  scenarios: WhatIfScenarioResult[];
}

export type WhatIfStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';

export const WHATIF_STATUS_NAMES: Record<WhatIfStatus, string> = {
  QUEUED: '대기',
  RUNNING: '계산 중',
  DONE: '완료',
  FAILED: '실패',
};

/** GET /whatif/runs/:id */
export interface WhatIfRunView {
  id: number;
  status: WhatIfStatus;
  progress: { done: number; total: number };
  /** 실제 시각 */
  createdAt: string;
  createdBy: string | null;
  /** 기준 상태의 가상 시작 시각 */
  vStartAt: string;
  request: WhatIfRequest;
  base: WhatIfBase;
  result: WhatIfResult | null;
  error: string | null;
}

/** GET /whatif/runs (목록: 결과 본문 없이) */
export type WhatIfRunSummary = Omit<WhatIfRunView, 'base' | 'result'> & {
  /** 계획별 전체 양품 평균 (완료된 것만) */
  outMeans: number[] | null;
};

/** POST /whatif/runs/:id/apply: 계획 하나의 작업지시 순서를 MES 대기 순서에 반영한다 */
export interface WhatIfApply {
  scenario: number;
  line: LineCode;
}

export interface WhatIfApplyResult {
  line: LineCode;
  /** 순서를 바꾼 대기 작업지시 id */
  reordered: number[];
  /** 새로 만든 작업지시 id (계획에서 더한 가상 지시) */
  created: number[];
  /** 계획에서 뺐지만 MES에는 남아 있는 대기 지시 (자동으로 중단하지 않는다) */
  untouched: number[];
}

// ─────────────────────────── 집계 도우미 (서버·화면·테스트 공용) ───────────────────────────

/** 백분위 (선형 보간). xs가 비면 0 */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export function dist(xs: number[]): WhatIfDist {
  if (!xs.length) return { mean: 0, p10: 0, p90: 0, min: 0, max: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean, p10: percentile(xs, 0.1), p90: percentile(xs, 0.9), min: Math.min(...xs), max: Math.max(...xs) };
}

/** 요청 하나가 돌리는 가상 시간 총량 = 시간 × 반복 × 계획 수 (한도 budgetH와 비교) */
export function whatIfBudgetH(r: Pick<WhatIfRequest, 'horizonH' | 'reps' | 'scenarios'>): number {
  return r.horizonH * r.reps * r.scenarios.length;
}
