import { BadRequestException } from '@nestjs/common';
import {
  FACTORY,
  LINES,
  STATIONS,
  WHATIF_LIMITS,
  lineOf,
  whatIfBudgetH,
  type LineCode,
  type WhatIfBase,
  type WhatIfBaseSource,
  type WhatIfEvent,
  type WhatIfOrder,
  type WhatIfRequest,
  type WhatIfScenarioInput,
  type WhatIfSimInput,
} from '@lumitwin/shared';

// What-if 요청 검사·정리 (순수 함수). 틀리면 400 + 한국어 메시지.
// 결과: 서버가 고친 요청(투입 중 작업지시를 맨 앞에 넣는 등, 화면·DB에 그대로 남는다)과 시뮬레이터 입력의 계획(모든 라인을 채운 것).

/** 계획에서 새로 더한 가상 지시의 시뮬레이터 id = NEW_ID_BASE + n (MES id와 겹치지 않게) */
export const NEW_ID_BASE = 1_000_000;
const NAME_MAX = 30;
const CODE_MAX = 40;

export type SimScenario = WhatIfSimInput['scenarios'][number];
export type SimOrder = SimScenario['orders'][LineCode][number];

export interface Normalized {
  request: WhatIfRequest;
  base: WhatIfBase;
  sim: SimScenario[];
}

const LINE_CODES = new Set<string>(LINES.map((l) => l.code));
const SCENARIO_IDS = new Set(FACTORY.scenarios.map((s) => s.id));
const bad = (msg: string) => new BadRequestException(msg);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseSource(v: unknown): WhatIfBaseSource {
  if (v === 'live' || v === 'clean') return v;
  throw bad('기준 상태(base)는 live(지금 공장 상태) 또는 clean(초기화한 공장)입니다');
}

/** 숫자 칸 (시간·반복·계획 수·계산량) 먼저: 기준 상태를 만들기 전에 거른다 */
export function checkShape(body: unknown): { horizonH: number; reps: number; source: WhatIfBaseSource; scenarios: unknown[] } {
  if (!isObj(body)) throw bad('요청 본문이 필요합니다');
  const L = WHATIF_LIMITS;
  const horizonH = body.horizonH;
  if (!isNum(horizonH) || horizonH < L.horizonH.min || horizonH > L.horizonH.max) throw bad(`내다볼 시간(horizonH)은 ${L.horizonH.min} ~ ${L.horizonH.max}시간입니다`);
  const reps = body.reps;
  if (!Number.isInteger(reps) || (reps as number) < L.reps.min || (reps as number) > L.reps.max) throw bad(`반복 횟수(reps)는 ${L.reps.min} ~ ${L.reps.max} 사이 정수입니다`);
  const source = parseSource(body.base);
  const scenarios = body.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length < L.scenarios.min || scenarios.length > L.scenarios.max) throw bad(`계획은 ${L.scenarios.min} ~ ${L.scenarios.max}개입니다 (첫째가 비교 기준)`);
  const budget = whatIfBudgetH({ horizonH, reps: reps as number, scenarios: scenarios as WhatIfScenarioInput[] });
  if (budget > L.budgetH) {
    throw bad(`계산량이 너무 큽니다: 계획 ${scenarios.length}개 × 반복 ${reps as number}번 × ${horizonH}시간 = ${Math.round(budget)}시간 (한도 ${L.budgetH}시간). 반복이나 시간을 줄여 주세요`);
  }
  return { horizonH, reps: reps as number, source, scenarios };
}

