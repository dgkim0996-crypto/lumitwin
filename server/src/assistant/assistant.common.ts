import { LINES, STATIONS, type AssistantRef, type LineCode, type StationState } from '@lumitwin/shared';

// 도구 실행기(assistant.tools.ts)와 실행 MES 도구(assistant.mes-tools.ts)가 같이 쓰는 입력 검사·표기 도우미

/** 도구 하나를 실행한 결과. data는 모델에게, summary·refs는 화면에 간다 */
export interface ToolOutcome {
  ok: boolean;
  data: unknown;
  summary: string;
  refs: AssistantRef[];
}

export type Input = Record<string, unknown>;
export type Parsed<T> = { ok: true; v: T } | { ok: false; error: string };

export const STATE_NAMES: Record<StationState, string> = {
  RUN: '가동', IDLE: '투입 대기', BLOCKED: '배출 대기', DOWN: '고장', SETUP: '셋업', STOP: '계획 정지',
};
export const LINE_CODES = LINES.map((l) => l.code);

export const pct = (v: number) => Math.round(v * 1000) / 10;
export const r1 = (v: number) => Math.round(v * 10) / 10;
export const r2 = (v: number) => Math.round(v * 100) / 100;

/** 가상 시각을 한국 시간 'MM-DD HH:mm'으로 */
export function kst(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(Date.parse(iso) + 9 * 3_600_000);
  return d.toISOString().slice(5, 16).replace('T', ' ');
}

/** iso부터 nowMs까지 흐른 분 (가상). 시각을 모르면 null */
export function minutesSince(iso: string | null | undefined, nowMs: number): number | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 60_000)) : null;
}

export const stationRef = (code: string): AssistantRef => ({ kind: 'station', id: code, label: `${code} ${STATIONS[code]?.name ?? ''}`.trim() });
export const pageRef = (id: string, label: string): AssistantRef => ({ kind: 'page', id, label });

/** 코드·이름·이름 일부로 설비를 찾는다. 여러 개가 비슷하면 후보를 돌려준다 */
export function resolveStation(q: string): { code: string } | { error: string; candidates: string[] } {
  const s = q.trim();
  const up = s.toUpperCase();
  if (STATIONS[up]) return { code: up };
  const all = Object.values(STATIONS);
  const norm = (x: string) => x.replace(/\s+|\(.*?\)/g, '').toLowerCase();
  const ns = norm(s);
  const exact = all.filter((st) => norm(st.name) === ns);
  if (exact.length === 1) return { code: exact[0].code };
  const contains = all.filter((st) => norm(st.name).includes(ns) || (ns.length >= 3 && ns.includes(norm(st.name))));
  if (contains.length === 1) return { code: contains[0].code };
  // 두 글자 조각이 가장 많이 겹치는 설비
  const grams = (x: string) => new Set([...norm(x)].map((_, i, a) => a.slice(i, i + 2).join('')).filter((g) => g.length === 2));
  const qg = grams(s);
  const scored = all
    .map((st) => {
      const g = grams(st.name);
      let hit = 0;
      for (const x of qg) if (g.has(x)) hit++;
      return { code: st.code, score: qg.size ? hit / qg.size : 0 };
    })
    .sort((a, b) => b.score - a.score);
  const pool = contains.length > 1 ? contains.map((c) => c.code) : scored.filter((x) => x.score >= 0.5).map((x) => x.code);
  if (pool.length === 1) return { code: pool[0] };
  if (scored[0]?.score >= 0.5 && scored[0].score > (scored[1]?.score ?? 0) + 0.2) return { code: scored[0].code };
  return { error: `'${q}'에 맞는 설비를 하나로 정하지 못했습니다`, candidates: (pool.length ? pool : scored.slice(0, 5).map((x) => x.code)).slice(0, 6) };
}

// ───────────── 입력 검사 ─────────────
// 스트리밍 도구 입력(eager_input_streaming)은 서버가 스키마를 검사하지 않으므로 여기서 검사한다

export function str(input: Input, key: string, required: true): Parsed<string>;
export function str(input: Input, key: string, required: false): Parsed<string | undefined>;
export function str(input: Input, key: string, required: boolean): Parsed<string | undefined> {
  const v = input[key];
  if (v == null || v === '') return required ? { ok: false, error: `${key}가 필요합니다` } : { ok: true, v: undefined };
  if (typeof v !== 'string') return { ok: false, error: `${key}는 문자열이어야 합니다` };
  return { ok: true, v: v.trim() };
}

/** 정해진 값 중 하나 (대소문자 무시). 비어 있으면 undefined */
export function oneOf<T extends string>(input: Input, key: string, values: readonly T[]): Parsed<T | undefined> {
  const r = str(input, key, false);
  if (!r.ok || r.v === undefined) return r as Parsed<undefined>;
  const hit = values.find((x) => x.toLowerCase() === r.v!.toLowerCase());
  return hit ? { ok: true, v: hit } : { ok: false, error: `${key}는 ${values.join('·')} 중 하나입니다` };
}

export function lineArg(input: Input): Parsed<LineCode | undefined> {
  const r = str(input, 'line', false);
  if (!r.ok || r.v === undefined) return r as Parsed<undefined>;
  const up = r.v.toUpperCase() as LineCode;
  return LINE_CODES.includes(up) ? { ok: true, v: up } : { ok: false, error: `line은 ${LINE_CODES.join('·')} 중 하나입니다` };
}

export function stationArg(input: Input, required: boolean): Parsed<string | undefined> | { ok: false; error: string; candidates: string[] } {
  const r = required ? str(input, 'station', true) : str(input, 'station', false);
  if (!r.ok || r.v === undefined) return r;
  const hit = resolveStation(r.v);
  return 'code' in hit ? { ok: true, v: hit.code } : { ok: false, error: hit.error, candidates: hit.candidates };
}

export const LINE_PROP = { type: 'string', enum: LINE_CODES, description: 'HL 헤드램프 · EM 전장 모듈(LED·BMS) · OSM 사이드미러' };
export const STATION_PROP = { type: 'string', description: '설비 코드(예: OSM-FT-01) 또는 설비 이름' };

export function fail(error: string, extra?: Record<string, unknown>): ToolOutcome {
  return { ok: false, data: { error, ...extra }, summary: error, refs: [] };
}
