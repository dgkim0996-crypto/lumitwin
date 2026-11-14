import { WO_AHEAD, productSteps, stepOf, type LineDef, type WoPlanSlot, type WoStatus } from '@lumitwin/shared';

/**
 * 생산 계획 (순수 함수): 자동 계획 보충, 기종별 투입 간격, 대기 순서의 예상 시작·끝.
 * 시각은 모두 가상 시각 (ms)이다.
 */

export interface PlanOrder {
  id: number;
  variant: string;
  qty: number;
  seq: number;
  status: WoStatus;
  released: number;
  startedAt: string | null;
}

/** 기종 목록에서 prev 다음 기종 (번갈아). prev가 없으면 첫 기종 */
export function nextVariant(line: LineDef, prev?: string | null): string {
  const vs = line.variants.map((v) => v.code);
  const i = prev ? vs.indexOf(prev) : -1;
  return vs[(i + 1) % vs.length];
}

/**
 * 자동 계획: 대기(PLANNED) 건이 ahead보다 적으면 채울 기종 목록.
 * 기종은 순서상 마지막 작업지시(중단 제외) 다음 기종부터 번갈아 낸다 → 작업지시마다 기종 변경이 생긴다
 */
export function autoFill(line: LineDef, orders: PlanOrder[], ahead = WO_AHEAD): string[] {
  const planned = orders.filter((o) => o.status === 'PLANNED').length;
  const need = Math.max(0, ahead - planned);
  let last = orders
    .filter((o) => o.status !== 'CANCELLED')
    .sort((a, b) => a.seq - b.seq)
    .at(-1)?.variant;
  const out: string[] = [];
  for (let i = 0; i < need; i++) {
    last = nextVariant(line, last);
    out.push(last);
  }
  return out;
}

/**
 * 이 기종의 한 개 투입 간격 (초): 계획 택트와 제품 경로 공정의 병목 중 큰 값.
 * 공정별 처리 능력 = Σ 설비 (동시 투입 × 배치 × 분할) ÷ (사이클 × 기종 배수). 예: BMS 고용량형은 FCT 사이클이 1.15배라 택트보다 느리다
 */
export function pitchSec(line: LineDef, variant: string): number {
  const v = line.variants.find((x) => x.code === variant);
  let worst = 0;
  for (const step of productSteps(line)) {
    const sts = line.stations.filter((s) => s.step === step && !s.aux && s.cycle > 0);
    if (!sts.length) continue;
    const split = stepOf(line, step)?.split ?? 1;
    const perSec = sts.reduce((a, s) => a + ((s.slots ?? 1) * (s.batch ?? 1) * split) / (s.cycle * (v?.cycle?.[s.code] ?? 1)), 0);
    if (perSec > 0) worst = Math.max(worst, 1 / perSec);
  }
  return Math.max(line.taktSec, Math.round(worst * 10) / 10);
}

/**
 * 기종 변경 셋업 (분): 라인 설비 셋업의 합. 셋업은 투입 공정부터 물결처럼 차례로 일어나고 사이 버퍼가 작아(3개)
 * 앞 설비가 곧 막히므로, 라인 끝 출력이 늦어지는 시간을 보수적으로 합으로 본다 (assumed)
 */
export function setupMinutes(line: LineDef): number {
  return line.changeover.reduce((a, c) => a + c.minutes, 0);
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * 대기 순서의 예상 투입 시각. 지금 투입 중인 작업지시의 남은 수부터 이어서, 앞뒤 기종이 다르면 셋업 시간을 더한다.
 * releasingId = 지금 투입 중인 작업지시 (없으면 lastVariant가 라인에 걸린 기종)
 */
export function schedule(line: LineDef, orders: PlanOrder[], nowMs: number, releasingId: number | null, lastVariant: string | null): Map<number, WoPlanSlot> {
  const out = new Map<number, WoPlanSlot>();
  let t = nowMs;
  let prev = lastVariant;
  const setup = setupMinutes(line);
  const cur = releasingId != null ? orders.find((o) => o.id === releasingId && o.status === 'RUNNING') : undefined;
  if (cur) {
    const p = pitchSec(line, cur.variant);
    const left = Math.max(0, cur.qty - cur.released);
    const end = t + left * p * 1000;
    out.set(cur.id, { start: cur.startedAt ?? iso(t), end: iso(end), changeover: false, setupMin: 0, pitchSec: p });
    t = end;
    prev = cur.variant;
  }
  for (const o of orders.filter((x) => x.status === 'PLANNED').sort((a, b) => a.seq - b.seq)) {
    const p = pitchSec(line, o.variant);
    const change = prev != null && prev !== o.variant;
    const start = t + (change ? setup * 60_000 : 0);
    const end = start + o.qty * p * 1000;
    out.set(o.id, { start: iso(start), end: iso(end), changeover: change, setupMin: change ? setup : 0, pitchSec: p });
    t = end;
    prev = o.variant;
  }
  return out;
}

/**
 * 대기 작업지시의 새 seq. ids 순서대로 앞에 두고, 빠진 대기 건은 원래 순서대로 뒤에 붙인다.
 * seq 값 자체는 기존 대기 건들이 쓰던 값을 작은 것부터 다시 나눠 준다 (진행·완료 건의 seq와 섞이지 않게)
 */
export function reorder(planned: { id: number; seq: number }[], ids: number[]): Map<number, number> {
  const bySeq = [...planned].sort((a, b) => a.seq - b.seq);
  const known = new Set(bySeq.map((p) => p.id));
  const picked = [...new Set(ids)].filter((id) => known.has(id));
  const rest = bySeq.map((p) => p.id).filter((id) => !picked.includes(id));
  const order = [...picked, ...rest];
  const seqs = bySeq.map((p) => p.seq);
  return new Map(order.map((id, i) => [id, seqs[i]]));
}