function parseEvent(raw: unknown, horizonH: number, where: string): WhatIfEvent {
  if (!isObj(raw)) throw bad(`${where}: 사건 형식이 틀렸습니다`);
  const atMin = raw.atMin;
  const endMin = horizonH * 60;
  if (!isNum(atMin) || atMin < 0 || atMin >= endMin) throw bad(`${where}: 사건 시각(atMin)은 0 이상 ${endMin}분 미만이어야 합니다`);
  const station = (): string => {
    const s = raw.station;
    if (typeof s !== 'string' || !STATIONS[s]) throw bad(`${where}: 없는 설비입니다: ${String(s)}`);
    return s;
  };
  switch (raw.kind) {
    case 'down': {
      const code = station();
      const minutes = raw.minutes;
      if (!isNum(minutes) || minutes < 1 || minutes > 720) throw bad(`${where}: 고장 시간(minutes)은 1 ~ 720분입니다`);
      return { kind: 'down', station: code, atMin, minutes };
    }
    case 'pm':
      return { kind: 'pm', station: station(), atMin };
    case 'scenario': {
      const id = raw.id;
      if (typeof id !== 'string' || !SCENARIO_IDS.has(id)) throw bad(`${where}: 없는 공정 이상 시나리오입니다: ${String(id)}`);
      if (typeof raw.on !== 'boolean') throw bad(`${where}: 공정 이상 사건은 켜기·끄기(on)가 필요합니다`);
      return { kind: 'scenario', id, on: raw.on, atMin };
    }
    default:
      throw bad(`${where}: 사건 종류(kind)는 down·pm·scenario 중 하나입니다`);
  }
}

/**
 * 라인 하나의 계획 순서. 기준 상태에 투입 중(RUNNING) 지시가 있으면 맨 앞에 둔다
 * (빠졌으면 넣고, 다른 자리면 옮긴다. 그 지시의 기종·수량 변경은 무시한다: 이미 투입 중이다)
 */
function parseOrders(raw: unknown, line: LineCode, base: WhatIfBase, where: string): WhatIfOrder[] {
  const def = lineOf(line);
  if (!Array.isArray(raw)) throw bad(`${where}: ${def.name} 작업지시 목록이 배열이 아닙니다`);
  if (raw.length > WHATIF_LIMITS.ordersPerLine) throw bad(`${where}: ${def.name} 작업지시는 ${WHATIF_LIMITS.ordersPerLine}건까지입니다`);
  const baseOrders = base.lines[line]?.orders ?? [];
  const byId = new Map(baseOrders.map((o) => [o.id, o]));
  const running = baseOrders.find((o) => o.status === 'RUNNING');
  const seen = new Set<number>();
  const out: WhatIfOrder[] = [];
  let runningDue: number | undefined;
  let n = 0;
  for (const r of raw) {
    if (!isObj(r)) throw bad(`${where}: 작업지시 형식이 틀렸습니다`);
    let dueMin: number | undefined;
    if (r.dueMin != null) {
      if (!isNum(r.dueMin) || r.dueMin < 0) throw bad(`${where}: 납기(dueMin)는 0 이상인 분입니다`);
      dueMin = r.dueMin;
    }
    if (r.id != null) {
      const id = r.id;
      if (!Number.isInteger(id)) throw bad(`${where}: 작업지시 id는 정수입니다`);
      const b = byId.get(id as number);
      if (!b) throw bad(`${where}: 작업지시 #${String(id)}은(는) 기준 상태의 ${def.name} 진행·대기 작업지시가 아닙니다`);
      if (seen.has(b.id)) throw bad(`${where}: 작업지시 ${b.code}이(가) 두 번 들어 있습니다`);
      seen.add(b.id);
      if (b === running) {
        runningDue = dueMin;
        continue; // 맨 앞에 따로 넣는다
      }
      out.push({ id: b.id, code: b.code, variant: variantOf(r.variant, def, where), qty: qtyOf(r.qty, where), ...(dueMin != null ? { dueMin } : {}) });
      continue;
    }
    n++;
    const code = typeof r.code === 'string' && r.code.trim() ? r.code.trim().slice(0, CODE_MAX) : `NEW-${line}-${n}`;
    out.push({ code, variant: variantOf(r.variant, def, where), qty: qtyOf(r.qty, where), ...(dueMin != null ? { dueMin } : {}) });
  }
  if (running) out.unshift({ id: running.id, code: running.code, variant: running.variant, qty: running.qty, ...(runningDue != null ? { dueMin: runningDue } : {}) });
  return out;
}

function variantOf(v: unknown, def: ReturnType<typeof lineOf>, where: string): string {
  if (typeof v !== 'string' || !def.variants.some((x) => x.code === v)) throw bad(`${where}: ${def.name}에 없는 기종입니다: ${String(v)}`);
  return v;
}

