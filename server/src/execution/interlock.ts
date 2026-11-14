import {
  FACTORY,
  NCR_STATUS_NAMES,
  ROUTE_GRACE_SEC,
  WO_STATUS_NAMES,
  lineOf,
  prevStep,
  stepOf,
  type Disposition,
  type IlkReqMsg,
  type InterlockCode,
  type LineCode,
  type LineDef,
  type NcrStatus,
  type WoStatus,
} from '@lumitwin/shared';

/**
 * 공정 인터록 판정 (순수 함수). 게이트 설비가 투입하는 순간 묻는 요청에 메모리만 보고 바로 답한다.
 * 판정 순서는 계약 2.2: HOLD → NG → REPAIR → ROUTE → WO → FA. 처음 걸리는 것으로 답한다.
 */

/** 판정에 쓰는 개체 기억 (시리얼 하나). 개체 메시지로 갱신하고, 기동 때 production_unit에서 되살린다 */
export interface UnitMem {
  line: LineCode;
  lastStep: string;
  lastStation: string;
  lastResult: 'OK' | 'NG';
  /** WIP · NG · DONE · CONSUMED · SCRAP · HOLD · REPAIR */
  status: string;
  variant: string | null;
  wo: number | null;
  /** 이 개체와 그 안에 조립된 부품이 쓴 자재 LOT (lotKey) */
  lots: string[];
  /** 이 개체가 조립된 상위 제품 */
  parent: string | null;
}

/** 시리얼의 마지막 NCR 중 판정에 쓰는 부분 */
export interface NcrBrief {
  status: NcrStatus;
  station: string;
  disposition: Disposition | null;
  reinspect: 'OK' | 'NG' | null;
}

export interface HoldHit {
  holdId: number;
  holdCode: string;
  reason: string;
  /** 폐기 판정으로 끝난 Hold의 대상: 거부한 뒤 바로 폐기한다 */
  scrap: boolean;
}

export interface IlkContext {
  unit(serial: string): UnitMem | undefined;
  /** 시리얼·LOT가 걸린 Hold (활성, 또는 폐기 판정으로 끝난 것) */
  hold(serials: string[], lots: string[]): HoldHit | null;
  /** 시리얼의 가장 최근 NCR */
  ncr(serial: string): NcrBrief | undefined;
  wo(id: number): { status: WoStatus; variant: string; code: string } | undefined;
  /** 이 설비에 초물 판정을 기다리는 변경점 (QualitySystemService.firstArticlePending) */
  faPending(station: string): { detail: string } | null;
}

export interface IlkDecision {
  verdict: 'OK' | 'NG' | 'WAIT';
  code?: InterlockCode;
  reason?: string;
  holdId?: number;
  /** Hold 폐기 판정 대상: 거부한 뒤 바로 폐기 명령을 보낸다 */
  scrap?: boolean;
}

/** 자재 LOT 키 (자재 코드와 LOT 번호) */
export const lotKey = (material: string, lot: string) => `${material}|${lot}`;

/** 시뮬레이터가 시작할 때 버퍼에 채워 둔 초기 재공 (앞글자 WIP, 이력 없음). 공정 순서·불량 판정을 하지 않는다 */
export const isInitialWip = (serial: string) => /^WIP\d/.test(serial);

const OK: IlkDecision = { verdict: 'OK' };
const ng = (code: InterlockCode, reason: string): IlkDecision => ({ verdict: 'NG', code, reason });
const wait = (code: InterlockCode, reason: string): IlkDecision => ({ verdict: 'WAIT', code, reason });

interface StepRef {
  line: LineCode;
  step: string;
}
const refKey = (r: StepRef) => `${r.line}.${r.step}`;

/** 이 공정이 받는 부품을 만드는 공정 (같은 라인 앞 공정, 이송이면 출발 공정) */
export function producingSteps(line: LineDef, step: string): StepRef[] {
  const out: StepRef[] = [];
  for (const i of stepOf(line, step)?.inputs ?? []) {
    if (i.step) out.push({ line: line.code, step: i.step });
    else if (i.transfer) {
      const tr = FACTORY.transfers.find((x) => x.code === i.transfer);
      if (tr) out.push({ line: tr.from.line, step: tr.from.step });
    }
  }
  return out;
}

const upstreamCache = new Map<string, Set<string>>();

/** 이 공정보다 앞선 공정 전부 (입력을 거슬러 올라간다, 자기 자신 제외) */
export function upstreamOf(ref: StepRef): Set<string> {
  const key = refKey(ref);
  const hit = upstreamCache.get(key);
  if (hit) return hit;
  const seen = new Set<string>();
  const todo: StepRef[] = [ref];
  while (todo.length) {
    const cur = todo.pop()!;
    for (const p of producingSteps(lineOf(cur.line), cur.step)) {
      const k = refKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      todo.push(p);
    }
  }
  upstreamCache.set(key, seen);
  return seen;
}

