// 로컬 음성 인식 서버(faster-whisper) 실행기. OpenAI 호환 POST /v1/audio/transcriptions 를 연다.
//   node scripts/whisper.mjs --setup   tools/whisper/.venv를 만들고 faster-whisper를 설치한다
//   node scripts/whisper.mjs           서버 실행 (WHISPER_MODEL=small, WHISPER_PORT=8792, 처음 한 번 모델을 내려받는다)
// server/.env 에 STT_BASE_URL=http://localhost:8792 를 넣고 MES 서버를 다시 띄우면 AI 비서의 음성 질의가 이 서버로 받아쓴다.
// 꺼 두면 화면은 브라우저 음성 인식(Web Speech API)으로 대신한다.
import { join } from 'node:path';
import { root, runInVenv, setupVenv } from './pyvenv.mjs';

const dir = join(root, 'tools', 'whisper');
const args = process.argv.slice(2);
if (args.includes('--setup')) {
  setupVenv('whisper', dir);
  process.exit(0);
}
// Windows는 기본으로 심볼릭 링크를 못 만들어 Hugging Face 캐시가 매번 경고를 찍는다(동작에는 지장 없음)
runInVenv('whisper', dir, ['server.py', ...args], { HF_HUB_DISABLE_SYMLINKS_WARNING: '1', HF_HUB_VERBOSITY: 'error' });
