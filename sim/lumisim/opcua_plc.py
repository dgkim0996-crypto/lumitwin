"""가상 PLC: 시뮬레이터의 설비 신호를 OPC UA 서버로 낸다 (`python -m lumisim --link opcua`).

실제 공장이라면 설비 PLC, 또는 PLC 앞에 붙은 OPC UA 서버가 하는 일이다. 시뮬레이터 엔진은 그대로 두고,
설비 토픽(tags·state·unit)으로 나가던 메시지를 MQTT 대신 이 서버의 주소 공간에 쓴다.
MES에 묻는 요청(공정 인터록 ilk/req·작업지시 wo/req)도 PLC가 MQTT를 직접 쏘지 않고 태그 핸드셰이크로 한다:
요청 데이터·요청 번호를 쓰면 엣지가 MES에 묻고, 결과·응답 번호를 PLC에 써 준다.
AMR·시뮬레이터 상태·명령·변경점·검사·상태 감시·수리 결과는 지금처럼 MQTT로 바로 오간다.
MQTT로 옮기는 일은 엣지 게이트웨이(`python -m lumisim.edge`)가 한다.

주소 공간 (네임스페이스 urn:lumitwin:plc)
  Objects/LumiTwin                  공장. 아래 두 이벤트를 낸다
    HL/HL-IM-L1                     라인/설비 (설명에 설비 이름)
      State, StateReason            현재 상태와 사유 (String)
      GoodCount, BadCount           양품·불량 누계 (UInt32)
      Tags/<key>                    태그 (Double, 설명에 태그 이름, EngineeringUnits 속성)
      Interlock                     게이트 설비만: 공정 인터록 핸드셰이크 (IlkReqMsg → IlkResMsg)
        ReqSeq, ReqData             PLC가 쓴다: 요청 번호 (UInt32, 새 요청마다 1 증가) · 요청 JSON (String)
        ResSeq, ResData             엣지가 쓴다: 응답 번호 (ReqSeq와 같아지면 응답 완료) · 응답 JSON
    HL/WorkOrder                    투입 공정이 있는 라인만: 작업지시 핸드셰이크 (WoReqMsg → WoResMsg), 구성은 같다
  이벤트 타입 (BaseEventType 아래)
    StationStateEventType           상태가 바뀔 때: Line, Station, State, Reason
    UnitCompletedEventType          한 개 가공이 끝날 때: Line, Station, Serial, Result, Defect, Seq, Record(생산 기록 JSON)

연속값은 구독(값이 바뀔 때만 알림)으로 충분하지만, 상태 변경·생산 실적은 하나라도 빠지면 OEE·추적이 틀어진다.
그래서 기록은 이벤트로 낸다: 서버가 구독마다 큐에 쌓아 두고 순서대로 보낸다.
값의 SourceTimestamp와 이벤트의 Time은 모두 가상 시각이다.
보안: 로컬 시연용이라 SecurityPolicy None·익명 접속만 연다 (현장에서는 Basic256Sha256 서명·암호화와 인증서를 쓴다).
"""
from __future__ import annotations

import asyncio
import json
import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from asyncua import Server, ua

from .edge import HS_REQ_DATA, HS_REQ_SEQ, HS_RES_DATA, HS_RES_SEQ, ILK_BLOCK, WO_BLOCK, next_seq
from .model import parse_iso
from .mqtt_io import REPLY_ACTION, t_ilk_res, t_wo_res
from .opcua_names import DEFAULT_ENDPOINT, NS_URI, PLANT, STATE_EVENT, UNIT_EVENT

STATION_KINDS = ('tags', 'state', 'unit')
# MES 핸드셰이크 요청: 인터록(키 = 설비) · 작업지시(키 = 라인)
REQ_KINDS = ('ilk', 'wo')
# 엣지가 없어 쌓여 있던 요청을 이만큼(실제 초) 넘게 늦게 꺼내면 쓰지 않고 버린다. 설비는 이미 응답 시간 초과로
# 넘어갔고(인터록 ILK_TIMEOUT_SEC 3초), 작업지시는 5초마다 다시 묻는다 (assumed: 인터록 시간 초과와 같게)
REQ_STALE_SEC_DEFAULT = 3.0
# 상태 이벤트 심각도 (OPC UA: 1~1000)
SEVERITY = {'DOWN': 700, 'STOP': 300, 'SETUP': 300}
# 한 번에 처리할 최대 메시지 수 (밀려도 서버 응답이 멈추지 않게)
DRAIN_MAX = 5000
# 이벤트를 구독한 클라이언트(엣지)가 없으면 이벤트가 그냥 사라진다. 그동안은 내보내지 않고 쌓아 둔다 (최대 개수)
HOLD_MAX = 200_000

