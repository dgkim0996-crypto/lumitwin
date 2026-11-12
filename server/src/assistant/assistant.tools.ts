import { Injectable } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import {
  DEFECT_NAMES,
  FACTORY,
  LINES,
  LOSS_INFO,
  LOSS_KEYS,
  STATIONS,
  type AlarmLive,
  type LossTimes,
  type AssistantRef,
  type LineCode,
  type StationState,
  type TraceNode,
} from '@lumitwin/shared';
import { LiveService } from '../live/live.service';
import { OperatorService } from '../operator/operator.service';
import { ProductionService } from '../production/production.service';
import { StandardsIndex } from './standards.index';

/** 도구 하나를 실행한 결과. data는 모델에게, summary·refs는 화면에 간다 */
export interface ToolOutcome {
  ok: boolean;
  data: unknown;
  summary: string;
  refs: AssistantRef[];
}

type Input = Record<string, unknown>;
type Parsed<T> = { ok: true; v: T } | { ok: false; error: string };

export const STATE_NAMES: Record<StationState, string> = {
  RUN: '가동', IDLE: '투입 대기', BLOCKED: '배출 대기', DOWN: '고장', SETUP: '셋업', STOP: '계획 정지',
};
const ALARM_KINDS = ['DOWN', 'LIMIT', 'QUALITY', 'SPC', 'CHECK'] as const;
export const ALARM_KIND_NAMES: Record<string, string> = { DOWN: '고장', LIMIT: '공정값 이탈', QUALITY: '불량률 상승', SPC: 'SPC 이상', CHECK: '작업 전 점검 이상' };
const LINE_CODES = LINES.map((l) => l.code);
const MATERIALS = new Map(FACTORY.materials.map((m) => [m.code, m]));
/** 같은 자재의 다른 LOT 대비 편중 판정 (추적 화면과 같은 기준) */
const LOT_MIN_JUDGED = 20;
const LOT_FLAG_Z = 3;
const LOT_MIN_NG = 5;

const pct = (v: number) => Math.round(v * 1000) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
/** 측정값은 유효숫자 4자리로 (8.024999999999999 → 8.025). 크기가 제각각이라 소수 자릿수로 자르면 안 된다 */
const sig4 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Number(v.toPrecision(4)));
/** 가상 시각을 한국 시간 'MM-DD HH:mm'으로 */
export function kst(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(Date.parse(iso) + 9 * 3_600_000);
  return d.toISOString().slice(5, 16).replace('T', ' ');
}
const stationRef = (code: string): AssistantRef => ({ kind: 'station', id: code, label: `${code} ${STATIONS[code]?.name ?? ''}`.trim() });

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

/** 태그·검사값·부품 속성 키 → 이름·단위 */
function signalName(station: string, key: string): { name: string; unit: string } {
  const st = STATIONS[station];
  const t = st?.tags.find((x) => x.key === key) ?? st?.measures?.find((x) => x.key === key) ?? st?.attrs?.find((x) => x.key === key);
  return { name: t?.name ?? key, unit: t?.unit ?? '' };
}

// ───────────── 입력 검사 ─────────────
// 스트리밍 도구 입력(eager_input_streaming)은 서버가 스키마를 검사하지 않으므로 여기서 검사한다

function str(input: Input, key: string, required: true): Parsed<string>;
function str(input: Input, key: string, required: false): Parsed<string | undefined>;
function str(input: Input, key: string, required: boolean): Parsed<string | undefined> {
  const v = input[key];
  if (v == null || v === '') return required ? { ok: false, error: `${key}가 필요합니다` } : { ok: true, v: undefined };
  if (typeof v !== 'string') return { ok: false, error: `${key}는 문자열이어야 합니다` };
  return { ok: true, v: v.trim() };
}

function lineArg(input: Input): Parsed<LineCode | undefined> {
  const r = str(input, 'line', false);
  if (!r.ok || r.v === undefined) return r as Parsed<undefined>;
  const up = r.v.toUpperCase() as LineCode;
  return LINE_CODES.includes(up) ? { ok: true, v: up } : { ok: false, error: `line은 ${LINE_CODES.join('·')} 중 하나입니다` };
}

function stationArg(input: Input, required: boolean): Parsed<string | undefined> | { ok: false; error: string; candidates: string[] } {
  const r = required ? str(input, 'station', true) : str(input, 'station', false);
  if (!r.ok || r.v === undefined) return r;
  const hit = resolveStation(r.v);
  return 'code' in hit ? { ok: true, v: hit.code } : { ok: false, error: hit.error, candidates: hit.candidates };
}

// ───────────── 도구 정의 ─────────────

const LINE_PROP = { type: 'string', enum: LINE_CODES, description: 'HL 헤드램프 · EM 전장 모듈(LED·BMS) · OSM 사이드미러' };
const STATION_PROP = { type: 'string', description: '설비 코드(예: OSM-FT-01) 또는 설비 이름' };

