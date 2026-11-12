import type { Oee, StationState } from '@lumitwin/shared';

/** 상태별 누적 시간 (초) */
export type StateTimes = Partial<Record<StationState, number>>;

export const r3 = (v: number) => Math.round(v * 1000) / 1000;

const sum = (times: StateTimes, ks: StationState[]) => ks.reduce((a, k) => a + (times[k] ?? 0), 0);

/**
 * 설비 OEE = 가동률 × 성능 × 양품률
 * - 계획 시간 = 전체 − 계획 정지(STOP). 작업자가 일부러 세운 시간은 손실로 세지 않는다
 * - 가동률 = 가동 가능 시간(가동·투입 대기·배출 대기) ÷ 계획 시간. 고장(DOWN)·셋업(SETUP)이 가동률 손실이다
 * - 성능 = 이상 사이클 × 처리 수 ÷ 가동 가능 시간 (투입·배출 대기는 성능 손실로 잡힌다). 유틸리티 설비(사이클 없음)는 1
 * - 양품률 = 양품 ÷ 처리 수
 */
export function stationOee(times: StateTimes, c: { ok: number; ng: number; idealSec: number; utility: boolean }): Oee {
  const total = sum(times, ['RUN', 'IDLE', 'BLOCKED', 'DOWN', 'SETUP', 'STOP']);
  const planned = total - (times.STOP ?? 0);
  const operating = sum(times, ['RUN', 'IDLE', 'BLOCKED']);
  const count = c.ok + c.ng;
  const availability = planned > 0 ? operating / planned : 1;
  const performance = c.utility ? 1 : operating > 0 ? Math.min(1, (c.idealSec * count) / operating) : 0;
  const quality = count > 0 ? c.ok / count : 1;
  return { availability: r3(availability), performance: r3(performance), quality: r3(quality), oee: r3(availability * performance * quality) };
}
