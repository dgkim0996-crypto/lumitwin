import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STATIONS, type SimStatusMsg, type StationState } from '@lumitwin/shared';
import { LiveService } from '../src/live/live.service';
import { aheadLimitMs, outOfRun } from '../src/live/run-clock';
import type { MqttBrokerService, MqttInbound } from '../src/mqtt/mqtt-broker.service';

const CODE = 'HL-VM-01';
const LINE = STATIONS[CODE].line;
const OLD_START = '2026-11-12T00:00:00.000Z';
const NEW_START = '2026-11-12T00:30:00.000Z';

const status = (startedAt: string, t: string, speed = 60): SimStatusMsg => ({
  t, startedAt, speed, running: true, scenarios: [], buffers: {}, inbound: {}, warehouse: {}, escaped: {},
});

/** 브로커 없이 LiveService에 MQTT 메시지를 직접 흘려 넣는다 */
function harness() {
  let handler: (m: MqttInbound) => void = () => {};
  const broker = { onMessage: (h: (m: MqttInbound) => void) => (handler = h) } as unknown as MqttBrokerService;
  const live = new LiveService(broker);
  live.onModuleInit();
  const states: { state: StationState; t: string }[] = [];
  live.events.on('state', (station, state, _reason, t) => station === CODE && states.push({ state, t }));
  const send = (parts: string[], payload: unknown) => handler({ topic: `lt/v1/${parts.join('/')}`, parts, payload });
  return {
    live,
    states,
    status: (s: SimStatusMsg) => send(['sim', 'status'], s),
    reset: (t: string) => send(['sim', 'event'], { t, kind: 'reset', message: '시뮬레이션 초기화' }),
    state: (t: string, state: StationState, reason?: string) => send([LINE, CODE, 'state'], { t, state, reason }),
  };
}

describe('실행 시계: 다른 실행의 메시지 거르기', () => {
  it('실행 시작 전이거나 상태 시각보다 한참 뒤면 지금 실행의 메시지가 아니다', () => {
    const sim = status(NEW_START, '2026-11-12T01:00:00.000Z', 60);
    const t = (iso: string) => Date.parse(iso);
    assert.equal(aheadLimitMs(60), 30 * 60_000);
    assert.equal(aheadLimitMs(1), 5 * 60_000, '배속이 낮아도 5분은 봐준다');
    assert.equal(outOfRun(t('2026-11-12T00:59:00Z'), sim), false);
    assert.equal(outOfRun(t('2026-11-12T01:20:00Z'), sim), false, '상태보다 조금 앞선 건 받는다 (상태는 1초마다 온다)');
    assert.equal(outOfRun(t('2026-11-12T00:29:59Z'), sim), true, '실행 시작 전');
    assert.equal(outOfRun(t('2026-11-12T16:00:00Z'), sim), true, '이전 실행의 앞선 가상 시계');
    assert.equal(outOfRun(t('2026-11-12T16:00:00Z'), null), false, '상태를 모르면 판단하지 않는다');
  });

  it('초기화 직후 엣지 경로로 늦게 온 이전 실행의 값은 새 실행에 섞이지 않는다', () => {
    const h = harness();
    // 이전 실행: 60배속으로 16시간째
    h.status(status(OLD_START, '2026-11-12T16:00:00.000Z'));
    h.state('2026-11-12T16:00:00.000Z', 'RUN');
    // 초기화: 새 실행의 가상 시계는 실제 시각(00:30)에서 다시 시작한다
    h.reset(NEW_START);
    h.state('2026-11-12T16:00:01.000Z', 'DOWN', '누설'); // 게이트웨이 큐에 남아 있던 이전 실행의 값
    h.state('2026-11-12T00:30:20.000Z', 'RUN'); // 새 실행의 값 (상태 메시지보다 먼저 왔다)
    h.status(status(NEW_START, '2026-11-12T00:31:00.000Z'));
    h.state('2026-11-12T16:00:02.000Z', 'DOWN', '누설'); // 새 상태 메시지 뒤에 온 이전 실행의 값

    assert.equal(h.live.virtualNow, '2026-11-12T00:31:00.000Z', '가상 시계가 이전 실행 시각으로 튀지 않는다');
    assert.equal(h.live.snapshot().stations[CODE].state, 'RUN');
    assert.deepEqual(h.states.map((s) => s.state), ['RUN', 'RUN'], 'DB로 가는 상태 기록에도 이전 실행의 고장이 없다');
  });

  it('시계가 시뮬레이터 상태보다 한참 앞서 있으면 상태 시각으로 되돌린다', () => {
    const h = harness();
    // 예전에 오염된 기록으로 되살리면 시계가 한참 뒤에 가 있다
    h.live.hydrate({
      startedAt: NEW_START, nowMs: Date.parse('2026-11-13T08:00:00Z'), counts: [], recent: new Map(), finals: [], states: [],
      alarms: [], alarmSeq: 0, limitAlarms: [],
    });
    h.status(status(NEW_START, '2026-11-12T02:00:00.000Z'));
    assert.equal(h.live.virtualNow, '2026-11-12T02:00:00.000Z');
    // 정상 범위면 건드리지 않는다: 상태보다 조금 앞선 설비 메시지 시각은 그대로 둔다
    h.state('2026-11-12T02:00:30.000Z', 'RUN');
    h.status(status(NEW_START, '2026-11-12T02:00:10.000Z'));
    assert.equal(h.live.virtualNow, '2026-11-12T02:00:30.000Z');
  });
});
