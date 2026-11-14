import type { AttrDef, DefectDef, HealthDef, MeasureDef, SourceGrade, StationDef, TagDef, Term, WarmupDef } from '../types';

type TagOpts = Partial<Pick<TagDef, 'lsl' | 'usl' | 'idle' | 'tau' | 'digits' | 'note'>> & { terms?: [string, number][] };
type Opt = { digits?: number; note?: string };
/** 불량 처리 기준 (P9): 처리·수리 시간(분, 가상)·성공 확률 */
type Disp = Pick<DefectDef, 'disposition' | 'repairMin' | 'repairProb'>;

const terms = (list: [string, number][] = []): Term[] => list.map(([ref, coef]) => ({ ref, coef }));

/** 연속 태그 (온도·압력처럼 계속 변하는 값) */
export function ct(key: string, name: string, unit: string, nominal: number, sd: number, grade: SourceGrade, o: TagOpts = {}): TagDef {
  const { terms: t, ...rest } = o;
  return { key, name, unit, mode: 'continuous', nominal, sd, grade, ...rest, ...(t ? { terms: terms(t) } : {}) };
}

/** 사이클 태그 (한 개 가공할 때마다 기록되는 값) */
export function cy(key: string, name: string, unit: string, nominal: number, sd: number, grade: SourceGrade, o: TagOpts = {}): TagDef {
  const { terms: _t, ...rest } = o;
  return { key, name, unit, mode: 'cycle', nominal, sd, grade, ...rest };
}

/** 부품 속성 */
export function attr(key: string, name: string, unit: string, base: number, sd: number, t: [string, number][], grade: SourceGrade, o: Opt = {}): AttrDef {
  return { key, name, unit, base, sd, terms: terms(t), grade, ...o };
}

/** 검사 측정값 */
export function meas(
  key: string, name: string, unit: string, base: number, sd: number, t: [string, number][], defect: string, grade: SourceGrade,
  o: Opt & { lsl?: number; usl?: number } & Disp = {},
): MeasureDef {
  return { key, name, unit, base, sd, terms: terms(t), defect, grade, ...o };
}

/**
 * 사출기 재가동 초품: 10분 넘게 멈췄다 다시 돌리면 첫 3쇼트는 절반꼴로 불량 (온도·재료가 안정될 때까지).
 * 현장에서는 이 쇼트를 미리 버리거나(퍼지·시사출) 초품 검사로 거른다
 */
export function warmup(defect: string, o: Partial<Omit<WarmupDef, 'defect'>> = {}): WarmupDef {
  return { minHalt: 10, shots: 3, prob: 0.5, defect, grade: 'assumed', note: '재가동 직후 금형·실린더 온도 불안정 (수치는 가정)', ...o };
}

/** 불량 모드. drivers: [참조, 방향, 계수] */
export function defect(
  code: string, name: string, base: number, drivers: [string, 1 | -1 | 0, number][], grade: SourceGrade,
  o: { latent?: boolean; note?: string } & Disp = {},
): DefectDef {
  return { code, name, base, drivers: drivers.map(([ref, dir, k]) => ({ ref, dir, k })), grade, ...o };
}

/**
 * 불량 처리 기준 (P9). `defect()`·`meas()`의 옵션에 펼쳐 넣는다: `{ ...fix('REWORK', 4, 0.95), note }`.
 * 같은 불량 코드는 공장 전체에서 처리 기준이 하나여야 한다 (mes.ts defectDefOf가 코드로 첫 정의를 찾는다)
 */
export function fix(disposition: NonNullable<Disp['disposition']>, repairMin?: number, repairProb?: number): Disp {
  return { disposition, ...(repairMin != null ? { repairMin } : {}), ...(repairProb != null ? { repairProb } : {}) };
}

/**
 * 소비 전력 (kW, P9 에너지). run = 가공 중 · idle = 대기·막힘·셋업 · off = 정지·고장.
 * 압축공기·냉각수·질소 같은 공용 유틸리티는 빼고 설비 자체 전기만 센다
 */
export function power(run: number, idle: number, off: number, grade: SourceGrade, note?: string): NonNullable<StationDef['power']> {
  return { run, idle, off, grade, ...(note ? { note } : {}) };
}

/**
 * 상태 감시 기준 (P9 예지 보전). vib = 진동 RMS(mm/s) · cur = 구동 전류(A) · temp = 베어링·모터 온도(°C), 모두 신품값.
 * wearHours = 새것에서 마모 끝까지 가동 시간(가상 시간). 실제 수명(가정)을 1/100로 줄여 시연에서 마모가 보이게 했다
 */
export function health(
  vib: number, cur: number, temp: number, wearHours: number, part: string, cls: HealthDef['cls'], grade: SourceGrade, note?: string,
): HealthDef {
  return { vib, cur, temp, wearHours, part, cls, grade, ...(note ? { note } : {}) };
}
