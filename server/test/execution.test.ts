import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FACTORY, LINES, ROUTE_GRACE_SEC, WO_AHEAD, defaultDisposition, type IlkReqMsg, type LineCode } from '@lumitwin/shared';
import { decide, isInitialWip, lotKey, producingSteps, type HoldHit, type IlkContext, type NcrBrief, type UnitMem } from '../src/execution/interlock';
import {
  applyReinspect,
  applyRepair,
  awaitingReinspect,
  canDispose,
  holdCode,
  initialDisposition,
  maxSeq,
  ncrCode,
  outcome,
  statusAfter,
  summarize,
  unitStatusAfter,
  woDone,
  type NcrState,
} from '../src/execution/ncr-rules';
import { autoFill, nextVariant, pitchSec, reorder, schedule, setupMinutes, type PlanOrder } from '../src/execution/planner';

const line = (c: LineCode) => LINES.find((l) => l.code === c)!;
const HL = line('HL');
const EM = line('EM');

const unit = (over: Partial<UnitMem> = {}): UnitMem => ({
  line: 'HL', lastStep: 'ASSY', lastStation: 'HL-AS-01', lastResult: 'OK', status: 'WIP', variant: 'HL-VX1-L', wo: 1, lots: [], parent: null, ...over,
});

interface World {
  units?: Record<string, UnitMem>;
  holds?: { serials?: string[]; lots?: string[]; scrap?: boolean }[];
  ncr?: Record<string, NcrBrief>;
  wo?: Record<number, { status: 'PLANNED' | 'RUNNING' | 'DONE' | 'CANCELLED'; variant: string; code: string }>;
  fa?: Record<string, string>;
}

function ctx(w: World = {}): IlkContext {
  return {
    unit: (s) => w.units?.[s],
    hold: (serials, lots): HoldHit | null => {
      for (const [i, h] of (w.holds ?? []).entries()) {
        if (serials.some((s) => h.serials?.includes(s)) || lots.some((l) => h.lots?.includes(l))) return { holdId: i + 1, holdCode: `HOLD-${i + 1}`, reason: `Hold ${i + 1}`, scrap: !!h.scrap };
      }
      return null;
    },
    ncr: (s) => w.ncr?.[s],
    wo: (id) => w.wo?.[id],
    faPending: (st) => (w.fa?.[st] ? { detail: w.fa[st] } : null),
  };
}

const req = (over: Partial<IlkReqMsg>): IlkReqMsg => ({
  t: '2026-11-13T00:00:00.000Z', reqId: 'r1', line: 'HL', station: 'HL-SL-01', step: 'SEAL', serial: 'HL26111300001', comps: [], lots: {}, ...over,
});

