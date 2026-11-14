"""OPC UA 경로 테스트: 가상 PLC(OPC UA 서버) → 엣지 게이트웨이 → MQTT.

- 변환(Mapper)·버퍼(Forwarder)·핸드셰이크 판단(Handshake)은 asyncua 없이 돈다
- 서버·엣지를 실제로 붙이는 테스트는 asyncua가 있을 때만 돈다 (`npm run sim:setup:opcua`)
  같은 시뮬레이션을 MQTT 직행과 OPC UA 경로로 보냈을 때 MES가 받는 상태 변경·생산 실적이 같아야 한다
  MES 요청(인터록·작업지시)은 PLC 태그 핸드셰이크 → 엣지 → MQTT로 가고, 응답은 거꾸로 PLC 태그를 거쳐 명령 큐로 온다
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import queue
import socket
import time
import unittest
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from lumisim.edge import Edge, Forwarder, Handshake, HsBlock, Mapper
from lumisim.engine import ILK_WAIT_REASON, Sim
from lumisim.model import load_factory
from lumisim.mqtt_io import REPLY_ACTION, MqttIO, t_ilk_req, t_ilk_res, t_wo_req, t_wo_res

HAS_ASYNCUA = importlib.util.find_spec('asyncua') is not None
FACTORY = load_factory()
# 보안 정책 없는 로컬 접속 경고와 재연결 시험 중 내부 연결 오류 로그는 알고 있는 것이라 숨긴다
logging.getLogger('asyncua').setLevel(logging.CRITICAL)


def at(sec: float) -> datetime:
    return datetime(2026, 11, 12, tzinfo=timezone.utc) + timedelta(seconds=sec)


class FakeMqtt:
    """paho 클라이언트 자리: 보낸 것을 모아 둔다. fwd = 이 클라이언트를 쓰는 Forwarder (MES 응답을 넣을 때 쓴다)"""

    def __init__(self):
        self.out: list[tuple[str, str, int]] = []
        self.fwd: Forwarder | None = None

    def publish(self, topic, data, qos=0):
        self.out.append((topic, data, qos))

    def sent(self, kind: str) -> list[dict]:
        """토픽 끝이 kind인 보낸 메시지 (예: ilk/req · wo/req)"""
        return [json.loads(d) for t, d, _ in self.out if t.endswith('/' + kind)]


def gate_line() -> tuple[str, str]:
    """투입 공정이 있는 첫 라인과 그 라인의 첫 게이트 설비 (공장 데이터가 바뀌어도 정의에서 찾는다)"""
    ln = next(ln for ln in FACTORY['lines'] if ln.get('release'))
    return ln['code'], next(s['code'] for s in ln['stations'] if s.get('gate'))


class FakeMes(FakeMqtt):
    """MQTT 너머의 MES 흉내: 엣지가 보낸 요청에 곧바로 MQTT 응답을 돌려준다.
    작업지시는 라인마다 첫 기종으로 qty개. 인터록은 wait_first 설비의 첫 요청만 WAIT(ROUTE), 나머지는 OK"""

    def __init__(self, wait_first: str | None = None, qty: int = 50):
        super().__init__()
        self.wait_first, self.qty = wait_first, qty
        self.waited = False
        self.n_wo = 0

    def publish(self, topic, data, qos=0):
        super().publish(topic, data, qos)
        parts = topic.split('/')
        if topic.endswith('/wo/req'):
            m = json.loads(data)
            line = parts[2]
            ln = next(x for x in FACTORY['lines'] if x['code'] == line)
            self.n_wo += 1
            wo = {'id': self.n_wo, 'code': f'WO-T{self.n_wo:03d}', 'variant': ln['variants'][0]['code'], 'qty': self.qty}
            self.fwd.receive(t_wo_res(line), json.dumps({'t': m['t'], 'reqId': m['reqId'], 'wo': wo}).encode())
        elif topic.endswith('/ilk/req'):
            m = json.loads(data)
            res = {'t': m['t'], 'reqId': m['reqId'], 'serial': m['serial'], 'verdict': 'OK'}
            if m['station'] == self.wait_first and not self.waited:
                self.waited = True
                res.update(verdict='WAIT', code='ROUTE', reason='앞 공정 실적 대기')
            self.fwd.receive(t_ilk_res(parts[2], parts[3]), json.dumps(res, ensure_ascii=False).encode())


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

    def test_idle_reason_passes_like_simulator(self):
        """인터록 대기(IDLE 'MES 확인 대기') 사유도 MQTT 직행과 같이 싣는다"""
        m = Mapper()
        _, msg = m.on_state('HL', 'A', 'IDLE', ILK_WAIT_REASON, at(3))
        self.assertEqual(msg, {'t': '2026-11-12T00:00:03.000Z', 'state': 'IDLE', 'reason': ILK_WAIT_REASON})
        self.assertEqual(m.on_state('HL', 'A', 'IDLE', '', at(4))[1], {'t': '2026-11-12T00:00:04.000Z', 'state': 'IDLE'})

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

    def test_requests_dropped_not_buffered_while_disconnected(self):
        """MES 요청은 끊긴 동안 쌓지 않는다: 다시 붙은 뒤 보내면 이미 지나간 개체를 MES가 판정한다"""
        fake = FakeMqtt()
        f = Forwarder(client=fake)
        f.send('a/unit', {'n': 1}, 1, 'unit')
        self.assertFalse(f.send_request('lt/v1/HL/HL-AS-01/ilk/req', {'reqId': 'r1'}, 'ilk'))
        self.assertEqual((len(f.buffer), f.req_dropped), (1, 1), '기록은 쌓고 요청은 버린다')
        f.set_connected(True)
        self.assertEqual([t for t, _, _ in fake.out], ['a/unit'])
        self.assertTrue(f.send_request('lt/v1/HL/wo/req', {'reqId': 'w1'}, 'wo'))
        self.assertEqual(fake.out[-1], ('lt/v1/HL/wo/req', '{"reqId":"w1"}', 1), '요청은 QoS 1')
        self.assertEqual(f.sent['wo'], 1)

    def test_receive_passes_mes_reply(self):
        f = Forwarder(client=FakeMqtt())
        got = []
        f.on_reply = lambda topic, msg: got.append((topic, msg))
        f.receive('lt/v1/HL/wo/res', b'{"reqId":"w1","wo":null}')
        f.receive('lt/v1/HL/wo/res', b'{not json')
        f.receive('lt/v1/HL/wo/res', b'[1,2]')
        self.assertEqual(got, [('lt/v1/HL/wo/res', {'reqId': 'w1', 'wo': None})], '형식이 틀린 응답은 넘기지 않는다')


class HandshakeRules(unittest.TestCase):
    """요청 번호·응답 번호 핸드셰이크 판단 (네트워크 없이)"""

    def block(self, kind='ilk'):
        return HsBlock(kind, 'HL', 'HL-AS-01' if kind == 'ilk' else None)

    def test_request_forwarded_and_answer_written_with_its_seq(self):
        hs, blk = Handshake(), self.block()
        hs.add(blk, 0)
        hs.mark(blk, 0)
        self.assertEqual(hs.take_pending(), [], '처리한 번호와 같으면 읽지 않는다')
        hs.mark(blk, 1)
        [b] = hs.take_pending()
        topic, msg = hs.accept(b, 1, '{"reqId":"r1","serial":"S1"}')
        self.assertEqual((topic, msg), ('lt/v1/HL/HL-AS-01/ilk/req', {'reqId': 'r1', 'serial': 'S1'}))
        self.assertIsNone(hs.accept(b, 1, '{"reqId":"r1"}'), '같은 번호는 한 번만 보낸다')
        res = {'reqId': 'r1', 'serial': 'S1', 'verdict': 'OK'}
        self.assertEqual(hs.answer('lt/v1/HL/HL-AS-01/ilk/res', res), (blk, 1, '{"reqId":"r1","serial":"S1","verdict":"OK"}'))
        self.assertIsNone(hs.answer('lt/v1/HL/HL-AS-01/ilk/res', res), '중복 응답은 쓰지 않는다')
        self.assertEqual((hs.forwarded, hs.answered, hs.late), (1, 1, 1))

    def test_late_answer_after_next_request_is_dropped(self):
        hs, blk = Handshake(), self.block('wo')
        hs.add(blk, 7)
        hs.accept(blk, 8, '{"reqId":"w8","line":"HL"}')
        hs.accept(blk, 9, '{"reqId":"w9","line":"HL"}')
        self.assertIsNone(hs.answer('lt/v1/HL/wo/res', {'reqId': 'w8', 'wo': None}), 'PLC가 다음 요청으로 넘어간 뒤 온 응답')
        self.assertEqual(hs.answer('lt/v1/HL/wo/res', {'reqId': 'w9', 'wo': None})[1], 9)
        self.assertEqual(hs.late, 1)

    def test_request_pending_at_connect_is_not_sent(self):
        """새로 붙을 때 이미 걸려 있던 요청은 언제 낸 것인지 몰라 보내지 않는다"""
        hs, blk = Handshake(), self.block()
        hs.add(blk, 5)
        self.assertIsNone(hs.accept(blk, 5, '{"reqId":"old"}'))
        self.assertEqual(hs.open, {})

    def test_wrong_topic_or_bad_data(self):
        hs, blk = Handshake(), self.block()
        hs.add(blk, 0)
        self.assertIsNone(hs.accept(blk, 1, 'not json'))
        self.assertEqual(hs.bad, 1)
        hs.accept(blk, 2, '{"reqId":"r2"}')
        self.assertIsNone(hs.answer('lt/v1/HL/HL-SL-01/ilk/res', {'reqId': 'r2'}), '다른 설비 토픽으로 온 응답')
        hs.drop(blk)  # MQTT가 끊겨 못 보낸 요청은 닫는다
        self.assertIsNone(hs.answer('lt/v1/HL/HL-AS-01/ilk/res', {'reqId': 'r2'}))


class MqttReplies(unittest.TestCase):
    def test_direct_replies_ignored_on_opcua_path(self):
        """OPC UA 경로(stop_replies 뒤)에서는 MQTT로 온 MES 응답을 명령 큐에 넣지 않는다 (PLC 태그로만 받는다)"""

        class Msg:
            def __init__(self, topic, payload):
                self.topic, self.payload = topic, payload

        class Dummy:
            cmds = queue.Queue()
            replies = False

        MqttIO._on_message(Dummy, None, None, Msg('lt/v1/HL/wo/res', b'{"reqId":"x","wo":null}'))
        MqttIO._on_message(Dummy, None, None, Msg('lt/v1/cmd', b'{"action":"pause"}'))
        self.assertEqual(Dummy.cmds.get_nowait(), {'action': 'pause'})
        self.assertTrue(Dummy.cmds.empty())


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


async def until(cond, timeout: float = 10.0, what: str = '조건') -> None:
    t0 = time.monotonic()
    while not cond():
        if time.monotonic() - t0 > timeout:
            raise AssertionError(f'{timeout:g}초 안에 {what}이(가) 맞지 않음')
        await asyncio.sleep(0.02)


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

    def with_edge(self, endpoint, fake, scenario, timeout=60.0):
        """엣지를 이 테스트의 이벤트 루프에서 붙여 두고(구독까지 선 뒤) scenario(edge, fwd)를 돌린다"""

        async def go():
            fwd = Forwarder(client=fake)
            fwd.set_connected(True)
            fake.fwd = fwd
            edge = Edge(endpoint, fwd, verbose=False)
            stop = asyncio.Event()
            task = asyncio.create_task(edge.run(stop))
            try:
                await until(lambda: edge.opcua == 'connected', 20, 'OPC UA 연결')
                await asyncio.wait_for(scenario(edge, fwd), timeout)
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

        class Mq(NullMqttIO):
            def __init__(self):
                super().__init__()
                self.replies = True

            def stop_replies(self):
                self.replies = False

        plc, mq = FakePlc(), Mq()
        io = PlcIO(mq, plc)
        io.publish('lt/v1/HL/HL-IM-L1/tags', {})
        io.publish('lt/v1/HL/HL-IM-L1/unit', {})
        io.publish('lt/v1/amr/AMR-01', {})
        io.publish('lt/v1/sim/status', {})
        io.publish('lt/v1/HL/HL-AS-01/ilk/req', {})
        io.publish('lt/v1/HL/wo/req', {})
        io.publish('lt/v1/HL/HL-AS-01/change', {})
        io.publish('lt/v1/HL/repair', {})
        self.assertEqual(plc.posted, [('tags', 'HL-IM-L1'), ('unit', 'HL-IM-L1'), ('ilk', 'HL-AS-01'), ('wo', 'HL')],
                         '설비 신호와 MES 요청은 PLC로')
        self.assertEqual(mq.sent, ['lt/v1/amr/AMR-01', 'lt/v1/sim/status', 'lt/v1/HL/HL-AS-01/change', 'lt/v1/HL/repair'])
        self.assertEqual(io.link, 'opcua')
        self.assertIs(plc.sink, io.cmds, 'PLC가 받은 MES 응답은 시뮬레이터 명령 큐로')
        self.assertFalse(mq.replies, 'MQTT로 온 MES 응답은 받지 않는다')

    def test_handshake_round_trip_and_late_reply(self):
        """인터록·작업지시 요청: PLC 태그 → 엣지 → MQTT(가짜). 응답: MQTT → 엣지 → PLC 태그 → 시뮬레이터 명령 큐.
        다음 요청으로 넘어간 뒤 온 늦은 응답은 버리고, MQTT가 끊긴 동안의 요청은 쌓지 않고 버린다"""
        from lumisim.opcua_plc import PlcIO

        line, gate = gate_line()
        port = free_port()
        plc = self.start_plc(port)
        io = PlcIO(NullMqttIO(), plc)
        ilk = {'t': '2026-11-12T00:00:01.000Z', 'reqId': 'T-I1', 'line': line, 'station': gate, 'step': 'X',
               'serial': 'S0001', 'comps': ['C0001'], 'lots': {'PC_RESIN': 'A1'}, 'variant': 'V-L', 'wo': 3}
        wo = {'t': '2026-11-12T00:00:01.000Z', 'reqId': 'T-W1', 'line': line, 'finished': {'id': 2, 'released': 50}}
        ilk_res = {'t': '2026-11-12T00:00:01.100Z', 'reqId': 'T-I1', 'serial': 'S0001', 'verdict': 'OK'}
        wo_res = {'t': '2026-11-12T00:00:01.100Z', 'reqId': 'T-W1', 'wo': {'id': 3, 'code': 'WO-한글-003', 'variant': 'V-L', 'qty': 50}}
        got: list[dict] = []

        def cmds():
            while not io.cmds.empty():
                got.append(io.cmds.get_nowait())
            return got

        fake = FakeMqtt()

        async def scenario(edge, fwd):
            io.publish(t_ilk_req(line, gate), ilk, qos=1)
            io.publish(t_wo_req(line), wo, qos=1)
            await until(lambda: len(fake.sent('ilk/req')) == 1 and len(fake.sent('wo/req')) == 1, 10, '요청 전달')
            fwd.receive(t_wo_res(line), json.dumps(wo_res, ensure_ascii=False).encode())
            fwd.receive(t_ilk_res(line, gate), json.dumps(ilk_res).encode())
            await until(lambda: len(cmds()) >= 2, 10, '응답 도착')
            # 늦은 응답: I2를 보낸 뒤 I3로 넘어갔는데 I2 응답이 온다
            io.publish(t_ilk_req(line, gate), {**ilk, 'reqId': 'T-I2'}, qos=1)
            await until(lambda: len(fake.sent('ilk/req')) == 2, 10, '두 번째 요청 전달')
            io.publish(t_ilk_req(line, gate), {**ilk, 'reqId': 'T-I3'}, qos=1)
            await until(lambda: len(fake.sent('ilk/req')) == 3, 10, '세 번째 요청 전달')
            fwd.receive(t_ilk_res(line, gate), json.dumps({**ilk_res, 'reqId': 'T-I2'}).encode())
            fwd.receive(t_ilk_res(line, gate), json.dumps({**ilk_res, 'reqId': 'T-I3', 'verdict': 'NG', 'code': 'HOLD'}).encode())
            await until(lambda: len(cmds()) >= 3, 10, '세 번째 응답 도착')
            await asyncio.sleep(0.3)  # 늦은 응답이 뒤따라 오지 않는지 본다
            cmds()
            # MQTT가 끊긴 동안 낸 요청은 버린다
            fwd.set_connected(False)
            io.publish(t_ilk_req(line, gate), {**ilk, 'reqId': 'T-I4'}, qos=1)
            await until(lambda: fwd.req_dropped == 1, 10, '끊긴 동안 요청 버림')
            fwd.set_connected(True)
            await asyncio.sleep(0.3)

        try:
            edge = self.with_edge(f'opc.tcp://127.0.0.1:{port}/lumitwin/', fake, scenario)
        finally:
            plc.stop()

        self.assertEqual(fake.sent('ilk/req'), [ilk, {**ilk, 'reqId': 'T-I2'}, {**ilk, 'reqId': 'T-I3'}],
                         'MQTT 직행과 같은 JSON. 끊긴 동안의 T-I4는 다시 붙어도 보내지 않는다')
        self.assertEqual(fake.sent('wo/req'), [wo])
        self.assertTrue(all(q == 1 for t, _, q in fake.out if t.endswith('/req')), '요청은 QoS 1')
        reply = lambda topic, msg: {'action': REPLY_ACTION, 'topic': topic, 'msg': msg}
        self.assertCountEqual(got[:2], [reply(t_wo_res(line), wo_res), reply(t_ilk_res(line, gate), ilk_res)],
                              '응답은 MQTT 경로와 같은 모양으로 명령 큐에 온다')
        self.assertEqual(got[2:], [reply(t_ilk_res(line, gate), {**ilk_res, 'reqId': 'T-I3', 'verdict': 'NG', 'code': 'HOLD'})],
                         '늦은 T-I2 응답은 PLC에 쓰지 않는다')
        self.assertEqual((edge.hs.late, edge.fwd.req_dropped), (1, 1))
        self.assertEqual((plc.requests, plc.answers, plc.stale), (5, 3, 0))
        hs = edge.status()['handshake']
        gates = sum(1 for ln in FACTORY['lines'] for s in ln['stations'] if s.get('gate'))
        self.assertEqual((hs['ilk'], hs['wo']), (gates, sum(1 for ln in FACTORY['lines'] if ln.get('release'))))

    def test_stale_request_held_without_edge_is_dropped(self):
        """엣지가 없는 동안 쌓인 요청은 늦게 꺼내면 PLC 태그에 쓰지 않는다 (설비는 이미 시간 초과로 넘어갔다).
        엣지가 붙은 뒤 낸 요청은 보낸다"""
        from lumisim.opcua_plc import PlcIO

        line, gate = gate_line()
        port = free_port()
        plc = self.start_plc(port)
        plc.req_stale_sec = 0.2
        io = PlcIO(NullMqttIO(), plc)
        old = {'t': '2026-11-12T00:00:01.000Z', 'reqId': 'OLD', 'line': line, 'station': gate, 'step': 'X', 'serial': 'S1', 'comps': [], 'lots': {}}
        io.publish(t_ilk_req(line, gate), old, qos=1)
        time.sleep(0.5)
        self.assertEqual(plc.inbox.qsize(), 1, '엣지가 없어 쌓아 둔다')
        fake = FakeMqtt()

        async def scenario(edge, fwd):
            await until(lambda: plc.stale == 1, 10, '오래된 요청 버림')
            io.publish(t_ilk_req(line, gate), {**old, 'reqId': 'NEW'}, qos=1)
            await until(lambda: len(fake.sent('ilk/req')) == 1, 10, '새 요청 전달')

        try:
            self.with_edge(f'opc.tcp://127.0.0.1:{port}/lumitwin/', fake, scenario)
        finally:
            plc.stop()
        self.assertEqual([m['reqId'] for m in fake.sent('ilk/req')], ['NEW'])
        self.assertEqual((plc.requests, plc.stale), (1, 1))

    def test_engine_gets_mes_replies_through_plc(self):
        """시뮬레이터를 OPC UA 경로로 돌리고 가짜 MES가 MQTT로 답한다.
        작업지시를 받아 투입하고, 인터록 응답이 시간 안에 와서 확인 없이 통과(ilkSkip)한 개체가 없다.
        첫 인터록은 WAIT라 'MES 확인 대기' IDLE이 생기고, 엣지가 낸 상태 변경·실적은 MQTT 직행과 같다"""
        from lumisim.__main__ import handle
        from lumisim.opcua_plc import PlcIO

        line, gate = gate_line()
        ln = next(x for x in FACTORY['lines'] if x['code'] == line)
        release = next(s['code'] for s in ln['stations'] if s['step'] == ln['release'])
        port = free_port()
        plc = self.start_plc(port)
        rec = Recorder(PlcIO(NullMqttIO(), plc))
        fake = FakeMes(wait_first=release)
        box: dict = {'replies': 0}

        def run_sim():
            # 가상 시계를 실제보다 빠르게(가상 2초씩 약 15ms마다) 돌린다. 배속 60이면 인터록 시간 초과가 가상 180초라
            # 실제로는 1초 넘게 남아, 핸드셰이크 왕복(수백 ms)이 넉넉히 들어온다
            sim = Sim(FACTORY, io=rec, realtime=False, seed=7, tick=5.0, speed=60)
            while sim.env.now < 600:
                sim.env.run(until=sim.env.now + 2.0)
                time.sleep(0.015)
                while not rec.cmds.empty():
                    cmd = rec.cmds.get_nowait()
                    box['replies'] += cmd.get('action') == REPLY_ACTION
                    sim = handle(sim, cmd, FACTORY, rec)
            box['sim'] = sim

        def late_replies():
            """시뮬레이션이 끝난 뒤 도착한 응답 (끝나기 직전에 낸 요청의 응답)"""
            while not rec.cmds.empty():
                box['replies'] += rec.cmds.get_nowait().get('action') == REPLY_ACTION
            return box['replies']

        async def scenario(edge, fwd):
            await asyncio.to_thread(run_sim)
            n_req = sum(1 for t, _ in rec.direct if t.endswith(('/ilk/req', '/wo/req')))
            await until(lambda: late_replies() >= n_req, 5, '마지막 응답')
            n_unit = sum(map(len, by_station(rec.direct, 'unit').values()))
            n_state = sum(map(len, by_station(rec.direct, 'state').values()))
            await until(lambda: edge.received['unit'] >= n_unit and edge.received['state'] >= n_state, 20, '기록 전달')

        try:
            edge = self.with_edge(f'opc.tcp://127.0.0.1:{port}/lumitwin/', fake, scenario, timeout=90)
        finally:
            plc.stop()

        sim = box['sim']
        units = by_station(rec.direct, 'unit')
        states = by_station(rec.direct, 'state')
        self.assertTrue(any(u.get('wo') for u in units.get(release, [])), '작업지시를 받아 투입했다')
        self.assertTrue(any(s['state'] == 'IDLE' and s.get('reason') == ILK_WAIT_REASON for s in states[release]), 'WAIT 동안 MES 확인 대기')
        self.assertEqual(sim.ilk_miss, 0, '인터록 응답 시간 초과가 없다')
        self.assertFalse([u for us in units.values() for u in us if u.get('ilkSkip')], '확인 없이 통과한 개체가 없다')
        direct_req = [m for t, m in rec.direct if t.endswith('/ilk/req')]
        self.assertGreater(len(direct_req), 3)
        self.assertEqual(fake.sent('ilk/req'), direct_req, '모든 인터록 요청이 PLC 태그를 거쳐 그대로 MES에 갔다')
        self.assertEqual(box['replies'], len(direct_req) + len(fake.sent('wo/req')), '모든 응답이 PLC 태그를 거쳐 명령 큐로 왔다')
        got = [(t, json.loads(d)) for t, d, _ in fake.out]
        self.assertEqual(by_station(got, 'state'), states, '상태 변경(IDLE 사유 포함)이 MQTT 직행과 같다')
        self.assertEqual(by_station(got, 'unit'), units)
        self.assertEqual(edge.hs.late, 0)

        # 요청이 그보다 먼저 난 실적을 앞지르지 않는다 (MES가 공정 순서를 판정할 때 앞 공정 실적이 먼저 와 있어야 한다)
        def units_before(msgs):
            n, out = 0, {}
            for t, m in msgs:
                if t.endswith('/unit'):
                    n += 1
                elif t.endswith('/ilk/req'):
                    out[m['reqId']] = n
            return out

        direct_before, edge_before = units_before(rec.direct), units_before(got)
        self.assertEqual([m['serial'] for t, m in got if t.endswith('/unit')], [m['serial'] for t, m in rec.direct if t.endswith('/unit')])
        self.assertFalse([r for r, n in direct_before.items() if edge_before[r] < n][:5], '앞 공정 실적보다 먼저 간 요청이 없다')

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
