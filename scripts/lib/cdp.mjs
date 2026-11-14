// 헤드리스 Edge·Chrome을 DevTools 프로토콜로 다루는 공용 코드 (화면 캡처·E2E 시험이 같이 쓴다, 추가 패키지 없음)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export function findBrowser() {
  const b = CANDIDATES.find((p) => existsSync(p));
  if (!b) throw new Error('Edge·Chrome을 찾지 못했습니다. BROWSER 환경 변수로 실행 파일 경로를 주세요.');
  return b;
}

export async function waitJson(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error(`응답 없음: ${url}`);
}

/** 브라우저가 고른 디버깅 포트. 고정 포트를 쓰면 지난번에 덜 닫힌 브라우저에 붙어 그 탭의 대화·상태가 섞여 찍힌다 */
export async function devtoolsPort(profile, tries = 100) {
  const file = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < tries; i++) {
    try {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0]);
      if (port > 0) return port;
    } catch {}
    await sleep(100);
  }
  throw new Error('브라우저 디버깅 포트를 알아내지 못했습니다');
}

/**
 * 브라우저를 닫는다. 실행 파일 프로세스만 죽이면 Windows에서는 렌더러·GPU 프로세스가 남아 프로필 폴더를 잡고 있으므로,
 * 먼저 DevTools의 Browser.close로 정상 종료시키고, 3초 안에 안 끝나면 프로세스 트리째 강제로 닫는다
 */
export async function closeBrowser(child, wsUrl) {
  let closed = !wsUrl;
  if (wsUrl) {
    try {
      const cdp = await Cdp.open(wsUrl);
      cdp.send('Browser.close').catch(() => {});
    } catch {}
    // 디버깅 포트가 닫히면 브라우저가 끝난 것이다
    const version = wsUrl.replace(/^ws/, 'http').replace(/\/devtools\/.*$/, '/json/version');
    for (let i = 0; i < 30 && !closed; i++) {
      await sleep(100);
      closed = await fetch(version).then(() => false, () => true);
    }
  }
  if (!closed || child.exitCode == null) {
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  }
  await sleep(500); // 프로필 폴더의 파일 잠금이 풀리길 기다린다
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.waiters = [];
    this.listeners = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message}`));
        else resolve(m.result);
      } else if (m.method) {
        this.waiters = this.waiters.filter((w) => !(w.method === m.method && (w.resolve(m.params), true)));
        for (const l of this.listeners) if (l.method === m.method) l.fn(m.params);
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
  /** 이벤트를 계속 받는다 (콘솔 오류 모으기 등). 되돌려 준 함수를 부르면 그만 받는다 */
  on(method, fn) {
    const l = { method, fn };
    this.listeners.push(l);
    return () => (this.listeners = this.listeners.filter((x) => x !== l));
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


/**
 * 헤드리스 브라우저를 띄우고 첫 탭에 붙는다. 끝나면 반드시 close()를 부른다 (프로필 폴더까지 지운다)
 * @returns {Promise<{ cdp: Cdp, close: () => Promise<void> }>}
 */
export async function launch({ size = [1440, 900], prefix = 'lumitwin-cdp-' } = {}) {
  const profile = mkdtempSync(join(tmpdir(), prefix));
  const browser = spawn(
    findBrowser(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${size[0]},${size[1]}`,
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=ko-KR',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let browserWs = null;
  const close = async () => {
    await closeBrowser(browser, browserWs);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  };
  try {
    const port = await devtoolsPort(profile);
    browserWs = (await waitJson(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl;
    const page = (await waitJson(`http://127.0.0.1:${port}/json/list`)).find((t) => t.type === 'page');
    const cdp = await Cdp.open(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 화면은 어두운 테마가 기본이다. 시스템 설정과 무관하게 같은 결과가 나오게 고정한다
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    return { cdp, close: async () => (cdp.ws.close(), close()) };
  } catch (e) {
    await close();
    throw e;
  }
}
