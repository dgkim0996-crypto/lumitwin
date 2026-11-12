import type { AttrDef, DefectDef, MeasureDef, SourceGrade, TagDef, Term, WarmupDef } from '../types';

type TagOpts = Partial<Pick<TagDef, 'lsl' | 'usl' | 'idle' | 'tau' | 'digits' | 'note'>> & { terms?: [string, number][] };
type Opt = { digits?: number; note?: string };

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
  o: Opt & { lsl?: number; usl?: number } = {},
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
  o: { latent?: boolean; note?: string } = {},
): DefectDef {
  return { code, name, base, drivers: drivers.map(([ref, dir, k]) => ({ ref, dir, k })), grade, ...o };
}
