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
- MES 요청(공정 인터록·작업지시)은 PLC 태그 핸드셰이크로 주고받는다 (아래 "핸드셰이크")

MQTT 토픽과 JSON 모양은 시뮬레이터가 MQTT로 바로 보낼 때와 같다. 그래서 MES는 데이터가 어느 길로 왔는지 몰라도 된다.

핸드셰이크 (요청 번호·응답 번호 비교)
  PLC 블록: 게이트 설비 아래 Interlock, 투입 공정이 있는 라인 아래 WorkOrder.
    ReqSeq(UInt32)·ReqData(String)는 PLC가 쓰고, ResSeq(UInt32)·ResData(String)는 엣지가 쓴다.
  1. PLC: ReqData에 요청 JSON을 쓰고 ReqSeq를 1 올린다 (ReqSeq ≠ ResSeq = 답을 기다리는 요청이 있다)
  2. 엣지: ReqSeq 변화를 구독으로 받아 ReqSeq·ReqData를 한 번에 읽고 MQTT ilk/req·wo/req로 보낸다
  3. 엣지: MES 응답(ilk/res·wo/res)이 오면 reqId로 블록을 찾아 ResData를 쓰고 ResSeq를 그 요청의 ReqSeq로 맞춘다
  4. PLC: ResSeq == ReqSeq가 되면 ResData를 읽어 응답으로 받는다 (Ack)
  - 이미 다음 요청으로 넘어간 reqId의 응답(늦은 응답)은 쓰지 않고 버린다
  - MQTT가 끊긴 동안의 요청은 버퍼에 쌓지 않고 버린다. 오래된 인터록 요청을 나중에 보내면
    MES가 이미 지나간 개체를 판정한다. 설비 쪽은 응답 시간 초과로 처리한다
  - OPC UA에 새로 붙을 때 이미 PLC에 걸려 있던 요청은 보내지 않는다 (언제 낸 것인지 알 수 없다)
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
from dataclasses import dataclass
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

from .model import iso
from .mqtt_io import ROOT, SUB_ILK_RES, SUB_WO_RES, t_ilk_req, t_ilk_res, t_state, t_tags, t_unit, t_wo_req, t_wo_res
from .opcua_names import DEFAULT_ENDPOINT, NS_URI, PLANT, STATE_EVENT, UNIT_EVENT

T_EDGE_STATUS = f'{ROOT}/edge/status'
FLUSH_SEC = 0.2
STATUS_SEC = 2.0
PUBLISH_MS = 200
# 시뮬레이터와 같은 규칙: 사유는 이 상태일 때만 싣는다 (IDLE은 인터록 'MES 확인 대기')
REASON_IN_STATE = ('DOWN', 'STOP', 'SETUP', 'IDLE')
REASON_IN_TAGS = ('DOWN', 'STOP')

# ── MES 핸드셰이크 블록 (가상 PLC opcua_plc도 이 이름으로 주소 공간을 만든다) ──
ILK_BLOCK = 'Interlock'  # 게이트 설비 아래: 공정 인터록 (투입 확인)
WO_BLOCK = 'WorkOrder'  # 투입 공정이 있는 라인 아래: 다음 작업지시 요청
HS_REQ_SEQ, HS_REQ_DATA, HS_RES_SEQ, HS_RES_DATA = 'ReqSeq', 'ReqData', 'ResSeq', 'ResData'
HS_SEQ_MAX = 0xFFFFFFFF  # UInt32. 넘으면 1로 돌아간다 (0은 "요청한 적 없음")
# ReqSeq 알림을 받으면 같은 발행 묶음의 이벤트(앞 공정 실적)를 먼저 보낸 뒤 요청을 보낸다.
# 큐가 이만큼 비어 있으면 묶음을 다 꺼낸 것으로 본다 · 아무리 늦어도 이만큼 안에는 보낸다
HS_SETTLE_SEC = 0.005
HS_MAX_DEFER_SEC = 0.05


def next_seq(seq: int) -> int:
    return seq % HS_SEQ_MAX + 1


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