describe('인터록 판정', () => {
  it('공정 순서가 맞고 걸리는 것이 없으면 통과', () => {
    const d = decide(req({}), ctx({ units: { HL26111300001: unit() } }));
    assert.equal(d.verdict, 'OK');
  });

  it('Hold 시리얼이면 NG HOLD, 폐기 판정 Hold면 scrap 표시', () => {
    const w: World = { units: { HL26111300001: unit() }, holds: [{ serials: ['HL26111300001'] }] };
    const d = decide(req({}), ctx(w));
    assert.equal(d.verdict, 'NG');
    assert.equal(d.code, 'HOLD');
    assert.equal(d.holdId, 1);
    assert.equal(d.scrap, false);
    assert.equal(decide(req({}), ctx({ ...w, holds: [{ serials: ['HL26111300001'], scrap: true }] })).scrap, true);
  });

  it('LOT Hold: 이번에 쓰는 LOT와 부품이 이미 쓴 LOT 모두 막는다', () => {
    const held = lotKey('HOTMELT', 'HOTMELT-261113-001');
    const direct = decide(req({ lots: { HOTMELT: 'HOTMELT-261113-001' } }), ctx({ units: { HL26111300001: unit() }, holds: [{ lots: [held] }] }));
    assert.equal(direct.code, 'HOLD');
    // 렌즈가 쓴 PC 레진 LOT가 Hold → 그 렌즈가 들어가는 실링에서 걸린다
    const resin = lotKey('PC_RESIN', 'PC_RESIN-261113-002');
    const w: World = {
      units: { HL26111300001: unit(), LN26111300009: unit({ lastStep: 'LENS_COAT', lots: [resin] }) },
      holds: [{ lots: [resin] }],
    };
    assert.equal(decide(req({ comps: ['LN26111300009'] }), ctx(w)).code, 'HOLD');
  });

  it('HOLD가 NG보다 먼저 걸린다 (판정 순서)', () => {
    const w: World = { units: { HL26111300001: unit({ lastResult: 'NG' }) }, holds: [{ serials: ['HL26111300001'] }] };
    assert.equal(decide(req({}), ctx(w)).code, 'HOLD');
  });

  it('불량 판정 뒤 처리가 안 끝났으면 NG, 특채로 끝났으면 통과', () => {
    const units = { HL26111300001: unit({ lastResult: 'NG' }) };
    assert.equal(decide(req({}), ctx({ units })).code, 'NG');
    const waiting = decide(req({}), ctx({ units, ncr: { HL26111300001: { status: 'WAIT_MRB', station: 'HL-AS-01', disposition: null, reinspect: null } } }));
    assert.equal(waiting.code, 'NG');
    assert.match(waiting.reason!, /MRB/);
    const uai = decide(req({}), ctx({ units, ncr: { HL26111300001: { status: 'CLOSED', station: 'HL-AS-01', disposition: 'UAI', reinspect: null } } }));
    assert.equal(uai.verdict, 'OK');
  });

  it('폐기 판정된 개체는 NG', () => {
    assert.equal(decide(req({}), ctx({ units: { HL26111300001: unit({ status: 'SCRAP' }) } })).code, 'NG');
  });

  it('재검사 투입: NCR이 재검사 대기이고 검출 설비여야 한다', () => {
    const units = { HL26111300001: unit({ lastStep: 'LEAK', lastStation: 'HL-LT-01', lastResult: 'NG' }) };
    const r = req({ station: 'HL-LT-01', step: 'LEAK', reinspect: true });
    const ok = decide(r, ctx({ units, ncr: { HL26111300001: { status: 'REINSPECT', station: 'HL-LT-01', disposition: 'REPAIR', reinspect: null } } }));
    assert.equal(ok.verdict, 'OK');
    const notYet = decide(r, ctx({ units, ncr: { HL26111300001: { status: 'REPAIRING', station: 'HL-LT-01', disposition: 'REPAIR', reinspect: null } } }));
    // 처리 중(수리 중)이면 2번 NG에서 먼저 걸린다
    assert.equal(notYet.code, 'NG');
    const okUnit = { HL26111300001: unit({ lastStep: 'LEAK', lastStation: 'HL-LT-01' }) };
    assert.equal(decide(r, ctx({ units: okUnit })).code, 'REPAIR');
    const other = decide(r, ctx({ units, ncr: { HL26111300001: { status: 'REINSPECT', station: 'HL-PH-01', disposition: 'REPAIR', reinspect: null } } }));
    assert.equal(other.code, 'REPAIR');
  });

  it('공정 순서: 앞 공정이면 대기, 유예가 지나면 NG, 엉뚱한 공정이면 바로 NG', () => {
    const r = req({ station: 'HL-LT-01', step: 'LEAK' }); // 앞 공정 SEAL
    assert.equal(decide(r, ctx({ units: { HL26111300001: unit({ lastStep: 'SEAL' }) } })).verdict, 'OK');
    const early = decide(r, ctx({ units: { HL26111300001: unit({ lastStep: 'ASSY' }) } }));
    assert.equal(early.verdict, 'WAIT');
    assert.equal(early.code, 'ROUTE');
    const unknown = decide(r, ctx({}));
    assert.equal(unknown.verdict, 'WAIT');
    const late = decide(r, ctx({}), ROUTE_GRACE_SEC * 1000 + 1);
    assert.equal(late.verdict, 'NG');
    assert.equal(late.code, 'ROUTE');
    const skipped = decide(r, ctx({ units: { HL26111300001: unit({ lastStep: 'PHOTO' }) } }));
    assert.equal(skipped.verdict, 'NG');
    assert.equal(skipped.code, 'ROUTE');
  });

  it('새로 발번하는 공정은 부품마다 만드는 공정을 본다 (이송 부품 포함), 초기 재공은 건너뛴다', () => {
    // LED 모듈은 이송(T-LED)으로 온다: 출발 공정은 공장 정의에서 읽는다
    const led = FACTORY.transfers.find((t) => t.code === 'T-LED')!.from;
    const producers = producingSteps(HL, 'ASSY').map((p) => `${p.line}.${p.step}`);
    assert.deepEqual(producers.sort(), [`${led.line}.${led.step}`, 'HL.HOUS_MOLD', 'HL.REFL_MET'].sort());
    const r = req({ station: 'HL-AS-01', step: 'ASSY', serial: 'HL26111300050', comps: ['HS26111300001', 'RF26111300001', 'LM26111300001-1', 'WIP26111300007'], wo: 7, variant: 'HL-VX1-L' });
    const units = {
      HS26111300001: unit({ lastStep: 'HOUS_MOLD' }),
      RF26111300001: unit({ lastStep: 'REFL_MET' }),
      'LM26111300001-1': unit({ line: led.line, lastStep: led.step }),
    };
    const wo = { 7: { status: 'RUNNING' as const, variant: 'HL-VX1-L', code: 'WO-HL-261113-001' } };
    assert.equal(decide(r, ctx({ units, wo })).verdict, 'OK');
    // 리플렉터가 아직 증착 실적이 안 왔다 (사출까지만) → 대기
    const waiting = decide(r, ctx({ units: { ...units, RF26111300001: unit({ lastStep: 'REFL_MOLD' }) }, wo }));
    assert.equal(waiting.verdict, 'WAIT');
    assert.equal(isInitialWip('WIP26111300007'), true);
    assert.equal(isInitialWip('HL26111300001'), false);
  });

  it('투입 공정은 진행 중인 작업지시와 기종이 맞아야 한다', () => {
    const units = { HS1: unit({ lastStep: 'HOUS_MOLD' }) };
    const base = { station: 'HL-AS-01', step: 'ASSY', serial: 'HL26111300050', comps: ['HS1'], variant: 'HL-VX1-R' };
    assert.equal(decide(req({ ...base }), ctx({ units })).code, 'WO');
    const planned = decide(req({ ...base, wo: 3 }), ctx({ units, wo: { 3: { status: 'PLANNED', variant: 'HL-VX1-R', code: 'WO-HL-261113-003' } } }));
    assert.equal(planned.code, 'WO');
    const mismatch = decide(req({ ...base, wo: 3 }), ctx({ units, wo: { 3: { status: 'RUNNING', variant: 'HL-VX1-L', code: 'WO-HL-261113-003' } } }));
    assert.equal(mismatch.code, 'WO');
    assert.equal(decide(req({ ...base, wo: 3 }), ctx({ units, wo: { 3: { status: 'RUNNING', variant: 'HL-VX1-R', code: 'WO-HL-261113-003' } } })).verdict, 'OK');
  });

  it('초물 판정 대기면 WAIT, 초물 자신은 통과', () => {
    const w: World = { units: { HL26111300001: unit() }, fa: { 'HL-SL-01': '기종 변경 L→R' } };
    const d = decide(req({}), ctx(w));
    assert.equal(d.verdict, 'WAIT');
    assert.equal(d.code, 'FA');
    assert.equal(decide(req({ fa: true }), ctx(w)).verdict, 'OK');
  });
});

