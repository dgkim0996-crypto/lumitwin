"""엣지 게이트웨이: 가상 PLC(OPC UA) → MQTT.

실행:
  python -m lumisim.edge                    opc.tcp://127.0.0.1:4840/lumitwin/ → MQTT 127.0.0.1:1884
  python -m lumisim.edge --opcua opc.tcp://192.168.0.10:4840/ --host broker --port 1883

하는 일
- 주소 공간을 탐색(Browse)해 라인·설비·태그 목록을 스스로 알아낸다. 공장 정의 파일을 몰라도 된다
- 태그는 값이 바뀔 때만 받아(구독, Report by Exception) 설비별로 모아 0.2초마다 tags 토픽으로 보낸다
- 상태 변경·생산 실적은 OPC UA 이벤트로 받아 곧바로 state·unit 토픽으로 보낸다
  실적에는 설비별 순번(Seq)이 붙어 있어, 빠진 기록이 있으면 센다
- MQTT가 끊기면 state·unit은 버퍼에 쌓았다가 다시 붙으면 순서대로 보낸다(store and forward).
  tags는 최신값만 의미가 있어 끊긴 동안 것은 버린다
- OPC UA 연결이 끊기면(PLC 재시작) 다시 붙고 처음부터 탐색한다
- 2초마다 lt/v1/edge/status 로 자기 상태를 낸다

MQTT 토픽과 JSON 모양은 시뮬레이터가 MQTT로 바로 보낼 때와 같다. 그래서 MES는 데이터가 어느 길로 왔는지 몰라도 된다.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import threading
import time
from collections import Counter, deque
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

from .model import iso
from .mqtt_io import ROOT, t_state, t_tags, t_unit
from .opcua_names import DEFAULT_ENDPOINT, NS_URI, PLANT, STATE_EVENT, UNIT_EVENT

T_EDGE_STATUS = f'{ROOT}/edge/status'
FLUSH_SEC = 0.2
STATUS_SEC = 2.0
PUBLISH_MS = 200
# 시뮬레이터와 같은 규칙: 사유는 이 상태일 때만 싣는다
REASON_IN_STATE = ('DOWN', 'STOP', 'SETUP')
REASON_IN_TAGS = ('DOWN', 'STOP')


def _utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


class Mapper:
    """OPC UA에서 받은 값·이벤트를 MES가 아는 MQTT 메시지로 바꾼다. 네트워크와 떨어져 있어 테스트하기 쉽다."""

    def __init__(self) -> None:
        self.reset()
        self.gaps = 0

    def reset(self) -> None:
        """다시 탐색할 때(연결이 새로 붙을 때) 부른다. 빠진 실적 누계(gaps)는 남긴다"""
        self.line: dict[str, str] = {}
        self.values: dict[str, dict[str, float]] = {}
        self.ts: dict[str, datetime] = {}
        self.state: dict[str, tuple[str, str]] = {}
        self.dirty: set[str] = set()
        self.last_seq: dict[str, int] = {}

    def add_station(self, line: str, code: str) -> None:
        self.line[code] = line
        self.values.setdefault(code, {})

    def has_state(self, code: str) -> bool:
        return code in self.state

    def init_state(self, code: str, state: str | None, reason: str | None) -> None:
        """처음 상태만 잡는다. 그 뒤로는 상태 이벤트가 바꾼다"""
        if state and code not in self.state:
            self.state[code] = (state, reason or '')

    def on_value(self, code: str, key: str, value, ts: datetime | None, good: bool) -> None:
        vals = self.values.setdefault(code, {})
        if not good or value is None:
            vals.pop(key, None)  # 아직 PLC가 안 쓴 값·통신 이상 값은 보내지 않는다
            return
        vals[key] = float(value)
        ts = _utc(ts)
        # 태그 묶음의 시각 = 직전 전송 뒤 받은 값 중 가장 늦은 시각.
        # 지금까지 본 최댓값을 계속 들고 있으면, 시뮬레이터를 초기화해 가상 시계가 되돌아갔을 때
        # 새 실행 값에 이전 실행 끝 시각이 붙어 나간다 (MES 시계가 몇 시간 앞으로 튄다)
        if ts is not None and (code not in self.dirty or code not in self.ts or ts > self.ts[code]):
            self.ts[code] = ts
        self.dirty.add(code)

    def on_state(self, line: str, code: str, state: str, reason: str, ts: datetime) -> tuple[str, dict]:
        self.line.setdefault(code, line)
        self.state[code] = (state, reason or '')
        msg = {'t': iso(_utc(ts)), 'state': state}
        if state in REASON_IN_STATE and reason:
            msg['reason'] = reason
        return t_state(line, code), msg

    def on_unit(self, line: str, code: str, seq: int | None, record: str) -> tuple[str, dict]:
        self.line.setdefault(code, line)
        if seq is not None:
            last = self.last_seq.get(code)
            if last is not None and seq > last + 1:
                self.gaps += seq - last - 1
            self.last_seq[code] = seq  # seq <= last 이면 PLC가 다시 시작한 것: 거기서부터 센다
        return t_unit(line, code), json.loads(record)

    def flush(self) -> list[tuple[str, dict]]:
        out = []
        for code in sorted(self.dirty):
            vals = self.values.get(code)
            if not vals or code not in self.ts or code not in self.line:
                continue
            msg: dict = {'t': iso(self.ts[code]), 'v': dict(vals)}
            st = self.state.get(code)
            if st:
                msg['s'] = st[0]
                if st[0] in REASON_IN_TAGS and st[1]:
                    msg['r'] = st[1]
            out.append((t_tags(self.line[code], code), msg))
        self.dirty.clear()
        return out


class Forwarder:
    """MQTT 발행 + 끊긴 동안의 기록 버퍼 (store and forward)."""

    def __init__(self, host: str = '127.0.0.1', port: int = 1884, client_id: str = 'lumiedge',
                 max_buffer: int = 20000, client=None):
        self.lock = threading.Lock()
        self.buffer: deque = deque()
        self.max_buffer = max_buffer
        self.sent: Counter = Counter()
        self.dropped = 0  # 버퍼가 넘쳐 버린 기록 (state·unit)
        self.skipped = 0  # 끊긴 동안 버린 tags
        self.connected = False
        self.host, self.port = host, port
        if client is not None:  # 테스트용 가짜 클라이언트
            self.client = client
            return
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id, clean_session=True)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.reconnect_delay_set(min_delay=1, max_delay=5)
        self.client.connect_async(host, port, keepalive=15)
        self.client.loop_start()

    def _on_connect(self, client, userdata, flags, reason_code, properties) -> None:
        if reason_code.is_failure:
            print(f'[edge] MQTT 연결 실패: {reason_code}', flush=True)
            return
        self.set_connected(True)
        print(f'[edge] MQTT 연결됨 · {self.host}:{self.port}', flush=True)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties) -> None:
        if self.connected:
            print('[edge] MQTT 연결 끊김 · 기록은 버퍼에 쌓는 중', flush=True)
        self.set_connected(False)

    def set_connected(self, on: bool) -> None:
        with self.lock:
            self.connected = on
            if on:
                n = len(self.buffer)
                self._flush_locked()
                if n:
                    print(f'[edge] 버퍼에 쌓인 기록 {n}건을 보냄', flush=True)

    def send(self, topic: str, payload: dict, qos: int = 0, kind: str = 'other') -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        with self.lock:
            if self.connected:
                self._flush_locked()
                self._publish(topic, data, qos, kind)
            elif qos > 0:
                if len(self.buffer) >= self.max_buffer:
                    self.buffer.popleft()
                    self.dropped += 1
                self.buffer.append((topic, data, qos, kind))
            else:
                self.skipped += 1

    def _flush_locked(self) -> None:
        while self.buffer:
            topic, data, qos, kind = self.buffer.popleft()
            self._publish(topic, data, qos, kind)

    def _publish(self, topic: str, data: str, qos: int, kind: str) -> None:
        self.client.publish(topic, data, qos=qos)
        self.sent[kind] += 1

    def close(self) -> None:
        if hasattr(self.client, 'loop_stop'):
            self.client.loop_stop()
            self.client.disconnect()


class Edge:
    def __init__(self, endpoint: str, fwd: Forwarder, verbose: bool = True):
        self.endpoint = endpoint
        self.fwd = fwd
        self.mapper = Mapper()
        self.verbose = verbose
        self.opcua = 'connecting'
        self.stations = 0
        self.tag_count = 0
        self.received: Counter = Counter()
        self.connected_at: str | None = None
        self.reconnects = 0

    def say(self, text: str) -> None:
        if self.verbose:
            print(text, flush=True)

    def status(self) -> dict:
        return {
            't': iso(datetime.now(timezone.utc)),
            'endpoint': self.endpoint,
            'opcua': self.opcua,
            'mqtt': self.fwd.connected,
            'since': self.connected_at,
            'reconnects': self.reconnects,
            'stations': self.stations,
            'tags': self.tag_count,
            'received': dict(self.received),
            'sent': dict(self.fwd.sent),
            'buffered': len(self.fwd.buffer),
            'dropped': self.fwd.dropped,
            'skipped': self.fwd.skipped,
            'gaps': self.mapper.gaps,
        }

    async def run(self, stop: asyncio.Event | None = None) -> None:
        stop = stop or asyncio.Event()
        status_task = asyncio.create_task(self._status_loop(stop))
        backoff = 1.0
        try:
            while not stop.is_set():
                try:
                    await self.session(stop)
                    backoff = 1.0
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # 연결 실패·끊김: 잠깐 기다렸다 다시 붙는다
                    if self.opcua == 'connected':
                        self.say(f'[edge] OPC UA 연결 끊김: {e!r}')
                    elif backoff == 1.0:
                        self.say(f'[edge] OPC UA 서버에 붙지 못함 ({self.endpoint}) · 다시 시도 중')
                self.opcua = 'connecting'
                if stop.is_set():
                    break
                try:
                    await asyncio.wait_for(stop.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, 10.0)
        finally:
            status_task.cancel()

    async def _status_loop(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            self.fwd.send(T_EDGE_STATUS, self.status(), 0, 'status')
            await asyncio.sleep(STATUS_SEC)

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(FLUSH_SEC)
            for topic, msg in self.mapper.flush():
                self.fwd.send(topic, msg, 0, 'tags')

    async def session(self, stop: asyncio.Event) -> None:
        from asyncua import Client, ua
        from asyncua.common.subscription import DataChangeEvent, OpcEvent, OverflowPolicy, StatusChangeEvent

        client = Client(self.endpoint, timeout=4)
        lost = asyncio.Event()

        async def on_lost(exc: Exception) -> None:
            lost.set()

        client.connection_lost_callback = on_lost
        async with client:
            idx = await client.get_namespace_index(NS_URI)
            plant = await client.nodes.objects.get_child(f'{idx}:{PLANT}')
            state_type = await client.nodes.base_event_type.get_child(f'{idx}:{STATE_EVENT}')
            unit_type = await client.nodes.base_event_type.get_child(f'{idx}:{UNIT_EVENT}')

            # ── 탐색: 공장 → 라인 → 설비 → Tags ──
            self.mapper.reset()
            tag_nodes, tag_keys, state_nodes = [], {}, []
            for line in await plant.get_children(nodeclassmask=ua.NodeClass.Object):
                lcode = (await line.read_browse_name()).Name
                for st in await line.get_children(nodeclassmask=ua.NodeClass.Object):
                    code = (await st.read_browse_name()).Name
                    self.mapper.add_station(lcode, code)
                    folder = await st.get_child(f'{idx}:Tags')
                    for var in await folder.get_children(nodeclassmask=ua.NodeClass.Variable):
                        tag_keys[var.nodeid] = (code, (await var.read_browse_name()).Name)
                        tag_nodes.append(var)
                    state_nodes.append((code, await st.get_child(f'{idx}:State'), await st.get_child(f'{idx}:StateReason')))
            self.stations, self.tag_count = len(state_nodes), len(tag_nodes)

            sub = await client.create_subscription(PUBLISH_MS, None, queue_maxsize=100_000, overflow=OverflowPolicy.WARN)
            async with sub:
                # 상태 변경은 이벤트로 받는다. State 변수 구독은 처음 상태를 잡는 데만 쓴다
                # (이벤트가 아직 없던 설비도 tags에 현재 상태를 실어야 MES가 늦게 붙어도 상태를 안다)
                await sub.subscribe_events(plant, [state_type, unit_type], queuesize=10_000)
                state_of = {s_node.nodeid: (code, r_node) for code, s_node, r_node in state_nodes}
                await sub.subscribe_data_change([s for _, s, _ in state_nodes], queuesize=1)
                await sub.subscribe_data_change(tag_nodes, queuesize=1)

                if self.connected_at is not None:
                    self.reconnects += 1
                self.opcua = 'connected'
                self.connected_at = iso(datetime.now(timezone.utc))
                self.say(f'[edge] OPC UA 연결됨 · {self.endpoint} · 설비 {self.stations} · 태그 {self.tag_count} 구독')
                flush_task = asyncio.create_task(self._flush_loop())
                try:
                    while not stop.is_set() and not lost.is_set():
                        ev = await sub.next_event(timeout=0.5)
                        if ev is None:
                            continue
                        if isinstance(ev, DataChangeEvent):
                            dv = ev.data.monitored_item.Value
                            key = tag_keys.get(ev.node.nodeid)
                            if key:
                                self.mapper.on_value(key[0], key[1], ev.value, dv.SourceTimestamp, dv.StatusCode.is_good())
                                self.received['value'] += 1
                            elif ev.node.nodeid in state_of and dv.StatusCode.is_good():
                                code, r_node = state_of[ev.node.nodeid]
                                if not self.mapper.has_state(code):
                                    reason = await r_node.read_data_value(raise_on_bad_status=False)
                                    self.mapper.init_state(code, ev.value, reason.Value.Value if reason.StatusCode.is_good() else '')
                        elif isinstance(ev, OpcEvent):
                            e = ev.event
                            if e.EventType == state_type.nodeid:
                                topic, msg = self.mapper.on_state(e.Line, e.Station, e.State, e.Reason or '', e.Time)
                                self.fwd.send(topic, msg, 1, 'state')
                                self.received['state'] += 1
                            elif e.EventType == unit_type.nodeid:
                                topic, msg = self.mapper.on_unit(e.Line, e.Station, e.Seq, e.Record)
                                self.fwd.send(topic, msg, 1, 'unit')
                                self.received['unit'] += 1
                        elif isinstance(ev, StatusChangeEvent):
                            if not ev.notification.Status.is_good():
                                raise ConnectionError(f'구독 상태 {ev.notification.Status}')
                    if lost.is_set():
                        raise ConnectionError('서버 응답 없음')
                finally:
                    flush_task.cancel()
                    # 끊기기 직전까지 받은 값은 보낸다
                    for topic, msg in self.mapper.flush():
                        self.fwd.send(topic, msg, 0, 'tags')


def main() -> None:
    ap = argparse.ArgumentParser(prog='lumisim.edge', description='LumiTwin 엣지 게이트웨이: OPC UA → MQTT')
    ap.add_argument('--opcua', default=os.environ.get('OPCUA_ENDPOINT', DEFAULT_ENDPOINT))
    ap.add_argument('--host', default=os.environ.get('MQTT_HOST', '127.0.0.1'))
    ap.add_argument('--port', type=int, default=int(os.environ.get('MQTT_PORT', '1884')))
    args = ap.parse_args()
    if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except AttributeError:
            pass
    logging.basicConfig(level=logging.ERROR, format='[edge] %(name)s: %(message)s')
    # asyncua는 보안 정책이 없다는 경고와, PLC가 내려갈 때 내부 발행 루프의 연결 오류를 길게 남긴다.
    # 끊김·재연결은 엣지가 직접 알리므로 라이브러리 로그는 치명적인 것만 보인다
    logging.getLogger('asyncua').setLevel(logging.CRITICAL)
    try:
        import asyncua  # noqa: F401
    except ImportError:
        raise SystemExit('[edge] asyncua가 없습니다. 먼저 `npm run sim:setup:opcua` 를 실행하세요.')
    fwd = Forwarder(args.host, args.port)
    edge = Edge(args.opcua, fwd)
    print(f'[edge] 시작 · OPC UA {args.opcua} → MQTT {args.host}:{args.port}', flush=True)
    t0 = time.monotonic()
    try:
        asyncio.run(edge.run())
    except KeyboardInterrupt:
        pass
    finally:
        fwd.close()
        print(f'[edge] 종료 · {time.monotonic() - t0:.0f}초 · 보낸 메시지 {dict(fwd.sent)}', flush=True)


if __name__ == '__main__':
    main()
