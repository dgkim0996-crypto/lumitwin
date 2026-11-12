// Cloudflare Tunnel로 이 PC의 화면(5180)을 인터넷에 공개한다. 쓰는 법: deploy/cloudflare/README.md
//   npm run tunnel                 빠른 터널: 계정 없이 https://<임의 이름>.trycloudflare.com 주소를 받는다 (켤 때마다 바뀜)
//   이름 붙인 터널: Cloudflare 대시보드에서 만든 터널의 토큰을 TUNNEL_TOKEN 환경 변수나 tools/cloudflared/tunnel-token.txt 에 두면 고정 주소로 붙는다
//   TUNNEL_ALLOWED_MAIL=a@x.com,*@y.com  빠른 터널을 이 메일 주소만 들어오게 막는다 (Cloudflare가 메일로 일회용 PIN을 보낸다)
// cloudflared는 바깥으로만 연결을 맺으므로 공유기 포트를 열 필요가 없다. 공개 링크로 들어온 방문자는 보기 전용이다(서버 READ_ONLY).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const target = process.env.TUNNEL_TARGET || 'http://127.0.0.1:5180';
const tokenFile = join(root, 'tools', 'cloudflared', 'tunnel-token.txt');
const token = process.env.TUNNEL_TOKEN?.trim() || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
const allowedMail = process.env.TUNNEL_ALLOWED_MAIL?.trim();

function findBinary() {
  if (process.env.CLOUDFLARED) return process.env.CLOUDFLARED;
  const local = join(root, 'tools', 'cloudflared', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  return existsSync(local) ? local : 'cloudflared';
}

/** 화면 서버가 뜰 때까지 기다린다 (npm run share에서 함께 띄울 때) */
async function waitForApp() {
  const until = Date.now() + 5 * 60_000;
  let said = false;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${target}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {
      /* 아직 안 떴다 */
    }
    if (!said) {
      console.log(`[tunnel] 화면 서버(${target})를 기다리는 중…`);
      said = true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error(`[tunnel] ${target}이(가) 5분 안에 뜨지 않았습니다. npm run build 뒤 npm run start(또는 npm run share)로 띄웠는지 확인하세요`);
  process.exit(1);
}

function banner(url) {
  const line = '─'.repeat(url.length + 4);
  console.log(`\n[tunnel] ┌${line}┐\n[tunnel] │  ${url}  │\n[tunnel] └${line}┘`);
  console.log('[tunnel] 공개 링크입니다. 방문자는 보기 전용이고, 이 PC에서 연 화면(http://localhost:5180)은 그대로 조작할 수 있습니다.');
  console.log(`[tunnel] 작업자 태블릿: ${url}/operator · 끄려면 Ctrl+C\n`);
}

await waitForApp();
const bin = findBinary();
if (!token && existsSync(join(homedir(), '.cloudflared', 'config.yaml'))) {
  console.warn('[tunnel] ~/.cloudflared/config.yaml 이 있으면 빠른 터널이 열리지 않습니다. 잠시 다른 이름으로 바꾸거나 TUNNEL_TOKEN을 쓰세요');
}
const args = token
  ? ['tunnel', '--no-autoupdate', 'run', '--token', token]
  : ['tunnel', '--no-autoupdate', '--url', target, ...(allowedMail ? ['--allowed-mail', allowedMail] : [])];
console.log(
  `[tunnel] ${token ? '이름 붙인 터널(토큰)로 연결 — 주소는 대시보드에 정한 도메인' : `빠른 터널 여는 중 (계정 없음, 주소는 켤 때마다 바뀜${allowedMail ? ` · 허용 메일 ${allowedMail}` : ''})`} → ${target}`,
);

// 터널이 실패하거나 끊겨도 이 프로세스는 살아서 다시 연다. 여기서 끝나면 npm run share(concurrently -k)가 앱까지 같이 끈다
// (빠른 터널 만들기는 Cloudflare가 잠시 429로 막기도 한다: 1분부터 10분까지 간격을 늘려 다시 시도)
let child = null;
let stopping = false;
let failures = 0;

function open() {
  let shown = false;
  const startedAt = Date.now();
  child = spawn(bin, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', (err) => {
    console.error(`[tunnel] cloudflared를 실행하지 못했습니다 (${err.message}). tools/cloudflared/ 에 실행 파일을 두세요: deploy/cloudflare/README.md`);
    process.exit(1);
  });
  const onData = (buf) => {
    const text = buf.toString();
    // 빠른 터널 주소가 나오면 크게 보여 준다. 나머지 로그는 연결·오류만 추린다
    // api.trycloudflare.com(터널을 만드는 API)은 오류 메시지에도 나오므로 빼고, 받은 주소(단어-단어-….trycloudflare.com)만 잡는다
    const m = !shown && text.match(/https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);
    if (m) {
      shown = true;
      failures = 0;
      banner(m[0]);
    }
    for (const l of text.split(/\r?\n/)) {
      if (/ERR|error|Registered tunnel connection|failed|Retrying/i.test(l)) console.log(`[tunnel] ${l.replace(/^\S+\s+/, '')}`);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    if (stopping) process.exit(0);
    // 한참 잘 돌다 끊긴 것이면 바로, 열자마자 실패한 것이면 간격을 늘려 다시 연다
    const quick = Date.now() - startedAt < 60_000;
    failures = quick ? failures + 1 : 0;
    // 너무 자주 두드리면 429가 더 길어진다: 1분 → 2분 → 4분 → … 최대 10분
    const wait = failures ? Math.min(600, 60 * 2 ** (failures - 1)) : 3;
    console.log(`[tunnel] cloudflared가 끝났습니다 (코드 ${code ?? '-'}). ${wait}초 뒤 다시 엽니다${token ? '' : ' (빠른 터널은 주소가 새로 바뀝니다)'}`);
    setTimeout(open, wait * 1000);
  });
}

open();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (child && child.exitCode == null) child.kill();
    else process.exit(0);
  });
}