log = logging.getLogger('lumisim.plc')

STATE_PROPS = [
    ('Line', ua.VariantType.String),
    ('Station', ua.VariantType.String),
    ('State', ua.VariantType.String),
    ('Reason', ua.VariantType.String),
]
UNIT_PROPS = [
    ('Line', ua.VariantType.String),
    ('Station', ua.VariantType.String),
    ('Serial', ua.VariantType.String),
    ('Result', ua.VariantType.String),
    ('Defect', ua.VariantType.String),
    ('Seq', ua.VariantType.UInt32),
    ('Record', ua.VariantType.String),
]


@dataclass
class StationNodes:
    line: str
    obj: ua.NodeId
    state: ua.NodeId
    reason: ua.NodeId
    good: ua.NodeId
    bad: ua.NodeId
    tags: dict[str, ua.NodeId] = field(default_factory=dict)
    cur_state: str = ''
    cur_reason: str = ''
    n_good: int = 0
    n_bad: int = 0
    seq: int = 0


@dataclass
class HsNodes:
    """MES 핸드셰이크 블록 (게이트 설비 Interlock · 라인 WorkOrder)"""

    kind: str  # 'ilk' | 'wo'
    line: str
    station: str | None
    req_seq: ua.NodeId
    req_data: ua.NodeId
    res_seq: ua.NodeId
    res_data: ua.NodeId
    seq: int = 0  # 마지막으로 낸 요청 번호
    acked: int = 0  # 마지막으로 응답을 받은 요청 번호 (seq와 다르면 응답을 기다리는 중)
    rid: str = ''

    @property
    def res_topic(self) -> str:
        return t_ilk_res(self.line, self.station) if self.kind == 'ilk' else t_wo_res(self.line)


def _dv(value, vtype: ua.VariantType, ts: datetime) -> ua.DataValue:
    return ua.DataValue(
        Value=ua.Variant(value, vtype),
        SourceTimestamp=ts,
        ServerTimestamp=datetime.now(timezone.utc),
    )


def _waiting(vtype: ua.VariantType) -> ua.DataValue:
    """아직 PLC가 쓰지 않은 값: 0을 진짜 값처럼 내보내지 않게 상태 코드로 표시한다"""
    return ua.DataValue(
        Value=ua.Variant(ua.get_default_value(vtype), vtype),
        StatusCode=ua.StatusCode(ua.StatusCodes.BadWaitingForInitialData),
        ServerTimestamp=datetime.now(timezone.utc),
    )


async def _describe(node, text: str) -> None:
    await node.write_attribute(
        ua.AttributeIds.Description,
        ua.DataValue(ua.Variant(ua.LocalizedText(text), ua.VariantType.LocalizedText)),
    )


