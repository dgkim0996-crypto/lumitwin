"""MQTT 입출력. 토픽 규칙은 shared/src/live.ts 의 TOPICS 와 같아야 한다."""
from __future__ import annotations

import json
import queue

import paho.mqtt.client as mqtt

ROOT = 'lt/v1'
CMD_TOPIC = f'{ROOT}/cmd'


def t_tags(line: str, station: str) -> str:
    return f'{ROOT}/{line}/{station}/tags'


def t_state(line: str, station: str) -> str:
    return f'{ROOT}/{line}/{station}/state'


def t_unit(line: str, station: str) -> str:
    return f'{ROOT}/{line}/{station}/unit'


def t_amr(code: str) -> str:
    return f'{ROOT}/amr/{code}'


# ── 실행 MES (P9) ──
def t_ilk_req(line: str, station: str) -> str:
    """설비 → MES 투입 확인 요청 (인터록 게이트 설비)"""
    return f'{ROOT}/{line}/{station}/ilk/req'


def t_ilk_res(line: str, station: str) -> str:
    return f'{ROOT}/{line}/{station}/ilk/res'


def t_wo_req(line: str) -> str:
    """라인 → MES 다음 작업지시 요청"""
    return f'{ROOT}/{line}/wo/req'


def t_wo_res(line: str) -> str:
    return f'{ROOT}/{line}/wo/res'


def t_change(line: str, station: str) -> str:
    """설비 → MES 4M 변경점"""
    return f'{ROOT}/{line}/{station}/change'


def t_insp(line: str, station: str) -> str:
    """설비 → MES 초·중·종물 검사"""
    return f'{ROOT}/{line}/{station}/insp'


def t_health(line: str, station: str) -> str:
    """설비 → MES 상태 감시 신호 (진동·전류·온도)"""
    return f'{ROOT}/{line}/{station}/health'


def t_repair(line: str) -> str:
    """라인 수리대 → MES 수리·재작업 결과"""
    return f'{ROOT}/{line}/repair'


T_STATUS = f'{ROOT}/sim/status'
T_EVENT = f'{ROOT}/sim/event'
# MES가 보내는 응답 (구독 패턴)
SUB_ILK_RES = f'{ROOT}/+/+/ilk/res'
SUB_WO_RES = f'{ROOT}/+/wo/res'
# 응답은 명령과 같은 큐로 넘긴다 (도착 순서를 지키고, OPC UA 경로의 PlcIO도 같은 큐를 쓴다)
REPLY_ACTION = 'reply'


class MqttIO:
    """paho-mqtt 래퍼. 연결이 끊기면 저절로 다시 붙고, 그동안 보내는 메시지는 버린다(실시간 값이라 늦게 보내도 쓸모없다)."""

    link = 'mqtt'  # 설비 신호가 브로커로 바로 간다 (opcua_plc.PlcIO 는 'opcua')

    def __init__(self, host: str, port: int, client_id: str = 'lumisim'):
        self.host, self.port = host, port
        self.cmds: queue.Queue = queue.Queue()
        self.connected = False
        # MES 응답(인터록·작업지시)을 MQTT로 직접 받는가. OPC UA 경로에서는 PLC 태그 핸드셰이크로 받으므로 끈다
        self.replies = True
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id, clean_session=True)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message
        self.client.reconnect_delay_set(min_delay=1, max_delay=5)
        self.client.max_queued_messages_set(2000)
        self.client.connect_async(host, port, keepalive=15)
        self.client.loop_start()

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code.is_failure:
            print(f'[sim] MQTT 연결 실패: {reason_code}', flush=True)
            return
        self.connected = True
        client.subscribe([(CMD_TOPIC, 1), (SUB_ILK_RES, 1), (SUB_WO_RES, 1)] if self.replies else [(CMD_TOPIC, 1)])
        print(f'[sim] MQTT 연결됨 · {self.host}:{self.port}', flush=True)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        if self.connected:
            print('[sim] MQTT 연결 끊김 · 다시 붙는 중', flush=True)
        self.connected = False

    def _on_message(self, client, userdata, msg):
        try:
            obj = json.loads(msg.payload.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            print(f'[sim] 명령 형식 오류: {msg.payload[:80]!r}', flush=True)
            return
        if msg.topic == CMD_TOPIC:
            self.cmds.put(obj)
        elif getattr(self, 'replies', True) and isinstance(obj, dict):
            # MES 응답(인터록·작업지시): 토픽을 붙여 명령 큐로 넘긴다
            self.cmds.put({'action': REPLY_ACTION, 'topic': msg.topic, 'msg': obj})

    def stop_replies(self) -> None:
        """MES 응답을 MQTT로 직접 받지 않는다 (OPC UA 경로: 엣지가 PLC 태그로 써 주고 PlcIO가 큐에 넣는다)"""
        self.replies = False
        if self.connected:
            self.client.unsubscribe([SUB_ILK_RES, SUB_WO_RES])

    def publish(self, topic: str, obj: dict, qos: int = 0) -> None:
        if not self.connected:
            return
        self.client.publish(topic, json.dumps(obj, ensure_ascii=False, separators=(',', ':')), qos=qos)

    def close(self) -> None:
        self.client.loop_stop()
        self.client.disconnect()
