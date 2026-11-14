/* eslint-disable @typescript-eslint/no-explicit-any -- 도구 결과(JSON)를 그대로 들여다본다 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  STATIONS,
  type AssistantEvent,
  type EnergyReport,
  type ExecutionSummary,
  type FaStationView,
  type HoldDetail,
  type HoldList,
  type HoldView,
  type InterlockReport,
  type NcrDetail,
  type NcrList,
  type NcrStatus,
  type NcrView,
  type ShiftLineReport,
  type ShiftList,
  type ShiftReport,
  type StationHealth,
  type WorkOrderView,
} from '@lumitwin/shared';
import { MesTools } from '../src/assistant/assistant.mes-tools';
import { AssistantTools, TOOL_DEFS, toolLabel } from '../src/assistant/assistant.tools';
import { MockProvider, extractEntities } from '../src/assistant/providers/mock.provider';

// 가상 시각: 11-14 10:30 (한국) = 주간 교대(2026-11-14-D) 2시간 30분째
const NOW = '2026-11-14T01:30:00.000Z';
const min = (m: number) => new Date(Date.parse(NOW) + m * 60_000).toISOString();

// ───────────── 가짜 서비스 ─────────────

function wo(p: Partial<WorkOrderView> & Pick<WorkOrderView, 'id' | 'code' | 'line' | 'variant' | 'status' | 'seq'>): WorkOrderView {
  return {
    qty: 160, released: 0, doneQty: 0, scrapQty: 0, wip: 0, source: 'AUTO', createdBy: null, note: null, createdAt: min(-300),
    startedAt: null, endedAt: null, plan: null, releasing: false, ...p,
  };
}

const RUNNING = wo({
  id: 11, code: 'WO-EM-261114-003', line: 'EM', variant: 'BMS-12V-S', status: 'RUNNING', seq: 3, released: 120, doneQty: 100, scrapQty: 2, wip: 18, releasing: true,
  startedAt: min(-90), plan: { start: min(-90), end: min(30), changeover: false, setupMin: 0, pitchSec: 45 },
});
const PLANNED = [
  wo({ id: 12, code: 'WO-EM-261114-004', line: 'EM', variant: 'BMS-12V-H', status: 'PLANNED', seq: 4, plan: { start: min(30), end: min(170), changeover: true, setupMin: 25, pitchSec: 52 } }),
  wo({ id: 13, code: 'WO-EM-261114-005', line: 'EM', variant: 'BMS-12V-S', status: 'PLANNED', seq: 5, plan: { start: min(170), end: min(300), changeover: true, setupMin: 25, pitchSec: 45 } }),
  wo({ id: 14, code: 'WO-EM-261114-006', line: 'EM', variant: 'BMS-12V-S', status: 'PLANNED', seq: 6, plan: { start: min(300), end: min(420), changeover: false, setupMin: 0, pitchSec: 45 } }),
];
const PAST = [1, 2, 3, 4].map((i) => wo({ id: i, code: `WO-EM-261113-90${i}`, line: 'EM', variant: 'BMS-12V-H', status: 'DONE', seq: i - 10, doneQty: 158, scrapQty: 2, endedAt: min(-100 - i) }));
const ORDERS = [RUNNING, ...PLANNED, ...PAST];

const SUMMARY: ExecutionSummary = {
  t: NOW,
  ready: true,
  holdsActive: 1,
  lines: [
    { line: 'HL', current: null, running: [], planned: 0, next: null, ncrOpen: 0, waitMrb: 0, repairing: 0, quarantine: 0, ilk: { ok: 0, ng: 0, wait: 0 } },
    { line: 'EM', current: RUNNING, running: [RUNNING], planned: 3, next: PLANNED[0], ncrOpen: 5, waitMrb: 2, repairing: 1, quarantine: 3, ilk: { ok: 400, ng: 4, wait: 9 } },
    { line: 'OSM', current: null, running: [], planned: 0, next: null, ncrOpen: 0, waitMrb: 0, repairing: 0, quarantine: 0, ilk: { ok: 0, ng: 0, wait: 0 } },
  ],
};

function ncr(id: number, status: NcrStatus, p: Partial<NcrView> = {}): NcrView {
  return {
    id, code: `NCR-261114-${String(id).padStart(4, '0')}`, serial: `EM2611140${String(id).padStart(4, '0')}`, item: 'BMS-12V', line: 'EM', station: 'EM-FCT-B1', step: 'FCT',
    defect: 'FCT_FAIL', variant: 'BMS-12V-S', workOrder: 11, woCode: RUNNING.code, status, disposition: status === 'WAIT_MRB' ? null : 'REPAIR', rule: status === 'WAIT_MRB' ? null : 'default-repair',
    decidedBy: status === 'WAIT_MRB' ? null : 'MES 자동', decidedAt: null, repairOk: null, repairMin: null, reinspect: null, attempt: 1, openedAt: min(-id * 3), closedAt: status === 'CLOSED' ? min(-1) : null,
    note: null, outcome: status === 'CLOSED' ? 'REPAIRED' : null, ...p,
  };
}
// 14건: MRB 대기 2건은 목록 뒤쪽(오래된 쪽)에 있다
const NCRS: NcrView[] = [
  ...Array.from({ length: 10 }, (_, i) => ncr(i + 1, i % 2 ? 'REPAIRING' : 'REINSPECT')),
  ncr(11, 'WAIT_MRB', { defect: 'NOISE', station: 'EM-EOL-B' }),
  ncr(12, 'WAIT_MRB'),
  ncr(13, 'CLOSED'),
  ncr(14, 'CLOSED', { outcome: 'SCRAPPED', disposition: 'SCRAP' }),
];

function ncrList(status?: string, line?: string): NcrList {
  const items = NCRS.filter((n) => (!line || n.line === line) && (!status || (status === 'ACTIVE' ? n.status !== 'CLOSED' : n.status === status)));
  return {
    items,
    summary: {
      total: NCRS.length, open: 12, byStatus: { OPEN: 0, WAIT_MRB: 2, REPAIRING: 5, REINSPECT: 5, CLOSED: 2 },
      repairSuccess: 0.875, repairDone: 8, avgRepairMin: 11.24, scrapped: 1, uai: 0, topDefects: [{ defect: 'FCT_FAIL', n: 12 }, { defect: 'NOISE', n: 1 }],
    },
  };
}

const LOT = 'PASTE-261113-002';
const HOLD_LOT: HoldView = {
  id: 7, code: 'HOLD-261114-001', kind: 'LOT', material: 'PASTE', lot: LOT, serials: [], reason: '페이스트 점도 이상 의심', status: 'ACTIVE',
  createdBy: '품질 담당', createdAt: min(-45), releasedBy: null, releasedAt: null, releaseNote: null, result: null, quarantined: ['EM26111400100'],
};
const HOLD_OLD: HoldView = {
  ...HOLD_LOT, id: 3, code: 'HOLD-261113-002', kind: 'SERIAL', material: null, lot: null, serials: ['HL26111300001', 'HL26111300002'], status: 'RELEASED',
  releasedBy: '품질 담당', releasedAt: min(-600), releaseNote: '재검 합격', result: 'RELEASE', quarantined: [],
};
const HOLDS: HoldList = {
  holds: [HOLD_LOT, HOLD_OLD],
  quarantine: [
    { serial: 'EM26111400100', comps: [], line: 'EM', station: 'EM-AOI-B', step: 'AOI', code: 'HOLD', reason: 'LOT Hold 대상', holdId: 7, holdCode: HOLD_LOT.code, wo: 11, variant: 'BMS-12V-S', at: min(-20) },
    { serial: 'EM26111400101', comps: ['X1'], line: 'EM', station: 'EM-ICT-B', step: 'ICT', code: 'ROUTE', reason: '앞 공정 AOI 실적 없음', holdId: null, holdCode: null, wo: 11, variant: 'BMS-12V-S', at: min(-10) },
  ],
};
const HOLD_DETAIL: HoldDetail = {
  ...HOLD_LOT,
  impact: {
    base: 240, byStatus: { DONE: 30, WIP: 50, HOLD: 1, SCRAP: 2 }, finished: 30, inProcess: 50, truncated: false,
    tops: Array.from({ length: 12 }, (_, i) => ({ serial: `EM261114${String(i).padStart(5, '0')}`, item: 'BMS-12V', line: 'EM', status: i < 3 ? 'DONE' : 'WIP', defect: null, parts: 2, lastAt: min(-i) })),
  },
};

const ILK: InterlockReport = {
  recent: [
    ...Array.from({ length: 10 }, (_, i) => ({ id: 100 - i, line: 'EM' as const, station: 'EM-AOI-B', step: 'AOI', serial: `EM2611140010${i}`, verdict: 'NG' as const, code: 'HOLD' as const, reason: 'LOT Hold 대상 (PASTE-261113-002)', comps: [], at: min(-i) })),
    { id: 50, line: 'EM', station: 'EM-FCT-B1', step: 'FCT', serial: 'EM26111400050', verdict: 'WAIT', code: 'FA', reason: '초물 대기 S12', comps: [], at: min(-30) },
  ],
  stats: {
    live: { ok: 900, ng: 12, wait: 30, since: min(-300) },
    byCode: [{ code: 'HOLD', ng: 10, wait: 0 }, { code: 'ROUTE', ng: 2, wait: 5 }, { code: 'FA', ng: 0, wait: 25 }],
    byStation: [{ station: 'EM-AOI-B', ok: 400, ng: 10, wait: 0 }, { station: 'EM-ICT-B', ok: 380, ng: 2, wait: 5 }, { station: 'EM-FCT-B1', ok: 120, ng: 0, wait: 25 }, { station: 'EM-PK-B', ok: 0, ng: 0, wait: 0 }],
    skipped: 1,
  },
};

const FA: FaStationView[] = [
  {
    station: 'HL-AS-01', line: 'HL', faRequired: true,
    pending: [{ changeId: 41, simId: 'S41', since: min(-25), category: 'METHOD', kind: 'changeover', detail: '기종 변경 HL-VX1-L → HL-VX1-R', status: 'PENDING' }],
    lastFirst: { at: min(-200), serial: 'HL26111400009', result: 'OK', changeSimId: 'S30' },
  },
  { station: 'HL-LT-01', line: 'HL', faRequired: true, pending: [], lastFirst: null },
  {
    station: 'EM-FCT-B1', line: 'EM', faRequired: true,
    pending: [{ changeId: 52, simId: 'S52', since: min(-5), category: 'MATERIAL', kind: 'lot', detail: 'PCB_BMS LOT A → B', status: 'NG' }],
    lastFirst: { at: min(-3), serial: 'EM26111400070', result: 'NG', changeSimId: 'S52' },
  },
];

function shiftLine(line: 'HL' | 'EM' | 'OSM', ok: number): ShiftLineReport {
  return {
    line, target: 960, orders: [{ id: 1, code: `WO-${line}-261113-001`, variant: 'X', qty: 160, status: 'DONE', released: 160, doneQty: 158, scrapQty: 2, input: 80, good: 79, startedAt: null, endedAt: null }],
    input: ok + 10, ok, ng: 12, scrap: 3, fpy: 0.962, oee: { oee: 0.71, availability: 0.88, performance: 0.85, quality: 0.95 },
    downtime: [{ state: 'DOWN', reason: '노즐 막힘', sec: 2700, count: 2, stations: ['HL-IM-L1'] }, { state: 'SETUP', reason: '기종 변경 L→R', sec: 1500, count: 6, stations: ['HL-AS-01'] }],
    defects: [{ code: 'FCT_FAIL', name: '기능 시험 불합격', count: 7, stations: ['EM-FCT-B1'] }],
    ncr: { opened: 9, closed: 8, openAtEnd: 1 }, changes: { total: 40, byCategory: { MAN: 20, MACHINE: 5, MATERIAL: 10, METHOD: 5 }, faNg: 1 },
    inspections: { FIRST: 30, MID: 6, LAST: 20, ng: 1 }, interlock: { ng: 4, wait: 20, byCode: { ROUTE: 1, HOLD: 3 } }, energy: { kwh: 1234.56, perUnit: 1.2856, missing: 0 },
  };
}
const SHIFTS: ShiftList = {
  runId: 1, runStartedAt: '2026-11-13T00:00:00.000Z', now: NOW,
  shifts: [
    { key: '2026-11-14-D', code: 'D', name: '11-14 주간', date: '2026-11-14', start: '2026-11-13T23:00:00.000Z', end: '2026-11-14T11:00:00.000Z', current: true },
    { key: '2026-11-13-N', code: 'N', name: '11-13 야간', date: '2026-11-13', start: '2026-11-13T11:00:00.000Z', end: '2026-11-13T23:00:00.000Z', current: false },
    { key: '2026-11-13-D', code: 'D', name: '11-13 주간', date: '2026-11-13', start: '2026-11-12T23:00:00.000Z', end: '2026-11-13T11:00:00.000Z', current: false },
  ],
};

const ENERGY: EnergyReport = {
  runId: 1, from: min(-150), to: NOW, now: NOW, runStartedAt: SHIFTS.runStartedAt, bucketHours: 1,
  total: { run: 300, idle: 120, off: 30, total: 450, idleShare: 120 / 450 },
  lines: [{ line: 'EM', run: 100, idle: 50, off: 10, total: 160, good: 200, perUnit: 0.8, idleShare: 50 / 160, stations: 20, missing: [] }],
  stations: [
    ...['EM-RF-B', 'EM-MT-B1', 'EM-RF-L', 'EM-MT-L', 'EM-AOI-B', 'EM-ICT-B', 'EM-FCT-B1', 'EM-FCT-B2', 'EM-EOL-B', 'EM-PK-B'].map((s, i) => ({
      station: s, line: 'EM' as const, run: 40 - i * 3, idle: i === 9 ? 30 : 5, off: 1, total: 46 - i * 3 + (i === 9 ? 25 : 0),
      kw: { run: 10, idle: 4, off: 0.5, grade: 'weak' as const }, hours: { run: 2, idle: 0.4, off: 0.1 }, ok: 100, perUnit: 0.46, idleShare: 0.1,
    })),
    { station: 'EM-LM-B', line: 'EM', run: 0, idle: 0, off: 0, total: 0, kw: null, hours: { run: 2, idle: 0, off: 0 }, ok: 100, perUnit: null, idleShare: null },
  ],
  hourly: Array.from({ length: 12 }, (_, i) => ({ t: min(-60 * (12 - i)), end: min(-60 * (11 - i)), run: 10, idle: 4, off: 1, partial: i === 11 })),
  missing: ['EM-LM-B'],
};

function health(station: string, level: StationHealth['level'], vib: number | null, index: number | null): StationHealth {
  return {
    station, line: STATIONS[station].line as StationHealth['line'], part: '베어링', cls: 'I', zones: { ab: 0.71, bc: 1.8, cd: 4.5 }, base: { vib: 0.69, cur: 3.6, temp: 39 }, grade: 'assumed',
    latest: vib == null ? null : { t: NOW, vib, cur: 4.1, temp: 47.3 }, vib, level, index,
    trend: Array.from({ length: 20 }, (_, i) => ({ t: min(-20 + i), vib: 0.7 + i * 0.05 })),
    rul: level === 'warn' ? { warnH: 0, dangerH: 9.44, slopePerH: 0.2833, n: 120 } : null,
    rulNote: level === 'warn' ? '' : '가동 표본이 30개 미만이라 추세를 내지 않습니다', lastMaint: null, samples: 200,
  };
}
const HEALTH = {
  t: NOW, runStartedAt: SHIFTS.runStartedAt, unmonitored: 60,
  stations: [health('HL-IM-L1', 'good', 0.9, 0.95), health('EM-MT-B1', 'warn', 2.1, 0.6), health('EM-RF-B', 'danger', 4.8, 0), health('OSM-AS-01', null, null, null)],
};

/** 서비스 가짜 객체로 MesTools를 만들고, 불린 인자를 기록한다 */
function setup() {
  const seen: Record<string, unknown[]> = {};
  const rec = (k: string, ...a: unknown[]) => (seen[k] = a);
  const live = { virtualNow: NOW };
  const exec = {
    summary: () => SUMMARY,
    orders: (line?: string) => ORDERS.filter((o) => !line || o.line === line),
    interlock: async (line?: string, station?: string) => (rec('interlock', line, station), ILK),
    ncrList,
    ncrDetail: (id: number): NcrDetail => {
      const n = NCRS.find((x) => x.id === id)!;
      return { ...n, history: [ncr(99, 'CLOSED', { serial: n.serial, outcome: 'REPAIRED' })], suggested: { action: 'MRB', rule: 'default-repair', minutes: 10, prob: 0.85 } };
    },
    holdList: () => HOLDS,
    holdDetail: async (id: number) => (rec('holdDetail', id), HOLD_DETAIL),
  };
  const quality = {
    faStatus: () => FA,
    changes: async (f: unknown) => (rec('changes', f), [
      { id: 1, at: min(-25), line: 'HL', station: 'HL-AS-01', category: 'METHOD', kind: 'changeover', detail: '기종 변경 HL-VX1-L → HL-VX1-R', source: 'SIM', simId: 'S41', createdBy: null, faStatus: 'PENDING', faSerial: null, faAt: null, approvedBy: null, approvedAt: null },
      { id: 2, at: min(-150), line: 'HL', station: 'HL-AS-01', category: 'MAN', kind: 'shift', detail: '주간 교대 시작', source: 'SIM', simId: 'S30', createdBy: null, faStatus: 'OK', faSerial: 'HL26111400009', faAt: min(-140), approvedBy: null, approvedAt: null },
    ]),
    inspections: async (f: unknown) => (rec('inspections', f), [
      { id: 1, at: min(-140), line: 'HL', station: 'HL-AS-01', type: 'FIRST', serial: 'HL26111400009', result: 'OK', values: {}, variant: 'HL-VX1-L', changeId: 2, changeSimId: 'S30', by: null },
    ]),
  };
  const reports = { shifts: async () => SHIFTS, shift: async (key: string, line?: string): Promise<ShiftReport> => {
    rec('shift', key, line);
    const s = SHIFTS.shifts.find((x) => x.key === key)!;
    return { runId: 1, key, code: s.code, name: s.name, date: s.date, start: s.start, end: s.end, from: s.start, to: s.current ? NOW : s.end, current: s.current, now: NOW, lines: [shiftLine('HL', 900), shiftLine('EM', 700)] };
  } };
  const energy = { report: async (q: unknown) => (rec('energy', q), ENERGY) };
  const healthSvc = { view: () => HEALTH };
  const mes = new MesTools(live as never, exec as never, quality as never, reports as never, energy as never, healthSvc as never);
  const tools = new AssistantTools(live as never, {} as never, {} as never, {} as never, {} as never, mes);
  return { mes, tools, seen };
}

