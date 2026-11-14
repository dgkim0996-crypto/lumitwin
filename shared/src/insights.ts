// 분석 (P9) 조회 API 응답 형태: 교대별 일보, 에너지, 예지 보전(상태 감시).
// 계산은 서버(server/src/insights)가 DB 기록으로 한다. 여기에는 화면과 서버가 같이 보는 이름표·기준과 응답 형태만 둔다.

import type { ChangeCategory, InspectionType, InterlockCode, Oee } from './live';
import type { HealthLevel, ShiftCode, WoStatus } from './mes';
import type { LineCode, SourceGrade, StationState } from './types';

// ─────────────────────────── 에너지 ───────────────────────────

/** 소비 전력 구분: run = 가공 중 · idle = 대기·막힘·셋업 · off = 정지·고장 (StationDef.power와 같은 뜻) */
export type PowerMode = 'run' | 'idle' | 'off';
export const POWER_MODES: readonly PowerMode[] = ['run', 'idle', 'off'];
export const POWER_MODE_NAMES: Record<PowerMode, string> = { run: '가동', idle: '대기', off: '정지' };
export const POWER_MODE_DESC: Record<PowerMode, string> = {
  run: '가공 중 (RUN)',
  idle: '대기·막힘·셋업 (IDLE·BLOCKED·SETUP): 히터·유압·진공을 켜 둔 채 기다린다',
  off: '정지·고장 (STOP·DOWN): 제어 전원·대기 부하만',
};

/** 설비 상태 → 소비 전력 구분 */
export function powerMode(state: StationState): PowerMode {
  if (state === 'RUN') return 'run';
  if (state === 'STOP' || state === 'DOWN') return 'off';
  return 'idle';
}

/** 전력량 (kWh) */
export interface Kwh {
  run: number;
  idle: number;
  off: number;
  total: number;
}

export interface StationEnergy extends Kwh {
  station: string;
  line: LineCode;
  /** 공장 정의의 소비 전력 (kW). 없으면 null: 자료 없음, 합계에서 빠진다 */
  kw: { run: number; idle: number; off: number; grade: SourceGrade } | null;
  /** 구분별 시간 (시간, 가상) */
  hours: { run: number; idle: number; off: number };
  /** 이 설비가 구간 안에 양품으로 처리한 수 */
  ok: number;
  /** 개당 전력량 (kWh/개) = 전력량 ÷ 양품 처리 수 */
  perUnit: number | null;
  /** 대기 전력 비중 = 대기 전력량 ÷ 전체 전력량 */
  idleShare: number | null;
}

export interface LineEnergy extends Kwh {
  line: LineCode;
  /** 최종 공정 양품 (완성품) */
  good: number;
  /** 완성품 1개당 전력량 (kWh/개) = 라인 전력량 ÷ 완성품 */
  perUnit: number | null;
  idleShare: number | null;
  /** 계산에 들어간 설비 수와 소비 전력 정의가 없어 빠진 설비 */
  stations: number;
  missing: string[];
}

/** 시간대 한 칸 (kWh). partial = 아직 끝나지 않았거나 구간 끝에 잘린 칸 */
export interface EnergyBucket {
  t: string;
  end: string;
  run: number;
  idle: number;
  off: number;
  partial: boolean;
}

export interface EnergyReport {
  runId: number | null;
  /** 실제로 센 구간 (실행 시작·지금으로 자른 것) */
  from: string;
  to: string;
  now: string | null;
  runStartedAt: string | null;
  /** 시간대 칸 크기 (시간) */
  bucketHours: number;
  total: Kwh & { idleShare: number | null };
  lines: LineEnergy[];
  stations: StationEnergy[];
  hourly: EnergyBucket[];
  /** 소비 전력 정의가 없는 설비 (계산에서 빠짐) */
  missing: string[];
}

// ─────────────────────────── 교대 일보 ───────────────────────────

export interface ShiftOption {
  key: string;
  code: ShiftCode;
  /** 화면 이름: '11-13 주간' */
  name: string;
  date: string;
  start: string;
  end: string;
  /** 지금 진행 중인 교대 */
  current: boolean;
}

export interface ShiftList {
  runId: number | null;
  runStartedAt: string | null;
  now: string | null;
  /** 새것부터 */
  shifts: ShiftOption[];
}

