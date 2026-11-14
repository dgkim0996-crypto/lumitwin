import {
  HEALTH_LEVEL_NAMES,
  POWER_MODE_NAMES,
  POWER_MODES,
  type EnergyReport,
  type HealthLevel,
  type HealthView,
  type LineCode,
  type PowerMode,
  type ShiftList,
  type ShiftReport,
  type StationHealthDetail,
} from '@lumitwin/shared';
import { API, api } from './api';

// ───────────── 조회 (P9 분석) ─────────────

export const fetchShifts = () => api.get<ShiftList>('/reports/shifts');
export const fetchShift = (key: string) => api.get<ShiftReport>(`/reports/shift?key=${encodeURIComponent(key)}`);
/** CSV 내려받기 주소 (같은 주소의 /api/v1 → MES) */
export const shiftCsvUrl = (key: string) => `${API}/reports/shift.csv?key=${encodeURIComponent(key)}`;

export type EnergyRange = { hours: number } | { from: string };
export function fetchEnergy(range: EnergyRange, line?: LineCode) {
  const q = new URLSearchParams();
  if ('hours' in range) q.set('hours', String(range.hours));
  else q.set('from', range.from);
  if (line) q.set('line', line);
  return api.get<EnergyReport>(`/energy?${q}`);
}

export const fetchHealth = () => api.get<HealthView>('/maintenance/health');
export const fetchHealthDetail = (station: string) => api.get<StationHealthDetail>(`/maintenance/health/${encodeURIComponent(station)}`);

// ───────────── 색·이름 ─────────────

/**
 * 소비 전력 구분 색 (범주형 고정 순서: 가동 → 대기 → 정지).
 * 어두운 차트 바탕(#0e141e)에서 dataviz 검증 통과 (밝기 띠·채도·색각 이웃 ΔE ≥ 17·대비 3:1)
 */
export const POWER_COLOR: Record<PowerMode, string> = { run: '#3987e5', idle: '#c98500', off: '#9085e9' };
export const POWER_LEGEND = POWER_MODES.map((m) => ({ label: POWER_MODE_NAMES[m], color: POWER_COLOR[m], shape: 'rect' as const }));

/** 상태 감시 등급 색 (상태색: 글자·점과 함께만 쓴다) */
export const HEALTH_COLOR: Record<HealthLevel, string> = {
  good: 'var(--color-run)',
  watch: 'var(--color-info)',
  warn: 'var(--color-warn)',
  danger: 'var(--color-down)',
};
export const HEALTH_SHORT: Record<HealthLevel, string> = { good: '양호', watch: '관찰', warn: '경고', danger: '위험' };
export const HEALTH_ORDER: Record<HealthLevel, number> = { danger: 0, warn: 1, watch: 2, good: 3 };
export { HEALTH_LEVEL_NAMES };

// ───────────── 숫자 ─────────────

/** kWh: 10 이상은 소수 1자리, 그 밑은 2자리 */
export function kwh(v: number | null | undefined, unit = true): string {
  if (v == null || !Number.isFinite(v)) return '-';
  const s = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('ko-KR') : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return unit ? `${s} kWh` : s;
}

/** 개당 kWh: 작은 값이 많아 유효숫자 3자리 */
export function perUnit(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${Number(v.toPrecision(3))} kWh/개`;
}

/** 시간 (가상): '23.5시간' · '45분' */
export function hoursText(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(h)) return '-';
  if (h < 1) return `${Math.round(h * 60)}분`;
  if (h >= 48) return `${(h / 24).toFixed(1)}일`;
  return `${h.toFixed(1)}시간`;
}