/** 개체 하나가 필요한 공정(들) 중 하나를 마지막으로 거쳤나: 맞으면 null, 아직 앞 공정이면 WAIT, 아니면 NG */
function checkLast(serial: string, u: UnitMem | undefined, need: StepRef[]): IlkDecision | null {
  const names = need.map((n) => n.step).join('·');
  if (!u) return wait('ROUTE', `${serial} 앞 공정(${names}) 실적이 아직 없음`);
  const here = refKey({ line: u.line, step: u.lastStep });
  if (need.some((n) => refKey(n) === here)) return null;
  if (need.some((n) => upstreamOf(n).has(here))) return wait('ROUTE', `${serial} 앞 공정 실적 대기 (마지막 ${u.lastStep}, 필요 ${names})`);
  return ng('ROUTE', `${serial} 마지막 공정 ${u.lastStep} (필요 ${names})`);
}

function route(req: IlkReqMsg, ctx: IlkContext, line: LineDef): IlkDecision | null {
  const main = ctx.unit(req.serial);
  const here: StepRef = { line: req.line, step: req.step };
  // 수리 뒤 재검사: 불량을 검출한 그 공정으로 돌아온다
  if (req.reinspect) return checkLast(req.serial, main, [here]);
  const step = stepOf(line, req.step);
  if (step?.serial !== 'new') {
    const need = prevStep(line, req.step);
    if (!need || isInitialWip(req.serial)) return null;
    return checkLast(req.serial, main, [{ line: req.line, step: need }]);
  }
  // 새로 발번하는 공정: 부품마다 그 부품을 만드는 공정을 마지막으로 거쳤어야 한다
  const producers = producingSteps(line, req.step);
  if (!producers.length) return null;
  for (const c of req.comps ?? []) {
    if (isInitialWip(c)) continue;
    const r = checkLast(c, ctx.unit(c), producers);
    if (r) return r;
  }
  return null;
}

/**
 * 인터록 판정. routeWaitedMs = 이 (설비, 시리얼)이 ROUTE 대기로 처음 답을 받은 뒤 지난 실제 시간.
 * 앞 공정 실적이 늦게 오는 경우(OPC UA 경로 등) ROUTE_GRACE_SEC 동안은 WAIT, 넘으면 NG로 바꾼다
 */
export function decide(req: IlkReqMsg, ctx: IlkContext, routeWaitedMs = 0): IlkDecision {
  const line = lineOf(req.line);
  const comps = req.comps ?? [];
  const subjects = [req.serial, ...comps];

  // 1. HOLD: 주 개체·부품 시리얼, 이번에 쓰는 자재 LOT, 부품이 이미 쓴 LOT
  const lots = new Set<string>(Object.entries(req.lots ?? {}).map(([m, l]) => lotKey(m, l)));
  for (const s of subjects) for (const k of ctx.unit(s)?.lots ?? []) lots.add(k);
  const h = ctx.hold(subjects, [...lots]);
  if (h) return { verdict: 'NG', code: 'HOLD', reason: h.reason, holdId: h.holdId, scrap: h.scrap };

  // 2. NG: 마지막 판정이 불량인데 처리가 특채로 끝나지 않음 (재검사 투입 자신은 3에서 본다)
  for (const s of subjects) {
    const u = ctx.unit(s);
    if (!u) continue;
    if (u.status === 'SCRAP') return ng('NG', `${s} 폐기 판정된 개체`);
    if (u.lastResult !== 'NG') continue;
    const n = ctx.ncr(s);
    if (n?.status === 'CLOSED' && n.disposition === 'UAI') continue;
    if (s === req.serial && req.reinspect && n?.status === 'REINSPECT') continue;
    return ng('NG', n ? `${s} 불량 처리 ${NCR_STATUS_NAMES[n.status]}` : `${s} 불량 판정 뒤 처리 기록 없음`);
  }

  // 3. REPAIR: 재검사 투입이면 그 시리얼의 NCR이 재검사 대기여야 하고, 검출한 설비여야 한다
  if (req.reinspect) {
    const n = ctx.ncr(req.serial);
    if (!n || n.status !== 'REINSPECT') return ng('REPAIR', `${req.serial} 재검사 대기 아님 (${n ? NCR_STATUS_NAMES[n.status] : '불량 처리 기록 없음'})`);
    if (n.station !== req.station) return ng('REPAIR', `${req.serial} 재검사는 검출 설비 ${n.station}에서`);
  }

  // 4. ROUTE: 공정 순서
  const r = route(req, ctx, line);
  if (r) {
    if (r.verdict === 'WAIT' && routeWaitedMs > ROUTE_GRACE_SEC * 1000) return ng('ROUTE', `${r.reason} · ${ROUTE_GRACE_SEC}초 넘게 실적 없음`);
    return r;
  }

  // 5. WO: 투입 공정은 진행 중인 작업지시와 기종이 맞아야 한다
  if (req.step === line.release) {
    if (req.wo == null) return ng('WO', '작업지시 없이 투입');
    const wo = ctx.wo(req.wo);
    if (!wo) return ng('WO', `작업지시 #${req.wo} 없음`);
    if (wo.status !== 'RUNNING') return ng('WO', `${wo.code} ${WO_STATUS_NAMES[wo.status]} 상태`);
    if (req.variant && req.variant !== wo.variant) return ng('WO', `기종 ${req.variant} ≠ 작업지시 ${wo.code} ${wo.variant}`);
  }

  // 6. FA: 초물 판정 대기 중이면 초물 자신만 통과
  const fa = ctx.faPending(req.station);
  if (fa && !req.fa) return wait('FA', `초물 판정 대기: ${fa.detail}`);

  return OK;
}
