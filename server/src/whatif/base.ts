import { BadRequestException } from '@nestjs/common';
import {
  FACTORY,
  LINES,
  PM_REASON,
  STATIONS,
  type LineCode,
  type SimStatusMsg,
  type StationState,
  type WhatIfBase,
  type WhatIfBaseLine,
  type WhatIfBaseOrder,
  type WhatIfBaseSource,
  type WhatIfBaseStation,
  type WorkOrderView,
} from '@lumitwin/shared';

// What-if 기준 상태 만들기 (순수 함수): 실시간 계층·실행 MES·상태 감시의 값을 받아 시뮬레이터에 넘길 WhatIfBase로 바꾼다.
// 서비스가 값을 모아 넘기고, 테스트가 같은 함수를 확인한다.

/** 시뮬레이터 마모 모델의 진동 이득: 진동 = 신품값 × (1 + 6·마모²) (sim engine.py VIB_WEAR_GAIN과 같아야 한다) */
export const VIB_WEAR_GAIN = 6;

export const NO_SIM_MESSAGE = '시뮬레이터 상태가 없어 지금 상태로 시작할 수 없습니다 (clean으로 돌리세요)';

const SCENARIO_IDS = new Set(FACTORY.scenarios.map((s) => s.id));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** 평활 진동으로 마모 모델을 거꾸로 푼다: 마모 = √(max(0, 진동 ÷ 신품값 − 1) ÷ 6), 0~1로 자름 */
export function wearFromVib(vib: number, baseVib: number): number {
  if (!(baseVib > 0) || !Number.isFinite(vib)) return 0;
  const w = Math.sqrt(Math.max(0, vib / baseVib - 1) / VIB_WEAR_GAIN);
  return Math.min(1, Math.round(w * 1000) / 1000);
}

export type BaseOrderInput = Pick<WorkOrderView, 'id' | 'code' | 'line' | 'variant' | 'qty' | 'seq' | 'status' | 'released' | 'doneQty' | 'releasing'>;

export interface BaseInput {
  source: WhatIfBaseSource;
  /** 시뮬레이터 상태 메시지 (연결이 끊겼으면 null) */
  sim: SimStatusMsg | null;
  /** 실시간 설비 상태 */
  stations: Record<string, { state: StationState; reason?: string }>;
  /** 예지 보전 설비의 평활 진동 (mm/s, 표본이 없으면 null) */
  vib: Record<string, number | null | undefined>;
  /** 실행 MES 작업지시 (진행·대기만 써도 되고 전부 넘겨도 된다) */
  orders: BaseOrderInput[];
  /** AMR 상태: 싣고 가는 중인 묶음(load)을 그 이송의 도착 버퍼에 더한다 (없으면 넣지 않는다) */
  amrs?: Record<string, { transfer: string; load: number }>;
  /** 실시간 계층의 가상 시각 (clean 시작 시각) */
  virtualNow: string | null;
  /** 지금 실제 시각 (ms) */
  nowMs: number;
}

/**
 * 라인별 작업지시: 투입 중(RUNNING) 하나를 맨 앞에, 대기(PLANNED)를 seq 순으로.
 * RUNNING이 둘 이상이면(앞 지시는 투입을 마치고 재공만 남음) 투입 중인 것만 넣는다. 나머지 수를 함께 돌려준다
 */
export function baseLines(orders: BaseOrderInput[], sim: SimStatusMsg | null): { lines: Record<LineCode, WhatIfBaseLine>; finishing: number } {
  let finishing = 0;
  const lines = {} as Record<LineCode, WhatIfBaseLine>;
  for (const l of LINES) {
    const mine = orders.filter((o) => o.line === l.code);
    const running = mine.filter((o) => o.status === 'RUNNING').sort((a, b) => a.seq - b.seq);
    const cur = running.find((o) => o.releasing) ?? running.find((o) => o.released < o.qty);
    finishing += running.filter((o) => o !== cur).length;
    const planned = mine.filter((o) => o.status === 'PLANNED').sort((a, b) => a.seq - b.seq);
    const list: WhatIfBaseOrder[] = [...(cur ? [cur] : []), ...planned].map((o) => ({
      id: o.id,
      code: o.code,
      variant: o.variant,
      qty: o.qty,
      status: o.status === 'RUNNING' ? 'RUNNING' : 'PLANNED',
      released: o.status === 'RUNNING' ? Math.max(0, o.released) : 0,
      done: Math.max(0, o.doneQty),
    }));
    lines[l.code] = { variant: sim?.lines?.[l.code]?.variant ?? cur?.variant ?? null, orders: list };
  }
  return { lines, finishing };
}

