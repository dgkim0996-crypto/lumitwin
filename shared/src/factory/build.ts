import type { AttrDef, DefectDef, MeasureDef, SourceGrade, TagDef, Term } from '../types';

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

/** 불량 모드. drivers: [참조, 방향, 계수] */
export function defect(
  code: string, name: string, base: number, drivers: [string, 1 | -1 | 0, number][], grade: SourceGrade,
  o: { latent?: boolean; note?: string } = {},
): DefectDef {
  return { code, name, base, drivers: drivers.map(([ref, dir, k]) => ({ ref, dir, k })), grade, ...o };
}