describe('생산 계획', () => {
  const order = (o: Partial<PlanOrder> & { id: number }): PlanOrder => ({ variant: 'HL-VX1-L', qty: 96, seq: o.id, status: 'PLANNED', released: 0, startedAt: null, ...o });

  it('자동 계획은 대기 건을 WO_AHEAD까지 채우고 기종을 번갈아 낸다', () => {
    assert.deepEqual(autoFill(HL, []), ['HL-VX1-L', 'HL-VX1-R', 'HL-VX1-L'].slice(0, WO_AHEAD));
    const some = [order({ id: 1, status: 'RUNNING', variant: 'HL-VX1-L' }), order({ id: 2, variant: 'HL-VX1-R' })];
    assert.deepEqual(autoFill(HL, some, 3), ['HL-VX1-L', 'HL-VX1-R']);
    // 중단한 것은 기종을 정할 때 빼고 본다
    const cancelled = [order({ id: 1, variant: 'HL-VX1-L', status: 'DONE' }), order({ id: 2, variant: 'HL-VX1-R', status: 'CANCELLED' })];
    assert.deepEqual(autoFill(HL, cancelled, 1), ['HL-VX1-R']);
    assert.equal(nextVariant(HL, 'HL-VX1-R'), 'HL-VX1-L');
  });

  it('기종별 투입 간격: 계획 택트보다 느린 병목이면 그 값 (BMS 고용량형 FCT)', () => {
    assert.equal(pitchSec(HL, 'HL-VX1-L'), HL.taktSec);
    assert.equal(pitchSec(EM, 'BMS-12V-S'), EM.taktSec);
    const h = pitchSec(EM, 'BMS-12V-H');
    assert.ok(h > EM.taktSec, `고용량형 ${h}초 > 택트 ${EM.taktSec}초`);
  });

  it('대기 순서 예상 시각: 투입 중인 것의 남은 수부터, 기종이 바뀌면 셋업을 더한다', () => {
    const now = Date.parse('2026-11-13T00:00:00Z');
    const orders = [
      order({ id: 1, status: 'RUNNING', variant: 'HL-VX1-L', qty: 96, released: 46, startedAt: '2026-11-12T23:00:00.000Z' }),
      order({ id: 2, seq: 2, variant: 'HL-VX1-L', qty: 10 }),
      order({ id: 3, seq: 3, variant: 'HL-VX1-R', qty: 10 }),
    ];
    const p = schedule(HL, orders, now, 1, 'HL-VX1-L');
    const end1 = now + 50 * HL.taktSec * 1000;
    assert.equal(p.get(1)!.end, new Date(end1).toISOString());
    assert.equal(p.get(2)!.changeover, false);
    assert.equal(p.get(2)!.start, new Date(end1).toISOString());
    const end2 = end1 + 10 * HL.taktSec * 1000;
    assert.equal(p.get(3)!.changeover, true);
    assert.equal(p.get(3)!.setupMin, setupMinutes(HL));
    assert.equal(p.get(3)!.start, new Date(end2 + setupMinutes(HL) * 60_000).toISOString());
  });

  it('순서 바꾸기는 대기 건의 seq 값만 다시 나눠 준다', () => {
    const planned = [
      { id: 10, seq: 4 },
      { id: 11, seq: 5 },
      { id: 12, seq: 7 },
    ];
    const m = reorder(planned, [12, 10]);
    assert.deepEqual([...m].sort((a, b) => a[1] - b[1]).map(([id]) => id), [12, 10, 11]);
    assert.deepEqual([...m.values()].sort((a, b) => a - b), [4, 5, 7]);
  });
});

