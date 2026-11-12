// README용 화면 캡처. 설치된 Edge(또는 Chrome)를 헤드리스로 띄우고 DevTools 프로토콜로 찍는다 (추가 패키지 없음)
//   먼저 npm run dev (또는 dev:opcua)로 띄우고 데이터가 좀 쌓인 뒤:
//   node scripts/screenshots.mjs                 모든 화면
//   node scripts/screenshots.mjs losses spc      고른 화면만
// 결과: docs/images/<이름>.png · 브라우저 경로는 BROWSER 환경 변수로 바꿀 수 있다
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './pyvenv.mjs';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5180';
const PORT = 9333;
const OUT = join(root, 'docs', 'images');
const CANDIDATES = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 화면 목록. actions는 페이지 안에서 돌릴 JS, ask는 AI 비서에게 할 질문,
 *  clip은 잘라 낼 범위(selector 요소의 오른쪽 fromRight px, 아래로는 until 식이 가리키는 요소 끝까지) */
const SHOTS = [
  { name: 'factory', url: '/', wait: 9000 },
  {
    name: 'data-path',
    url: '/',
    wait: 7000,
    actions: [`document.querySelector('button[title="데이터 경로"]').click()`],
    wait2: 800,
    // 헤더 오른쪽 끝에서 520px, 아래로는 열린 팝오버 끝까지
    clip: { selector: 'header', fromRight: 520, until: `document.querySelector('button[title="데이터 경로"]').parentElement.querySelector('.panel')` },
  },
  { name: 'production', url: '/production', wait: 5000 },
  { name: 'losses', url: '/losses', wait: 5000 },
  { name: 'spc', url: '/spc', wait: 5000 },
  { name: 'quality', url: '/quality', wait: 6000 },
  { name: 'trace', url: '/trace', wait: 5000 },
  { name: 'assistant', url: '/losses', wait: 5000, ask: 'OEE가 왜 낮아? 6대 로스로 보여 줘', wait2: 7000 },
  { name: 'operator', url: '/operator/HL-VM-01', wait: 5000, size: [1180, 820] },
];

function findBrowser() {
  const b = CANDIDATES.find((p) => existsSync(p));
  if (!b) throw new Error('Edge·Chrome을 찾지 못했습니다. BROWSER 환경 변수로 실행 파일 경로를 주세요.');
  return b;
}

async function waitJson(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error(`응답 없음: ${url}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.waiters = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message}`));
        else resolve(m.result);
      } else if (m.method) {
        this.waiters = this.waiters.filter((w) => !(w.method === m.method && (w.resolve(m.params), true)));
      }
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', fail, { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  once(method, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const w = { method, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`${method} 대기 시간 초과`));
      }, timeout);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

async function shoot(cdp, s) {
  const [width, height] = s.size ?? [1440, 900];
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: BASE + s.url });
  await loaded;
  await sleep(s.wait ?? 4000);
  for (const a of s.actions ?? []) await cdp.eval(a);
  if (s.ask) {
    await cdp.eval(`document.querySelector('button[title^="AI 현장 비서"]').click()`);
    await sleep(800);
    await cdp.eval(`(() => { const t = document.querySelector('aside textarea, textarea'); t.focus(); return !!t; })()`);
    await cdp.send('Input.insertText', { text: s.ask });
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
  }
  if (s.wait2) await sleep(s.wait2);
  let clip;
  if (s.clip) {
    const r = await cdp.eval(`(() => {
      const b = document.querySelector(${JSON.stringify(s.clip.selector)}).getBoundingClientRect();
      const u = ${s.clip.until ?? 'null'};
      return { x: b.x, y: b.y, w: b.width, bottom: Math.max(b.bottom, u ? u.getBoundingClientRect().bottom : 0) };
    })()`);
    clip = { x: Math.max(0, r.x + r.w - s.clip.fromRight), y: r.y, width: s.clip.fromRight, height: r.bottom - r.y + 12, scale: 1 };
  }
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip && { clip }) });
  const file = join(OUT, `${s.name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`[shot] ${s.name}.png ${clip ? `${clip.width}×${Math.round(clip.height)}` : `${width}×${height}`}`);
}

async function main() {
  const only = process.argv.slice(2);
  const shots = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
  if (!shots.length) throw new Error(`화면 이름: ${SHOTS.map((s) => s.name).join(', ')}`);
  await waitJson(`${BASE.replace(/\/$/, '')}/api/v1/access`, 5).catch(() => {
    throw new Error(`${BASE} 에 화면이 떠 있지 않습니다 (npm run dev 먼저)`);
  });
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'lumitwin-shot-'));
  const browser = spawn(
    findBrowser(),
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1440,900',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=ko-KR',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  try {
    await waitJson(`http://127.0.0.1:${PORT}/json/version`);
    const page = (await waitJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page');
    const cdp = await Cdp.open(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 화면은 어두운 테마가 기본이다. 시스템 설정과 무관하게 같은 결과가 나오게 고정한다
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    for (const s of shots) {
      try {
        await shoot(cdp, s);
      } catch (e) {
        console.error(`[shot] ${s.name} 실패: ${e.message}`);
        process.exitCode = 1;
      }
    }
    cdp.ws.close();
  } finally {
    browser.kill();
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((e) => {
  console.error(`[shot] ${e.message}`);
  process.exit(1);
});