class PlcServer:
    """asyncua 서버를 따로 스레드의 이벤트 루프에서 돌린다. 시뮬레이터 스레드는 post()로 넣기만 한다."""

    def __init__(self, factory: dict, endpoint: str = DEFAULT_ENDPOINT):
        self.factory = factory
        self.endpoint = endpoint
        self.inbox: queue.SimpleQueue = queue.SimpleQueue()
        self.ready = threading.Event()
        self.stopping = threading.Event()
        self.error: BaseException | None = None
        self.stations: dict[str, StationNodes] = {}
        # MES 핸드셰이크 블록: ('ilk', 설비) · ('wo', 라인)
        self.hs: dict[tuple[str, str], HsNodes] = {}
        # MES 응답을 넘길 곳: 시뮬레이터 명령 큐 (PlcIO가 이어 준다). {'action': REPLY_ACTION, 'topic', 'msg'}
        self.sink = queue.SimpleQueue()
        self.req_stale_sec = float((factory.get('mes') or {}).get('ilkTimeoutSec') or REQ_STALE_SEC_DEFAULT)
        self.requests = 0  # 핸드셰이크로 낸 요청
        self.answers = 0  # 받은 응답
        self.stale = 0  # 너무 늦게 꺼내 버린 요청
        self.written = 0
        self.events = 0
        self._warned: set[str] = set()
        self._thread = threading.Thread(target=self._thread_main, name='opcua-plc', daemon=True)

    # ── 시뮬레이터 스레드 쪽 ──
    def start(self, timeout: float = 30.0) -> None:
        self._thread.start()
        if not self.ready.wait(timeout):
            raise RuntimeError(f'OPC UA 서버가 {timeout:g}초 안에 뜨지 않았습니다')
        if self.error is not None:
            raise self.error

    def post(self, kind: str, station: str, msg: dict) -> None:
        """kind: tags·state·unit (키 = 설비) 또는 ilk (키 = 설비)·wo (키 = 라인).
        요청도 같은 줄에 넣어 앞 공정 실적보다 먼저 PLC에 쓰이지 않게 한다 (꺼낼 때 늦었는지 보려고 넣은 시각을 붙인다)"""
        self.inbox.put((kind, station, msg, time.monotonic()))

    def stop(self) -> None:
        self.stopping.set()
        self._thread.join(timeout=5)

    # ── 서버 스레드 ──
    def _thread_main(self) -> None:
        try:
            asyncio.run(self._main())
        except BaseException as e:  # 시작 전에 죽으면 start()가 알 수 있게
            if not self.ready.is_set():
                self.error = e
                self.ready.set()
            else:
                log.exception('OPC UA 서버가 멈췄습니다')

    async def _main(self) -> None:
        try:
            self.server = await self._build()
            await self.server.start()
        except BaseException as e:
            self.error = e
            self.ready.set()
            return
        self.ready.set()
        holding = False
        try:
            while not self.stopping.is_set():
                # 응답을 먼저 본다: 받은 응답을 다음 요청이 덮어쓰기 전에 넘긴다
                self._poll_replies()
                # 실제 PLC가 실적 버퍼를 두고 상위 시스템이 받아 갈 때까지 지우지 않는 것과 같은 역할
                if not self.subscribed() and self.inbox.qsize() < HOLD_MAX:
                    if not holding and self.inbox.qsize():
                        holding = True
                        print('[plc] 이벤트를 받을 클라이언트(엣지)가 없어 설비 신호를 쌓아 두는 중', flush=True)
                else:
                    if holding:
                        holding = False
                        print(f'[plc] 클라이언트가 붙어 쌓아 둔 신호 {self.inbox.qsize()}건을 내보냄', flush=True)
                    await self._drain()
                await asyncio.sleep(0.02)
        finally:
            await self.server.stop()

    def subscribed(self) -> bool:
        """공장 객체의 이벤트를 구독한 클라이언트가 있는가.
        asyncua 내부 구조(2.1)를 읽는다. 구조가 바뀌어 못 읽으면 있다고 보고 쌓지 않는다"""
        try:
            subs = self.server.iserver.subscription_service.subscriptions.values()
            return any(self.plant in s.monitored_item_srv._monitored_events for s in subs)
        except AttributeError:
            return True

    async def _build(self) -> Server:
        server = Server()
        await server.init()
        server.set_endpoint(self.endpoint)
        server.set_server_name('LumiTwin 가상 PLC (시뮬레이터)')
        server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
        idx = await server.register_namespace(NS_URI)
        self.idx = idx

        state_type = await server.create_custom_event_type(idx, STATE_EVENT, ua.ObjectIds.BaseEventType, STATE_PROPS)
        unit_type = await server.create_custom_event_type(idx, UNIT_EVENT, ua.ObjectIds.BaseEventType, UNIT_PROPS)

        plant = await server.nodes.objects.add_object(ua.NodeId(PLANT, idx), ua.QualifiedName(PLANT, idx))
        await _describe(plant, 'LumiTwin 가상 스마트공장 (램프·전장)')
        self.plant = plant.nodeid
        for ln in self.factory['lines']:
            line = await plant.add_object(ua.NodeId(ln['code'], idx), ua.QualifiedName(ln['code'], idx))
            await _describe(line, ln['name'])
            for sd in ln['stations']:
                code = sd['code']
                st = await line.add_object(ua.NodeId(code, idx), ua.QualifiedName(code, idx))
                await _describe(st, sd['name'])
                nodes = StationNodes(
                    line=ln['code'],
                    obj=st.nodeid,
                    state=(await st.add_variable(ua.NodeId(f'{code}.State', idx), ua.QualifiedName('State', idx), '', ua.VariantType.String)).nodeid,
                    reason=(await st.add_variable(ua.NodeId(f'{code}.StateReason', idx), ua.QualifiedName('StateReason', idx), '', ua.VariantType.String)).nodeid,
                    good=(await st.add_variable(ua.NodeId(f'{code}.GoodCount', idx), ua.QualifiedName('GoodCount', idx), 0, ua.VariantType.UInt32)).nodeid,
                    bad=(await st.add_variable(ua.NodeId(f'{code}.BadCount', idx), ua.QualifiedName('BadCount', idx), 0, ua.VariantType.UInt32)).nodeid,
                )
                tags = await st.add_folder(ua.NodeId(f'{code}.Tags', idx), ua.QualifiedName('Tags', idx))
                for td in sd['tags']:
                    var = await tags.add_variable(
                        ua.NodeId(f'{code}.Tags.{td["key"]}', idx), ua.QualifiedName(td['key'], idx), 0.0, ua.VariantType.Double
                    )
                    await _describe(var, td['name'])
                    if td.get('unit'):
                        eu = ua.EUInformation(
                            NamespaceUri='http://www.opcfoundation.org/UA/units/un/cefact',
                            UnitId=-1,
                            DisplayName=ua.LocalizedText(td['unit']),
                            Description=ua.LocalizedText(td['unit']),
                        )
                        await var.add_property(
                            ua.NodeId(f'{code}.Tags.{td["key"]}.EngineeringUnits', idx),
                            'EngineeringUnits',
                            eu,
                            datatype=ua.NodeId(ua.ObjectIds.EUInformation),
                        )
                    nodes.tags[td['key']] = var.nodeid
                self.stations[code] = nodes
                if sd.get('gate'):
                    self.hs[('ilk', code)] = await self._hs_block(
                        st, idx, f'{code}.{ILK_BLOCK}', ILK_BLOCK, 'ilk', ln['code'], code,
                        '공정 인터록 핸드셰이크: 투입 확인 요청(ReqSeq·ReqData) → MES 판정(ResSeq·ResData)',
                    )
            if ln.get('release'):
                self.hs[('wo', ln['code'])] = await self._hs_block(
                    line, idx, f'{ln["code"]}.{WO_BLOCK}', WO_BLOCK, 'wo', ln['code'], None,
                    '작업지시 핸드셰이크: 다음 작업지시 요청(ReqSeq·ReqData) → MES 작업지시(ResSeq·ResData)',
                )

        # 아직 시뮬레이터가 쓰지 않은 값은 "초기값 기다리는 중"으로 둔다
        for nodes in self.stations.values():
            for nid in nodes.tags.values():
                await server.write_attribute_value(nid, _waiting(ua.VariantType.Double))
            await server.write_attribute_value(nodes.state, _waiting(ua.VariantType.String))

        self.state_gen = await server.get_event_generator(state_type, plant)
        self.unit_gen = await server.get_event_generator(unit_type, plant)
        return server

    async def _hs_block(self, parent, idx: int, nid: str, name: str, kind: str, line: str, station: str | None,
                        text: str) -> HsNodes:
        """핸드셰이크 블록 폴더와 네 변수. 요청 쪽은 클라이언트가 읽기만, 응답 쪽은 클라이언트(엣지)가 쓸 수 있다"""
        folder = await parent.add_folder(ua.NodeId(nid, idx), ua.QualifiedName(name, idx))
        await _describe(folder, text)

        async def var(key: str, value, vtype: ua.VariantType, desc: str, writable: bool):
            v = await folder.add_variable(ua.NodeId(f'{nid}.{key}', idx), ua.QualifiedName(key, idx), value, vtype)
            await _describe(v, desc)
            if writable:
                await v.set_writable()
            return v.nodeid

        return HsNodes(
            kind=kind, line=line, station=station,
            req_seq=await var(HS_REQ_SEQ, 0, ua.VariantType.UInt32, '요청 번호 (PLC가 새 요청마다 1 올린다. 0 = 요청 없음)', False),
            req_data=await var(HS_REQ_DATA, '', ua.VariantType.String, '요청 데이터 (JSON)', False),
            res_seq=await var(HS_RES_SEQ, 0, ua.VariantType.UInt32, '응답 번호 (엣지가 응답을 쓰면 요청 번호와 같아진다)', True),
            res_data=await var(HS_RES_DATA, '', ua.VariantType.String, '응답 데이터 (JSON, MES 판정)', True),
        )

    async def _drain(self) -> None:
        for _ in range(DRAIN_MAX):
            try:
                kind, code, msg, posted = self.inbox.get_nowait()
            except queue.Empty:
                return
            if kind in REQ_KINDS:
                try:
                    await self._request(kind, code, msg, posted)
                except Exception:
                    log.exception('[plc] %s %s 요청 쓰기 실패', code, kind)
                continue
            st = self.stations.get(code)
            if st is None:
                self._warn_once(code, f'[plc] 주소 공간에 없는 설비: {code}')
                continue
            try:
                if kind == 'tags':
                    await self._tags(code, st, msg)
                elif kind == 'state':
                    await self._state(code, st, msg)
                elif kind == 'unit':
                    await self._unit(code, st, msg)
            except Exception:
                log.exception('[plc] %s %s 처리 실패', code, kind)

    def _warn_once(self, key: str, text: str) -> None:
        if key not in self._warned:
            self._warned.add(key)
            print(text, flush=True)

    async def _write(self, nid: ua.NodeId, value, vtype: ua.VariantType, ts: datetime) -> None:
        await self.server.write_attribute_value(nid, _dv(value, vtype, ts))
        self.written += 1

    async def _set_state(self, st: StationNodes, state: str, reason: str, ts: datetime) -> None:
        if reason != st.cur_reason:
            st.cur_reason = reason
            await self._write(st.reason, reason, ua.VariantType.String, ts)
        if state != st.cur_state:
            st.cur_state = state
            await self._write(st.state, state, ua.VariantType.String, ts)

    async def _tags(self, code: str, st: StationNodes, msg: dict) -> None:
        ts = parse_iso(msg['t'])
        for key, v in msg['v'].items():
            nid = st.tags.get(key)
            if nid is None:
                self._warn_once(f'{code}.{key}', f'[plc] 주소 공간에 없는 태그: {code}.{key}')
                continue
            await self._write(nid, float(v), ua.VariantType.Double, ts)
        # 시뮬레이터는 매 틱 현재 상태도 싣는다. 처음 상태(이벤트가 아직 없을 때)를 여기서 맞춘다
        s = msg.get('s')
        if s and s != st.cur_state:
            await self._set_state(st, s, msg.get('r') or '', ts)

    async def _state(self, code: str, st: StationNodes, msg: dict) -> None:
        ts = parse_iso(msg['t'])
        state, reason = msg['state'], msg.get('reason') or ''
        await self._set_state(st, state, reason, ts)
        ev = self.state_gen.event
        ev.SourceNode = st.obj
        ev.SourceName = code
        ev.Severity = SEVERITY.get(state, 100)
        ev.Line, ev.Station, ev.State, ev.Reason = st.line, code, state, reason
        await self.state_gen.trigger(time_attr=ts, message=f'{code} {state}' + (f' · {reason}' if reason else ''))
        self.events += 1

    async def _unit(self, code: str, st: StationNodes, msg: dict) -> None:
        ts = parse_iso(msg['t'])
        ok = msg.get('result') == 'OK'
        if ok:
            st.n_good += 1
            await self._write(st.good, st.n_good, ua.VariantType.UInt32, ts)
        else:
            st.n_bad += 1
            await self._write(st.bad, st.n_bad, ua.VariantType.UInt32, ts)
        st.seq += 1
        ev = self.unit_gen.event
        ev.SourceNode = st.obj
        ev.SourceName = code
        ev.Severity = 100 if ok else 400
        ev.Line, ev.Station = st.line, code
        ev.Serial, ev.Result, ev.Defect = msg.get('serial', ''), msg.get('result', ''), msg.get('defect') or ''
        ev.Seq = st.seq
        ev.Record = json.dumps(msg, ensure_ascii=False, separators=(',', ':'))
        await self.unit_gen.trigger(time_attr=ts, message=f'{code} {ev.Serial} {ev.Result}')
        self.events += 1

    # ── MES 핸드셰이크 ──
    async def _request(self, kind: str, key: str, msg: dict, posted: float) -> None:
        """요청 데이터를 먼저, 요청 번호를 나중에 쓴다. 엣지는 번호가 바뀐 것을 보고 데이터를 읽는다"""
        blk = self.hs.get((kind, key))
        if blk is None:
            self._warn_once(f'hs:{kind}:{key}', f'[plc] 핸드셰이크 블록이 없는 {kind} 요청: {key}')
            return
        if time.monotonic() - posted > self.req_stale_sec:
            # 엣지가 없던 동안 쌓인 요청: 설비는 이미 시간 초과로 넘어갔다. 지금 쓰면 엣지가 지난 요청을 MES에 묻는다
            self.stale += 1
            self._warn_once('hs:stale', '[plc] 엣지가 없는 동안 쌓인 MES 요청은 늦어서 버림 (설비는 응답 시간 초과로 처리)')
            return
        ts = parse_iso(msg['t']) if msg.get('t') else datetime.now(timezone.utc)
        seq = next_seq(blk.seq)
        await self._write(blk.req_data, json.dumps(msg, ensure_ascii=False, separators=(',', ':')), ua.VariantType.String, ts)
        await self._write(blk.req_seq, seq, ua.VariantType.UInt32, ts)
        blk.seq, blk.rid = seq, str(msg.get('reqId') or '')
        self.requests += 1

    def _poll_replies(self) -> None:
        """응답을 기다리는 블록의 ResSeq를 본다 (주소 공간을 바로 읽어 가볍다).
        ResSeq == ReqSeq이면 ResData를 읽어 시뮬레이터 명령 큐로 넘긴다 (MQTT로 받은 응답과 같은 모양).
        지난 요청 번호로 온 응답은 PLC가 이미 다음 요청으로 넘어간 것이라 받지 않는다"""
        for blk in self.hs.values():
            if blk.acked == blk.seq:
                continue
            try:
                dv = self.server.read_attribute_value(blk.res_seq)
                if dv.Value is None or dv.Value.Value != blk.seq:
                    continue
                blk.acked = blk.seq
                raw = self.server.read_attribute_value(blk.res_data).Value.Value
                msg = json.loads(raw) if raw else None
            except (ValueError, TypeError, AttributeError):
                self._warn_once(f'hs:bad:{blk.res_topic}', f'[plc] 읽을 수 없는 MES 응답: {blk.res_topic}')
                continue
            if isinstance(msg, dict):
                self.answers += 1
                self.sink.put({'action': REPLY_ACTION, 'topic': blk.res_topic, 'msg': msg})