/** 기준 상태. live인데 시뮬레이터 상태가 없으면 400 */
export function buildBase(input: BaseInput): WhatIfBase {
  const { lines, finishing } = baseLines(input.orders, input.sim);
  const notes: string[] = [];
  if (finishing) notes.push(`투입을 마치고 재공만 남은 작업지시 ${finishing}건은 계획에 넣지 않았습니다 (라인 안 재공은 버퍼·설비 안 개수로만 이어집니다)`);

  if (input.source === 'clean') {
    notes.unshift('초기화한 공장에서 시작합니다: 재공은 버퍼 절반, 마모는 무작위이고 지금 고장·보전·공정 이상은 넣지 않았습니다');
    if (!input.virtualNow) notes.push('시뮬레이터 가상 시각을 몰라 서버 시각에서 시작합니다');
    notes.push('인터록 대기(초물 수동 판정·Hold)는 반영하지 않습니다');
    return { source: 'clean', startAt: input.virtualNow ?? new Date(input.nowMs).toISOString(), lines, notes };
  }

  const sim = input.sim;
  if (!sim || !Number.isFinite(Date.parse(sim.t))) throw new BadRequestException(NO_SIM_MESSAGE);
  const simMs = Date.parse(sim.t);

  // 설비: 고장 중 → DOWN, 계획 보전 사유로 정지 → PM. 작업자 정지·셋업은 시작하자마자 다시 돈다고 본다
  const stations: Record<string, WhatIfBaseStation> = {};
  let down = 0;
  let pm = 0;
  let halted = 0;
  for (const [code, s] of Object.entries(input.stations)) {
    if (!STATIONS[code]) continue;
    if (s.state === 'DOWN') {
      stations[code] = { state: 'DOWN' };
      down++;
    } else if (s.state === 'STOP' && s.reason === PM_REASON) {
      stations[code] = { state: 'PM' };
      pm++;
    } else if (s.state === 'STOP' || s.state === 'SETUP') {
      halted++;
    }
  }
  // 마모: 예지 보전 설비(health가 있는 것)만, 진동 표본이 있을 때
  let noVib = 0;
  for (const [code, def] of Object.entries(STATIONS)) {
    if (!def.health) continue;
    const v = input.vib[code];
    if (v == null || !Number.isFinite(v)) {
      noVib++;
      continue;
    }
    stations[code] = { ...(stations[code] ?? { state: input.stations[code]?.state ?? 'RUN' }), wear: wearFromVib(v, def.health.vib) };
  }

  const scenarios = (sim.scenarios ?? [])
    .filter((s) => SCENARIO_IDS.has(s.id))
    .map((s) => ({ id: s.id, elapsedMin: r1(Math.max(0, (simMs - (Date.parse(s.startedAt) || simMs)) / 60_000)) }));

  // 설비 안 개체(셋업·가공·배출 대기)는 남은 가공 시간과 함께 그대로 이어 간다. 옛 시뮬레이터면 상태 메시지에 없다
  const inproc: Record<string, [number, number][]> = {};
  let inside = 0;
  for (const [code, slots] of Object.entries(sim.inproc ?? {})) {
    if (!STATIONS[code] || !Array.isArray(slots)) continue;
    const ok = slots.filter((x): x is [number, number] => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1]));
    inproc[code] = ok.map(([n, left]) => [Math.max(0, Math.round(n)), Math.max(0, left)]);
    inside += inproc[code].reduce((a, [n]) => a + n, 0);
  }
  // AMR이 싣고 가는 중인 묶음은 도착 버퍼에 이미 닿은 것으로 본다 (남은 주행 시간만큼 일찍 도착한다)
  const inbound: Record<string, number> = { ...(sim.inbound ?? {}) };
  let carried = 0;
  for (const a of Object.values(input.amrs ?? {})) {
    if (a && a.load > 0 && a.transfer in inbound) {
      inbound[a.transfer] += a.load;
      carried += a.load;
    }
  }

  if (sim.inproc) notes.push(`설비 안에서 가공·셋업·배출 대기 중이던 개체 ${inside}개는 남은 가공 시간과 함께 이어 갑니다 (가공 중 멈춘 시간은 모릅니다)`);
  else notes.push('시뮬레이터가 설비 안 개체를 보내지 않아(옛 버전) 설비 안은 비운 채 시작합니다 (터널형은 가득 찬 채)');
  if (carried) notes.push(`AMR이 싣고 가던 ${carried}개는 도착 버퍼에 이미 닿은 것으로 봤습니다`);
  if (down) notes.push(`고장 중인 설비 ${down}대의 남은 수리 시간은 평균 수리 시간 분포에서 새로 뽑습니다`);
  if (pm) notes.push(`보전 중인 설비 ${pm}대는 시작하자마자 보전을 처음부터 다시 합니다`);
  if (halted) notes.push(`작업자 정지·셋업 중인 설비 ${halted}대는 시작하자마자 다시 돈다고 봤습니다`);
  const held = Object.values(sim.lines ?? {}).reduce((a, x) => a + (x?.ngPen ?? 0) + (x?.repair ?? 0) + (x?.quarantine ?? 0), 0);
  if (held) notes.push(`불량 대기·수리대·격리 구역의 개체 ${held}개는 넣지 않았습니다`);
  if (noVib) notes.push(`진동 표본이 없는 예지 보전 설비 ${noVib}대는 마모를 모르므로 시뮬레이터 기본값으로 둡니다`);
  notes.push('인터록 대기(초물 수동 판정·Hold)는 반영하지 않습니다');

  return {
    source: 'live',
    startAt: new Date(simMs).toISOString(),
    lines,
    buffers: { ...(sim.buffers ?? {}) },
    inbound,
    ...(sim.inproc ? { inproc } : {}),
    stations,
    scenarios,
    notes,
  };
}
