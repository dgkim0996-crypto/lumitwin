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


T_STATUS = f'{ROOT}/sim/status'
T_EVENT = f'{ROOT}/sim/event'


class MqttIO:
    """paho-mqtt 래퍼. 연결이 끊기면 저절로 다시 붙고, 그동안 보내는 메시지는 버린다(실시간 값이라 늦게 보내도 쓸모없다)."""

    def __init__(self, host: str, port: int, client_id: str = 'lumisim'):
        self.host, self.port = host, port
        self.cmds: queue.Queue = queue.Queue()
        self.connected = False
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
        client.subscribe(CMD_TOPIC, qos=1)
        print(f'[sim] MQTT 연결됨 · {self.host}:{self.port}', flush=True)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        if self.connected:
            print('[sim] MQTT 연결 끊김 · 다시 붙는 중', flush=True)
        self.connected = False

    def _on_message(self, client, userdata, msg):
        try:
            self.cmds.put(json.loads(msg.payload.decode('utf-8')))
        except (ValueError, UnicodeDecodeError):
            print(f'[sim] 명령 형식 오류: {msg.payload[:80]!r}', flush=True)

    def publish(self, topic: str, obj: dict, qos: int = 0) -> None:
        if not self.connected:
            return
        self.client.publish(topic, json.dumps(obj, ensure_ascii=False, separators=(',', ':')), qos=qos)

    def close(self) -> None:
        self.client.loop_stop()
        self.client.disconnect()
