// 예지 보전 순수 계산: 가동 표본 고르기, 진동 평활, 직선 맞춤, 남은 수명(RUL) 외삽, PDM 알람 무장, 건강 지수.

import {
  HEALTH_RUN_RATIO,
  HEALTH_SMOOTH_N,
  PDM_REARM_RATIO,
  RUL_MIN_SAMPLES,
  RUL_MIN_T,
  RUL_WINDOW_H,
  type Rul,
} from '@lumitwin/shared';

const HOUR = 3_600_000;

/** 메모리에 들고 있는 표본 하나 (t = 가상 시각 ms) */
export interface Sample {
  t: number;
  vib: number;
  cur: number;
  temp: number;
}

export interface Zones {
  ab: number;
  bc: number;
  cd: number;
}

/** 가동 중 표본만: 멈춘 동안은 진동이 정상값보다 훨씬 작게 온다 */
export function runningOnly<T extends { vib: number }>(samples: T[], baseVib: number): T[] {
  const min = baseVib * HEALTH_RUN_RATIO;
  return samples.filter((s) => s.vib >= min);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 등급을 정할 진동: 최근 가동 표본 n개의 중앙값 (잡음 한 점에 흔들리지 않게) */
export function smoothedVib(samples: Sample[], baseVib: number, n = HEALTH_SMOOTH_N): number | null {
  const run = runningOnly(samples, baseVib);
  return median(run.slice(-n).map((s) => s.vib));
}

/** 최소제곱 직선 y = a + b·x 와 기울기의 표준오차 */
export function fitLine(xs: number[], ys: number[]): { slope: number; intercept: number; se: number; n: number } | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx <= 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (intercept + slope * xs[i])) ** 2;
  const se = Math.sqrt(sse / (n - 2) / sxx);
  return { slope, intercept, se, n };
}

/**
 * 남은 수명 (가상 시간): 마지막 보전 뒤, 최근 RUL_WINDOW_H 시간의 가동 표본으로 진동–시각 직선을 맞추고
 * 지금 맞춘 값에서 B/C(경고)·C/D(위험) 경계까지 기울기로 나눈다. 이미 넘었으면 0.
 * 표본이 RUL_MIN_SAMPLES보다 적거나, 기울기가 0 이하이거나 표준오차의 RUL_MIN_T배보다 작으면(잡음과 구별 안 됨) null.
 * 마모는 가동 시간에 따라 쌓이고 진동은 마모의 제곱으로 오르므로(가속), 직선 외삽은 실제보다 길게 잡는 쪽으로 틀린다
 */
export function estimateRul(samples: Sample[], o: { baseVib: number; zones: Zones; nowMs: number; sinceMs?: number | null }): { rul: Rul | null; note: string } {
  const from = Math.max(o.sinceMs ?? -Infinity, o.nowMs - RUL_WINDOW_H * HOUR);
  const run = runningOnly(samples, o.baseVib).filter((s) => s.t >= from && s.t <= o.nowMs);
  if (run.length < RUL_MIN_SAMPLES) return { rul: null, note: `표본 부족 (가동 표본 ${run.length}/${RUL_MIN_SAMPLES})` };
  const t0 = run[0].t;
  const fit = fitLine(
    run.map((s) => (s.t - t0) / HOUR),
    run.map((s) => s.vib),
  );
  if (!fit) return { rul: null, note: '추세를 맞출 수 없음' };
  if (fit.slope <= 0 || fit.slope < RUL_MIN_T * fit.se) return { rul: null, note: '진동 상승 추세 없음 (잡음 수준)' };
  const xNow = (run[run.length - 1].t - t0) / HOUR;
  const cur = fit.intercept + fit.slope * xNow;
  const to = (edge: number) => Math.max(0, (edge - cur) / fit.slope);
  return {
    rul: { warnH: round1(to(o.zones.bc)), dangerH: round1(to(o.zones.cd)), slopePerH: Math.round(fit.slope * 10_000) / 10_000, n: fit.n },
    note: `최근 ${run.length}개 가동 표본의 직선 추세`,
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** 알람 무장 상태: 0 = 양호, 1 = 경고(B/C) 알람 냄, 2 = 위험(C/D) 알람 냄 */
export type Armed = 0 | 1 | 2;

/**
 * PDM 알람: 진동이 B/C 경계를 넘으면 경고, C/D를 넘으면 위험을 등급이 오를 때 한 번씩 낸다 (0에서 바로 위험이면 위험 하나만).
 * 경계의 PDM_REARM_RATIO 밑으로 내려가면(보전 뒤) 그 등급을 다시 무장한다
 */
export function pdmStep(armed: Armed, vib: number, z: Zones): { armed: Armed; raise: 'warn' | 'critical' | null } {
  const level: Armed = vib >= z.cd ? 2 : vib >= z.bc ? 1 : 0;
  if (level > armed) return { armed: level, raise: level === 2 ? 'critical' : 'warn' };
  let a = armed;
  if (a === 2 && vib < z.cd * PDM_REARM_RATIO) a = 1;
  if (a === 1 && vib < z.bc * PDM_REARM_RATIO) a = 0;
  return { armed: a, raise: null };
}

/** 지금 진동으로 무장 상태를 정한다 (서버를 다시 띄울 때: 이미 넘은 등급의 알람은 다시 내지 않는다) */
export function armedOf(vib: number | null, z: Zones): Armed {
  if (vib == null) return 0;
  return vib >= z.cd ? 2 : vib >= z.bc ? 1 : 0;
}

/** 건강 지수 0~1 = 1 − (진동 − 정상값) ÷ (C/D 경계 − 정상값) */
export function healthIndex(vib: number | null, baseVib: number, cd: number): number | null {
  if (vib == null || cd <= baseVib) return null;
  return Math.round(Math.max(0, Math.min(1, 1 - (vib - baseVib) / (cd - baseVib))) * 1000) / 1000;
}

/** 추이 그래프용: 점이 max개를 넘으면 이웃끼리 평균해 줄인다 */
export function decimate(points: { t: number; vib: number }[], max: number): { t: number; vib: number }[] {
  if (points.length <= max) return points;
  const k = Math.ceil(points.length / max);
  const out: { t: number; vib: number }[] = [];
  for (let i = 0; i < points.length; i += k) {
    const g = points.slice(i, i + k);
    out.push({ t: g[g.length - 1].t, vib: g.reduce((a, p) => a + p.vib, 0) / g.length });
  }
  return out;
}
