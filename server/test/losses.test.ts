import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOSS_KEYS, type LossTimes } from '@lumitwin/shared';
import { stationLosses, sumLosses } from '../src/live/losses';
import { stationOee, type StateTimes } from '../src/live/oee';

const lossSum = (x: LossTimes) => LOSS_KEYS.reduce((a, k) => a + x.loss[k], 0);
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

describe('6대 로스', () => {
  const base = { ok: 0, ng: 0, startupNg: 0, idealSec: 10, utility: false };

  it('계획 시간 = 가치 시간 + 6대 로스 (계획 정지는 따로)', () => {
    const times: StateTimes = { RUN: 700, IDLE: 100, BLOCKED: 50, DOWN: 120, SETUP: 30, STOP: 500 };
    const x = stationLosses(times, { ...base, ok: 60, ng: 5, startupNg: 2 });
    assert.equal(x.planned, 1000);
    assert.equal(x.stopped, 500);
    near(x.valuable + lossSum(x), x.planned);
  });

  it('가치 시간 ÷ 계획 시간이 OEE와 같다', () => {
    const cases: [StateTimes, { ok: number; ng: number }][] = [
      [{ RUN: 700, IDLE: 100, BLOCKED: 50, DOWN: 120, SETUP: 30 }, { ok: 60, ng: 5 }],
      [{ RUN: 500, IDLE: 300, DOWN: 200 }, { ok: 50, ng: 0 }],
      // 이상 사이클보다 빨리 만든 경우 (성능 상한 1)
      [{ RUN: 400, IDLE: 400 }, { ok: 60, ng: 0 }],
      [{ RUN: 900, STOP: 100 }, { ok: 100, ng: 0 }],
    ];
    for (const [times, c] of cases) {
      const x = stationLosses(times, { ...base, ...c });
      const o = stationOee(times, { ...c, idealSec: base.idealSec, utility: false });
      assert.ok(Math.abs(x.valuable / x.planned - o.oee) < 0.001, `${JSON.stringify(times)}: ${x.valuable / x.planned} vs ${o.oee}`);
    }
  });

  it('고장·셋업은 가동률 로스, 투입·배출 대기는 순간 정지, 느린 가공은 속도 저하', () => {
    // 가동 800초 동안 이상 사이클 10초짜리 70개 → 순가동 700초, 속도 저하 100초
    const x = stationLosses({ RUN: 800, IDLE: 150, BLOCKED: 50, DOWN: 300, SETUP: 100 }, { ...base, ok: 70 });
    assert.equal(x.loss.breakdown, 300);
    assert.equal(x.loss.setup, 100);
    assert.equal(x.loss.minorStop, 200);
    assert.equal(x.loss.speed, 100);
    assert.equal(x.loss.defect, 0);
    assert.equal(x.valuable, 700);
  });

  it('이상보다 빨리 만든 만큼은 대기 시간과 상쇄되고 속도 저하는 0', () => {
    // 가동 400초에 60개(이상 600초어치) → 대기 400초 중 200초만 로스
    const x = stationLosses({ RUN: 400, IDLE: 400 }, { ...base, ok: 60 });
    assert.equal(x.loss.speed, 0);
    assert.equal(x.loss.minorStop, 200);
    assert.equal(x.valuable, 600);
  });

  it('불량에 쓴 시간: 재가동 직후 불량은 초기 수율, 나머지는 공정 불량', () => {
    const x = stationLosses({ RUN: 1000 }, { ...base, ok: 90, ng: 10, startupNg: 3 });
    assert.equal(x.loss.startup, 30);
    assert.equal(x.loss.defect, 70);
    assert.equal(x.valuable, 900);
  });

  it('초기 수율 불량 수가 불량 수보다 많아도 불량 수까지만 센다', () => {
    const x = stationLosses({ RUN: 100 }, { ...base, ok: 8, ng: 2, startupNg: 5 });
    assert.equal(x.loss.startup, 20);
    assert.equal(x.loss.defect, 0);
  });

  it('유틸리티 설비는 가동률 로스만 있다', () => {
    const x = stationLosses({ RUN: 800, DOWN: 200 }, { ...base, idealSec: 0, utility: true });
    assert.deepEqual(x.loss, { breakdown: 200, setup: 0, minorStop: 0, speed: 0, defect: 0, startup: 0 });
    assert.equal(x.valuable, 800);
  });

  it('아무것도 못 만들었으면 가동 가능 시간 전체가 순간 정지·속도 저하', () => {
    const x = stationLosses({ RUN: 30, IDLE: 70 }, base);
    assert.equal(x.valuable, 0);
    assert.equal(x.loss.minorStop, 70);
    assert.equal(x.loss.speed, 30);
  });

  it('합계는 항목별로 더한다', () => {
    const a = stationLosses({ RUN: 100, DOWN: 50 }, { ...base, ok: 10 });
    const b = stationLosses({ RUN: 200, SETUP: 20, STOP: 30 }, { ...base, ok: 15, ng: 5 });
    const s = sumLosses([a, b]);
    assert.equal(s.planned, a.planned + b.planned);
    assert.equal(s.stopped, 30);
    assert.equal(s.loss.breakdown, 50);
    assert.equal(s.loss.setup, 20);
    near(s.valuable + lossSum(s), s.planned);
  });
});
