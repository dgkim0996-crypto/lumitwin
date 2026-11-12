import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stationOee } from '../src/live/oee';

describe('설비 OEE', () => {
  const base = { ok: 0, ng: 0, idealSec: 10, utility: false };

  it('쉬지 않고 이상 사이클로 양품만 만들면 100%', () => {
    // 1000초 동안 10초짜리 100개
    const o = stationOee({ RUN: 1000 }, { ...base, ok: 100 });
    assert.deepEqual(o, { availability: 1, performance: 1, quality: 1, oee: 1 });
  });

  it('계획 정지(STOP)는 계획 시간에서 빠져 가동률을 깎지 않는다', () => {
    const o = stationOee({ RUN: 1000, STOP: 1000 }, { ...base, ok: 100 });
    assert.equal(o.availability, 1);
    assert.equal(o.oee, 1);
  });

  it('고장(DOWN)과 셋업(SETUP)은 가동률 손실이다', () => {
    const o = stationOee({ RUN: 600, DOWN: 200, SETUP: 200 }, { ...base, ok: 60 });
    assert.equal(o.availability, 0.6);
    assert.equal(o.performance, 1);
    assert.equal(o.oee, 0.6);
  });

  it('투입·배출 대기(IDLE·BLOCKED)는 가동률이 아니라 성능 손실이다', () => {
    // 가동 가능 1000초 중 실제로 만든 것은 50개 × 10초 = 500초어치
    const o = stationOee({ RUN: 500, IDLE: 300, BLOCKED: 200 }, { ...base, ok: 50 });
    assert.equal(o.availability, 1);
    assert.equal(o.performance, 0.5);
  });

  it('양품률은 양품 ÷ 처리 수이고, 세 값의 곱이 OEE다', () => {
    const o = stationOee({ RUN: 800, DOWN: 200 }, { ...base, ok: 72, ng: 8 });
    assert.equal(o.availability, 0.8);
    assert.equal(o.performance, 1);
    assert.equal(o.quality, 0.9);
    assert.equal(o.oee, 0.72);
  });

  it('성능은 1을 넘지 않는다 (사이클 편차로 이상 사이클보다 빨리 나온 경우)', () => {
    const o = stationOee({ RUN: 900 }, { ...base, ok: 100 });
    assert.equal(o.performance, 1);
  });

  it('유틸리티 설비(사이클 없음)는 성능 1, 처리 수가 없으면 양품률 1', () => {
    const o = stationOee({ RUN: 700, DOWN: 300 }, { ...base, idealSec: 0, utility: true });
    assert.deepEqual(o, { availability: 0.7, performance: 1, quality: 1, oee: 0.7 });
  });

  it('아직 시간이 없으면(막 시작) 가동률 1, 성능 0으로 0으로 나누지 않는다', () => {
    const o = stationOee({}, base);
    assert.deepEqual(o, { availability: 1, performance: 0, quality: 1, oee: 0 });
  });
});
