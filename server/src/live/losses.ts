import { LOSS_KEYS, type LossKey, type LossTimes } from '@lumitwin/shared';
import type { StateTimes } from './oee';

const t = (times: StateTimes, k: keyof StateTimes) => times[k] ?? 0;
const zero = (): Record<LossKey, number> => ({ breakdown: 0, setup: 0, minorStop: 0, speed: 0, defect: 0, startup: 0 });

/**
 * 설비 하나의 6대 로스. stationOee()와 같은 정의라 valuable ÷ planned = OEE가 된다.
 * - 가동률 로스: 고장(DOWN) · 셋업(SETUP)
 * - 성능 로스 = 가동 가능 시간 − 순가동 시간(이상 사이클 × 처리 수). 투입·배출 대기 시간을 먼저 순간 정지로 잡고 나머지를 속도 저하로 본다
 *   (사이클 편차로 이상보다 빨리 만든 만큼은 대기 시간과 상쇄된다)
 * - 양품률 로스: 불량품에 쓴 순가동 시간. 재가동 직후 불량은 초기 수율, 나머지는 공정 불량
 * - 유틸리티 설비(사이클 없음)는 가동률 로스만 있다
 */
export function stationLosses(times: StateTimes, c: { ok: number; ng: number; startupNg: number; idealSec: number; utility: boolean }): LossTimes {
  const stopped = t(times, 'STOP');
  const idle = t(times, 'IDLE') + t(times, 'BLOCKED');
  const operating = t(times, 'RUN') + idle;
  const planned = operating + t(times, 'DOWN') + t(times, 'SETUP');
  const loss = zero();
  loss.breakdown = t(times, 'DOWN');
  loss.setup = t(times, 'SETUP');
  if (c.utility) return { planned, stopped, valuable: operating, loss };

  const count = c.ok + c.ng;
  const net = Math.min(operating, c.idealSec * count);
  const perf = operating - net;
  loss.minorStop = Math.min(idle, perf);
  loss.speed = perf - loss.minorStop;
  const unit = count > 0 ? net / count : 0;
  const startupNg = Math.min(c.startupNg, c.ng);
  loss.startup = unit * startupNg;
  loss.defect = unit * (c.ng - startupNg);
  return { planned, stopped, valuable: unit * c.ok, loss };
}

/** 여러 설비를 더한다 (설비 시간 합) */
export function sumLosses(list: LossTimes[]): LossTimes {
  const out: LossTimes = { planned: 0, stopped: 0, valuable: 0, loss: zero() };
  for (const x of list) {
    out.planned += x.planned;
    out.stopped += x.stopped;
    out.valuable += x.valuable;
    for (const k of LOSS_KEYS) out.loss[k] += x.loss[k];
  }
  return out;
}

/** 화면·API로 보낼 때 0.1초 단위로 */
export function roundLosses<T extends LossTimes>(x: T): T {
  const r = (v: number) => Math.round(v * 10) / 10;
  const loss = Object.fromEntries(LOSS_KEYS.map((k) => [k, r(x.loss[k])])) as Record<LossKey, number>;
  return { ...x, planned: r(x.planned), stopped: r(x.stopped), valuable: r(x.valuable), loss };
}