const NO_JUNK = /undefined|NaN|\[object Object\]/;

describe('AI 비서 실행 MES 도구 정의', () => {
  it('새 도구 9개가 모두 등록돼 있고, 상태를 바꾸는 도구는 없다', () => {
    const names = TOOL_DEFS.map((t) => t.name);
    for (const n of ['work_orders', 'interlock_status', 'ncr_status', 'hold_status', 'change_points', 'control_plan', 'shift_report', 'energy_report', 'equipment_health']) {
      assert.ok(names.includes(n), n);
      assert.ok(MesTools.has(n));
      assert.notEqual(toolLabel(n, {}), n, `${n} 화면 이름`);
    }
    assert.equal(new Set(names).size, names.length, '이름 중복');
    assert.ok(TOOL_DEFS.every((t) => (t as { eager_input_streaming?: boolean }).eager_input_streaming === true));
    assert.ok(!names.some((n) => /create|update|dispose|release|approve|cancel|register|reorder|_set|pm$/.test(n)), '조회만');
    assert.equal(toolLabel('energy_report', { current_shift: true, line: 'EM' }), '에너지 조회 · EM · 이번 교대');
  });
});

describe('AI 비서 실행 MES 도구 결과', () => {
  it('작업지시: 진행 건 진척·대기 순서의 기종 변경·작업지시 없는 라인 상태를 준다', async () => {
    const { tools } = setup();
    const out = await tools.run('work_orders', { line: 'em' });
    assert.equal(out.ok, true);
    const d = out.data as any;
    assert.equal(d.lines.length, 1);
    const l = d.lines[0];
    assert.equal(l.current.code, RUNNING.code);
    assert.equal(l.current.donePct, 62.5);
    assert.equal(l.current.leftToRelease, 40);
    assert.equal(l.current.expectedEnd, '11-14 11:00');
    assert.deepEqual(l.queue[0].changeover, { from: 'BMS-12V-S', to: 'BMS-12V-H', setupMin: 25 });
    assert.deepEqual(l.queue[1].changeover, { from: 'BMS-12V-H', to: 'BMS-12V-S', setupMin: 25 });
    assert.equal(l.queue[2].changeover, null);
    assert.equal(l.nextChangeover.code, PLANNED[0].code);
    assert.equal(l.nextChangeover.inMin, 30);
    assert.equal(l.recentDone.length, 3, '지난 것은 3건만');
    assert.equal(l.waitMrb, 2);
    assert.ok(out.refs.some((r) => r.id === '/orders'));
    assert.doesNotMatch(out.summary, NO_JUNK);

    const all = (await tools.run('work_orders', {})).data as any;
    assert.equal(all.lines.length, 3);
    assert.match(all.lines.find((x: any) => x.line === 'HL').state, /생산 계획 없음/);
    assert.equal((await tools.run('work_orders', { line: 'XX' })).ok, false);
  });

  it('인터록: 사유 이름·거부 합계·최근 거부만 8건, 게이트가 아닌 설비는 거절한다', async () => {
    const { tools, seen } = setup();
    const out = await tools.run('interlock_status', { line: 'EM' });
    const d = out.data as any;
    assert.equal(d.rejected, 12);
    assert.equal(d.waited, 30);
    assert.equal(d.byCode[0].name, 'Hold 대상');
    assert.equal(d.recentRejects.length, 8);
    assert.ok(d.recentRejects.every((r: any) => r.code === 'HOLD'));
    assert.equal(d.recentWaits.length, 1);
    assert.equal(d.byStation.length, 3, '기록 없는 설비는 뺀다');
    assert.equal(d.sinceServerStart.ok, 900);
    assert.match(out.summary, /거부 1위 Hold 대상 10/);
    assert.deepEqual(seen.interlock, ['EM', undefined]);

    const notGate = await tools.run('interlock_status', { station: 'HL-IM-L1' });
    assert.equal(notGate.ok, false);
    assert.ok((notGate.data as any).gates.includes('HL-AS-01 램프 조립 셀 (협동로봇)'));
  });

  it('NCR: MRB 대기를 앞에 두고 10건만, 번호·시리얼로 상세를 찾는다', async () => {
    const { tools } = setup();
    const out = await tools.run('ncr_status', {});
    const d = out.data as any;
    assert.equal(d.matched, 12);
    assert.equal(d.shown.length, 10);
    assert.deepEqual(d.shown.slice(0, 2).map((n: any) => n.status), ['MRB 판정 대기', 'MRB 판정 대기']);
    assert.equal(d.shown[0].defectName !== undefined, true);
    assert.equal(d.summary.waitMrb, 2);
    assert.equal(d.summary.repairSuccessPct, 87.5);
    assert.equal(d.summary.avgRepairMin, 11.2);
    assert.equal(d.shown[0].waitingMin, 33);
    assert.ok(out.refs.some((r) => r.id === '/ncr'));

    const mrb = (await tools.run('ncr_status', { status: 'wait_mrb' })).data as any;
    assert.equal(mrb.matched, 2);
    assert.equal((await tools.run('ncr_status', { status: 'BAD' })).ok, false);

    const one = await tools.run('ncr_status', { code: 'ncr-261114-0011' });
    assert.equal(one.ok, true);
    const od = one.data as any;
    assert.equal(od.code, 'NCR-261114-0011');
    assert.equal(od.suggested.action, 'MRB 판정 (자동 처리 없음)');
    assert.equal(od.otherNcrsOfSerial.length, 1);
    const bySerial = await tools.run('ncr_status', { code: NCRS[2].serial });
    assert.equal((bySerial.data as any).code, NCRS[2].code);
    assert.equal((await tools.run('ncr_status', { code: 'NCR-000000-0000' })).ok, false);
  });

  it('Hold: 목록은 활성만·격리 구역 사유별, LOT 번호로 영향 범위를 찾는다', async () => {
    const { tools, seen } = setup();
    const list = (await tools.run('hold_status', {})).data as any;
    assert.equal(list.active, 1);
    assert.equal(list.holds.length, 1);
    assert.equal(list.quarantine.total, 2);
    assert.equal(list.quarantine.notInHold, 1);
    assert.deepEqual(list.quarantine.byReason.map((r: any) => r.name).sort(), ['Hold 대상', '공정 순서 위반'].sort());
    assert.equal(((await tools.run('hold_status', { status: 'ALL' })).data as any).holds.length, 2);

    const byLot = await tools.run('hold_status', { code: LOT.toLowerCase() });
    assert.equal(byLot.ok, true);
    assert.deepEqual(seen.holdDetail, [7]);
    const d = byLot.data as any;
    assert.equal(d.impact.topProducts, 83);
    assert.equal(d.impact.finished, 30);
    assert.equal(d.impact.examples.length, 8, '예시는 8개만');
    assert.match(d.target, /PASTE.*LOT PASTE-261113-002/);
    assert.ok(byLot.refs.some((r) => r.kind === 'lot' && r.id === LOT));

    const quar = await tools.run('hold_status', { code: 'X1' });
    assert.equal(quar.ok, true);
    assert.equal((quar.data as any).hold, null);
    assert.equal((quar.data as any).quarantine.name, '공정 순서 위반');
    assert.equal((await tools.run('hold_status', { code: 'NOPE-1' })).ok, false);
  });

  it('변경점·초물: 설비의 초물 대기와 원인 변경점, 게이트 여부를 준다', async () => {
    const { tools, seen } = setup();
    const out = await tools.run('change_points', { station: '램프 조립 셀' });
    assert.equal(out.ok, true);
    const d = out.data as any;
    assert.equal(d.gate, true);
    assert.equal(d.faPending.length, 1);
    assert.equal(d.faPending[0].waitingMin, 25);
    assert.equal(d.faPending[0].items[0].kind, '기종 변경');
    assert.equal(d.lastFirst.serial, 'HL26111400009');
    assert.equal(d.changes.awaitingApproval, 1);
    assert.deepEqual(seen.changes, [{ line: undefined, station: 'HL-AS-01', limit: '100' }]);

    const all = (await tools.run('change_points', {})).data as any;
    assert.equal(all.faPendingStations, 2);
    assert.equal(all.faPending[0].station, 'HL-AS-01', '오래 기다린 순');
    assert.equal(all.faPending[1].items[0].status, '초물 불합격');
  });

  it('관리계획서: 범위가 없으면 법규·안전 특성만, 설비·키워드로 거르고 12행까지', async () => {
    const { tools } = setup();
    const ov = (await tools.run('control_plan', {})).data as any;
    assert.equal(ov.counts.length, 3);
    assert.ok(ov.safetyCritical.length > 0);
    assert.ok(ov.safetyCritical.every((r: any) => r.special.startsWith('◆')));

    const st = (await tools.run('control_plan', { station: 'HL-PH-01' })).data as any;
    assert.ok(st.rows.length > 0);
    assert.ok(st.rows.every((r: any) => r.station === 'HL-PH-01'));

    const special = (await tools.run('control_plan', { line: 'EM', query: '특별 특성' })).data as any;
    assert.ok(special.rows.every((r: any) => r.special));
    assert.ok(special.rows.length <= 12);
    assert.equal(special.truncated, special.matched > 12);

    const kw = (await tools.run('control_plan', { query: '토크' })).data as any;
    assert.ok(kw.matched > 0);
    assert.ok(kw.rows.every((r: any) => /토크/.test(`${r.name} ${r.op} ${r.stationName} ${r.evaluation}`)));
  });

  it('교대 일보: 어제 야간·직전 교대를 키로 바꾸고, 없는 교대는 고를 수 있는 목록과 함께 거절한다', async () => {
    const { tools, seen } = setup();
    const out = await tools.run('shift_report', { day: 'yesterday', shift: 'N' });
    assert.equal(out.ok, true);
    assert.deepEqual(seen.shift, ['2026-11-13-N', undefined]);
    const d = out.data as any;
    assert.equal(d.shift, '11-13 야간');
    assert.equal(d.totals.ok, 1600);
    const l = d.lines[0];
    assert.equal(l.achievementPct, 93.8);
    assert.equal(l.oee.oeePct, 71);
    assert.equal(l.downtimeTop[0].minutes, 45);
    assert.equal(l.energy.kwh, 1234.6);
    assert.equal(l.energy.perUnitKwh, 1.286);
    assert.equal(l.interlock.topReject, 'Hold 대상 3');

    await tools.run('shift_report', { which: 'previous', line: 'HL' });
    assert.deepEqual(seen.shift, ['2026-11-13-N', 'HL']);
    await tools.run('shift_report', {});
    assert.deepEqual(seen.shift, ['2026-11-14-D', undefined]);
    await tools.run('shift_report', { key: '2026-11-13-d' });
    assert.deepEqual(seen.shift, ['2026-11-13-D', undefined]);

    const none = await tools.run('shift_report', { key: '2026-11-20-D' });
    assert.equal(none.ok, false);
    assert.equal((none.data as any).available[0], '2026-11-14-D 11-14 주간 (진행 중)');
  });

  it('에너지: 이번 교대는 교대 시작부터, 소비 전력 정의 없는 설비는 순위에서 뺀다', async () => {
    const { tools, seen } = setup();
    const out = await tools.run('energy_report', { current_shift: true, line: 'EM' });
    assert.equal(out.ok, true);
    assert.deepEqual(seen.energy, [{ from: '2026-11-13T23:00:00.000Z', hours: undefined, line: 'EM' }]);
    const d = out.data as any;
    assert.equal(d.period.label, '11-14 주간 교대 시작부터');
    assert.equal(d.topStations.length, 8);
    assert.equal(d.topStations[0].station, 'EM-RF-B');
    assert.ok(!d.topStations.some((s: any) => s.station === 'EM-LM-B'));
    assert.equal(d.topIdle[0].station, 'EM-PK-B');
    assert.equal(d.hourly.length, 8);
    assert.equal(d.total.idleSharePct, 26.7);
    assert.match(out.summary, /1위 EM-RF-B/);

    await tools.run('energy_report', { hours: 8 });
    assert.deepEqual(seen.energy, [{ from: undefined, hours: '8', line: undefined }]);
    assert.equal((await tools.run('energy_report', { hours: -1 })).ok, false);
  });

  it('예지 보전: 위험·경고 순, 설비 하나면 추이까지, 감시 대상이 아니면 목록과 함께 거절한다', async () => {
    const { tools } = setup();
    const all = (await tools.run('equipment_health', {})).data as any;
    assert.deepEqual(all.stations.map((s: any) => s.station), ['EM-RF-B', 'EM-MT-B1', 'HL-IM-L1', 'OSM-AS-01']);
    assert.equal(all.byLevel['위험 (즉시 보전)'], 1);
    assert.equal(all.stations[0].trend, undefined);

    const one = await tools.run('equipment_health', { station: '칩 마운터' });
    const d = (one.data as any).stations[0];
    assert.equal(d.station, 'EM-MT-B1');
    assert.equal(d.rul.toDangerH, 9.4);
    assert.equal(d.currentVsNormalPct, 113.9);
    assert.equal(d.tempRiseC, 8.3);
    assert.equal(d.trend.length, 6);
    assert.match(one.summary, /EM-MT-B1 · 경고/);

    const no = await tools.run('equipment_health', { station: 'HL-LT-01' });
    assert.equal(no.ok, false);
    assert.equal((no.data as any).monitored.length, 4);
  });
});

