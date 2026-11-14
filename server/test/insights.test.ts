import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LINES, STATIONS, shiftByKey, type LineDef, type ShiftReport } from '@lumitwin/shared';
import {
  buildEnergy,
  buildShiftReport,
  bucketHours,
  clipSpans,
  csvCell,
  downtimeTop,
  energyBuckets,
  fpyOf,
  initialState,
  kwhOf,
  lineOee,
  makeBuckets,
  shiftCsv,
  shiftsBetween,
  timesBy,
  type ShiftInput,
  type StateRow,
} from '../src/insights/calc';

const T0 = Date.parse('2026-11-13T00:00:00Z'); // 한국 시각 09:00 (주간 교대 중)
const at = (min: number) => new Date(T0 + min * 60_000);
const row = (station: string, state: string, from: number, to: number | null, first = false, reason: string | null = null): StateRow => ({
  station, state, reason, at: at(from), end: to == null ? null : at(to), first,
});
const win = (fromMin: number, toMin: number, nowMin = toMin, runMin = 0) => ({ runStartMs: T0 + runMin * 60_000, fromMs: T0 + fromMin * 60_000, toMs: T0 + toMin * 60_000, nowMs: T0 + nowMin * 60_000 });

const HL = LINES.find((l) => l.code === 'HL')!;
const ASSY = 'HL-AS-01'; // 투입 공정 (제품 경로, 사이클 70초)
const PACK = 'HL-PK-01'; // 최종 공정
const MOLD = 'HL-IM-L1'; // 렌즈 사출 (제품 경로 밖)

describe('상태 구간 자르기', () => {
  it('첫 기록 전은 초기 상태로 채우고, 열린 구간은 구간 끝까지 잇는다', () => {
    const spans = clipSpans([row(ASSY, 'RUN', 10, 40, true), row(ASSY, 'DOWN', 40, null)], win(0, 60), [ASSY]);
    const t = timesBy(spans).get(ASSY)!;
    assert.equal(initialState(ASSY), 'IDLE');
    assert.equal(t.IDLE, 10 * 60);
    assert.equal(t.RUN, 30 * 60);
    assert.equal(t.DOWN, 20 * 60);
  });

  it('구간 앞뒤로 자르고, 지금 뒤와 실행 시작 전은 세지 않는다', () => {
    // 기록: 0~100분 RUN, 100분부터 STOP. 구간 30~200분, 지금 150분, 실행 시작 20분
    const spans = clipSpans([row(ASSY, 'RUN', 0, 100, true), row(ASSY, 'STOP', 100, null)], win(30, 200, 150, 20), [ASSY]);
    const t = timesBy(spans).get(ASSY)!;
    assert.equal(t.RUN, 70 * 60);
    assert.equal(t.STOP, 50 * 60);
    assert.equal(t.IDLE, undefined);
  });

  it('기록이 없는 설비는 구간 전체가 초기 상태 (유틸리티 설비는 가동)', () => {
    const dryer = Object.values(STATIONS).find((s) => s.cycle <= 0)!.code;
    const t = timesBy(clipSpans([], win(0, 60), [ASSY, dryer]));
    assert.equal(t.get(ASSY)!.IDLE, 3600);
    assert.equal(t.get(dryer)!.RUN, 3600);
  });
});