/** 교대 중에 돌았던 작업지시 한 건. 누계는 작업지시 전체, input·good은 이 교대 몫 */
export interface ShiftOrderRow {
  id: number;
  code: string;
  variant: string;
  qty: number;
  status: WoStatus;
  released: number;
  doneQty: number;
  scrapQty: number;
  /** 이 교대에 투입 공정을 지난 수 (재검사 제외) */
  input: number;
  /** 이 교대에 최종 공정을 양품으로 지난 수 */
  good: number;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ShiftCount {
  code: string;
  name: string;
  count: number;
  stations: string[];
}

/** 비가동 사유 한 줄 (고장·셋업·정지) */
export interface ShiftDowntime {
  state: StationState;
  reason: string;
  /** 설비 시간 합 (초) */
  sec: number;
  /** 구간 수 */
  count: number;
  stations: string[];
}

export interface ShiftLineReport {
  line: LineCode;
  /** 택트 기준 목표 = 교대 중 실행 시간 ÷ 택트 (계획 정지 포함한 상한) */
  target: number;
  orders: ShiftOrderRow[];
  /** 투입 공정을 지난 수 (재검사 제외) */
  input: number;
  /** 생산 OK = 최종 공정 양품 */
  ok: number;
  /** 모든 공정의 불량 판정 수 (재검사 불합격 포함) */
  ng: number;
  /** 폐기 = 제품 경로 밖 불량(바로 버림) + 불량 처리 폐기·수리 실패 + Hold 폐기 */
  scrap: number;
  /** 직행률 = 공정별 첫 판정 합격률의 곱 (재검사 제외) */
  fpy: number | null;
  /** 설비 시간 합 기준 (6대 로스 화면과 같은 정의) */
  oee: Oee | null;
  downtime: ShiftDowntime[];
  defects: ShiftCount[];
  ncr: { opened: number; closed: number; openAtEnd: number };
  changes: { total: number; byCategory: Record<ChangeCategory, number>; faNg: number };
  inspections: Record<InspectionType, number> & { ng: number };
  interlock: { ng: number; wait: number; byCode: Partial<Record<InterlockCode, number>> };
  energy: { kwh: number | null; perUnit: number | null; missing: number };
}

export interface ShiftReport {
  runId: number;
  key: string;
  code: ShiftCode;
  name: string;
  date: string;
  start: string;
  end: string;
  /** 실제로 센 구간 (실행 시작·지금으로 자른 것) */
  from: string;
  to: string;
  current: boolean;
  now: string | null;
  lines: ShiftLineReport[];
}

/** 교대 이름: '11-13 주간' */
export function shiftLabel(date: string, code: ShiftCode): string {
  return `${date.slice(5)} ${code === 'D' ? '주간' : '야간'}`;
}

// ─────────────────────────── 예지 보전 (상태 감시) ───────────────────────────

/**
 * 진동이 정상값(HealthDef.vib)의 이 비율 밑이면 멈춘 동안의 표본으로 보고 추세·등급에서 뺀다.
 * 시뮬레이터는 멈춰 있으면 진동을 작게 보낸다 (가정값, assumed)
 */
export const HEALTH_RUN_RATIO = 0.6;
/** 등급은 최근 가동 표본 이만큼의 중앙값으로 정한다 (잡음 한 점으로 알람이 튀지 않게) */
export const HEALTH_SMOOTH_N = 5;
/** 남은 수명 추정: 마지막 보전 뒤, 최근 이 시간(가상) 안의 가동 표본으로 직선을 맞춘다 */
export const RUL_WINDOW_H = 6;
/** 남은 수명 추정에 필요한 최소 표본 수 (가상 1분 간격이면 30분) */
export const RUL_MIN_SAMPLES = 30;
/** 기울기가 표준오차의 이 배수보다 작으면 '추세 없음'으로 본다 */
export const RUL_MIN_T = 2;
/** 알람 다시 무장: 진동이 경계의 이 비율 밑으로 내려가야 같은 등급 알람을 다시 낸다 (경계에서 깜빡임 방지) */
export const PDM_REARM_RATIO = 0.9;

export interface HealthReading {
  t: string;
  vib: number;
  cur: number;
  temp: number;
}

/** 남은 수명 (가상 시간). 이미 넘었으면 0 */
export interface Rul {
  /** B/C 경계(경고)까지 */
  warnH: number;
  /** C/D 경계(위험)까지 */
  dangerH: number;
  /** 진동 추세 (mm/s per 시간) */
  slopePerH: number;
  /** 맞춘 표본 수 */
  n: number;
}

export interface StationHealth {
  station: string;
  line: LineCode;
  /** 닳는 부위 */
  part: string;
  cls: 'I' | 'II' | 'III';
  /** 진동 구역 경계 (mm/s) */
  zones: { ab: number; bc: number; cd: number };
  /** 새것일 때 값 */
  base: { vib: number; cur: number; temp: number };
  grade: SourceGrade;
  latest: HealthReading | null;
  /** 등급을 정한 진동 (최근 가동 표본 중앙값). 가동 표본이 없으면 null */
  vib: number | null;
  level: HealthLevel | null;
  /** 건강 지수 0~1 = 1 − (진동 − 정상값) ÷ (C/D 경계 − 정상값) */
  index: number | null;
  /** 최근 진동 추이 (가동 표본, 오래된 것부터, 최대 120점) */
  trend: { t: string; vib: number }[];
  /** 남은 수명. 표본이 적거나 추세가 없으면 null (rulNote에 이유) */
  rul: Rul | null;
  rulNote: string;
  /** 마지막 보전 (예방·예지 보전 또는 고장 수리 끝난 시각). 이번 실행에서 없으면 null */
  lastMaint: { kind: 'pm' | 'repair'; at: string } | null;
  /** 이번 실행에서 받은 표본 수 (메모리에 들고 있는 것) */
  samples: number;
}

export interface HealthView {
  t: string | null;
  runStartedAt: string | null;
  /** 상태 감시 정의(health)가 있는 설비만 */
  stations: StationHealth[];
  /** 상태 감시 정의가 없는 설비 수 */
  unmonitored: number;
}

export interface StationHealthDetail extends StationHealth {
  /** 이번 실행의 표본 전체 (오래된 것부터, 최대 1440점 = 가상 하루) */
  history: HealthReading[];
}
