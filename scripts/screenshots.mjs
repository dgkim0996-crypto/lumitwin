// README용 화면 캡처. 설치된 Edge(또는 Chrome)를 헤드리스로 띄우고 DevTools 프로토콜로 찍는다 (추가 패키지 없음)
//   먼저 npm run dev (또는 dev:opcua)로 띄우고 데이터가 좀 쌓인 뒤:
//   node scripts/screenshots.mjs                 모든 화면
//   node scripts/screenshots.mjs losses spc      고른 화면만
// 결과: docs/images/<이름>.png · 브라우저 경로는 BROWSER 환경 변수로 바꿀 수 있다
//   아무 주소나 한 장 (모델 확인용, docs/images에 넣지 않음):
//   node scripts/screenshots.mjs --url "/dev/machines?group=smt" --out C:/tmp/smt.png [--wait 6000] [--size 1600x1000]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep, waitJson } from './lib/cdp.mjs';
import { root } from './pyvenv.mjs';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5180';
const OUT = join(root, 'docs', 'images');

/** 화면 목록. actions는 페이지 안에서 돌릴 JS, ask는 AI 비서에게 할 질문,
 *  clip은 잘라 낼 범위(selector 요소의 오른쪽 fromRight px, 아래로는 until 식이 가리키는 요소 끝까지) */
const SHOTS = [
  // 로그인 화면은 로그아웃 상태로 먼저 찍고, 나머지는 조장(lead1)으로 로그인한 화면을 찍는다 (as)
  { name: 'login', url: '/login', wait: 3000, as: null },
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
  { name: 'maintenance', url: '/maintenance', wait: 5000 },
  { name: 'spc', url: '/spc', wait: 5000 },
  { name: 'quality', url: '/quality', wait: 6000 },
  { name: 'trace', url: '/trace', wait: 5000 },
  { name: 'assistant', url: '/losses', wait: 5000, ask: 'OEE가 왜 낮아? 6대 로스로 보여 줘', wait2: 7000 },
  { name: 'operator', url: '/operator/HL-VM-01', wait: 5000, size: [1180, 820] },
  // P9 실행 MES
  { name: 'orders', url: '/orders', wait: 5000 },
  { name: 'ncr', url: '/ncr', wait: 5000, as: 'qa1' },
  { name: 'changes', url: '/changes', wait: 5000, as: 'qa1' },
  { name: 'control-plan', url: '/control-plan', wait: 5000 },
  { name: 'reports', url: '/reports', wait: 6000 },
  { name: 'energy', url: '/energy', wait: 6000 },
  { name: 'audit', url: '/audit', wait: 5000, as: 'admin' },
];

const DEFAULT_AS = 'lead1';
const PW = process.env.DEMO_PASSWORD ?? 'demo1234';
let current;

/** 찍기 전에 그 계정으로 (null이면 로그아웃). 같은 주소의 화면에서 API를 불러 브라우저 쿠키를 바꾼다 */
async function signIn(cdp, who) {
  if (current === who) return;
  const href = await cdp.eval('location.href');
  if (!String(href).startsWith(BASE)) {
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: BASE + '/login' });
    await loaded;
  }
  const body = who ? JSON.stringify({ login: who, password: PW }) : null;
  const status = await cdp.eval(`fetch('/api/v1/auth/${who ? 'login' : 'logout'}', { method: 'POST', headers: { 'content-type': 'application/json' }${who ? `, body: ${JSON.stringify(body)}` : ''} }).then((r) => r.status)`);
  if (status >= 300) throw new Error(`${who ?? '로그아웃'} 실패 (${status})`);
  current = who;
}

async function shoot(cdp, s) {
  await signIn(cdp, s.as === undefined ? DEFAULT_AS : s.as);
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
  const file = s.out ?? join(OUT, `${s.name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`[shot] ${s.out ?? `${s.name}.png`} ${clip ? `${clip.width}×${Math.round(clip.height)}` : `${width}×${height}`}`);
}

/** --url 모드: 인자에서 한 장짜리 촬영 정의를 만든다 */
function adhoc(argv) {
  const get = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = get('--url');
  if (!url) return null;
  const out = get('--out');
  if (!out) throw new Error('--out <파일.png> 가 필요합니다');
  const size = get('--size')?.split('x').map(Number);
  return [{ name: out, url: url.startsWith('/') ? url : `/${url}`, out, wait: Number(get('--wait') ?? 6000), ...(size?.length === 2 && { size }) }];
}

async function main() {
  const argv = process.argv.slice(2);
  const custom = adhoc(argv);
  const shots = custom ?? (argv.length ? SHOTS.filter((s) => argv.includes(s.name)) : SHOTS);
  if (!shots.length) throw new Error(`화면 이름: ${SHOTS.map((s) => s.name).join(', ')}`);
  await waitJson(`${BASE.replace(/\/$/, '')}/api/v1/access`, 5).catch(() => {
    throw new Error(`${BASE} 에 화면이 떠 있지 않습니다 (npm run dev 먼저)`);
  });
  if (!custom) mkdirSync(OUT, { recursive: true });
  const { cdp, close } = await launch({ prefix: 'lumitwin-shot-' });
  try {
    for (const s of shots) {
      try {
        await shoot(cdp, s);
      } catch (e) {
        console.error(`[shot] ${s.name} 실패: ${e.message}`);
        process.exitCode = 1;
      }
    }
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error(`[shot] ${e.message}`);
  process.exit(1);
});
