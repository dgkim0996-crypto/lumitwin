import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PM_PLANS, PM_REASON, STATIONS, maintenanceTotals } from '@lumitwin/shared';
import { buildMaintenance, failureReason, type HaltRow } from '../src/maintenance/maintenance';

const T0 = Date.parse('2026-11-12T00:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000);
const row = (station: string, state: string, from: number, to: number | null, reason: string | null = null): HaltRow => ({
  station, state, reason, at: at(from), end: to == null ? null : at(to),
});
const report = (rows: HaltRow[], nowMin: number) => buildMaintenance(rows, { runStartMs: T0, nowMs: T0 + nowMin * 60_000 });
const of = (r: ReturnType<typeof report>, code: string) => r.stations.find((s) => s.station === code)!;

// 계획 보전 주기가 24시간인 사출기와 8시간인 솔더 인쇄기
const MOLD = 'HL-IM-L1';
const PRINTER = 'EM-PR-L';

describe('설비 보전', () => {
  it('MTBF = 가동 시간 ÷ 고장 수, 가동 시간에서 고장·계획 정지·셋업을 뺀다', () => {
    // 600분 중 고장 2번(30 + 20분), 계획 정지 60분, 셋업 10분 → 가동 480분
    const r = report(
      [row(MOLD, 'DOWN', 100, 130, '노즐 막힘'), row(MOLD, 'STOP', 200, 260, '교대·휴식'), row(MOLD, 'SETUP', 300, 310), row(MOLD, 'DOWN', 400, 420, '히터 단선')],
      600,
    );
    const s = of(r, MOLD);
    assert.equal(s.failures, 2);
    assert.equal(s.upSec, 480 * 60);
    assert.equal(s.downSec, 50 * 60);
    assert.equal(s.mtbf, 240);
    assert.equal(s.mttr, 25);
    assert.ok(Math.abs(s.availability! - 480 / 530) < 1e-9);
    assert.equal(s.designMtbf, STATIONS[MOLD].mtbf);
    assert.equal(s.down, false);
  });

  it('진행 중인 고장은 고장 수·고장 시간에 넣고 MTTR에서는 뺀다', () => {
    const r = report([row(MOLD, 'DOWN', 100, 130), row(MOLD, 'DOWN', 500, null, '진공 펌프 압력 이상 (작업자 등록)')], 600);
    const s = of(r, MOLD);
    assert.equal(s.down, true);
    assert.equal(s.failures, 2);
    assert.equal(s.downSec, (30 + 100) * 60);
    assert.equal(s.repairs, 1);
    assert.equal(s.mttr, 30);
    assert.equal(s.lastFailure?.end, null);
    assert.equal(s.lastFailure?.byOperator, true);
    assert.equal(s.lastFailure?.reason, '진공 펌프 압력 이상');
  });

  it('고장이 없으면 MTBF·MTTR은 비우고 가용도는 1', () => {
    const s = of(report([], 300), MOLD);
    assert.equal(s.failures, 0);
    assert.equal(s.mtbf, null);
    assert.equal(s.mttr, null);
    assert.equal(s.availability, 1);
    assert.equal(s.upSec, 300 * 60);
  });

  it('계획 보전: 사유가 계획 보전인 계획 정지가 끝난 뒤 쌓인 가동 시간을 주기와 비교한다', () => {
    const every = PM_PLANS[STATIONS[PRINTER].kind].every * 60;
    // 실행 시작부터 주기만큼 돌았으면 초과
    assert.equal(of(report([], every), PRINTER).pm.status, 'due');
    assert.equal(of(report([], every * 0.9), PRINTER).pm.status, 'soon');
    assert.equal(of(report([], every * 0.5), PRINTER).pm.status, 'ok');

    // 400분에 계획 보전(15분)을 했으면 그 뒤부터 다시 센다. 그 뒤 고장 10분은 가동 시간이 아니다
    const r = report([row(PRINTER, 'STOP', 400, 415, PM_REASON), row(PRINTER, 'DOWN', 450, 460)], 500);
    const s = of(r, PRINTER);
    assert.equal(s.pm.count, 1);
    assert.equal(s.pm.lastAt, at(415).toISOString());
    assert.equal(s.pm.sinceSec, (500 - 415 - 10) * 60);
    assert.equal(s.pm.status, 'ok');
  });

  it('다른 사유의 계획 정지는 계획 보전으로 치지 않고, 보전 중이면 상태가 doing', () => {
    const notPm = of(report([row(PRINTER, 'STOP', 100, 130, '교대·휴식')], 200), PRINTER);
    assert.equal(notPm.pm.count, 0);
    assert.equal(notPm.pm.lastAt, null);
    assert.equal(notPm.pm.sinceSec, (200 - 30) * 60);

    const doing = of(report([row(PRINTER, 'STOP', 190, null, PM_REASON)], 200), PRINTER);
    assert.equal(doing.pm.status, 'doing');
  });

  it('실행 시작 전에 시작된 구간과 지금 이후는 잘라 낸다', () => {
    const r = buildMaintenance([row(MOLD, 'DOWN', -30, 10)], { runStartMs: T0, nowMs: T0 + 60 * 60_000 });
    assert.equal(of(r, MOLD).downSec, 10 * 60);
  });

  it('고장 이력은 새것부터, 사유별 합계는 시간 큰 순', () => {
    const r = report([row(MOLD, 'DOWN', 10, 20, '노즐 막힘'), row(PRINTER, 'DOWN', 30, 70, '스퀴지 압력 이상'), row(MOLD, 'DOWN', 100, 105, '노즐 막힘')], 200);
    assert.deepEqual(r.failures.map((f) => f.start), [at(100), at(30), at(10)].map((d) => d.toISOString()));
    assert.equal(r.reasons[0].reason, '스퀴지 압력 이상');
    assert.deepEqual(r.reasons[1], { reason: '노즐 막힘', count: 2, sec: 15 * 60, stations: [MOLD] });
  });

  it('작업자 등록 꼬리표를 떼고 등록 주체를 가른다', () => {
    assert.deepEqual(failureReason('히터 단선'), { reason: '히터 단선', byOperator: false });
    assert.deepEqual(failureReason('누설 (작업자 등록)'), { reason: '누설', byOperator: true });
    assert.deepEqual(failureReason('작업자 고장 등록'), { reason: '사유 미기재', byOperator: true });
    assert.deepEqual(failureReason(null), { reason: '사유 없음', byOperator: false });
  });

  it('합계: 공장 MTBF는 가동 시간 합 ÷ 고장 수 합, MTTR은 끝난 고장만', () => {
    const r = report([row(MOLD, 'DOWN', 100, 130), row(PRINTER, 'DOWN', 200, 210), row(PRINTER, 'DOWN', 590, null)], 600);
    const t = maintenanceTotals(r.stations);
    const up = r.stations.reduce((a, s) => a + s.upSec, 0);
    assert.equal(t.failures, 3);
    assert.ok(Math.abs(t.mtbf! - up / 3 / 60) < 1e-9);
    assert.equal(t.mttr, 20);
    assert.equal(t.downNow, 1);
  });
});