function qtyOf(v: unknown, where: string): number {
  const { min, max } = WHATIF_LIMITS.qty;
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw bad(`${where}: 수량은 ${min} ~ ${max} 사이 정수입니다`);
  return v as number;
}

/** 시뮬레이터 입력의 라인 계획: 모든 라인을 채운다 (계획에서 빠진 라인 = 기준 상태 순서) */
export function simOrders(req: WhatIfScenarioInput, base: WhatIfBase): Record<LineCode, SimOrder[]> {
  const out = {} as Record<LineCode, SimOrder[]>;
  for (const l of LINES) {
    const baseOrders = base.lines[l.code]?.orders ?? [];
    const running = baseOrders.find((o) => o.status === 'RUNNING');
    const plan: WhatIfOrder[] = req.orders?.[l.code] ?? baseOrders.map((o) => ({ id: o.id, code: o.code, variant: o.variant, qty: o.qty }));
    let n = 0;
    out[l.code] = plan.map((o) => {
      if (o.id != null) {
        const b = baseOrders.find((x) => x.id === o.id);
        return { id: o.id, code: b?.code ?? o.code ?? String(o.id), variant: o.variant, qty: o.qty, released: o.id === running?.id ? running.released : 0, ...(o.dueMin != null ? { dueMin: o.dueMin } : {}) };
      }
      n++;
      return { id: NEW_ID_BASE + n, code: `NEW-${l.code}-${n}`, variant: o.variant, qty: o.qty, released: 0, ...(o.dueMin != null ? { dueMin: o.dueMin } : {}) };
    });
  }
  return out;
}

/**
 * 요청 전체를 검사하고 정리한다. makeBase는 기준 상태를 만든다 (live인데 시뮬레이터가 없으면 그 안에서 400).
 * 기준 상태를 만들기 전에 숫자 칸·계산량부터 거른다
 */
export function normalizeRequest(body: unknown, makeBase: (source: WhatIfBaseSource) => WhatIfBase): Normalized {
  const shape = checkShape(body);
  const base = makeBase(shape.source);
  const scenarios: WhatIfScenarioInput[] = shape.scenarios.map((raw, i) => {
    const where = `계획 ${i + 1}`;
    if (!isObj(raw)) throw bad(`${where}: 형식이 틀렸습니다`);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (name.length < 1 || name.length > NAME_MAX) throw bad(`${where}: 이름은 1 ~ ${NAME_MAX}자입니다`);
    const at = `계획 '${name}'`;
    let events: WhatIfEvent[] = [];
    if (raw.events != null) {
      if (!Array.isArray(raw.events)) throw bad(`${at}: 사건 목록이 배열이 아닙니다`);
      if (raw.events.length > WHATIF_LIMITS.events) throw bad(`${at}: 사건은 ${WHATIF_LIMITS.events}개까지입니다`);
      events = raw.events.map((e) => parseEvent(e, shape.horizonH, at));
    }
    if (raw.autoFill != null && typeof raw.autoFill !== 'boolean') throw bad(`${at}: autoFill은 true·false입니다`);
    const autoFill = raw.autoFill !== false;
    let orders: Partial<Record<LineCode, WhatIfOrder[]>> | undefined;
    if (raw.orders != null) {
      if (!isObj(raw.orders)) throw bad(`${at}: 작업지시(orders)는 라인별 목록입니다`);
      orders = {};
      for (const [line, list] of Object.entries(raw.orders)) {
        if (!LINE_CODES.has(line)) throw bad(`${at}: 없는 라인입니다: ${line}`);
        if (list == null) continue;
        orders[line as LineCode] = parseOrders(list, line as LineCode, base, at);
      }
    }
    return { name, ...(orders ? { orders } : {}), events, autoFill };
  });
  const request: WhatIfRequest = { horizonH: shape.horizonH, reps: shape.reps, base: shape.source, scenarios };
  const sim = scenarios.map((s) => ({ orders: simOrders(s, base), events: s.events ?? [], autoFill: s.autoFill !== false }));
  return { request, base, sim };
}
