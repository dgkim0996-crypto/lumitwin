import type { SimStatusMsg } from '@lumitwin/shared';

/**
 * 설비 메시지가 시뮬레이터 상태 시각보다 앞서도 되는 한도 (실제 초).
 * 상태는 1초마다 오고 설비 메시지는 그보다 늦게 오는 게 보통이라(엣지 경로는 더 늦다) 넉넉히 둔다
 */
export const AHEAD_REAL_SEC = 30;
/** 배속이 낮아도 이만큼(가상 ms)은 봐준다 */
export const AHEAD_MIN_MS = 5 * 60_000;

/** 지금 배속에서 상태 시각보다 앞서도 되는 가상 시간 (ms) */
export function aheadLimitMs(speed: number): number {
  return Math.max(AHEAD_MIN_MS, (speed > 0 ? speed : 1) * AHEAD_REAL_SEC * 1000);
}

/**
 * 지금 실행의 메시지로 볼 수 없는 시각인가: 실행 시작 전이거나, 시뮬레이터가 알려 준 지금보다 한참 뒤.
 * 초기화하면 가상 시계가 실제 시각으로 돌아가는데, 엣지 게이트웨이 큐에 남은 이전 실행의 값은 그 뒤에 도착한다.
 * 그대로 받으면 새 실행에 섞여 가상 시계가 몇 시간 앞으로 튀고 상태 기록도 엉뚱한 시각으로 남는다.
 * 상태 메시지를 아직 못 받았으면(sim = null) 판단하지 않는다
 */
export function outOfRun(tMs: number, sim: Pick<SimStatusMsg, 'startedAt' | 't' | 'speed'> | null): boolean {
  if (!sim || !Number.isFinite(tMs)) return false;
  const start = Date.parse(sim.startedAt);
  const now = Date.parse(sim.t);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return false;
  return tMs < start || tMs > now + aheadLimitMs(sim.speed);
}
