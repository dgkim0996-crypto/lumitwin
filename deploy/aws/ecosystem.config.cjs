// LumiTwin 배포용 pm2 설정 (AWS 서버 한 대). 쓰는 법: deploy/aws/README.md
//   pm2 start deploy/aws/ecosystem.config.cjs            서버·화면·시뮬레이터
//   WHISPER=1 pm2 start deploy/aws/ecosystem.config.cjs  + 음성 받아쓰기(faster-whisper, 램 약 1GB 더)
//   EMBEDDED_DB=1 …                                       + PostgreSQL을 따로 깔지 않고 embedded-postgres로 띄움
// 모든 프로세스는 127.0.0.1에서만 받는다. 밖에는 Caddy(80·443)만 연다.
const path = require('node:path');

const CODE_DIR = process.env.CODE_DIR || path.resolve(__dirname, '..', '..');
const on = (name) => process.env[name] === '1';

const apps = [
  {
    name: 'lumitwin-server',
    // cwd는 server/: dotenv가 server/.env를 읽고, 작업표준서(../docs/standards)를 여기 기준으로 찾는다
    cwd: path.join(CODE_DIR, 'server'),
    script: 'dist/main.js',
    // MQTT 브로커·실시간 집계·AI 비서 대화·질문 한도가 프로세스 메모리에 있다. 클러스터로 늘리지 않는다
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    // 종료 신호를 받으면 DB 기록 큐를 비우고 나간다
    kill_timeout: 15_000,
    max_memory_restart: '900M',
    env: { NODE_ENV: 'production' },
  },
  {
    name: 'lumitwin-client',
    cwd: path.join(CODE_DIR, 'client'),
    // npm run start는 모든 주소로 열리므로 Next를 직접 띄워 127.0.0.1에만 연다 (workspaces라 next는 맨 위 node_modules에 있다)
    script: path.join(CODE_DIR, 'node_modules', 'next', 'dist', 'bin', 'next'),
    args: 'start -H 127.0.0.1 -p 5180',
    interpreter: 'node',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    kill_timeout: 10_000,
    max_memory_restart: '600M',
    env: { NODE_ENV: 'production' },
  },
  {
    name: 'lumitwin-sim',
    // 가상 공장(Python SimPy). sim/.venv는 npm run sim:setup 으로 만든다. MES 브로커가 늦게 떠도 시뮬레이터가 다시 붙는다
    cwd: CODE_DIR,
    script: 'scripts/sim.mjs',
    args: `--speed ${process.env.SIM_SPEED || '5'}`,
    interpreter: 'node',
    autorestart: true,
    // 다시 띄우면 새 실행(가상 시계 처음부터)이 시작된다. 너무 자주 죽으면 멈춘다
    max_restarts: 20,
    restart_delay: 3_000,
    kill_timeout: 5_000,
    env: { MQTT_HOST: '127.0.0.1', MQTT_PORT: '1884' },
  },
];

if (on('WHISPER')) {
  apps.push({
    name: 'lumitwin-whisper',
    // OpenAI 호환 받아쓰기 서버. server/.env에 STT_BASE_URL=http://127.0.0.1:8792 를 넣어야 화면이 쓴다
    cwd: CODE_DIR,
    script: 'scripts/whisper.mjs',
    interpreter: 'node',
    autorestart: true,
    restart_delay: 5_000,
    max_memory_restart: '1500M',
    env: { WHISPER_MODEL: process.env.WHISPER_MODEL || 'small', WHISPER_DEVICE: 'cpu', WHISPER_HOST: '127.0.0.1', WHISPER_PORT: '8792' },
  });
}

if (on('EMBEDDED_DB')) {
  // 시스템 PostgreSQL 대신 개발과 같은 embedded-postgres (데이터: 코드 폴더/.local-db). server/.env의 DATABASE_URL을 이 주소로 둔다
  apps.unshift({
    name: 'lumitwin-db',
    cwd: CODE_DIR,
    script: 'scripts/local-db.mjs',
    interpreter: 'node',
    autorestart: true,
    kill_timeout: 20_000,
    env: { LOCAL_DB_PORT: '54332' },
  });
}

module.exports = { apps };