// ───────────── 모의 모드 ─────────────

/** MES 도구는 진짜로(가짜 서비스 위에서) 돌리고, 나머지 도구는 불린 것만 적어 둔다 */
function mockSetup() {
  const { tools } = setup();
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const spy = {
    run: async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      return MesTools.has(name) ? tools.run(name, input) : { ok: false, data: { error: 'test' }, summary: 'test', refs: [] };
    },
  };
  return { calls, provider: new MockProvider(spy as never) };
}

async function ask(provider: MockProvider, message: string): Promise<string> {
  let text = '';
  const emit = (e: AssistantEvent) => {
    if (e.type === 'text') text += e.delta;
  };
  const conv = { id: 't', createdAt: 0, updatedAt: 0, busy: false, messages: [], oai: [], memo: {} };
  await provider.run({ conv, message, context: {}, emit, signal: new AbortController().signal }).catch(() => undefined);
  return text;
}

describe('AI 비서 모의 모드: 실행 MES 질문', () => {
  const cases: { q: string; calls: [string, Record<string, unknown>][]; text: RegExp }[] = [
    { q: '지금 EM 라인 작업지시 어디까지 왔어?', calls: [['work_orders', { line: 'EM' }]], text: /WO-EM-261114-003.*양품 100\/160/s },
    { q: 'MRB 대기 NCR 있어?', calls: [['ncr_status', { status: 'WAIT_MRB' }]], text: /MRB 판정을 기다리는 NCR이 2건.*\/ncr/s },
    { q: 'NCR-261114-0011 어떻게 됐어?', calls: [['ncr_status', { code: 'NCR-261114-0011' }]], text: /NCR-261114-0011.*MRB 판정/s },
    { q: '이 LOT Hold 영향 범위는?', calls: [['hold_status', {}], ['hold_status', { code: 'HOLD-261114-001' }]], text: /활성 Hold가 1건.*완제품·창고 \(출하 보류·회수 검토\): 30개/s },
    { q: `${LOT} Hold 걸렸어?`, calls: [['hold_status', { code: LOT }]], text: /HOLD-261114-001\(자재 LOT .*\)은 격리 중 상태/ },
    { q: 'HL-AS-01 초물 대기 왜 걸렸어?', calls: [['change_points', { station: 'HL-AS-01' }]], text: /초물 대기 1건으로 25분째.*기종 변경.*게이트 설비/s },
    { q: '칩 마운터 진동 괜찮아?', calls: [['equipment_health', { station: 'EM-MT-B1' }]], text: /EM-MT-B1 칩 마운터는 진동 2\.1 mm\/s로 경고.*경고 기준은 이미 넘었고, 추세대로면 위험까지 약 9\.4시간/s },
    { q: '어제 야간 교대 실적 요약해 줘', calls: [['shift_report', { day: 'yesterday', shift: 'N' }]], text: /11-13 야간 교대 실적.*\| 라인 \| 목표/s },
    { q: '이번 교대 전력 제일 많이 쓴 설비는?', calls: [['energy_report', { current_shift: true }]], text: /가장 많이 쓴 설비는 EM-RF-B/ },
    { q: '인터록 거부 많은 설비 알려 줘', calls: [['interlock_status', {}]], text: /거부 12건.*EM-AOI-B/s },
    { q: '헤드램프 관리계획서 특별 특성 보여 줘', calls: [['control_plan', { line: 'HL', query: '특별 특성' }]], text: /관리계획서에서 '특별 특성'에 맞는 항목은 \d+개.*\| 번호 \|/s },
    { q: 'WO-EM-261114-004 언제 시작해?', calls: [['work_orders', { line: 'EM' }]], text: /대기 3건/ },
    { q: '예지 보전 상태 어때?', calls: [['equipment_health', {}]], text: /상태 감시 설비 4대.*EM-RF-B.*OSM-AS-01 [^\n]*진동 표본 없음/s },
  ];
  for (const c of cases) {
    it(c.q, async () => {
      const a = mockSetup();
      const text = await ask(a.provider, c.q);
      assert.deepEqual(a.calls.map((x) => [x.name, x.input]), c.calls);
      assert.match(text, c.text);
      assert.doesNotMatch(text, NO_JUNK);
    });
  }

  it('절차를 묻는 격리·초물 질문은 작업표준서로, 보전 이력 질문은 설비 보전으로 간다', async () => {
    const a = mockSetup();
    await ask(a.provider, '불량 LOT 격리 절차 알려 줘');
    assert.equal(a.calls[0]?.name, 'search_standards');
    const b = mockSetup();
    await ask(b.provider, '초물 검사 방법 알려 줘');
    assert.equal(b.calls[0]?.name, 'search_standards');
    const c = mockSetup();
    await ask(c.provider, '계획 보전 밀린 설비 알려 줘');
    assert.equal(c.calls[0]?.name, 'maintenance');
  });

  it('작업지시·Hold·NCR 번호를 LOT 번호로 잘못 읽지 않는다', () => {
    const e = extractEntities('WO-HL-261114-002, HOLD-261114-001, NCR-261114-0001 그리고 PASTE-261113-002', {}, {});
    assert.equal(e.wo, 'WO-HL-261114-002');
    assert.equal(e.hold, 'HOLD-261114-001');
    assert.equal(e.ncr, 'NCR-261114-0001');
    assert.equal(e.lot, 'PASTE-261113-002');
    assert.equal(e.station, undefined);
    assert.equal(extractEntities('WO-HL-261114-002 진행 상황', {}, {}).lot, undefined);
  });
});