describe('에너지', () => {
  const kw = { run: 10, idle: 4, off: 0.5 };

  it('상태 시간 × 구분별 소비 전력: RUN = 가동, IDLE·BLOCKED·SETUP = 대기, STOP·DOWN = 정지', () => {
    const e = kwhOf({ RUN: 3600, IDLE: 1800, BLOCKED: 900, SETUP: 900, STOP: 3600, DOWN: 3600 }, kw);
    assert.equal(e.run, 10);
    assert.equal(e.idle, 4 * 1);
    assert.equal(e.off, 0.5 * 2);
    assert.equal(e.total, 15);
  });

  it('시간대 칸은 한국 시각 정시에 맞추고, 칸 경계를 넘는 구간은 나눠 담는다', () => {
    // 09:30~11:30 (한국 시각) RUN → 9시 칸 30분, 10시 칸 60분, 11시 칸 30분
    const spans = clipSpans([row(ASSY, 'RUN', 30, null, true)], win(30, 150), [ASSY]);
    const b = energyBuckets(spans, makeBuckets(T0 + 30 * 60_000, T0 + 150 * 60_000, 1, T0 + 150 * 60_000), () => kw);
    assert.deepEqual(
      b.map((x) => x.run),
      [5, 10, 5],
    );
    assert.equal(b[0].t, new Date(T0).toISOString());
    assert.equal(b[0].partial, true);
    assert.equal(b[1].partial, false);
    assert.equal(bucketHours(24 * 3_600_000), 1);
    assert.equal(bucketHours(7 * 24 * 3_600_000), 4);
  });

  it('라인 개당 전력량 = 라인 전력량 ÷ 완성품, 대기 비중 = 대기 ÷ 전체, 소비 전력이 없는 설비는 빠진다', () => {
    const r = buildEnergy({
      runId: 1, runStartMs: T0, nowMs: T0 + 60 * 60_000, fromMs: T0, toMs: T0 + 60 * 60_000,
      rows: [row(ASSY, 'RUN', 0, 30, true), row(ASSY, 'IDLE', 30, null), row(PACK, 'DOWN', 0, null, true)],
      okByStation: new Map([[ASSY, 20]]), goodByLine: new Map([['HL', 10]]), line: 'HL',
      kw: (c) => (c === ASSY || c === PACK ? kw : null),
    });
    const a = r.stations.find((s) => s.station === ASSY)!;
    assert.equal(a.run, 5);
    assert.equal(a.idle, 2);
    assert.equal(a.perUnit, 0.35);
    const hl = r.lines[0];
    assert.equal(hl.total, 5 + 2 + 0.5);
    assert.equal(hl.perUnit, 0.75);
    assert.equal(hl.idleShare, Math.round((2 / 7.5) * 1000) / 1000);
    assert.equal(hl.stations, 2);
    assert.equal(hl.missing.length, HL.stations.length - 2);
    assert.equal(r.missing.length, HL.stations.length - 2);
    assert.equal(r.hourly.reduce((x, b) => x + b.run + b.idle + b.off, 0), 7.5);
  });

  it('소비 전력 정의가 하나도 없으면 비중·개당 값은 비운다 (자료 없음)', () => {
    const r = buildEnergy({ runId: 1, runStartMs: T0, nowMs: T0 + 3_600_000, fromMs: T0, toMs: T0 + 3_600_000, rows: [], okByStation: new Map(), goodByLine: new Map([['HL', 5]]), line: 'HL', kw: () => null });
    assert.equal(r.lines[0].perUnit, null);
    assert.equal(r.lines[0].idleShare, null);
    assert.equal(r.total.idleShare, null);
    assert.equal(r.total.total, 0);
  });
});

describe('라인 OEE · 직행률 · 비가동 사유', () => {
  it('가동률 × 성능 × 양품률 = 가치 시간 ÷ 계획 시간 (설비 시간 합)', () => {
    const one: LineDef = { ...HL, stations: [HL.stations.find((s) => s.code === ASSY)!] };
    const oee = lineOee(one, new Map([[ASSY, { RUN: 3000, IDLE: 600, DOWN: 400, STOP: 1000 }]]), new Map([[ASSY, { ok: 45, ng: 5 }]]))!;
    // 계획 4000 (정지 제외) · 가동 가능 3600 · 순가동 70×50 = 3500 · 가치 3500÷50×45 = 3150
    assert.equal(oee.availability, 0.9);
    assert.equal(oee.performance, Math.round((3500 / 3600) * 1000) / 1000);
    assert.equal(oee.quality, 0.9);
    assert.equal(oee.oee, Math.round((3150 / 4000) * 1000) / 1000);
  });

  it('계획 시간이 없으면 OEE는 비운다', () => {
    const one: LineDef = { ...HL, stations: [HL.stations.find((s) => s.code === ASSY)!] };
    assert.equal(lineOee(one, new Map([[ASSY, { STOP: 1000 }]]), new Map()), null);
  });

  it('직행률 = 공정별 합격률의 곱, 판정이 없으면 null', () => {
    assert.equal(fpyOf([{ ok: 90, ng: 10 }, { ok: 50, ng: 0 }, { ok: 0, ng: 0 }]), 0.9);
    assert.equal(fpyOf([]), null);
  });

  it('비가동 사유: 고장·셋업·정지만, 사유별 합, 작업자 등록 꼬리표는 뗀다', () => {
    const spans = clipSpans(
      [
        row(ASSY, 'DOWN', 0, 10, true, '그리퍼 이상 (작업자 등록)'),
        row(ASSY, 'RUN', 10, 20),
        row(ASSY, 'DOWN', 20, 25, false, '그리퍼 이상'),
        row(ASSY, 'STOP', 25, 60, false, '교대·휴식'),
        row(PACK, 'IDLE', 0, null, true, 'MES 확인 대기'),
      ],
      win(0, 60),
      [ASSY, PACK],
    );
    const top = downtimeTop(spans);
    assert.deepEqual(
      top.map((d) => [d.state, d.reason, d.sec, d.count]),
      [
        ['STOP', '교대·휴식', 35 * 60, 1],
        ['DOWN', '그리퍼 이상', 15 * 60, 2],
      ],
    );
  });
});

