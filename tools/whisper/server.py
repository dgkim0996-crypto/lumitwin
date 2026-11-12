"""LumiTwin 로컬 음성 인식 서버 (faster-whisper).

OpenAI 호환 POST /v1/audio/transcriptions (multipart: file, model, language, prompt, response_format)를 받아
음성을 받아쓴다. MES 서버(server/src/assistant/stt.service.ts)가 STT_BASE_URL로 이 서버를 부른다.
표준 라이브러리 HTTP 서버만 써서 faster-whisper 말고는 더 설치할 것이 없다.

환경 변수
  WHISPER_MODEL    모델 크기 또는 경로 (기본 small · tiny / base / small / medium / large-v3 / turbo)
  WHISPER_DEVICE   cpu | cuda | auto (기본 cpu. cuda는 cuBLAS·cuDNN이 깔려 있어야 한다)
  WHISPER_COMPUTE  연산 정밀도 (기본: cuda면 float16, cpu면 int8)
  WHISPER_HOST     기본 127.0.0.1 (이 PC에서만 받는다)
  WHISPER_PORT     기본 8792
모델은 처음 한 번 Hugging Face에서 내려받아 tools/whisper/.models 에 둔다.
"""

from __future__ import annotations

import io
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import av
import numpy as np
from faster_whisper import WhisperModel

HERE = Path(__file__).resolve().parent
MODEL = os.environ.get('WHISPER_MODEL', 'small')
DEVICE = os.environ.get('WHISPER_DEVICE', 'cpu')
COMPUTE = os.environ.get('WHISPER_COMPUTE') or ('float16' if DEVICE == 'cuda' else 'int8')
HOST = os.environ.get('WHISPER_HOST', '127.0.0.1')
PORT = int(os.environ.get('WHISPER_PORT', '8792'))
MAX_BYTES = 25 * 1024 * 1024  # OpenAI와 같은 25MB 한도

print(f'[whisper] 모델 {MODEL} ({DEVICE}, {COMPUTE}) 불러오는 중… 처음에는 내려받느라 오래 걸립니다', flush=True)
_t0 = time.time()
model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE, download_root=str(HERE / '.models'))
print(f'[whisper] 모델 준비 {time.time() - _t0:.1f}초', flush=True)
# 모델 하나를 여러 요청이 한꺼번에 쓰면 느려지기만 하므로 차례로 처리한다
_lock = threading.Lock()


def parse_multipart(content_type: str, body: bytes) -> tuple[dict[str, str], tuple[str, bytes] | None]:
    """multipart/form-data를 (일반 필드, (파일 이름, 내용)) 으로 나눈다"""
    m = re.search(r'boundary="?([^";]+)"?', content_type)
    if not m:
        raise ValueError('multipart boundary가 없습니다')
    delim = b'--' + m.group(1).encode('latin-1')
    fields: dict[str, str] = {}
    file: tuple[str, bytes] | None = None
    for chunk in body.split(delim)[1:]:
        if chunk.startswith(b'--'):
            break
        head, sep, data = chunk.partition(b'\r\n\r\n')
        if not sep:
            continue
        if data.endswith(b'\r\n'):
            data = data[:-2]
        headers = head.decode('utf-8', 'replace')
        name = re.search(r'\bname="([^"]*)"', headers)
        filename = re.search(r'\bfilename="([^"]*)"', headers)
        if not name:
            continue
        if filename is not None:
            file = (filename.group(1) or 'audio', data)
        else:
            fields[name.group(1)] = data.decode('utf-8', 'replace')
    return fields, file


def decode(audio: bytes, rate: int = 16_000) -> np.ndarray:
    """어떤 형식(webm/opus, ogg, m4a, wav…)이든 Whisper가 받는 16kHz 모노 float32로 바꾼다.
    faster-whisper의 decode_audio는 PyAV 새 판에서 없어진 인자를 써서, 여기서 직접 디코딩한다."""
    resampler = av.AudioResampler(format='s16', layout='mono', rate=rate)
    chunks: list[np.ndarray] = []
    with av.open(io.BytesIO(audio), mode='r') as container:
        for frame in container.decode(audio=0):
            frame.pts = None  # 브라우저 녹음의 들쭉날쭉한 시각 정보는 무시하고 이어 붙인다
            chunks.extend(f.to_ndarray() for f in resampler.resample(frame))
        chunks.extend(f.to_ndarray() for f in resampler.resample(None))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks, axis=1).reshape(-1).astype(np.float32) / 32768.0


def transcribe(audio: bytes, language: str | None, prompt: str | None) -> dict:
    samples = decode(audio)
    with _lock:
        t0 = time.time()
        # vad_filter: 앞뒤 무음을 잘라 잡음에서 문장을 지어내는 일을 줄인다
        segments, info = model.transcribe(
            samples,
            language=language or None,
            initial_prompt=prompt or None,
            vad_filter=True,
            beam_size=5,
        )
        segs = [{'start': round(s.start, 2), 'end': round(s.end, 2), 'text': s.text.strip()} for s in segments]
    return {
        'text': ' '.join(s['text'] for s in segs).strip(),
        'language': info.language,
        'duration': round(info.duration, 2),
        'segments': segs,
        'elapsed': round(time.time() - t0, 2),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = 'LumiTwinWhisper/1.0'

    def _send(self, status: int, payload: dict | str) -> None:
        if isinstance(payload, str):
            body, ctype = payload.encode('utf-8'), 'text/plain; charset=utf-8'
        else:
            body, ctype = json.dumps(payload, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8'
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send(status, {'error': {'message': message}})

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ('/health', '/'):
            self._send(200, {'ok': True, 'model': MODEL, 'device': DEVICE, 'compute': COMPUTE})
        elif self.path == '/v1/models':
            self._send(200, {'object': 'list', 'data': [{'id': MODEL, 'object': 'model'}]})
        else:
            self._error(404, f'없는 경로: {self.path}')

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split('?')[0] != '/v1/audio/transcriptions':
            return self._error(404, f'없는 경로: {self.path}')
        ctype = self.headers.get('Content-Type', '')
        length = int(self.headers.get('Content-Length') or 0)
        if not ctype.startswith('multipart/form-data'):
            return self._error(400, 'multipart/form-data로 보내야 합니다')
        if length <= 0 or length > MAX_BYTES:
            return self._error(413, '음성 파일은 25MB 이하여야 합니다')
        try:
            fields, file = parse_multipart(ctype, self.rfile.read(length))
        except ValueError as e:
            return self._error(400, str(e))
        if not file or not file[1]:
            return self._error(400, 'file 필드(음성)가 없습니다')
        try:
            result = transcribe(file[1], fields.get('language'), fields.get('prompt'))
        except Exception as e:  # 코덱을 못 읽는 파일 등
            return self._error(400, f'음성을 읽지 못했습니다: {e}')
        print(f'[whisper] {result["duration"]}초 음성 → {result["elapsed"]}초 · {result["text"][:60]}', flush=True)
        fmt = fields.get('response_format', 'json')
        if fmt == 'text':
            return self._send(200, result['text'])
        if fmt == 'verbose_json':
            return self._send(200, result)
        return self._send(200, {'text': result['text']})

    def log_message(self, format: str, *args) -> None:  # 요청마다 찍는 기본 로그는 끈다
        pass


if __name__ == '__main__':
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f'[whisper] http://{HOST}:{PORT}/v1/audio/transcriptions · server/.env 에 STT_BASE_URL=http://localhost:{PORT}', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
