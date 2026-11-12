"""OPC UA 경로 테스트: 가상 PLC(OPC UA 서버) → 엣지 게이트웨이 → MQTT.

- 변환(Mapper)·버퍼(Forwarder)는 asyncua 없이 돈다
- 서버·엣지를 실제로 붙이는 테스트는 asyncua가 있을 때만 돈다 (`npm run sim:setup:opcua`)
  같은 시뮬레이션을 MQTT 직행과 OPC UA 경로로 보냈을 때 MES가 받는 상태 변경·생산 실적이 같아야 한다
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import socket
import time
import unittest
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from lumisim.edge import Edge, Forwarder, Mapper
from lumisim.engine import Sim
from lumisim.model import load_factory

HAS_ASYNCUA = importlib.util.find_spec('asyncua') is not None
FACTORY = load_factory()
# 보안 정책 없는 로컬 접속 경고와 재연결 시험 중 내부 연결 오류 로그는 알고 있는 것이라 숨긴다
logging.getLogger('asyncua').setLevel(logging.CRITICAL)


def at(sec: float) -> datetime:
    return datetime(2026, 11, 12, tzinfo=timezone.utc) + timedelta(seconds=sec)


class FakeMqtt:
    """paho 클라이언트 자리: 보낸 것을 모아 둔다"""

    def __init__(self):
        self.out: list[tuple[str, str, int]] = []

    def publish(self, topic, data, qos=0):
        self.out.append((topic, data, qos))


class MapperRules(unittest.TestCase):
    def test_tags_grouped_per_station_with_state(self):
        m = Mapper()
        m.add_station('HL', 'HL-IM-L1')
        m.init_state('HL-IM-L1', 'DOWN', '밴드 히터 단선')
        m.on_value('HL-IM-L1', 'moldTemp', 61.2, at(10), True)
        m.on_value('HL-IM-L1', 'pressure', 82.0, at(11), True)
        [(topic, msg)] = m.flush()
        self.assertEqual(topic, 'lt/v1/HL/HL-IM-L1/tags')
        self.assertEqual(msg, {'t': '2026-11-12T00:00:11.000Z', 'v': {'moldTemp': 61.2, 'pressure': 82.0}, 's': 'DOWN', 'r': '밴드 히터 단선'})
        self.assertEqual(m.flush(), [], '바뀐 것이 없으면 다시 보내지 않는다')

    def test_tags_time_follows_clock_back_after_sim_reset(self):
        m = Mapper()
        m.add_station('HL', 'A')
        m.on_value('A', 'x', 1.0, at(50_000), True)  # 이전 실행: 가상 시계가 14시간째
        m.flush()
        # 초기화: 새 실행의 가상 시계는 처음으로 돌아간다. OPC UA 연결은 그대로라 Mapper도 그대로다
        m.on_value('A', 'x', 2.0, at(10), True)
        m.on_value('A', 'y', 3.0, at(12), True)
        m.on_value('A', 'x', 2.5, at(11), True)  # 같은 묶음 안에서는 가장 늦은 시각
        self.assertEqual(m.flush()[0][1]['t'], '2026-11-12T00:00:12.000Z')

    def test_bad_quality_value_is_not_sent(self):
        m = Mapper()
        m.add_station('HL', 'A')
        m.on_value('A', 'x', 0.0, at(1), False)
        self.assertEqual(m.flush(), [], '초기값 기다리는 중(Bad)인 값만 있으면 보내지 않는다')
        m.on_value('A', 'x', 1.5, at(2), True)
        m.on_value('A', 'y', 0.0, at(2), False)
        self.assertEqual(m.flush()[0][1]['v'], {'x': 1.5})

    def test_state_message_matches_simulator_shape(self):
        m = Mapper()
        self.assertEqual(m.on_state('HL', 'A', 'SETUP', '금형 교체', at(5)), ('lt/v1/HL/A/state', {'t': '2026-11-12T00:00:05.000Z', 'state': 'SETUP', 'reason': '금형 교체'}))
        self.assertEqual(m.on_state('HL', 'A', 'RUN', '', at(6))[1], {'t': '2026-11-12T00:00:06.000Z', 'state': 'RUN'})
        # 태그에는 사유를 고장·정지일 때만 싣는다 (시뮬레이터 규칙과 같다)
        m.on_state('HL', 'A', 'SETUP', '금형 교체', at(7))
        m.on_value('A', 'x', 1.0, at(8), True)
        self.assertNotIn('r', m.flush()[0][1])

    def test_naive_timestamp_is_utc(self):
        m = Mapper()
        _, msg = m.on_state('HL', 'A', 'RUN', '', datetime(2026, 11, 12, 1, 2, 3, 456000))
        self.assertEqual(msg['t'], '2026-11-12T01:02:03.456Z')

    def test_unit_gaps_counted_and_restart_tolerated(self):
        m = Mapper()
        for seq in (1, 2, 5):
            m.on_unit('HL', 'A', seq, '{"serial":"S"}')
        self.assertEqual(m.gaps, 2, '3·4번이 빠졌다')
        m.on_unit('HL', 'A', 1, '{"serial":"S"}')  # PLC가 다시 시작해 순번이 처음부터
        m.on_unit('HL', 'A', 2, '{"serial":"S"}')
        self.assertEqual(m.gaps, 2)


class StoreAndForward(unittest.TestCase):
    def test_records_buffered_while_disconnected_and_flushed_in_order(self):
        fake = FakeMqtt()
        f = Forwarder(client=fake)
        f.send('a/tags', {'v': 1}, 0, 'tags')
        f.send('a/state', {'n': 1}, 1, 'state')
        f.send('a/unit', {'n': 2}, 1, 'unit')
        self.assertEqual(fake.out, [])
        self.assertEqual((len(f.buffer), f.skipped), (2, 1), '끊긴 동안 tags는 버리고 기록은 쌓는다')
        f.set_connected(True)
        f.send('a/unit', {'n': 3}, 1, 'unit')
        self.assertEqual([d for _, d, _ in fake.out], ['{"n":1}', '{"n":2}', '{"n":3}'])
        self.assertEqual(f.sent, {'state': 1, 'unit': 2})

    def test_buffer_overflow_drops_oldest(self):
        f = Forwarder(client=FakeMqtt(), max_buffer=3)
        for i in range(5):
            f.send('a/unit', {'n': i}, 1, 'unit')
        self.assertEqual((len(f.buffer), f.dropped), (3, 2))
        self.assertEqual(f.buffer[0][1], '{"n":2}')


def free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Recorder:
    """시뮬레이터 io 자리: MQTT로 바로 보냈다면 나갔을 설비 메시지를 기록하면서 PlcIO로 넘긴다"""

    def __init__(self, inner):
        self.inner = inner
        self.cmds = inner.cmds
        self.link = inner.link
        self.direct: list[tuple[str, dict]] = []

    def publish(self, topic, obj, qos=0):
        self.direct.append((topic, obj))
        self.inner.publish(topic, obj, qos)


class NullMqttIO:
    link = 'mqtt'

    def __init__(self):
        import queue

        self.cmds = queue.Queue()
        self.sent: list[str] = []

    def publish(self, topic, obj, qos=0):
        self.sent.append(topic)

    def close(self):
        pass


def by_station(msgs, kind):
    out = defaultdict(list)
    for topic, obj in msgs:
        parts = topic.split('/')
        if len(parts) == 5 and parts[4] == kind:
            out[parts[3]].append(obj)
    return dict(out)


@unittest.skipUnless(HAS_ASYNCUA, 'asyncua 없음 (npm run sim:setup:opcua)')
class OpcuaPath(unittest.TestCase):
    def start_plc(self, port):
        from lumisim.opcua_plc import PlcServer

        plc = PlcServer(FACTORY, f'opc.tcp://127.0.0.1:{port}/lumitwin/')
        plc.start()
        return plc

    def run_edge(self, endpoint, fake, until, timeout=40.0, between=None):
        """엣지를 이 테스트의 이벤트 루프에서 돌리다가 until(edge)가 참이 되면 멈춘다"""

        async def go():
            fwd = Forwarder(client=fake)
            fwd.set_connected(True)
            edge = Edge(endpoint, fwd, verbose=False)
            stop = asyncio.Event()
            task = asyncio.create_task(edge.run(stop))
            t0 = time.monotonic()
            try:
                while time.monotonic() - t0 < timeout:
                    await asyncio.sleep(0.1)
                    if between is not None:
                        await between(edge)
                    if until(edge):
                        break
            finally:
                stop.set()
                await asyncio.wait_for(task, 10)
            return edge

        return asyncio.run(go())

    def test_plcio_routes_station_topics_to_plc(self):
        from lumisim.opcua_plc import PlcIO

        class FakePlc:
            def __init__(self):
                self.posted = []

            def post(self, kind, station, msg):
                self.posted.append((kind, station))

        plc, mq = FakePlc(), NullMqttIO()
        io = PlcIO(mq, plc)
        io.publish('lt/v1/HL/HL-IM-L1/tags', {})
        io.publish('lt/v1/HL/HL-IM-L1/unit', {})
        io.publish('lt/v1/amr/AMR-01', {})
        io.publish('lt/v1/sim/status', {})
        self.assertEqual(plc.posted, [('tags', 'HL-IM-L1'), ('unit', 'HL-IM-L1')])
        self.assertEqual(mq.sent, ['lt/v1/amr/AMR-01', 'lt/v1/sim/status'])
        self.assertEqual(io.link, 'opcua')

    def test_same_records_as_direct_mqtt(self):
        """엣지가 붙은 뒤 가상 20분을 돌려, MQTT 직행이었다면 나갔을 기록과 엣지가 MQTT로 낸 기록을 비교한다"""
        from lumisim.opcua_plc import PlcIO

        port = free_port()
        plc = self.start_plc(port)
        rec = Recorder(PlcIO(NullMqttIO(), plc))
        want: dict = {}

        def run_sim():
            sim = Sim(FACTORY, io=rec, realtime=False, seed=5, tick=5.0)
            sim.station_op('HL-IM-L1', 'fail', '밴드 히터 단선')

            def later():
                yield sim.env.timeout(300)
                sim.station_op('HL-IM-L1', 'repair', None)
                sim.station_op('OSM-IM-C1', 'setup', '금형 교체')
                yield sim.env.timeout(120)
                sim.station_op('OSM-IM-C1', 'start', None)

            sim.env.process(later())
            sim.env.run(until=1200)
            want['units'] = by_station(rec.direct, 'unit')
            want['states'] = by_station(rec.direct, 'state')
            want['tags'] = {k: v[-1] for k, v in by_station(rec.direct, 'tags').items()}

        async def between(edge):
            if not want and edge.opcua == 'connected':
                await asyncio.to_thread(run_sim)  # 구독이 선 뒤에 난 이벤트만 받을 수 있다

        quiet = {'n': -1, 'since': 0.0}

        def done(edge):
            if not want:
                return False
            if edge.received['unit'] < sum(map(len, want['units'].values())) or edge.received['state'] < sum(map(len, want['states'].values())):
                return False
            # 태그 알림이 0.6초 동안 더 오지 않으면 다 받은 것으로 본다
            if edge.received['value'] != quiet['n']:
                quiet['n'], quiet['since'] = edge.received['value'], time.monotonic()
            return time.monotonic() - quiet['since'] > 0.6

        fake = FakeMqtt()
        try:
            edge = self.run_edge(f'opc.tcp://127.0.0.1:{port}/lumitwin/', fake, done, between=between)
        finally:
            plc.stop()

        want_units, want_states, want_tags = want['units'], want['states'], want['tags']
        self.assertGreater(sum(map(len, want_units.values())), 100)
        self.assertIn('HL-IM-L1', want_states)
        got = [(t, json.loads(d)) for t, d, _ in fake.out]
        self.assertEqual(by_station(got, 'unit'), want_units, '생산 실적이 하나도 빠지거나 바뀌지 않는다')
        self.assertEqual(by_station(got, 'state'), want_states, '상태 변경이 순서·사유까지 같다')
        self.assertEqual(edge.mapper.gaps, 0)
        got_tags = {k: v[-1] for k, v in by_station(got, 'tags').items()}
        self.assertEqual(set(got_tags), set(want_tags), '모든 설비의 태그가 온다')
        for code, msg in want_tags.items():
            self.assertEqual(got_tags[code]['v'], msg['v'], f'{code} 마지막 태그 값')
            # 값이 바뀔 때만 보내므로(RBE) 시각은 마지막으로 값이 바뀐 때다: 시뮬레이터의 마지막 틱보다 늦을 수 없다
            self.assertLessEqual(got_tags[code]['t'], msg['t'], f'{code} 마지막 태그 시각(가상)')
        self.assertTrue(all(q == 1 for t, _, q in fake.out if t.endswith(('/unit', '/state'))), '기록은 QoS 1')
        self.assertEqual(edge.stations, len(sum((ln['stations'] for ln in FACTORY['lines']), [])))

    def test_plc_holds_records_until_edge_subscribes(self):
        """이벤트는 구독 중인 클라이언트에게만 간다. 엣지가 없을 때 난 기록은 PLC가 쌓아 두었다가 엣지가 붙으면 낸다"""
        port = free_port()
        endpoint = f'opc.tcp://127.0.0.1:{port}/lumitwin/'
        plc = self.start_plc(port)
        try:
            plc.post('state', 'HL-IM-L1', {'t': '2026-11-12T00:00:01.000Z', 'state': 'DOWN', 'reason': '노즐 막힘'})
            plc.post('unit', 'HL-IM-L1', {'t': '2026-11-12T00:00:02.000Z', 'serial': 'S1', 'result': 'OK'})
            time.sleep(0.3)
            self.assertFalse(plc.subscribed())
            self.assertEqual(plc.inbox.qsize(), 2, '엣지가 없으니 내보내지 않고 쌓아 둔다')
            first = FakeMqtt()
            self.run_edge(endpoint, first, lambda e: e.received['unit'] >= 1, timeout=20)
            # 엣지가 내려간 사이에 난 실적도 다음 연결에서 받는다
            deadline = time.monotonic() + 5
            while plc.subscribed() and time.monotonic() < deadline:
                time.sleep(0.1)
            plc.post('unit', 'HL-IM-L1', {'t': '2026-11-12T00:00:03.000Z', 'serial': 'S2', 'result': 'NG', 'defect': 'WELD'})
            second = FakeMqtt()
            edge = self.run_edge(endpoint, second, lambda e: e.received['unit'] >= 1, timeout=20)
        finally:
            plc.stop()
        units = lambda out: [json.loads(d)['serial'] for t, d, _ in out if t.endswith('/unit')]
        self.assertEqual([t for t, _, _ in first.out if t.endswith(('/state', '/unit'))], ['lt/v1/HL/HL-IM-L1/state', 'lt/v1/HL/HL-IM-L1/unit'])
        self.assertEqual((units(first.out), units(second.out)), (['S1'], ['S2']))
        self.assertEqual(edge.mapper.gaps, 0)

    def test_reconnects_after_plc_restart(self):
        port = free_port()
        endpoint = f'opc.tcp://127.0.0.1:{port}/lumitwin/'
        plcs = [self.start_plc(port)]
        step = {'restarted': False, 'posted': False}

        async def between(edge):
            if not step['restarted'] and edge.opcua == 'connected':
                step['restarted'] = True
                await asyncio.to_thread(plcs[0].stop)
                plcs.append(await asyncio.to_thread(self.start_plc, port))
            elif step['restarted'] and not step['posted'] and edge.reconnects >= 1 and edge.opcua == 'connected':
                step['posted'] = True  # 다시 붙어 구독이 선 뒤에 낸 이벤트는 받아야 한다
                plcs[-1].post('state', 'HL-IM-L1', {'t': '2026-11-12T00:00:01.000Z', 'state': 'DOWN', 'reason': '노즐 막힘'})

        fake = FakeMqtt()
        try:
            edge = self.run_edge(endpoint, fake, lambda e: e.reconnects >= 1 and e.received['state'] >= 1, timeout=40, between=between)
        finally:
            for p in plcs:
                p.stop()
        self.assertEqual(edge.reconnects, 1, 'PLC가 다시 뜨면 다시 붙는다')
        self.assertIn(('lt/v1/HL/HL-IM-L1/state', '{"t":"2026-11-12T00:00:01.000Z","state":"DOWN","reason":"노즐 막힘"}', 1), fake.out)


if __name__ == '__main__':
    unittest.main()