/** 모델에 알려 주는 도구 목록. 모두 조회만 한다 (설비 조작 도구는 일부러 두지 않았다) */
export const TOOL_DEFS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: 'factory_overview',
    description: '공장 전체 현황: 라인별 완성 수·최근 1시간 실적과 목표·OEE(가동률·성능·양품률)·FPY, 멈춘 설비(고장·셋업·계획 정지)와 사유, 확인 안 된 알람, 현재 가상 시각과 배속. 상황을 처음 파악할 때 먼저 쓴다.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'station_status',
    description: '설비 하나의 상세: 현재 상태와 지속 시간·사유(작업자가 고른 비가동 사유 포함), 상태별 시간 비율, OEE, 처리·불량 수와 불량 종류, 현재 공정값(태그)과 관리 범위 이탈 여부, SPC 관리도 요약(Cpk·최근 규칙 위반), 최근 알람, 작업자의 마지막 작업 전 점검 결과.',
    input_schema: { type: 'object', properties: { station: STATION_PROP }, required: ['station'], additionalProperties: false },
  },
  {
    name: 'list_alarms',
    description: '최근 알람 목록(새것부터). 설비·종류·미확인 여부로 거를 수 있다. 종류: DOWN 고장, LIMIT 공정값 규격 이탈, QUALITY 불량률 상승, SPC 관리도 규칙 위반.',
    input_schema: {
      type: 'object',
      properties: {
        station: STATION_PROP,
        kind: { type: 'string', enum: [...ALARM_KINDS] },
        unacked_only: { type: 'boolean', description: 'true면 확인 안 된 알람만' },
        limit: { type: 'integer', minimum: 1, maximum: 30 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'spc_overview',
    description: '관리도 요약: 공정능력(Cpk)이 낮거나(1.33 미만) 최근 10개 부분군에서 판정 규칙을 어긴 관리 항목을 나쁜 순으로. 라인으로 거를 수 있다.',
    input_schema: { type: 'object', properties: { line: LINE_PROP }, additionalProperties: false },
  },
  {
    name: 'defect_pareto',
    description: '이번 실행의 불량 누계를 설비·불량 종류별로 많은 순서로(파레토). 어디서 어떤 불량이 많은지 볼 때 쓴다. 라인으로 거를 수 있다.',
    input_schema: { type: 'object', properties: { line: LINE_PROP }, additionalProperties: false },
  },
  {
    name: 'defect_factors',
    description:
      '불량 요인 비교: 이 설비에서 불량 판정을 받은 제품과 같은 시기 양품을 비교해, 앞 공정·하위 부품까지 거슬러 공정값·부품 속성·검사값의 차이(효과 크기 d)가 큰 순으로, 그리고 불량품 쪽에 몰린 자재 LOT를 돌려준다. 검출 설비(검사기)를 넣는다. 상관이지 인과가 아니다.',
    input_schema: {
      type: 'object',
      properties: { station: STATION_PROP, defect: { type: 'string', description: '불량 코드(예: NOISE). 비우면 이 설비의 모든 불량' } },
      required: ['station'],
      additionalProperties: false,
    },
  },
  {
    name: 'six_losses',
    description:
      '6대 로스(TPM): 계획 시간을 가치 시간(= OEE)과 고장·셋업·조정·순간 정지·공회전·속도 저하·공정 불량·초기 수율로 나눈 비율, 라인별 구성, 잃은 시간이 큰 설비×로스 순위. OEE가 왜 낮은지, 무엇부터 줄일지 답할 때 쓴다. 라인으로 거를 수 있다.',
    input_schema: { type: 'object', properties: { line: LINE_PROP }, additionalProperties: false },
  },
  {
    name: 'hourly_output',
    description: '라인의 시간대별(가상 시각) 완성 수와 불량 수, 시간당 목표. 최근 12시간.',
    input_schema: { type: 'object', properties: { line: LINE_PROP }, required: ['line'], additionalProperties: false },
  },
  {
    name: 'trace_serial',
    description: '제품·부품 시리얼의 계보: 거친 공정과 판정, 투입한 자재 LOT, 조립돼 들어간 하위 부품(재귀), 이 부품이 들어간 상위 제품.',
    input_schema: { type: 'object', properties: { serial: { type: 'string' } }, required: ['serial'], additionalProperties: false },
  },
  {
    name: 'lot_trace',
    description: '자재 LOT 하나의 영향 범위: 그 LOT를 쓴 부품 수(설비별), 그 부품이 조립돼 들어간 맨 위 제품의 상태별 수(완성=회수 검토, 공정 중=격리), 불량 제품 예시.',
    input_schema: { type: 'object', properties: { lot: { type: 'string', description: 'LOT 번호(예: GEARSET-261112-004)' } }, required: ['lot'], additionalProperties: false },
  },
  {
    name: 'lot_quality',
    description: '한 자재의 LOT별 불량률 비교: LOT마다 부품 수·불량(상위 제품까지 따라가 판정)·완성 수와, 같은 자재의 다른 LOT를 합친 불량률 대비 z 값. z가 크면 그 LOT에 불량이 몰린 것이다.',
    input_schema: {
      type: 'object',
      properties: { material: { type: 'string', description: `자재 코드 또는 이름. 자재: ${FACTORY.materials.map((m) => `${m.code}(${m.name})`).join(', ')}` } },
      required: ['material'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_standards',
    description: '작업표준서 검색: 공정 조건(기준값·관리 범위), 작업 순서, 품질 확인, 이상 발생 시 조치, 안전(LOTO), 설비 고장 대응, 부적합품·LOT 격리, SPC 이상 조치(OCAP). 절차나 기준을 답할 때는 반드시 이것으로 찾아 인용한다.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: '찾을 내용 (한국어 키워드 위주)' }, station: STATION_PROP },
      required: ['query'],
      additionalProperties: false,
    },
  },
].map((t) => ({ ...t, eager_input_streaming: true }) as Anthropic.Beta.Messages.BetaTool);

/** 화면에 보일 도구 호출 이름 */
export function toolLabel(name: string, input: Input): string {
  const arg = (k: string) => (typeof input[k] === 'string' ? ` · ${input[k] as string}` : '');
  switch (name) {
    case 'factory_overview': return '공장 현황 조회';
    case 'station_status': return `설비 상태 조회${arg('station')}`;
    case 'list_alarms': return `알람 조회${arg('station')}${arg('kind')}`;
    case 'spc_overview': return `SPC 요약 조회${arg('line')}`;
    case 'defect_pareto': return `불량 파레토 조회${arg('line')}`;
    case 'defect_factors': return `불량 요인 비교${arg('station')}${arg('defect')}`;
    case 'six_losses': return `6대 로스 조회${arg('line')}`;
    case 'hourly_output': return `시간대별 실적 조회${arg('line')}`;
    case 'trace_serial': return `시리얼 추적${arg('serial')}`;
    case 'lot_trace': return `LOT 영향 범위 조회${arg('lot')}`;
    case 'lot_quality': return `LOT별 불량률 비교${arg('material')}`;
    case 'search_standards': return `작업표준서 검색${arg('query')}`;
    default: return name;
  }
}

/** 도구 실행기. Claude 모드와 모의 모드가 같은 것을 쓴다 */
@Injectable()
export class AssistantTools {
  constructor(
    private readonly live: LiveService,
    private readonly production: ProductionService,
    private readonly standards: StandardsIndex,
    private readonly operator: OperatorService,
  ) {}

  async run(name: string, input: Input): Promise<ToolOutcome> {
    try {
      switch (name) {
        case 'factory_overview': return this.overview();
        case 'station_status': return this.station(input);
        case 'list_alarms': return this.alarms(input);
        case 'spc_overview': return this.spcOverview(input);
        case 'defect_pareto': return await this.pareto(input);
        case 'defect_factors': return await this.factors(input);
        case 'six_losses': return this.losses(input);
        case 'hourly_output': return await this.hourly(input);
        case 'trace_serial': return await this.trace(input);
        case 'lot_trace': return await this.lot(input);
        case 'lot_quality': return await this.lotQuality(input);
        case 'search_standards': return this.searchStandards(input);
        default: return fail(`알 수 없는 도구 ${name}`);
      }
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  private now(): number {
    return Date.parse(this.live.virtualNow ?? '') || Date.now();
  }

  overview(): ToolOutcome {
    const s = this.live.snapshot();
    const now = this.now();
    const lines = LINES.map((l) => {
      const x = s.lines[l.code];
      return {
        code: l.code, name: l.name, output: x.output, lastHour: x.lastHour, targetPerHour: Math.round(3600 / l.taktSec),
        oeePct: pct(x.oee.oee), availabilityPct: pct(x.oee.availability), performancePct: pct(x.oee.performance), fpyPct: pct(x.fpy),
        ng: x.ng, down: x.downStations,
      };
    });
    const st = Object.values(s.stations);
    const byState: Partial<Record<string, number>> = {};
    for (const x of st) byState[STATE_NAMES[x.state]] = (byState[STATE_NAMES[x.state]] ?? 0) + 1;
    const stopped = st
      .filter((x) => x.state === 'DOWN' || x.state === 'SETUP' || x.state === 'STOP')
      .map((x) => ({ code: x.code, name: STATIONS[x.code]?.name, state: STATE_NAMES[x.state], reason: x.reason ?? null, minutes: Math.round((now - Date.parse(x.since)) / 60_000) }));
    const unacked = s.alarms.filter((a) => !a.acked);
    const byKind: Record<string, number> = {};
    for (const a of unacked) byKind[ALARM_KIND_NAMES[a.kind] ?? a.kind] = (byKind[ALARM_KIND_NAMES[a.kind] ?? a.kind] ?? 0) + 1;
    const data = {
      virtualTime: kst(this.live.virtualNow), speed: s.sim?.speed ?? null, running: s.sim?.running ?? null, simConnected: s.connected.sim,
      lines, stationsByState: byState, stopped,
      alarms: { unacked: unacked.length, byKind, latest: unacked.slice(0, 6).map(alarmView) },
    };
    const down = stopped.filter((x) => x.state === '고장').length;
    return {
      ok: true, data,
      summary: `라인 ${lines.length}개 · 고장 ${down}대 · 미확인 알람 ${unacked.length}건`,
      refs: [...stopped.map((x) => stationRef(x.code)), { kind: 'page', id: '/production', label: '생산 현황' }],
    };
  }

  async station(input: Input): Promise<ToolOutcome> {
    const a = stationArg(input, true);
    if (!a.ok) return fail(a.error, 'candidates' in a ? { candidates: a.candidates } : undefined);
    const code = a.v as string;
    const def = STATIONS[code];
    const s = this.live.snapshot();
    const x = s.stations[code];
    const total = Object.values(x.stateSec).reduce((p, v) => p + (v ?? 0), 0);
    const share = Object.fromEntries(Object.entries(x.stateSec).filter(([, v]) => (v ?? 0) > 0).map(([k, v]) => [STATE_NAMES[k as StationState], total ? pct((v ?? 0) / total) : 0]));
    const tags = def.tags.map((t) => {
      const v = x.tags[t.key];
      const out = v != null && ((t.lsl != null && v < t.lsl) || (t.usl != null && v > t.usl));
      return { key: t.key, name: t.name, unit: t.unit, value: v ?? null, nominal: t.nominal, lsl: t.lsl ?? null, usl: t.usl ?? null, outOfSpec: out };
    });
    const spc = this.live.spc(code).map((c) => {
      const recent = c.points.slice(-10);
      return {
        key: c.key, name: c.name, unit: c.unit, source: c.source, cpk: c.cpk, cl: c.cl, ucl: c.ucl, lcl: c.lcl, lsl: c.lsl ?? null, usl: c.usl ?? null,
        lastMean: c.points[c.points.length - 1]?.mean ?? null, flaggedRecent: recent.filter((p) => p.flags.length).length,
        rulesRecent: [...new Set(recent.flatMap((p) => p.flags))],
      };
    });
    const count = x.ok + x.ng;
    // 작업자 태블릿의 마지막 작업 전 점검 (DB가 잠깐 안 되면 없이 답한다)
    const check = (await this.operator.checks(code, 1).catch(() => []))[0];
    const data = {
      code, name: def.name, line: def.line, step: def.step, kind: def.kind, cycleSec: def.cycle, batch: def.batch ?? 1, desc: def.desc,
      lastCheck: check ? { t: kst(check.at), by: check.by, items: check.items.length, ngItems: check.items.filter((i) => !i.ok).map((i) => i.text) } : null,
      state: STATE_NAMES[x.state], reason: x.reason ?? null, stateMinutes: Math.round((this.now() - Date.parse(x.since)) / 60_000), timeSharePct: share,
      oee: { oeePct: pct(x.oee.oee), availabilityPct: pct(x.oee.availability), performancePct: pct(x.oee.performance), qualityPct: pct(x.oee.quality) },
      processed: count, ng: x.ng, ngRatePct: count ? pct(x.ng / count) : 0,
      defects: Object.entries(x.defects).sort((p, q) => q[1] - p[1]).map(([c, n]) => ({ code: c, name: DEFECT_NAMES[c] ?? c, n })),
      tags, lastUnit: x.last ? { t: kst(x.last.t), serial: x.last.serial, result: x.last.result, defect: x.last.defect ?? null, values: x.last.values } : null,
      spc, alarms: s.alarms.filter((al) => al.station === code).slice(0, 5).map(alarmView),
    };
    const outs = tags.filter((t) => t.outOfSpec).length;
    return {
      ok: true, data,
      summary: `${def.name} · ${STATE_NAMES[x.state]} · 불량 ${x.ng}/${count}${outs ? ` · 규격 이탈 ${outs}` : ''}`,
      refs: [stationRef(code), { kind: 'page', id: `/spc?station=${code}`, label: `${code} SPC` }],
    };
  }

  alarms(input: Input): ToolOutcome {
    const st = stationArg(input, false);
    if (!st.ok) return fail(st.error, 'candidates' in st ? { candidates: st.candidates } : undefined);
    const kind = str(input, 'kind', false);
    if (!kind.ok) return fail(kind.error);
    if (kind.v && !(ALARM_KINDS as readonly string[]).includes(kind.v)) return fail(`kind는 ${ALARM_KINDS.join('·')} 중 하나입니다`);
    const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(30, Math.round(input.limit))) : 10;
    const unacked = input.unacked_only === true;
    const list = this.live.alarmList.filter((a) => (!st.v || a.station === st.v) && (!kind.v || a.kind === kind.v) && (!unacked || !a.acked));
    const shown = list.slice(0, limit);
    return {
      ok: true,
      data: { total: list.length, alarms: shown.map(alarmView) },
      summary: `알람 ${list.length}건${unacked ? '(미확인)' : ''}`,
      refs: [...new Set(shown.map((a) => a.station))].slice(0, 6).map(stationRef),
    };
  }

  spcOverview(input: Input): ToolOutcome {
    const line = lineArg(input);
    if (!line.ok) return fail(line.error);
    const all = this.live.spcSummary().filter((c) => !line.v || STATIONS[c.station]?.line === line.v);
    const view = (c: (typeof all)[number]) => ({
      station: c.station, stationName: STATIONS[c.station]?.name, key: c.key, name: c.name, unit: c.unit, source: c.source, ctq: c.alarms,
      cpk: c.cpk, cl: c.cl, ucl: c.ucl, lcl: c.lcl, lastMean: c.last?.mean ?? null, lastFlags: c.last?.flags ?? [], flaggedRecent10: c.flagged,
    });
    // 공정능력이 모자란 것(Cpk 낮은 순)과 지금 흔들리는 것(최근 규칙 위반 많은 순)은 따로 본다
    const low = all.filter((c) => c.cpk != null && c.cpk < 1.33).sort((a, b) => (a.cpk ?? 9) - (b.cpk ?? 9));
    const flagged = all.filter((c) => c.flagged > 0).sort((a, b) => b.flagged - a.flagged || (a.cpk ?? 9) - (b.cpk ?? 9));
    const shown = [...new Set([...low.slice(0, 8), ...flagged.slice(0, 8)].map((c) => c.station))];
    return {
      ok: true,
      data: { charts: all.length, lowCpkCount: low.length, flaggedCount: flagged.length, lowestCpk: low.slice(0, 8).map(view), mostFlagged: flagged.slice(0, 8).map(view), note: 'Cpk 1.33 미만이면 공정능력 부족. 규칙 위반은 최근 10개 부분군 기준' },
      summary: `관리 항목 ${all.length}개 · Cpk 1.33 미만 ${low.length} · 최근 규칙 위반 ${flagged.length}`,
      refs: shown.slice(0, 6).map(stationRef).concat({ kind: 'page', id: '/spc', label: 'SPC' }),
    };
  }

  async pareto(input: Input): Promise<ToolOutcome> {
    const line = lineArg(input);
    if (!line.ok) return fail(line.error);
    const rows = await this.production.defects(line.v);
    const snap = this.live.snapshot();
    const total = rows.reduce((a, r) => a + r.n, 0);
    const top = [...rows].sort((a, b) => b.n - a.n).slice(0, 15).map((r) => {
      const x = snap.stations[r.station];
      const processed = x ? x.ok + x.ng : 0;
      return { station: r.station, stationName: STATIONS[r.station]?.name, line: STATIONS[r.station]?.line, defect: r.defect, defectName: DEFECT_NAMES[r.defect] ?? r.defect, n: r.n, sharePct: total ? pct(r.n / total) : 0, stationNgRatePct: processed ? pct(x.ng / processed) : null };
    });
    return {
      ok: true,
      data: { totalNg: total, top },
      summary: top[0] ? `불량 ${total}건 · 1위 ${top[0].stationName} ${top[0].defectName} ${top[0].n}건` : '불량 기록 없음',
      refs: [...new Set(top.map((r) => r.station))].slice(0, 5).map(stationRef).concat({ kind: 'page', id: '/quality', label: '불량 분석' }),
    };
  }

  async factors(input: Input): Promise<ToolOutcome> {
    const st = stationArg(input, true);
    if (!st.ok) return fail(st.error, 'candidates' in st ? { candidates: st.candidates } : undefined);
    const code = st.v as string;
    const defect = str(input, 'defect', false);
    if (!defect.ok) return fail(defect.error);
    let dcode = defect.v?.toUpperCase();
    if (defect.v && !DEFECT_NAMES[dcode ?? '']) {
      // 이름으로 준 경우
      dcode = Object.entries(DEFECT_NAMES).find(([, n]) => n === defect.v || n.includes(defect.v as string))?.[0];
      if (!dcode) return fail(`불량 '${defect.v}'를 모릅니다`);
    }
    const fa = await this.production.factors(code, dcode);
    const factors = fa.factors.slice(0, 8).map((f) => {
      const sig = signalName(f.station, f.key);
      return {
        station: f.station, stationName: STATIONS[f.station]?.name, key: f.key, name: sig.name, unit: sig.unit, kind: f.kind, relation: f.relation,
        effect: r2(f.effect), ngMedian: sig4(f.ng.median), okMedian: sig4(f.ok.median), ngMean: sig4(f.ng.mean), okMean: sig4(f.ok.mean),
      };
    });
    const lots = fa.lots.slice(0, 3).map((l) => ({
      material: l.material, materialName: MATERIALS.get(l.material)?.name ?? l.material, lot: l.lot, usedAt: l.station,
      ngWithLot: l.ng, okWithLot: l.ok, ngSharePct: pct(l.ngShare), okSharePct: pct(l.okShare), z: r2(l.z),
    }));
    const data = {
      station: code, stationName: STATIONS[code]?.name, defect: dcode ?? null, defectName: dcode ? DEFECT_NAMES[dcode] : null,
      ngCount: fa.ngCount, okCount: fa.okCount, window: { from: kst(fa.from), to: kst(fa.to) }, factors, lotSkew: lots,
      note:
        '효과 크기 d = (불량 평균 − 양품 평균) / 합동 표준편차. |d|가 1 이상이면 두 집단이 뚜렷이 갈린다. 상관이지 인과가 아니다. ' +
        'kind: tag = 설비 공정값(설비 설정·상태, 자재 LOT로 바뀌지 않음), attr = 부품 속성(자재 LOT가 바꿀 수 있음), measure = 검사값. ' +
        'tag가 뚜렷이 갈리는데 같은 설비의 LOT도 편중돼 있으면 그 시기에 쓰던 LOT라 함께 오른 것일 수 있다(불량품 거의 전부가 그 LOT가 아니라면 설비를 먼저 본다).',
    };
    const head = factors[0] ? `1위 ${factors[0].stationName} ${factors[0].name} d=${factors[0].effect}` : '뚜렷한 요인 없음';
    return {
      ok: true, data,
      summary: `불량 ${fa.ngCount} vs 양품 ${fa.okCount} · ${head}${lots[0] ? ` · LOT 편중 ${lots[0].lot}` : ''}`,
      refs: [
        stationRef(code),
        ...[...new Set(factors.slice(0, 3).map((f) => f.station))].filter((c) => c !== code).map(stationRef),
        ...lots.map((l): AssistantRef => ({ kind: 'lot', id: l.lot, label: l.lot })),
        { kind: 'page', id: `/quality?station=${code}`, label: '불량 분석' },
      ],
    };
  }

  losses(input: Input): ToolOutcome {
    const line = lineArg(input);
    if (!line.ok) return fail(line.error);
    const r = this.live.losses();
    const scope: LossTimes = line.v ? r.lines.find((l) => l.line === line.v)! : r.total;
    const view = (x: LossTimes) => ({
      plannedMin: Math.round(x.planned / 60),
      oeePct: x.planned ? pct(x.valuable / x.planned) : null,
      lossPct: Object.fromEntries(LOSS_KEYS.map((k) => [LOSS_INFO[k].name, x.planned ? pct(x.loss[k] / x.planned) : 0])),
    });
    const rank = (keys: readonly (typeof LOSS_KEYS)[number][], n: number) =>
      r.stations
        .filter((s) => !line.v || s.line === line.v)
        .flatMap((s) => keys.map((k) => ({ station: s.station, stationName: STATIONS[s.station]?.name, loss: LOSS_INFO[k].name, minutes: Math.round(s.loss[k] / 6) / 10, ofStationPct: s.planned ? pct(s.loss[k] / s.planned) : 0 })))
        .filter((x) => x.minutes > 0)
        .sort((a, b) => b.minutes - a.minutes)
        .slice(0, n);
    // 그 설비에서 직접 줄일 수 있는 로스와, 앞 공정 때문에 생긴 대기(순간 정지·공회전)를 따로 준다
    const top = rank(LOSS_KEYS.filter((k) => k !== 'minorStop'), 10);
    const waiting = rank(['minorStop'], 3);
    const ranked = LOSS_KEYS.filter((k) => scope.loss[k] > 0).sort((a, b) => scope.loss[b] - scope.loss[a]);
    const data = {
      scope: line.v ? LINES.find((l) => l.code === line.v)?.name : '공장 전체',
      ...view(scope),
      lines: line.v ? undefined : r.lines.map((l) => ({ line: l.line, name: LINES.find((d) => d.code === l.line)?.name, ...view(l) })),
      topStationLosses: top,
      topWaiting: waiting,
      startupWindowMin: r.startupWindowSec / 60,
      note: '계획 시간 = 가치 시간 + 6대 로스(설비 시간 합). topStationLosses는 그 설비에서 직접 줄일 수 있는 로스(고장·셋업·속도 저하·불량·초기 수율) 순위, topWaiting은 순간 정지·공회전(투입·배출 대기) 순위다. 대기는 대개 앞 설비가 멈추거나 느려 생기므로 개선은 topStationLosses의 앞 설비부터 본다. 초기 수율은 재가동 뒤 일정 시간 안에 나온 불량.',
    };
    const big = ranked[0];
    return {
      ok: true, data,
      summary: `OEE ${data.oeePct ?? '−'}%${big ? ` · 가장 큰 로스 ${LOSS_INFO[big].name} ${pct(scope.loss[big] / (scope.planned || 1))}%` : ''}`,
      refs: [...new Set(top.slice(0, 4).map((x) => x.station))].map(stationRef).concat({ kind: 'page', id: '/losses', label: '6대 로스' }),
    };
  }

  async hourly(input: Input): Promise<ToolOutcome> {
    const line = lineArg(input);
    if (!line.ok) return fail(line.error);
    if (!line.v) return fail('line이 필요합니다');
    const def = LINES.find((l) => l.code === line.v)!;
    const finals = new Set(def.stations.filter((s) => s.step === def.finalStep).map((s) => s.code));
    const rows = await this.production.hourly(def.code);
    const byHour = new Map<string, { output: number; ng: number }>();
    for (const r of rows) {
      const h = byHour.get(r.hour) ?? { output: 0, ng: 0 };
      if (finals.has(r.station)) h.output += r.ok;
      h.ng += r.ng;
      byHour.set(r.hour, h);
    }
    const hours = [...byHour.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-12).map(([h, v]) => ({ hour: kst(h)?.slice(6), ...v }));
    const target = Math.round(3600 / def.taktSec);
    // 마지막 시간대는 아직 진행 중이라 평균에서 뺀다
    const done = hours.slice(0, -1);
    const avg = done.length ? Math.round(done.reduce((a, h) => a + h.output, 0) / done.length) : null;
    return {
      ok: true,
      data: { line: def.code, name: def.name, targetPerHour: target, hours, note: '마지막 시간대는 진행 중' },
      summary: `${def.short ?? def.name} 시간당 목표 ${target} · 최근 평균 ${avg ?? '−'}`,
      refs: [{ kind: 'page', id: '/production', label: '생산 현황' }],
    };
  }

  async trace(input: Input): Promise<ToolOutcome> {
    const s = str(input, 'serial', true);
    if (!s.ok) return fail(s.error);
    const serial = s.v.toUpperCase();
    const [node, parents] = await Promise.all([this.production.trace(serial), this.production.ancestors(serial)]);
    if (!node.records.length && !node.status) return fail(`시리얼 ${serial}의 기록이 없습니다`);
    const lots: AssistantRef[] = [];
    const view = (n: TraceNode, depth: number): unknown => {
      for (const r of n.records) for (const lot of Object.values(r.lots ?? {})) if (!lots.some((x) => x.id === lot)) lots.push({ kind: 'lot', id: lot, label: lot });
      return {
        serial: n.serial, item: n.item, status: n.status, defect: n.defect, defectName: n.defect ? DEFECT_NAMES[n.defect] ?? n.defect : null,
        steps: n.records.map((r) => ({ station: r.station, result: r.result, defect: r.defect, at: kst(r.endedAt), lots: r.lots ?? undefined })),
        components: depth < 3 ? n.children.map((c) => view(c, depth + 1)) : n.children.map((c) => c.serial),
      };
    };
    const data = { tree: view(node, 0), usedIn: parents };
    return {
      ok: true, data,
      summary: `${serial} · ${node.status ?? '상태 모름'} · 공정 ${node.records.length} · 부품 ${node.children.length}`,
      refs: [{ kind: 'serial', id: serial, label: serial }, ...parents.slice(-1).map((p): AssistantRef => ({ kind: 'serial', id: p, label: `상위 ${p}` })), ...lots.slice(0, 4)],
    };
  }

  async lot(input: Input): Promise<ToolOutcome> {
    const l = str(input, 'lot', true);
    if (!l.ok) return fail(l.error);
    const t = await this.production.lot(l.v.toUpperCase());
    const byStatus: Record<string, number> = {};
    for (const f of t.finished) byStatus[f.status ?? '모름'] = (byStatus[f.status ?? '모름'] ?? 0) + 1;
    const ng = t.finished.filter((f) => f.status === 'NG');
    const data = {
      lot: t.lot, material: t.material, materialName: t.material ? MATERIALS.get(t.material)?.name : null,
      partsUsed: t.parts, byStation: t.byStation, firstUsed: kst(t.firstUsedAt), lastUsed: kst(t.lastUsedAt),
      topProducts: t.finished.length, byStatus,
      ngExamples: ng.slice(0, 8).map((f) => ({ serial: f.serial, item: f.item, defect: f.defect, defectName: f.defect ? DEFECT_NAMES[f.defect] : null })),
      note: 'DONE = 완성(이미 출하됐을 수 있어 회수 검토), WIP = 공정 중(격리), NG = 불량 판정, CONSUMED가 없으면 맨 위 제품 기준',
    };
    return {
      ok: true, data,
      summary: `${t.lot} · 부품 ${t.parts} · 영향 제품 ${t.finished.length} (불량 ${ng.length})`,
      refs: [{ kind: 'lot', id: t.lot, label: `${t.lot} 회수 범위` }, ...t.byStation.slice(0, 2).map((b) => stationRef(b.station))],
    };
  }

  async lotQuality(input: Input): Promise<ToolOutcome> {
    const m = str(input, 'material', true);
    if (!m.ok) return fail(m.error);
    const q = m.v;
    const mat = MATERIALS.get(q.toUpperCase()) ?? FACTORY.materials.find((x) => x.name.includes(q) || q.includes(x.name.split(/[·\s]/)[0]));
    if (!mat) return fail(`자재 '${q}'를 모릅니다`, { materials: FACTORY.materials.map((x) => `${x.code} ${x.name}`) });
    const rows = await this.production.lotQuality(mat.code);
    const ngAll = rows.reduce((a, r) => a + r.ng, 0);
    const judgedAll = rows.reduce((a, r) => a + r.ng + r.done, 0);
    const lots = rows.map((r) => {
      const judged = r.ng + r.done;
      const rate = judged ? r.ng / judged : 0;
      const oj = judgedAll - judged;
      const others = oj > 0 ? (ngAll - r.ng) / oj : 0;
      const se = judged && oj ? Math.sqrt((others * (1 - others)) / judged) : 0;
      const z = se > 0 ? (rate - others) / se : 0;
      return {
        lot: r.lot, parts: r.parts, ng: r.ng, done: r.done, ngRatePct: pct(rate), othersRatePct: pct(others), z: r2(z),
        suspect: judged >= LOT_MIN_JUDGED && r.ng >= LOT_MIN_NG && z >= LOT_FLAG_Z, firstUsed: kst(r.firstUsedAt), lastUsed: kst(r.lastUsedAt),
      };
    });
    const top = [...lots].sort((a, b) => b.z - a.z).slice(0, 8);
    const sus = top.filter((x) => x.suspect);
    return {
      ok: true,
      data: { material: mat.code, materialName: mat.name, lots: rows.length, top, rule: `판정 ${LOT_MIN_JUDGED}개 이상·불량 ${LOT_MIN_NG}개 이상이고 z ≥ ${LOT_FLAG_Z}이면 편중 의심. 같은 시기 다른 원인(설비 이상, 다른 불량 LOT)의 영향일 수도 있다` },
      summary: `${mat.name} LOT ${rows.length}개 · 편중 의심 ${sus.length}개`,
      refs: [...sus.slice(0, 3).map((x): AssistantRef => ({ kind: 'lot', id: x.lot, label: x.lot })), { kind: 'page', id: `/trace?material=${mat.code}`, label: 'LOT 추적' }],
    };
  }

  searchStandards(input: Input): ToolOutcome {
    const q = str(input, 'query', true);
    if (!q.ok) return fail(q.error);
    const st = stationArg(input, false);
    const station = st.ok ? st.v : undefined;
    const hits = this.standards.search(`${q.v} ${station ? `${station} ${STATIONS[station]?.name ?? ''}` : ''}`, 4, station);
    return {
      ok: true,
      data: { hits: hits.map((h) => ({ ref: `${h.doc} §${h.n}`, title: h.title, section: h.section, text: h.text })), note: hits.length ? '인용은 [문서 ID §절] 형태로' : '맞는 절이 없다' },
      summary: hits.length ? `${hits.length}개 절 · ${hits[0].doc} §${hits[0].n} ${hits[0].section}` : '맞는 절 없음',
      refs: hits.map((h): AssistantRef => ({ kind: 'standard', id: h.ref, label: `${h.doc} §${h.n} ${h.section}` })),
    };
  }
}

function alarmView(a: AlarmLive) {
  return { id: a.id, t: kst(a.t), station: a.station, severity: a.severity, kind: a.kind, title: a.title, detail: a.detail ?? null, acked: a.acked };
}

function fail(error: string, extra?: Record<string, unknown>): ToolOutcome {
  return { ok: false, data: { error, ...extra }, summary: error, refs: [] };
}