@dataclass(eq=False)
class HsBlock:
    """PLC 핸드셰이크 블록 하나 (게이트 설비의 Interlock 또는 라인의 WorkOrder). 노드는 asyncua Node (테스트에서는 아무 값)"""

    kind: str  # 'ilk' | 'wo'
    line: str
    station: str | None = None
    req_seq: object = None
    req_data: object = None
    res_seq: object = None
    res_data: object = None
    seen: int = 0  # 마지막으로 처리한 ReqSeq (탐색 때 읽은 값에서 시작)
    seq: int = 0  # 지금 답을 기다리는 요청의 ReqSeq
    rid: str | None = None  # 그 요청의 reqId

    @property
    def req_topic(self) -> str:
        return t_ilk_req(self.line, self.station) if self.kind == 'ilk' else t_wo_req(self.line)

    @property
    def res_topic(self) -> str:
        return t_ilk_res(self.line, self.station) if self.kind == 'ilk' else t_wo_res(self.line)


class Handshake:
    """요청 번호·응답 번호 핸드셰이크의 판단만 한다 (OPC UA 읽기·쓰기는 Edge가 한다). 네트워크 없이 테스트한다.

    블록마다 답을 기다리는 요청은 하나뿐이다: 새 요청을 보내면 이전 reqId는 닫혀 그 응답은 늦은 응답이 된다.
    """

    def __init__(self) -> None:
        self.reset()
        self.forwarded = 0
        self.answered = 0
        self.late = 0
        self.bad = 0

    def reset(self) -> None:
        """다시 탐색할 때 부른다 (누계는 남긴다)"""
        self.blocks: list[HsBlock] = []
        self.open: dict[str, HsBlock] = {}  # reqId → 답을 기다리는 블록
        self.pending: dict[HsBlock, None] = {}  # ReqSeq가 바뀌어 읽어야 하는 블록 (순서 유지)
        self.pending_since = 0.0

    def add(self, blk: HsBlock, seq: int) -> None:
        """탐색 때 읽은 ReqSeq를 기준으로 삼는다. 이미 걸려 있던 요청은 보내지 않는다"""
        blk.seen = int(seq or 0)
        self.blocks.append(blk)

    def mark(self, blk: HsBlock, seq: int) -> None:
        """ReqSeq 알림: 처리한 번호와 다르면 읽어 보낼 대상으로 둔다"""
        if int(seq) != blk.seen and blk not in self.pending:
            if not self.pending:
                self.pending_since = time.monotonic()
            self.pending[blk] = None

    def take_pending(self) -> list[HsBlock]:
        out = list(self.pending)
        self.pending.clear()
        return out

    def accept(self, blk: HsBlock, seq, data) -> tuple[str, dict] | None:
        """한 번에 읽은 ReqSeq·ReqData → 보낼 (토픽, 요청). 이미 처리한 번호거나 형식이 틀리면 None"""
        seq = int(seq or 0)
        if seq == blk.seen:
            return None
        blk.seen = seq
        try:
            msg = json.loads(data) if data else None
        except (TypeError, ValueError):
            msg = None
        if not isinstance(msg, dict) or not msg.get('reqId'):
            self.bad += 1
            return None
        # 이전 요청은 답을 받았거나 PLC가 다음 요청으로 넘어갔다: 그 응답이 이제 오면 늦은 응답이다
        if blk.rid is not None:
            self.open.pop(blk.rid, None)
        blk.seq, blk.rid = seq, str(msg['reqId'])
        self.open[blk.rid] = blk
        self.forwarded += 1
        return blk.req_topic, msg

    def drop(self, blk: HsBlock) -> None:
        """보내지 못한 요청 (MQTT 끊김): 응답이 올 일이 없으니 닫는다"""
        if blk.rid is not None:
            self.open.pop(blk.rid, None)
        blk.rid = None
        self.forwarded -= 1

    def answer(self, topic: str, msg: dict) -> tuple[HsBlock, int, str] | None:
        """MES 응답 → (블록, 써 넣을 ResSeq, ResData JSON). 모르는 reqId(늦은 응답·중복·다른 실행)면 None"""
        rid = msg.get('reqId')
        blk = self.open.get(str(rid)) if rid is not None else None
        if blk is None or topic != blk.res_topic:
            self.late += 1
            return None
        del self.open[blk.rid]
        blk.rid = None
        self.answered += 1
        return blk, blk.seq, json.dumps(msg, ensure_ascii=False, separators=(',', ':'))

    def status(self) -> dict:
        return {
            'ilk': sum(1 for b in self.blocks if b.kind == 'ilk'),
            'wo': sum(1 for b in self.blocks if b.kind == 'wo'),
            'forwarded': self.forwarded,
            'answered': self.answered,
            'late': self.late,
            'bad': self.bad,
        }