class PlcIO:
    """시뮬레이터의 io 자리에 끼우는 분배기: 설비 토픽과 MES 요청은 가상 PLC(OPC UA)로, 나머지는 MQTT로 바로 보낸다.

    MES 응답(인터록·작업지시)은 MQTT로 직접 받지 않고, 엣지가 PLC 핸드셰이크 태그에 써 준 것을
    PLC가 명령 큐(cmds)에 넣는다. 엔진은 MQTT 경로와 같은 모양의 응답을 받는다.
    """

    link = 'opcua'

    def __init__(self, mqtt_io, plc: PlcServer):
        self.mqtt = mqtt_io
        self.plc = plc
        self.cmds = mqtt_io.cmds
        plc.sink = self.cmds
        stop = getattr(mqtt_io, 'stop_replies', None)
        if stop is not None:
            stop()

    def publish(self, topic: str, obj: dict, qos: int = 0) -> None:
        parts = topic.split('/')
        if len(parts) == 5 and parts[4] in STATION_KINDS:  # lt/v1/{line}/{station}/{kind}
            self.plc.post(parts[4], parts[3], obj)
        elif len(parts) == 6 and parts[4] == 'ilk' and parts[5] == 'req':  # lt/v1/{line}/{station}/ilk/req
            self.plc.post('ilk', parts[3], obj)
        elif len(parts) == 5 and parts[3] == 'wo' and parts[4] == 'req':  # lt/v1/{line}/wo/req
            self.plc.post('wo', parts[2], obj)
        else:
            self.mqtt.publish(topic, obj, qos=qos)

    def close(self) -> None:
        self.plc.stop()
        self.mqtt.close()
