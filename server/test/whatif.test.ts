/* eslint-disable @typescript-eslint/no-explicit-any -- 결과(JSON)를 그대로 들여다본다 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  LINES,
  PM_REASON,
  WHATIF_LIMITS,
  lineOf,
  type AssistantEvent,
  type SimStatusMsg,
  type StationState,
  type WhatIfBase,
  type WhatIfRep,
  type WhatIfRequest,
  type WorkOrderView,
} from '@lumitwin/shared';
import { MesTools } from '../src/assistant/assistant.mes-tools';
import { TOOL_DEFS, toolLabel } from '../src/assistant/assistant.tools';
import { MockProvider } from '../src/assistant/providers/mock.provider';
import { pitchSec, reorder, setupMinutes } from '../src/execution/planner';
import { lineOee } from '../src/insights/calc';
import { aggregate, planEnds } from '../src/whatif/aggregate';
import { NO_SIM_MESSAGE, VIB_WEAR_GAIN, buildBase, wearFromVib, type BaseInput, type BaseOrderInput } from '../src/whatif/base';
import { NEW_ID_BASE, normalizeRequest } from '../src/whatif/validate';
import { SimRunError, findSimDir, type SimRunner } from '../src/whatif/whatif.runner';
import { RESTART_MESSAGE, WhatIfService } from '../src/whatif/whatif.service';

// 가상 시각 11-16 10:00 (한국)
const T = '2026-11-16T01:00:00.000Z';
const min = (m: number) => new Date(Date.parse(T) + m * 60_000).toISOString();
const HL = lineOf('HL');

function order(p: Partial<BaseOrderInput> & Pick<BaseOrderInput, 'id' | 'line' | 'variant' | 'status' | 'seq'>): BaseOrderInput {
  return { code: `WO-${p.line}-261116-${String(p.id).padStart(3, '0')}`, qty: 96, released: 0, doneQty: 0, releasing: false, ...p };
}

const ORDERS: BaseOrderInput[] = [
  // 투입을 마치고 재공만 남은 지시 (기준 상태에서 뺀다)
  order({ id: 10, line: 'HL', variant: 'HL-VX1-R', status: 'RUNNING', seq: 2, released: 96, doneQty: 90 }),
  order({ id: 11, line: 'HL', variant: 'HL-VX1-L', status: 'RUNNING', seq: 3, released: 40, doneQty: 30, releasing: true }),
  order({ id: 13, line: 'HL', variant: 'HL-VX1-L', status: 'PLANNED', seq: 5 }),
  order({ id: 12, line: 'HL', variant: 'HL-VX1-R', status: 'PLANNED', seq: 4 }),
  order({ id: 21, line: 'EM', variant: 'BMS-12V-H', status: 'PLANNED', seq: 1, qty: 160 }),
];

const SIM: SimStatusMsg = {
  t: T,
  startedAt: min(-600),
  speed: 10,
  running: true,
  scenarios: [
    { id: 'HL-VAC-LEAK', startedAt: min(-30), level: 1 },
    { id: 'NO-SUCH', startedAt: min(-5), level: 1 },
  ],
  buffers: { 'HL.IM-L': 5, 'EM.SMT-B': 2 },
  inbound: { 'T-LED': 3 },
  warehouse: {},
  escaped: {},
  lines: {
    HL: { wo: { id: 11, code: 'WO-HL-261116-011', variant: 'HL-VX1-L', qty: 96, released: 40 }, variant: 'HL-VX1-L', waitingWo: false, ngPen: 2, repair: 1, quarantine: 0 },
  },
};

const STATES: Record<string, { state: StationState; reason?: string }> = {
  'HL-IM-L1': { state: 'DOWN', reason: '히터 단선' },
  'HL-VM-01': { state: 'STOP', reason: PM_REASON },
  'HL-AS-01': { state: 'STOP', reason: '휴식' },
  'EM-RF-B': { state: 'SETUP' },
  'OSM-AS-01': { state: 'RUN' },
};

// HL-IM-L1 신품 진동 1.05 → 마모 0.5면 1.05 × (1 + 6 × 0.25) = 2.625
const VIB: Record<string, number | null> = { 'HL-IM-L1': 2.625, 'HL-AS-01': 0.66, 'HL-PK-01': 0.5, 'EM-MT-L': null };

function input(p: Partial<BaseInput> = {}): BaseInput {
  return { source: 'live', sim: SIM, stations: STATES, vib: VIB, orders: ORDERS, virtualNow: T, nowMs: Date.parse('2026-11-16T05:00:00Z'), ...p };
}

const cleanBase = () => buildBase(input({ source: 'clean' }));

function badRequest(fn: () => unknown, re: RegExp) {
  assert.throws(fn, (e: unknown) => e instanceof BadRequestException && re.test(String((e as BadRequestException).message)));
}

// ───────────── 기준 상태 ─────────────

describe('What-if 기준 상태', () => {
  it('진동으로 마모를 거꾸로 푼다 (진동 = 신품값 × (1 + 6·마모²))', () => {
    for (const w of [0, 0.3, 0.7, 1]) assert.equal(wearFromVib(1.05 * (1 + 6 * w * w), 1.05), w);
    assert.equal(wearFromVib(0.9, 1.05), 0, '신품값보다 낮으면 0');
    assert.equal(wearFromVib(1.05 * 20, 1.05), 1, '1을 넘으면 자른다');
  });

  it('마모 이득은 시뮬레이터 engine.py의 VIB_WEAR_GAIN과 같다', () => {
    const dir = findSimDir();
    assert.ok(dir, 'sim 폴더를 찾아야 한다');
    const m = readFileSync(path.join(dir, 'lumisim', 'engine.py'), 'utf8').match(/^VIB_WEAR_GAIN\s*=\s*([\d.]+)/m);
    assert.ok(m, 'engine.py에 VIB_WEAR_GAIN이 있어야 한다');
    assert.equal(Number(m[1]), VIB_WEAR_GAIN);
  });

  it('live: 고장 → DOWN, 계획 보전 정지 → PM, 마모, 시나리오 경과 분, 버퍼를 넣는다', () => {
    const b = buildBase(input());
    assert.equal(b.source, 'live');
    assert.equal(b.startAt, T);
    assert.deepEqual(b.stations!['HL-IM-L1'], { state: 'DOWN', wear: 0.5 });
    assert.deepEqual(b.stations!['HL-VM-01'], { state: 'PM' }, '진동 표본이 없으면 마모는 넣지 않는다');
    assert.deepEqual(b.stations!['HL-AS-01'], { state: 'STOP', wear: 0 }, '작업자 정지는 상태만 참고로 남는다');
    assert.equal(b.stations!['HL-PK-01'].wear, 0);
    assert.equal(b.stations!['EM-RF-B'], undefined, '셋업 중·마모 모름 → 넣지 않음');
    assert.equal(b.stations!['EM-MT-L'], undefined);
    assert.deepEqual(b.scenarios, [{ id: 'HL-VAC-LEAK', elapsedMin: 30 }], '공장 정의에 없는 시나리오는 뺀다');
    assert.deepEqual(b.buffers, SIM.buffers);
    assert.deepEqual(b.inbound, SIM.inbound);
    const notes = b.notes.join('\n');
    assert.match(notes, /고장 중인 설비 1대/);
    assert.match(notes, /작업자 정지·셋업 중인 설비 2대/);
    assert.match(notes, /불량 대기·수리대·격리 구역의 개체 3개/);
    assert.match(notes, /재공만 남은 작업지시 1건/);
    assert.match(notes, /인터록 대기/);
  });

  it('설비 안 개체는 남은 가공 시간과 함께 넣고, AMR이 싣고 가던 묶음은 도착 버퍼에 더한다', () => {
    const sim: SimStatusMsg = {
      ...SIM,
      inproc: { 'HL-VM-01': [[24, 610.4]], 'HL-HC-01': [[1, 12], [1, -3]], 'HL-AS-01': [], 'NO-SUCH': [[1, 5]] },
    };
    const amrs = { 'AMR-01': { transfer: 'T-LED', load: 20 }, 'AMR-02': { transfer: 'T-HL-FG', load: 30 }, 'AMR-03': { transfer: 'T-LED', load: 0 } };
    const b = buildBase(input({ sim, amrs }));
    assert.deepEqual(b.inproc, { 'HL-VM-01': [[24, 610.4]], 'HL-HC-01': [[1, 12], [1, 0]], 'HL-AS-01': [] }, '모르는 설비는 빼고 음수 남은 시간은 0');
    assert.deepEqual(b.inbound, { 'T-LED': 23 }, '도착 버퍼가 있는 이송(라인 사이)만 더한다. 창고행은 뺀다');
    const notes = b.notes.join('\n');
    assert.match(notes, /설비 안에서 가공·셋업·배출 대기 중이던 개체 26개/);
    assert.match(notes, /AMR이 싣고 가던 20개/);
    assert.deepEqual(SIM.inbound, { 'T-LED': 3 }, '원본 상태 메시지는 바꾸지 않는다');

    const old = buildBase(input());
    assert.equal(old.inproc, undefined, '옛 시뮬레이터(inproc 없음)면 넣지 않는다');
    assert.match(old.notes.join('\n'), /설비 안 개체를 보내지 않아/);
    assert.equal(cleanBase().inproc, undefined);
  });

  it('라인: 투입 중 지시를 맨 앞에, 대기는 seq 순. released·done을 넣고 기종은 시뮬레이터 상태에서', () => {
    const b = buildBase(input());
    assert.deepEqual(
      b.lines.HL.orders.map((o) => [o.id, o.status, o.released, o.done]),
      [
        [11, 'RUNNING', 40, 30],
        [12, 'PLANNED', 0, 0],
        [13, 'PLANNED', 0, 0],
      ],
    );
    assert.equal(b.lines.HL.variant, 'HL-VX1-L');
    assert.deepEqual(b.lines.EM.orders.map((o) => o.id), [21]);
    assert.equal(b.lines.EM.variant, null);
    assert.deepEqual(b.lines.OSM, { variant: null, orders: [] });
  });

  it('live인데 시뮬레이터 상태가 없으면 400', () => {
    badRequest(() => buildBase(input({ sim: null })), new RegExp(NO_SIM_MESSAGE.slice(0, 10)));
  });

  it('clean: 버퍼·설비·시나리오 없이 가상 시각(없으면 서버 시각)에서', () => {
    const b = cleanBase();
    assert.equal(b.source, 'clean');
    assert.equal(b.startAt, T);
    assert.equal(b.stations, undefined);
    assert.equal(b.buffers, undefined);
    assert.equal(b.scenarios, undefined);
    assert.equal(b.lines.HL.orders.length, 3);
    const noClock = buildBase(input({ source: 'clean', sim: null, virtualNow: null }));
    assert.equal(noClock.startAt, '2026-11-16T05:00:00.000Z');
    assert.match(noClock.notes.join('\n'), /서버 시각/);
  });
});

// ───────────── 요청 검사 ─────────────

const req = (p: Record<string, unknown> = {}) => ({ horizonH: 8, reps: 5, base: 'clean', scenarios: [{ name: '지금 계획' }], ...p });
const norm = (body: unknown, base: WhatIfBase = cleanBase()) => normalizeRequest(body, () => base);

describe('What-if 요청 검사', () => {
  it('계획에서 빠진 라인은 기준 순서, 시뮬레이터 입력은 모든 라인을 채운다', () => {
    const n = norm(req());
    assert.deepEqual(Object.keys(n.sim[0].orders).sort(), ['EM', 'HL', 'OSM']);
    assert.deepEqual(n.sim[0].orders.HL.map((o) => [o.id, o.released]), [[11, 40], [12, 0], [13, 0]]);
    assert.deepEqual(n.sim[0].orders.OSM, []);
    assert.equal(n.sim[0].autoFill, true);
    assert.deepEqual(n.sim[0].events, []);
    assert.equal(n.request.scenarios[0].orders, undefined, '사람이 안 건드린 라인은 요청에 남기지 않는다');
  });

  it('투입 중 지시가 빠졌으면 맨 앞에 넣고, 새 지시는 NEW id·코드를 붙인다', () => {
    const n = norm(req({ scenarios: [{ name: '순서 변경', orders: { HL: [{ id: 13, variant: 'HL-VX1-L', qty: 50, dueMin: 120 }, { variant: 'HL-VX1-R', qty: 10, code: '시험 지시' }, { id: 12, variant: 'HL-VX1-R', qty: 96 }] }, autoFill: false }] }));
    const hl = n.sim[0].orders.HL;
    assert.deepEqual(hl.map((o) => o.id), [11, 13, NEW_ID_BASE + 1, 12]);
    assert.deepEqual(hl.map((o) => o.code), ['WO-HL-261116-011', 'WO-HL-261116-013', 'NEW-HL-1', 'WO-HL-261116-012']);
    assert.equal(hl[0].released, 40);
    assert.equal(hl[1].qty, 50);
    assert.equal(hl[1].dueMin, 120);
    assert.equal(n.sim[0].autoFill, false);
    const r = n.request.scenarios[0].orders!.HL!;
    assert.deepEqual(r.map((o) => o.code), ['WO-HL-261116-011', 'WO-HL-261116-013', '시험 지시', 'WO-HL-261116-012'], '요청에는 화면 이름이 남는다');
    assert.equal(r[2].id, undefined);
    assert.deepEqual(n.sim[0].orders.EM.map((o) => o.id), [21]);
  });

  it('투입 중 지시가 다른 자리에 있으면 맨 앞으로 옮기고 기종·수량 변경은 무시한다 (납기는 쓴다)', () => {
    const n = norm(req({ scenarios: [{ name: 'x', orders: { HL: [{ id: 12, variant: 'HL-VX1-R', qty: 96 }, { id: 11, variant: 'HL-VX1-R', qty: 5, dueMin: 60 }] } }] }));
    const hl = n.sim[0].orders.HL;
    assert.deepEqual(hl.map((o) => [o.id, o.variant, o.qty]), [[11, 'HL-VX1-L', 96], [12, 'HL-VX1-R', 96]]);
    assert.equal(hl[0].dueMin, 60);
    assert.equal(n.request.scenarios[0].orders!.HL!.length, 2, '계획에서 뺀 13은 빠진 채로 둔다');
  });

  it('한도·계산량', () => {
    badRequest(() => norm(req({ horizonH: 0.5 })), /horizonH/);
    badRequest(() => norm(req({ horizonH: 25 })), /horizonH/);
    badRequest(() => norm(req({ reps: 11 })), /reps/);
    badRequest(() => norm(req({ reps: 2.5 })), /reps/);
    badRequest(() => norm(req({ scenarios: [] })), /계획은 1 ~ 3개/);
    badRequest(() => norm(req({ scenarios: [1, 2, 3, 4].map((i) => ({ name: `p${i}` })) })), /계획은 1 ~ 3개/);
    badRequest(() => norm(req({ base: 'other' })), /base/);
    const three = [1, 2, 3].map((i) => ({ name: `p${i}` }));
    badRequest(() => norm(req({ horizonH: 24, reps: 10, scenarios: three })), new RegExp(`한도 ${WHATIF_LIMITS.budgetH}시간`));
    assert.equal(norm(req({ horizonH: 8, reps: 10, scenarios: three })).sim.length, 3, '8 × 10 × 3 = 240시간은 된다');
    // 숫자 칸이 틀리면 기준 상태를 만들지 않는다 (live인데 시뮬레이터가 없어도 숫자 오류가 먼저)
    badRequest(() => normalizeRequest(req({ reps: 0 }), () => { throw new Error('불리면 안 된다'); }), /reps/);
  });

  it('이름·사건·작업지시 검사', () => {
    badRequest(() => norm(req({ scenarios: [{ name: '  ' }] })), /이름은 1 ~ 30자/);
    badRequest(() => norm(req({ scenarios: [{ name: 'x'.repeat(31) }] })), /이름은 1 ~ 30자/);
    const ev = (e: unknown) => norm(req({ scenarios: [{ name: 'e', events: [e] }] }));
    badRequest(() => ev({ kind: 'down', station: 'NO-SUCH', atMin: 0, minutes: 10 }), /없는 설비/);
    badRequest(() => ev({ kind: 'down', station: 'HL-AS-01', atMin: 480, minutes: 10 }), /480분 미만/);
    badRequest(() => ev({ kind: 'down', station: 'HL-AS-01', atMin: -1, minutes: 10 }), /atMin/);
    badRequest(() => ev({ kind: 'down', station: 'HL-AS-01', atMin: 0, minutes: 0 }), /1 ~ 720분/);
    badRequest(() => ev({ kind: 'down', station: 'HL-AS-01', atMin: 0, minutes: 721 }), /1 ~ 720분/);
    badRequest(() => ev({ kind: 'scenario', id: 'NO-SUCH', on: true, atMin: 0 }), /없는 공정 이상/);
    badRequest(() => ev({ kind: 'scenario', id: 'HL-VAC-LEAK', atMin: 0 }), /on/);
    badRequest(() => ev({ kind: 'boom', atMin: 0 }), /down·pm·scenario/);
    badRequest(() => norm(req({ scenarios: [{ name: 'e', events: Array.from({ length: 13 }, () => ({ kind: 'pm', station: 'HL-AS-01', atMin: 0 })) }] })), /12개까지/);
    const ok = ev({ kind: 'scenario', id: 'HL-VAC-LEAK', on: true, atMin: 30, extra: 1 });
    assert.deepEqual(ok.request.scenarios[0].events, [{ kind: 'scenario', id: 'HL-VAC-LEAK', on: true, atMin: 30 }], '모르는 칸은 버린다');

    const ords = (list: unknown, line = 'HL') => norm(req({ scenarios: [{ name: 'o', orders: { [line]: list } }] }));
    badRequest(() => ords([{ variant: 'BMS-12V-S', qty: 10 }]), /헤드램프.*없는 기종|없는 기종/);
    badRequest(() => ords([{ variant: 'HL-VX1-L', qty: 0 }]), /수량/);
    badRequest(() => ords([{ variant: 'HL-VX1-L', qty: 2001 }]), /수량/);
    badRequest(() => ords([{ variant: 'HL-VX1-L', qty: 1.5 }]), /수량/);
    badRequest(() => ords([{ id: 99, variant: 'HL-VX1-L', qty: 10 }]), /#99/);
    badRequest(() => ords([{ id: 21, variant: 'HL-VX1-L', qty: 10 }]), /#21/, );
    badRequest(() => ords([{ id: 12, variant: 'HL-VX1-R', qty: 96 }, { id: 12, variant: 'HL-VX1-R', qty: 96 }]), /두 번/);
    badRequest(() => ords([{ variant: 'HL-VX1-L', qty: 10, dueMin: -5 }]), /납기/);
    badRequest(() => ords(Array.from({ length: 13 }, () => ({ variant: 'HL-VX1-L', qty: 1 }))), /12건까지/);
    badRequest(() => ords([], 'XX'), /없는 라인/);
    badRequest(() => norm(req({ scenarios: [{ name: 'a', autoFill: 'yes' }] })), /autoFill/);
  });
});

// ───────────── 집계 ─────────────

type St = WhatIfRep['stations'][string];
const st = (ok: number, ng: number, sec: St['sec'], failures = 0): St => ({ ok, ng, sec, failures });
const lines0 = (hl: Partial<WhatIfRep['lines']['HL']>): WhatIfRep['lines'] =>
  Object.fromEntries(LINES.map((l) => [l.code, { out: 0, scrap: 0, repaired: 0, changeovers: 0, hourly: [0, 0], ...(l.code === 'HL' ? hl : {}) }])) as WhatIfRep['lines'];
type RO = WhatIfRep['orders'][number];
const ro = (id: number, code: string, finishedSec: number | null, done = 0, variant = 'HL-VX1-L'): RO => ({ line: 'HL', id, code, variant, qty: 96, released: 96, done, scrap: 0, finishedSec });

function aggFixture() {
  const base = cleanBase();
  const n = norm(req({ horizonH: 2, reps: 2, scenarios: [{ name: '지금 계획', orders: { HL: [{ id: 12, variant: 'HL-VX1-R', qty: 96, dueMin: 110 }, { variant: 'HL-VX1-R', qty: 10, code: '시험 지시' }, { id: 13, variant: 'HL-VX1-L', qty: 96 }] } }] }), base);
  const rep0: WhatIfRep = {
    scenario: 0, rep: 0, seed: 100, wallMs: 1200,
    stations: { 'HL-IM-L1': st(100, 2, { RUN: 3600, DOWN: 1800, IDLE: 1800 }, 2), 'HL-AS-01': st(50, 0, { RUN: 6000, SETUP: 1200 }) },
    lines: lines0({ out: 40, scrap: 1, changeovers: 1, hourly: [15, 40] }),
    orders: [ro(11, 'WO-HL-261116-011', 1800, 96), ro(12, 'WO-HL-261116-012', 6000, 80, 'HL-VX1-R'), ro(NEW_ID_BASE + 1, 'NEW-HL-1', null, 0, 'HL-VX1-R'), ro(13, 'WO-HL-261116-013', null), ro(-1, 'AUTO-HL-1', null)],
  };
  const rep1: WhatIfRep = {
    scenario: 0, rep: 1, seed: 101, wallMs: 1300,
    stations: { 'HL-IM-L1': st(120, 0, { RUN: 7200 }), 'HL-AS-01': st(60, 1, { RUN: 5000, SETUP: 2200, STOP: 600 }) },
    lines: lines0({ out: 60, scrap: 3, changeovers: 2, hourly: [20] }),
    orders: [ro(11, 'WO-HL-261116-011', 2400, 96), ro(12, 'WO-HL-261116-012', 7000, 96, 'HL-VX1-R'), ro(NEW_ID_BASE + 1, 'NEW-HL-1', null, 4, 'HL-VX1-R'), ro(13, 'WO-HL-261116-013', null)],
  };
  // 소비 전력: HL-IM-L1만 (가동 10 · 대기 4 · 정지 1 kW)
  const kw = (code: string) => (code === 'HL-IM-L1' ? { run: 10, idle: 4, off: 1 } : null);
  const result = aggregate({ request: n.request, base, sim: n.sim, seed: 100, runs: [rep1, rep0], elapsedMs: 3000.4, kw });
  return { base, n, rep0, rep1, result };
}

describe('What-if 집계', () => {
  it('라인 생산량·시간별 누적·고장·셋업·가장 오래 멈춘 설비를 분포로', () => {
    const { result } = aggFixture();
    assert.deepEqual(result.seeds, [100, 101]);
    assert.equal(result.computeMs, 2500);
    assert.equal(result.elapsedMs, 3000);
    const s = result.scenarios[0];
    const hl = s.lines.find((l) => l.line === 'HL')!;
    assert.deepEqual(hl.out, { mean: 50, p10: 42, p90: 58, min: 40, max: 60 });
    assert.equal(hl.scrap.mean, 2);
    assert.equal(hl.changeovers.mean, 1.5);
    assert.deepEqual(hl.hourly.mean, [17.5, 30], '짧은 hourly는 마지막 값을 이어 쓴다');
    assert.equal(hl.downMin.mean, 15);
    assert.equal(hl.setupMin.mean, 28.3);
    assert.deepEqual(hl.topLoss, { station: 'HL-AS-01', minutes: 33.3 });
    assert.deepEqual(s.total.out, { mean: 50, p10: 42, p90: 58, min: 40, max: 60 }, '다른 라인은 0');
    assert.deepEqual(s.failures, [{ station: 'HL-IM-L1', mean: 1 }]);
  });

  it('OEE는 라이브와 같은 lineOee, 에너지는 kwhOf 합', () => {
    const { result, rep0, rep1 } = aggFixture();
    const hl = result.scenarios[0].lines.find((l) => l.line === 'HL')!;
    const oeeOf = (r: WhatIfRep) => {
      const times = new Map(HL.stations.map((s) => [s.code, r.stations[s.code]?.sec ?? {}]));
      const counts = new Map(HL.stations.map((s) => [s.code, { ok: r.stations[s.code]?.ok ?? 0, ng: r.stations[s.code]?.ng ?? 0 }]));
      return lineOee(HL, times, counts)!;
    };
    const o0 = oeeOf(rep0);
    const o1 = oeeOf(rep1);
    assert.equal(hl.oee.mean, Math.round(((o0.oee + o1.oee) / 2) * 1000) / 1000);
    assert.equal(hl.availability.min, Math.min(o0.availability, o1.availability));
    // rep0: 가동 1h × 10 + 대기 0.5h × 4 + 고장 0.5h × 1 = 12.5 · rep1: 2h × 10 = 20
    assert.deepEqual([hl.kwh.min, hl.kwh.max], [12.5, 20]);
    assert.equal(hl.kwhPerUnit.mean, Math.round(((12.5 / 40 + 20 / 60) / 2) * 1000) / 1000);
    const em = result.scenarios[0].lines.find((l) => l.line === 'EM')!;
    assert.equal(em.kwhPerUnit.mean, 0, '양품이 없으면 개당 전력 0');
  });

  it('작업지시: 끝낸 반복의 finishMin·납기 지킨 반복·계산식 예상·자동 계획 지시', () => {
    const { result, base, n } = aggFixture();
    const orders = result.scenarios[0].orders.filter((o) => o.line === 'HL');
    assert.deepEqual(orders.map((o) => o.code), ['WO-HL-261116-011', 'WO-HL-261116-012', '시험 지시', 'WO-HL-261116-013', 'AUTO-HL-1']);
    const [w11, w12, nw, w13, auto] = orders;
    assert.equal(w11.id, 11);
    assert.equal(w11.finishedReps, 2);
    assert.deepEqual(w11.finishMin, { mean: 35, p10: 31, p90: 39, min: 30, max: 40 });
    assert.equal(w11.onTimeReps, undefined, '납기가 없으면 세지 않는다');
    assert.equal(w12.dueMin, 110);
    assert.equal(w12.onTimeReps, 1, '100분은 지키고 116.7분은 못 지킴');
    assert.equal(w12.doneMean, 88);
    assert.equal(nw.id, undefined);
    assert.equal(nw.auto, undefined);
    assert.equal(nw.finishMin, null);
    assert.equal(nw.doneMean, 2);
    assert.equal(w13.finishedReps, 0);
    assert.equal(auto.auto, true);
    assert.equal(auto.id, undefined);
    assert.equal(auto.planEndMin, null);
    assert.equal(auto.doneMean, 0, '한 반복에만 생긴 자동 지시: 없는 반복은 0');
    // 계산식 예상: 투입 중 11은 남은 56개, 12는 기종이 바뀌어 셋업 + 96개
    const p = (v: string) => pitchSec(HL, v);
    const end11 = (56 * p('HL-VX1-L')) / 60;
    const end12 = end11 + setupMinutes(HL) + (96 * p('HL-VX1-R')) / 60;
    assert.equal(w11.planEndMin, Math.round(end11 * 10) / 10);
    assert.equal(w12.planEndMin, Math.round(end12 * 10) / 10);
    assert.equal(nw.planEndMin, Math.round((end12 + (10 * p('HL-VX1-R')) / 60) * 10) / 10, '같은 기종이 이어지면 셋업 없음');
    const ends = planEnds(HL, n.sim[0].orders.HL, base);
    assert.equal(ends.get(13), Math.round((end12 + (10 * p('HL-VX1-R')) / 60 + setupMinutes(HL) + (96 * p('HL-VX1-L')) / 60) * 10) / 10);
  });

  it('투입 중 지시가 없으면 라인에 걸린 기종과 첫 지시 기종이 다를 때 셋업을 더한다', () => {
    const base = buildBase(input({ source: 'clean', orders: [order({ id: 31, line: 'OSM', variant: 'OSM-VX1-R', status: 'PLANNED', seq: 1, qty: 10 })], sim: { ...SIM, lines: { OSM: { wo: null, variant: 'OSM-VX1-L', waitingWo: true, ngPen: 0, repair: 0, quarantine: 0 } } } }));
    const osm = lineOf('OSM');
    const n = norm(req(), base);
    assert.equal(planEnds(osm, n.sim[0].orders.OSM, base).get(31), Math.round((setupMinutes(osm) + (10 * pitchSec(osm, 'OSM-VX1-R')) / 60) * 10) / 10);
  });
});

// ───────────── 서비스 (가짜 DB·실행 MES) ─────────────

function fakePrisma() {
  const rows: any[] = [];
  let seq = 0;
  const match = (r: any, where: any = {}) =>
    Object.entries(where).every(([k, v]: [string, any]) => (v && typeof v === 'object' && 'in' in v ? v.in.includes(r[k]) : r[k] === v));
  const sortDesc = (xs: any[]) => [...xs].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  const whatIfRun = {
    create: async ({ data }: any) => {
      const row = { id: ++seq, createdAt: new Date(Date.now() + seq), result: null, error: null, elapsedMs: null, createdBy: null, runId: null, ...data };
      rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }: any) => {
      const r = rows.find((x) => x.id === where.id);
      Object.assign(r, data);
      return { ...r };
    },
    updateMany: async ({ where, data }: any) => {
      const hit = rows.filter((r) => match(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    findUnique: async ({ where }: any) => {
      const r = rows.find((x) => x.id === where.id);
      return r ? { ...r } : null;
    },
    findFirst: async ({ where }: any) => {
      const r = sortDesc(rows.filter((x) => match(x, where)))[0];
      return r ? { ...r } : null;
    },
    findMany: async ({ take }: any) => sortDesc(rows).slice(0, take).map((r) => ({ ...r })),
  };
  return { rows, prisma: { whatIfRun } };
}

function fakeExec() {
  const wos: (WorkOrderView & { note: string | null })[] = ORDERS.map((o) => ({
    ...o, doneQty: o.doneQty, scrapQty: 0, wip: 0, source: 'AUTO', createdBy: null, note: null, createdAt: T, startedAt: null, endedAt: null, plan: null,
  })) as never;
  const log: string[] = [];
  const exec = {
    wos,
    log,
    orders: (line?: string, status?: string) => {
      const want = status ? new Set(status.split(',')) : null;
      return wos.filter((w) => (!line || w.line === line) && (!want || want.has(w.status))).sort((a, b) => a.seq - b.seq);
    },
    createOrder: async (body: any) => {
      const w = { ...wos[0], id: 100 + wos.length, code: `WO-${body.line}-NEW-${wos.length}`, line: body.line, variant: body.variant, qty: body.qty, status: 'PLANNED', seq: Math.max(...wos.map((x) => x.seq)) + 1, note: body.note, released: 0, releasing: false } as never;
      wos.push(w);
      log.push(`create ${body.variant} ${body.qty}`);
      return w;
    },
    reorderOrders: (body: any) => {
      const planned = exec.orders(body.line, 'PLANNED');
      const seqs = reorder(planned, body.ids);
      for (const w of planned) w.seq = seqs.get(w.id) ?? w.seq;
      log.push(`reorder ${body.ids.join(',')}`);
      return exec.orders(body.line, 'PLANNED');
    },
  };
  return exec;
}

function setupService(runner?: SimRunner) {
  const db = fakePrisma();
  const exec = fakeExec();
  const live = { snapshot: () => ({ sim: SIM, stations: STATES, connected: { sim: true, edge: false } }), virtualNow: T };
  const health = { view: () => ({ stations: Object.entries(VIB).map(([station, vib]) => ({ station, vib })) }) };
  const writer = { currentRunId: 7 };
  const svc = new WhatIfService(db.prisma as never, live as never, exec as never, health as never, writer as never);
  const calls: any[] = [];
  svc.useRunner(
    runner ??
      (async (inp, opts) => {
        calls.push(inp);
        opts.onProgress?.(0, inp.scenarios.length * inp.reps);
        const runs: WhatIfRep[] = [];
        for (let s = 0; s < inp.scenarios.length; s++) {
          for (let r = 0; r < inp.reps; r++) {
            runs.push({ scenario: s, rep: r, seed: inp.seed + r, wallMs: 10, stations: {}, lines: lines0({ out: 100 + s * 10 + r, hourly: [50, 100] }), orders: [] });
            opts.onProgress?.(runs.length, inp.scenarios.length * inp.reps);
          }
        }
        return runs;
      }),
  );
  return { svc, db, exec, writer, calls };
}

const WHO = { login: 'lead1', name: '라인 조장', role: 'leader' as const };

describe('What-if 서비스', () => {
  it('요청을 저장(QUEUED)하고 뒤에서 계산해 DONE으로 바꾼다', async () => {
    const { svc, db, calls } = setupService();
    const view = await svc.create({ horizonH: 2, reps: 2, base: 'live', scenarios: [{ name: '지금 계획' }, { name: '고장 대비', events: [{ kind: 'down', station: 'HL-AS-01', atMin: 10, minutes: 30 }] }] }, WHO);
    assert.equal(view.status, 'QUEUED');
    assert.deepEqual(view.progress, { done: 0, total: 4 });
    assert.equal(view.createdBy, '라인 조장');
    assert.equal(view.vStartAt, T);
    assert.equal(view.base.source, 'live');
    assert.equal(db.rows[0].runId, 7);
    await svc.idle();
    const inp = calls[0];
    assert.equal(inp.horizonSec, 7200);
    assert.equal(inp.reps, 2);
    assert.ok(inp.seed >= 1 && inp.seed <= 999_999);
    assert.ok(inp.workers >= 1);
    assert.deepEqual(Object.keys(inp.scenarios[1].orders).sort(), ['EM', 'HL', 'OSM']);
    assert.equal(inp.base.lines.HL.orders[0].done, 30, '시뮬레이터가 더하는 기준 양품 수');
    const done = await svc.detail(view.id);
    assert.equal(done.status, 'DONE');
    assert.deepEqual(done.progress, { done: 4, total: 4 });
    assert.deepEqual(done.result!.scenarios.map((s) => s.total.out.mean), [100.5, 110.5]);
    assert.deepEqual(done.result!.seeds, [inp.seed, inp.seed + 1]);
    const list = await svc.list(10);
    assert.deepEqual(list[0].outMeans, [100.5, 110.5]);
    assert.equal((list[0] as any).base, undefined);
    assert.equal((list[0] as any).result, undefined);
  });

  it('실행기가 실패하면 FAILED와 이유를 남긴다', async () => {
    const { svc } = setupService(async () => {
      throw new SimRunError('시뮬레이터 가상환경이 없습니다 (npm run sim:setup)');
    });
    const view = await svc.create(req(), WHO);
    await svc.idle();
    const v = await svc.detail(view.id);
    assert.equal(v.status, 'FAILED');
    assert.match(v.error ?? '', /가상환경/);
    assert.equal(v.result, null);
  });

  it('검사 실패는 저장하지 않고 400', async () => {
    const { svc, db } = setupService();
    await assert.rejects(svc.create(req({ reps: 99 }), WHO), BadRequestException);
    assert.equal(db.rows.length, 0);
  });

  it('서버가 켜질 때 대기·계산 중으로 남은 행은 실패로', async () => {
    const { svc, db } = setupService();
    db.rows.push({ id: 50, status: 'RUNNING', createdAt: new Date() }, { id: 51, status: 'QUEUED', createdAt: new Date() }, { id: 52, status: 'DONE', createdAt: new Date() });
    await svc.onModuleInit();
    assert.deepEqual(db.rows.map((r) => [r.status, r.error ?? null]), [['FAILED', RESTART_MESSAGE], ['FAILED', RESTART_MESSAGE], ['DONE', null]]);
  });

  it('반영: 기존 대기 지시는 순서만, 새 지시는 만든 뒤 그 자리로, 빠진 지시는 그대로 둔다. 다시 눌러도 또 만들지 않는다', async () => {
    const { svc, exec } = setupService();
    const view = await svc.create(req({ base: 'live', reps: 1, horizonH: 1, scenarios: [{ name: '기준' }, { name: '우측 먼저', orders: { HL: [{ id: 12, variant: 'HL-VX1-R', qty: 96 }, { variant: 'HL-VX1-R', qty: 20 }, { id: 13, variant: 'HL-VX1-L', qty: 96 }] } }] }), WHO);
    await svc.idle();
    // 계산 뒤에 맨 앞에 끼어든 대기 지시 (계획에 없다) → 중단하지 않고 뒤에 남긴다
    exec.wos.push({ ...exec.wos[2], id: 14, code: 'WO-HL-261116-014', seq: 1 });
    const out = await svc.apply(view.id, { scenario: 1, line: 'HL' }, WHO, '127.0.0.1');
    assert.equal(out.line, 'HL');
    assert.equal(out.created.length, 1);
    const created = out.created[0];
    assert.deepEqual(exec.orders('HL', 'PLANNED').map((w) => w.id), [12, created, 13, 14]);
    assert.deepEqual(out.untouched, [14]);
    // seq는 대기 건들이 쓰던 값(1·4·5·7)을 다시 나눈다: 12는 4 → 1, 13은 5 그대로
    assert.deepEqual(out.reordered, [12]);
    assert.equal(exec.log.at(-1), `reorder 12,${created},13`, '투입 중 11은 순서 목록에 넣지 않는다');
    assert.match(exec.wos.find((w) => w.id === created)!.note ?? '', new RegExp(`What-if #${view.id} 계획 2`));
    const again = await svc.apply(view.id, { scenario: 1, line: 'HL' }, WHO);
    assert.deepEqual(again.created, [], '메모로 이미 만든 지시를 찾는다');
    assert.deepEqual(again.reordered, []);
    assert.equal(exec.log.filter((x) => x.startsWith('create')).length, 1);
  });

  it('반영: 완료 전이거나 실행이 바뀌었으면 409, 계획·라인이 틀리면 400', async () => {
    const { svc, db, writer } = setupService();
    const view = await svc.create(req({ reps: 1, horizonH: 1 }), WHO);
    db.rows[0].status = 'RUNNING';
    await assert.rejects(svc.apply(view.id, { scenario: 0, line: 'HL' }, WHO), ConflictException);
    await svc.idle();
    await assert.rejects(svc.apply(view.id, { scenario: 3, line: 'HL' }, WHO), BadRequestException);
    await assert.rejects(svc.apply(view.id, { scenario: 0, line: 'XX' }, WHO), BadRequestException);
    writer.currentRunId = 8;
    await assert.rejects(svc.apply(view.id, { scenario: 0, line: 'HL' }, WHO), /실행이 바뀌어/);
  });
});

// ───────────── AI 비서 ─────────────

function assistantFixture() {
  const { result } = aggFixture();
  const second = structuredClone(result.scenarios[0]);
  second.name = '우측 먼저';
  second.total.out.mean = 60;
  second.lines[0].out.mean = 60;
  second.lines[0].oee.mean += 0.05;
  second.orders = second.orders.map((o) => (o.dueMin != null ? { ...o, onTimeReps: 2 } : o));
  const request: WhatIfRequest = { horizonH: 2, reps: 2, base: 'live', scenarios: [{ name: '지금 계획' }, { name: '우측 먼저' }] };
  const view = {
    id: 12, status: 'DONE' as const, progress: { done: 4, total: 4 }, createdAt: T, createdBy: '라인 조장', vStartAt: T, request,
    base: { ...cleanBase(), notes: ['인터록 대기(초물 수동 판정·Hold)는 반영하지 않습니다'] }, result: { ...result, scenarios: [result.scenarios[0], second] }, error: null,
  };
  const calls: unknown[] = [];
  const whatif = { latestForAssistant: async (id?: number) => (calls.push(id), { view, pending: { id: 13, status: 'RUNNING' as const, progress: { done: 1, total: 4 } } }) };
  const mes = new MesTools({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, undefined, whatif as never);
  return { mes, calls };
}

describe('AI 비서 What-if 조회', () => {
  it('whatif_latest가 도구 목록에 있고 조회만 한다', () => {
    const names = TOOL_DEFS.map((t) => t.name);
    assert.ok(names.includes('whatif_latest'));
    assert.ok(MesTools.has('whatif_latest'));
    assert.equal(toolLabel('whatif_latest', { run_id: 3 }), 'What-if 결과 조회 · #3');
  });

  it('계획별 라인 생산량·OEE 범위, 늦는 작업지시, 기준 대비 차이를 준다', async () => {
    const { mes, calls } = assistantFixture();
    const out = await mes.run('whatif_latest', {});
    assert.equal(out.ok, true);
    assert.deepEqual(calls, [undefined]);
    const d = out.data as any;
    assert.equal(d.run.id, 12);
    assert.equal(d.run.base, '지금 공장 상태');
    assert.equal(d.scenarios.length, 2);
    const [a, b] = d.scenarios;
    assert.equal(a.isBase, true);
    assert.equal(a.vsBase, null);
    assert.deepEqual(a.lines[0].out, { mean: 50, p10: 42, p90: 58 });
    assert.equal(typeof a.lines[0].oeePct.p10, 'number');
    assert.equal(a.lateOrders, 1);
    assert.equal(a.late[0].code, 'WO-HL-261116-012');
    assert.equal(a.late[0].onTime, '1/2');
    assert.equal(b.vsBase.out, 10);
    assert.equal(b.vsBase.outPct, 20);
    assert.equal(b.vsBase.lines[0].oeePts, 5);
    assert.equal(b.vsBase.lateOrders, -1);
    assert.deepEqual(d.pending, { id: 13, status: '계산 중', progress: '1/4' });
    assert.match(out.summary, /양품 최다 '우측 먼저'/);
    assert.ok(out.refs.some((r) => r.kind === 'page' && r.id === '/whatif'));
    assert.equal((await new MesTools({} as never, {} as never, {} as never, {} as never, {} as never, {} as never).run('whatif_latest', {})).ok, false);
  });

  it('모의 모드: "What-if 계획 비교" 질문을 whatif_latest로 보내고 표로 답한다', async () => {
    const { mes } = assistantFixture();
    const called: [string, unknown][] = [];
    const spy = { run: async (name: string, inp: Record<string, unknown>) => (called.push([name, inp]), MesTools.has(name) ? mes.run(name, inp) : { ok: false, data: {}, summary: 'test', refs: [] }) };
    const provider = new MockProvider(spy as never);
    let text = '';
    const conv = { id: 't', createdAt: 0, updatedAt: 0, busy: false, messages: [], oai: [], memo: {} };
    await provider.run({ conv, message: '최근 What-if 계획 비교 결과 알려 줘', context: {}, emit: (e: AssistantEvent) => { if (e.type === 'text') text += e.delta; }, signal: new AbortController().signal });
    assert.deepEqual(called, [['whatif_latest', {}]]);
    assert.match(text, /What-if #12/);
    assert.match(text, /\| 우측 먼저 \| 60 \(42~58\) \| \+10 \(\+20%\) \| 0건 \|/);
    assert.match(text, /WO-HL-261116-012.*납기 110분/);
    assert.match(text, /What-if #13이\(가\) 계산 중 \(1\/4\)/);
    assert.doesNotMatch(text, /undefined|NaN|\[object Object\]/);
  });
});