class Forwarder:
    """MQTT 발행 + 끊긴 동안의 기록 버퍼 (store and forward) + MES 응답 받기."""

    def __init__(self, host: str = '127.0.0.1', port: int = 1884, client_id: str = 'lumiedge',
                 max_buffer: int = 20000, client=None):
        self.lock = threading.Lock()
        self.buffer: deque = deque()
        self.max_buffer = max_buffer
        self.sent: Counter = Counter()
        self.dropped = 0  # 버퍼가 넘쳐 버린 기록 (state·unit)
        self.skipped = 0  # 끊긴 동안 버린 tags
        self.req_dropped = 0  # 끊긴 동안 버린 MES 요청 (인터록·작업지시)
        self.connected = False
        self.host, self.port = host, port
        # MES 응답(ilk/res·wo/res)을 받으면 부른다: on_reply(topic, dict). MQTT 스레드에서 불린다
        self.on_reply = None
        if client is not None:  # 테스트용 가짜 클라이언트 (응답은 receive()로 넣는다)
            self.client = client
            return
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id, clean_session=True)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message
        self.client.reconnect_delay_set(min_delay=1, max_delay=5)
        self.client.connect_async(host, port, keepalive=15)
        self.client.loop_start()

    def _on_connect(self, client, userdata, flags, reason_code, properties) -> None:
        if reason_code.is_failure:
            print(f'[edge] MQTT 연결 실패: {reason_code}', flush=True)
            return
        # 깨끗한 세션이라 붙을 때마다 다시 구독한다
        client.subscribe([(SUB_ILK_RES, 1), (SUB_WO_RES, 1)])
        self.set_connected(True)
        print(f'[edge] MQTT 연결됨 · {self.host}:{self.port}', flush=True)

    def _on_message(self, client, userdata, msg) -> None:
        self.receive(msg.topic, msg.payload)

    def receive(self, topic: str, payload) -> None:
        """MQTT로 받은 MES 응답을 엣지로 넘긴다"""
        try:
            if isinstance(payload, (bytes, bytearray)):
                payload = payload.decode('utf-8')
            obj = json.loads(payload) if isinstance(payload, str) else payload
        except (ValueError, UnicodeDecodeError):
            print(f'[edge] MES 응답 형식 오류: {topic}', flush=True)
            return
        cb = self.on_reply
        if isinstance(obj, dict) and cb is not None:
            cb(topic, obj)

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

    def send_request(self, topic: str, payload: dict, kind: str) -> bool:
        """MES 요청은 붙어 있을 때만 보낸다 (QoS 1). 끊겨 있으면 버퍼에 넣지 않고 버린다:
        요청을 낸 설비는 응답 시간 초과로 처리하고, 늦게 보낸 요청은 이미 지나간 개체를 판정하게 된다"""
        data = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        with self.lock:
            if not self.connected:
                self.req_dropped += 1
                return False
            self._flush_locked()  # 쌓인 기록(앞 공정 실적)이 요청보다 먼저 가야 MES가 공정 순서를 바로 판정한다
            self._publish(topic, data, 1, kind)
            return True

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
        self.hs = Handshake()
        self.replies: asyncio.Queue | None = None  # MES 응답 (run()이 만든다)

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
            # PLC 핸드셰이크: 블록 수(ilk·wo), 보낸 요청·써 준 응답, 버린 늦은 응답·형식 오류, MQTT가 끊겨 버린 요청
            'handshake': {**self.hs.status(), 'dropped': self.fwd.req_dropped},
        }

    def _on_reply(self, loop: asyncio.AbstractEventLoop, topic: str, msg: dict) -> None:
        """MQTT 스레드 → 엣지 이벤트 루프"""
        try:
            loop.call_soon_threadsafe(self.replies.put_nowait, (topic, msg))
        except RuntimeError:  # 루프가 이미 닫혔다 (종료 중)
            pass

    async def run(self, stop: asyncio.Event | None = None) -> None:
        stop = stop or asyncio.Event()
        loop = asyncio.get_running_loop()
        self.replies = asyncio.Queue()
        self.fwd.on_reply = lambda topic, msg: self._on_reply(loop, topic, msg)
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
            self.fwd.on_reply = None
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

    # ── MES 핸드셰이크 ──
    @staticmethod
    async def _block(node, idx: int, kind: str, line: str, station: str | None) -> HsBlock:
        async def child(name: str):
            return await node.get_child(f'{idx}:{name}')

        return HsBlock(kind, line, station, await child(HS_REQ_SEQ), await child(HS_REQ_DATA),
                       await child(HS_RES_SEQ), await child(HS_RES_DATA))

    async def _forward_requests(self, client) -> None:
        """요청 번호가 바뀐 블록의 ReqSeq·ReqData를 한 번에 읽어(같은 Read 안이라 짝이 어긋나지 않는다) MQTT로 보낸다"""
        blocks = self.hs.take_pending()
        if not blocks:
            return
        vals = await client.read_values([n for b in blocks for n in (b.req_seq, b.req_data)])
        for i, blk in enumerate(blocks):
            out = self.hs.accept(blk, vals[2 * i], vals[2 * i + 1])
            if out is None:
                continue
            topic, msg = out
            self.received[blk.kind] += 1
            if not self.fwd.send_request(topic, msg, blk.kind):
                self.hs.drop(blk)

    async def _reply_loop(self, client) -> None:
        """MES 응답을 PLC에 써 준다: ResData를 먼저, ResSeq를 나중에 (한 번의 Write 안에서 서버가 순서대로 쓴다)"""
        from asyncua import ua

        while True:
            topic, msg = await self.replies.get()
            hit = self.hs.answer(topic, msg)
            if hit is None:
                continue  # 늦은 응답·중복·모르는 요청
            blk, seq, data = hit
            try:
                await client.write_values([blk.res_data, blk.res_seq], [
                    ua.DataValue(ua.Variant(data, ua.VariantType.String)),
                    ua.DataValue(ua.Variant(seq, ua.VariantType.UInt32)),
                ])
            except asyncio.CancelledError:
                raise
            except Exception as e:  # 연결이 끊겼으면 세션이 알아서 다시 붙는다. 설비는 응답 시간 초과로 처리한다
                self.say(f'[edge] PLC에 MES 응답을 쓰지 못함 ({blk.res_topic}): {e!r}')

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

            # ── 탐색: 공장 → 라인 → 설비 → Tags (+ MES 핸드셰이크 블록) ──
            self.mapper.reset()
            self.hs.reset()
            tag_nodes, tag_keys, state_nodes = [], {}, []
            blocks: list[HsBlock] = []
            for line in await plant.get_children(nodeclassmask=ua.NodeClass.Object):
                lcode = (await line.read_browse_name()).Name
                for st in await line.get_children(nodeclassmask=ua.NodeClass.Object):
                    code = (await st.read_browse_name()).Name
                    if code == WO_BLOCK:  # 설비가 아니라 라인의 작업지시 블록
                        blocks.append(await self._block(st, idx, 'wo', lcode, None))
                        continue
                    self.mapper.add_station(lcode, code)
                    folder = await st.get_child(f'{idx}:Tags')
                    for var in await folder.get_children(nodeclassmask=ua.NodeClass.Variable):
                        tag_keys[var.nodeid] = (code, (await var.read_browse_name()).Name)
                        tag_nodes.append(var)
                    state_nodes.append((code, await st.get_child(f'{idx}:State'), await st.get_child(f'{idx}:StateReason')))
                    try:
                        ilk = await st.get_child(f'{idx}:{ILK_BLOCK}')
                    except ua.UaStatusCodeError:
                        continue  # 게이트 설비가 아니다
                    blocks.append(await self._block(ilk, idx, 'ilk', lcode, code))
            self.stations, self.tag_count = len(state_nodes), len(tag_nodes)
            # 지금 PLC에 걸려 있는 요청 번호를 기준으로 삼는다 (언제 낸 요청인지 알 수 없어 보내지 않는다)
            seqs = await client.read_values([b.req_seq for b in blocks]) if blocks else []
            for b, s in zip(blocks, seqs):
                self.hs.add(b, s)
            hs_of = {b.req_seq.nodeid: b for b in blocks}
            if self.replies is None:
                self.replies = asyncio.Queue()
            while not self.replies.empty():  # 연결이 없던 동안 온 응답은 짝지을 요청이 없다
                self.replies.get_nowait()
                self.hs.late += 1

            sub = await client.create_subscription(PUBLISH_MS, None, queue_maxsize=100_000, overflow=OverflowPolicy.WARN)
            async with sub:
                # 상태 변경은 이벤트로 받는다. State 변수 구독은 처음 상태를 잡는 데만 쓴다
                # (이벤트가 아직 없던 설비도 tags에 현재 상태를 실어야 MES가 늦게 붙어도 상태를 안다)
                await sub.subscribe_events(plant, [state_type, unit_type], queuesize=10_000)
                state_of = {s_node.nodeid: (code, r_node) for code, s_node, r_node in state_nodes}
                await sub.subscribe_data_change([s for _, s, _ in state_nodes], queuesize=1)
                await sub.subscribe_data_change(tag_nodes, queuesize=1)
                # 핸드셰이크 요청 번호도 같은 구독으로 받는다: 앞 공정 실적(이벤트)과 같은 발행 묶음으로 와야 순서를 맞출 수 있다
                if blocks:
                    await sub.subscribe_data_change([b.req_seq for b in blocks], queuesize=1)

                if self.connected_at is not None:
                    self.reconnects += 1
                self.opcua = 'connected'
                self.connected_at = iso(datetime.now(timezone.utc))
                self.say(f'[edge] OPC UA 연결됨 · {self.endpoint} · 설비 {self.stations} · 태그 {self.tag_count} 구독'
                         f' · MES 핸드셰이크 {len(blocks)}')
                flush_task = asyncio.create_task(self._flush_loop())
                reply_task = asyncio.create_task(self._reply_loop(client))
                try:
                    while not stop.is_set() and not lost.is_set():
                        # 요청 번호가 바뀌었으면 같은 묶음의 알림(실적 이벤트)을 마저 꺼낸 뒤 요청을 보낸다.
                        # 서버는 한 발행 묶음에 값 변화를 이벤트보다 앞에 담으므로, 바로 보내면 MES가 앞 공정 실적보다 요청을 먼저 받는다
                        ev = await sub.next_event(timeout=HS_SETTLE_SEC if self.hs.pending else 0.5)
                        if ev is None:
                            if self.hs.pending:
                                await self._forward_requests(client)
                            continue
                        if isinstance(ev, DataChangeEvent):
                            dv = ev.data.monitored_item.Value
                            key = tag_keys.get(ev.node.nodeid)
                            if key:
                                self.mapper.on_value(key[0], key[1], ev.value, dv.SourceTimestamp, dv.StatusCode.is_good())
                                self.received['value'] += 1
                            elif ev.node.nodeid in hs_of:
                                if dv.StatusCode.is_good() and ev.value is not None:
                                    self.hs.mark(hs_of[ev.node.nodeid], ev.value)
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
                        # 알림이 쉬지 않고 이어져도 요청을 오래 붙잡지 않는다
                        if self.hs.pending and time.monotonic() - self.hs.pending_since > HS_MAX_DEFER_SEC:
                            await self._forward_requests(client)
                    if lost.is_set():
                        raise ConnectionError('서버 응답 없음')
                finally:
                    flush_task.cancel()
                    reply_task.cancel()
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