describe('불량 처리 (NCR)', () => {
  const ncr = (over: Partial<NcrState> = {}): NcrState => ({
    id: 1, code: 'NCR-261113-0001', serial: 'HL1', item: 'LAMP', line: 'HL', station: 'HL-LT-01', step: 'LEAK', defect: 'LEAK', variant: null, workOrder: 1,
    status: 'OPEN', disposition: null, rule: null, decidedBy: null, decidedAt: null, repairOk: null, repairMin: null, reinspect: null, attempt: 1,
    openedAt: '2026-11-13T00:00:00.000Z', closedAt: null, note: null, ...over,
  });

  it('재검사에서 또 불합격이면 폐기, 아니면 불량 처리 기준을 따른다', () => {
    assert.deepEqual(initialDisposition('HL', 'HL-LT-01', 'LEAK', true), { action: 'SCRAP', rule: 'reinspect-ng' });
    const d = defaultDisposition('HL', 'HL-LT-01', 'LEAK');
    assert.deepEqual(initialDisposition('HL', 'HL-LT-01', 'LEAK', false), { action: d.action, rule: d.rule });
  });

  it('판정 뒤 NCR·개체 상태', () => {
    assert.equal(statusAfter('REPAIR'), 'REPAIRING');
    assert.equal(statusAfter('REWORK'), 'REPAIRING');
    assert.equal(statusAfter('SCRAP'), 'CLOSED');
    assert.equal(statusAfter('UAI'), 'CLOSED');
    assert.equal(statusAfter('MRB'), 'WAIT_MRB');
    assert.equal(unitStatusAfter('REPAIR'), 'REPAIR');
    assert.equal(unitStatusAfter('SCRAP'), 'SCRAP');
    assert.equal(unitStatusAfter('UAI'), 'WIP');
    assert.equal(unitStatusAfter('MRB'), null);
    assert.equal(canDispose('WAIT_MRB'), true);
    assert.equal(canDispose('REPAIRING'), false);
  });

  it('수리 성공 → 재검사 대기 → 재검사 합격이면 수리 합격으로 종결', () => {
    const n = ncr({ status: 'REPAIRING', disposition: 'REPAIR' });
    assert.deepEqual(applyRepair(n, true, 12.34, '2026-11-13T01:00:00.000Z'), { unit: 'WIP', scrapped: false });
    assert.equal(n.status, 'REINSPECT');
    assert.equal(n.repairMin, 12.3);
    assert.equal(awaitingReinspect([ncr({ id: 0, status: 'CLOSED' }), n]), n);
    applyReinspect(n, 'OK', '2026-11-13T01:10:00.000Z');
    assert.equal(n.status, 'CLOSED');
    assert.equal(outcome(n), 'REPAIRED');
  });

  it('수리 실패는 폐기로 종결', () => {
    const n = ncr({ status: 'REPAIRING', disposition: 'REWORK' });
    assert.deepEqual(applyRepair(n, false, 8, '2026-11-13T01:00:00.000Z'), { unit: 'SCRAP', scrapped: true });
    assert.equal(n.status, 'CLOSED');
    assert.equal(outcome(n), 'SCRAPPED');
  });

  it('요약: 수리 성공률·평균 수리 시간·폐기·특채·불량 상위', () => {
    const list = [
      ncr({ status: 'CLOSED', disposition: 'REPAIR', repairOk: true, repairMin: 10, reinspect: 'OK' }),
      ncr({ status: 'CLOSED', disposition: 'REPAIR', repairOk: true, repairMin: 20, reinspect: 'NG' }),
      ncr({ status: 'CLOSED', disposition: 'REPAIR', repairOk: false, repairMin: 6 }),
      ncr({ status: 'CLOSED', disposition: 'SCRAP', defect: 'BUBBLE' }),
      ncr({ status: 'CLOSED', disposition: 'UAI', defect: 'BUBBLE' }),
      ncr({ status: 'WAIT_MRB', defect: 'BUBBLE' }),
      ncr({ status: 'REPAIRING', disposition: 'REPAIR' }),
    ];
    const s = summarize(list);
    assert.equal(s.total, 7);
    assert.equal(s.open, 2);
    assert.equal(s.byStatus.WAIT_MRB, 1);
    assert.equal(s.repairDone, 3);
    assert.ok(Math.abs(s.repairSuccess! - 1 / 3) < 1e-9);
    assert.equal(s.avgRepairMin, 12);
    assert.equal(s.scrapped, 3);
    assert.equal(s.uai, 1);
    assert.deepEqual(s.topDefects[0], { defect: 'LEAK', n: 4 });
  });

  it('작업지시 완료: 수량만큼 투입했고 투입한 것이 모두 양품·폐기로 끝남', () => {
    assert.equal(woDone({ qty: 10, released: 10, doneQty: 9, scrapQty: 1 }), true);
    assert.equal(woDone({ qty: 10, released: 10, doneQty: 8, scrapQty: 1 }), false);
    assert.equal(woDone({ qty: 10, released: 6, doneQty: 6, scrapQty: 0 }), false);
  });

  it('번호: 한국 시각 날짜로 매기고 기동 때 이어 센다', () => {
    // 11/13 16:00 UTC = 11/14 01:00 KST
    assert.equal(ncrCode('2026-11-13T16:00:00.000Z', 7), 'NCR-261114-0007');
    assert.equal(holdCode('2026-11-13T00:00:00.000Z', 2), 'HOLD-261113-002');
    assert.equal(maxSeq(['NCR-261113-0003', 'NCR-261113-0011', 'NCR-261112-0099'], 'NCR-261113-'), 11);
  });
});
