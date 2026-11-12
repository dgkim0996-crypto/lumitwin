import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SpcRule } from '@lumitwin/shared';
import { SpcSeries } from '../src/live/spc';

/** 기준 10, σ 1, 부분군 5 → 관리 한계 10 ± 3·1/√5 ≈ 8.658 ~ 11.342, R 관리 상한 4.918 */
function series(over: Partial<ConstructorParameters<typeof SpcSeries>[0]> = {}) {
  const se = 1 / Math.sqrt(5);
  return new SpcSeries({
    station: 'T-01', key: 'x', name: '시험 특성', unit: 'mm', source: 'measure', n: 5,
    cl: 10, sigma: 1, ucl: 10 + 3 * se, lcl: 10 - 3 * se, rCl: 2.326, rUcl: 4.918,
    lsl: 7, usl: 13, alarms: true,
    ...over,
  });
}

/** 부분군 하나(값 5개)를 넣고 결과를 돌려준다 */
function group(s: SpcSeries, vs: number[]) {
  assert.equal(vs.length, 5);
  for (let i = 0; i < 4; i++) assert.equal(s.add(vs[i], `t${i}`), null, '부분군이 차기 전에는 점을 만들지 않는다');
  const out = s.add(vs[4], 't4');
  assert.ok(out);
  return out;
}
const flat = (m: number) => [m, m, m, m, m];
const flagsOf = (r: { point: { flags: SpcRule[] } }) => r.point.flags;

describe('SPC X̄-R 관리도', () => {
  it('부분군 평균과 범위를 점으로 만든다', () => {
    const r = group(series(), [9, 10, 10, 10, 11]);
    assert.equal(r.point.mean, 10);
    assert.equal(r.point.range, 2);
    assert.deepEqual(r.point.flags, []);
    assert.equal(r.alarmRule, null);
  });

  it('R1: 평균이 관리 한계를 벗어나면 표시하고 알람을 낸다', () => {
    const s = series();
    const r = group(s, flat(12));
    assert.ok(flagsOf(r).includes('R1'));
    assert.equal(r.alarmRule, 'R1');
  });

  it('알람 뒤 12개 부분군 동안은 같은 특성에서 알람을 다시 내지 않는다 (표시는 한다)', () => {
    const s = series();
    assert.equal(group(s, flat(12)).alarmRule, 'R1');
    for (let i = 0; i < 12; i++) {
      const r = group(s, flat(12));
      assert.ok(flagsOf(r).includes('R1'));
      assert.equal(r.alarmRule, null, `${i + 1}번째`);
    }
    assert.equal(group(s, flat(12)).alarmRule, 'R1');
  });

  it('R2: 9점 연속 중심선 한쪽이면 표시한다 (한계 안이어도)', () => {
    const s = series();
    for (let i = 0; i < 8; i++) assert.ok(!flagsOf(group(s, flat(10.5))).includes('R2'));
    const r = group(s, flat(10.5));
    assert.ok(flagsOf(r).includes('R2'));
    assert.equal(r.alarmRule, 'R2');
  });

  it('R3: 6점 연속 오르면 표시만 하고 알람은 내지 않는다', () => {
    const s = series();
    let r!: ReturnType<typeof group>;
    for (const m of [9.5, 9.7, 9.9, 10.1, 10.3, 10.5]) r = group(s, flat(m));
    assert.ok(flagsOf(r).includes('R3'));
    assert.equal(r.alarmRule, null);
  });

  it('R4: 부분군 범위가 R 관리 상한을 넘으면 표시한다', () => {
    const r = group(series(), [7, 10, 10, 10, 13]);
    assert.equal(r.point.mean, 10);
    assert.ok(flagsOf(r).includes('R4'));
  });

  it('알람을 끈 특성(공정 파라미터)은 판정만 하고 알람은 내지 않는다', () => {
    const r = group(series({ alarms: false, source: 'cycle' }), flat(12));
    assert.ok(flagsOf(r).includes('R1'));
    assert.equal(r.alarmRule, null);
  });

  it('Cpk = min(USL−μ, μ−LSL) / 3σ, σ = R̄/d2 (점 5개부터)', () => {
    const s = series();
    // 범위 2.326씩 → σ = 1, 평균 10 → Cpk = min(3, 3)/3 = 1
    const vs = [8.837, 10, 10, 10, 11.163];
    for (let i = 0; i < 4; i++) group(s, vs);
    assert.equal(s.chart.cpk, null, '점이 4개면 계산하지 않는다');
    group(s, vs);
    assert.equal(s.chart.cpk, 1);
  });

  it('숫자가 아닌 값은 버린다', () => {
    const s = series();
    assert.equal(s.add(Number.NaN, 't'), null);
    assert.equal(s.add(Number.POSITIVE_INFINITY, 't'), null);
    const r = group(s, flat(10));
    assert.equal(r.point.mean, 10);
  });
});