describe('교대', () => {
  it('실행 시작부터 지금까지 걸친 교대 (새것부터)', () => {
    // 실행 시작 11-13 07:00 (한국), 지금 11-13 21:00 → 11-12 야간, 11-13 주간, 11-13 야간
    const list = shiftsBetween(Date.parse('2026-11-13T07:00:00+09:00'), Date.parse('2026-11-13T21:00:00+09:00'));
    assert.deepEqual(
      list.map((s) => s.key),
      ['2026-11-13-N', '2026-11-13-D', '2026-11-12-N'],
    );
    assert.equal(shiftsBetween(Date.parse('2026-11-01T08:00:00+09:00'), Date.parse('2026-12-01T08:00:00+09:00'), 10).length, 10);
  });
});

describe('교대 일보', () => {
  const slot = shiftByKey('2026-11-13-D')!; // 08:00~20:00 한국 = 2026-11-12T23:00Z ~ 11-13T11:00Z
  const S = Date.parse(slot.start);
  const tAt = (h: number) => new Date(S + h * 3_600_000);

  const input = (over: Partial<ShiftInput> = {}): ShiftInput => ({
    slot,
    runId: 7,
    runStartMs: S + 3_600_000, // 실행은 09:00에 시작
    nowMs: S + 5 * 3_600_000, // 지금 13:00 (교대 진행 중)
    current: true,
    rows: [],
    records: [
      { line: 'HL', step: 'ASSY', station: ASSY, result: 'OK', defect: null, workOrder: 1, reinspect: false, n: 40 },
      { line: 'HL', step: 'ASSY', station: ASSY, result: 'NG', defect: 'MISASSY', workOrder: 1, reinspect: false, n: 2 },
      { line: 'HL', step: 'PACK', station: PACK, result: 'OK', defect: null, workOrder: 1, reinspect: false, n: 30 },
      { line: 'HL', step: 'PACK', station: PACK, result: 'OK', defect: null, workOrder: 2, reinspect: false, n: 5 },
      { line: 'HL', step: 'LENS_MOLD', station: MOLD, result: 'NG', defect: 'SILVER', workOrder: null, reinspect: false, n: 3 },
      { line: 'HL', step: 'ASSY', station: ASSY, result: 'OK', defect: null, workOrder: 1, reinspect: true, n: 1 },
      { line: 'EM', step: 'BMS_PACK', station: 'EM-x', result: 'OK', defect: null, workOrder: null, reinspect: false, n: 99 },
    ],
    orders: [
      { id: 1, code: 'WO-HL-261113-001', line: 'HL', variant: 'HL-VX1-L', qty: 96, status: 'RUNNING', released: 42, doneQty: 30, scrapQty: 0, startedAt: tAt(1), endedAt: null },
      { id: 2, code: 'WO-HL-261113-002', line: 'HL', variant: 'HL-VX1-R', qty: 96, status: 'DONE', released: 96, doneQty: 95, scrapQty: 1, startedAt: tAt(-3), endedAt: tAt(0.5) },
      { id: 3, code: 'WO-HL-261113-003', line: 'HL', variant: 'HL-VX1-L', qty: 96, status: 'PLANNED', released: 0, doneQty: 0, scrapQty: 0, startedAt: null, endedAt: null },
      { id: 4, code: 'WO-HL-261112-009', line: 'HL', variant: 'HL-VX1-R', qty: 96, status: 'DONE', released: 96, doneQty: 96, scrapQty: 0, startedAt: tAt(-6), endedAt: tAt(-2) },
    ],
    ncr: [
      { line: 'HL', openedAt: tAt(2), closedAt: tAt(2.5), disposition: 'SCRAP', repairOk: null },
      { line: 'HL', openedAt: tAt(3), closedAt: tAt(3.5), disposition: 'REPAIR', repairOk: false },
      { line: 'HL', openedAt: tAt(3), closedAt: null, disposition: null, repairOk: null },
      { line: 'HL', openedAt: tAt(-1), closedAt: tAt(1.5), disposition: 'REPAIR', repairOk: true },
    ],
    changes: [
      { line: 'HL', category: 'MAN', kind: 'shift', faStatus: 'OK', n: 6 },
      { line: 'HL', category: 'MACHINE', kind: 'repair', faStatus: 'NG', n: 1 },
    ],
    inspections: [
      { line: 'HL', type: 'FIRST', result: 'OK', n: 6 },
      { line: 'HL', type: 'FIRST', result: 'NG', n: 1 },
      { line: 'HL', type: 'MID', result: 'OK', n: 3 },
    ],
    interlock: [
      { line: 'HL', verdict: 'NG', code: 'ROUTE', n: 2 },
      { line: 'HL', verdict: 'NG', code: 'HOLD', n: 1 },
      { line: 'HL', verdict: 'WAIT', code: 'FA', n: 4 },
    ],
    holdScrap: new Map([['HL', 2]]),
    line: 'HL',
    kw: (c) => (c === ASSY ? { run: 3, idle: 1, off: 0.1 } : null),
    ...over,
  });

  it('투입·생산 OK·NG·폐기·직행률을 라인별로 모은다', () => {
    const r = buildShiftReport(input());
    assert.equal(r.lines.length, 1);
    const hl = r.lines[0];
    assert.equal(hl.input, 42); // 재검사 제외
    assert.equal(hl.ok, 35);
    assert.equal(hl.ng, 5);
    // 폐기 = 제품 경로 밖 불량 3 + NCR 폐기 1 + 수리 실패 1 + Hold 폐기 2
    assert.equal(hl.scrap, 3 + 1 + 1 + 2);
    // 직행률: ASSY 40/42 × PACK 1 × LENS_MOLD 0/3 = 0
    assert.equal(hl.fpy, 0);
    assert.equal(hl.defects[0].code, 'SILVER');
    assert.equal(hl.defects[0].count, 3);
  });

  it('실행 시작·지금으로 자른 구간: 목표 = 구간 ÷ 택트, 작업지시는 구간과 겹치거나 실적이 있는 것', () => {
    const r = buildShiftReport(input());
    assert.equal(r.from, new Date(S + 3_600_000).toISOString());
    assert.equal(r.to, new Date(S + 5 * 3_600_000).toISOString());
    assert.equal(r.current, true);
    assert.equal(r.name, '11-13 주간');
    const hl = r.lines[0];
    assert.equal(hl.target, Math.floor((4 * 3600) / HL.taktSec));
    assert.deepEqual(
      hl.orders.map((o) => [o.id, o.input, o.good]),
      [
        [2, 0, 5],
        [1, 42, 30],
      ],
    );
  });

  it('NCR 발생·종결·미결, 변경점, 초중종물, 인터록 거부, 전력량', () => {
    const hl = buildShiftReport(input()).lines[0];
    assert.deepEqual(hl.ncr, { opened: 3, closed: 3, openAtEnd: 1 });
    assert.equal(hl.changes.total, 7);
    assert.equal(hl.changes.byCategory.MAN, 6);
    assert.equal(hl.changes.faNg, 1);
    assert.deepEqual(hl.inspections, { FIRST: 7, MID: 3, LAST: 0, ng: 1 });
    assert.deepEqual(hl.interlock, { ng: 3, wait: 4, byCode: { ROUTE: 2, HOLD: 1 } });
    // 상태 기록이 없으면 투입 공정은 구간 4시간 내내 투입 대기 → 1 kW × 4 h
    assert.equal(hl.energy.kwh, 4);
    assert.equal(hl.energy.perUnit, Math.round((4 / 35) * 1000) / 1000);
    assert.equal(hl.energy.missing, HL.stations.length - 1);
  });
});

describe('CSV', () => {
  it('쉼표·따옴표·줄바꿈은 따옴표로 감싸고, 수식으로 읽힐 글은 막는다', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('그는 "OK"'), '"그는 ""OK"""');
    assert.equal(csvCell('줄\n바꿈'), '"줄\n바꿈"');
    assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
    assert.equal(csvCell(-3), '-3');
    assert.equal(csvCell(null), '');
  });

  it('엑셀용 UTF-8 BOM으로 시작하고 줄은 CRLF', () => {
    const slot = shiftByKey('2026-11-13-N')!;
    const r: ShiftReport = buildShiftReport({
      slot, runId: 1, runStartMs: Date.parse(slot.start), nowMs: Date.parse(slot.end), current: false, rows: [], records: [], orders: [], ncr: [],
      changes: [], inspections: [], interlock: [], holdScrap: new Map(), kw: () => null,
    });
    const text = shiftCsv(r);
    assert.equal(text.charCodeAt(0), 0xfeff);
    assert.ok(text.includes('\r\n'));
    assert.ok(text.includes('교대 일보,2026-11-13 야간'));
    assert.ok(text.includes('전력량 (kWh),자료 없음,자료 없음,자료 없음'));
  });
});
