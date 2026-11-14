// 화면 E2E 시험. 앱을 띄운 상태(npm run dev)에서 헤드리스 Edge·Chrome을 DevTools 프로토콜로 움직인다 (Playwright 없이, 추가 패키지 없음).
//   node scripts/e2e.mjs              전체
//   node scripts/e2e.mjs pages auth   고른 묶음만
// 화면을 열어 오류 없이 그려지는지, 로그인·권한, 실행 MES 흐름(작업지시·불량 처리·Hold·변경점·일보)이 끝까지 도는지 본다.
// 시연 계정 비밀번호는 DEMO_PASSWORD (기본값은 서버와 같다)
import { launch, sleep, waitJson } from './lib/cdp.mjs';

const BASE = (process.env.E2E_BASE ?? 'http://localhost:5180').replace(/\/$/, '');
const PW = process.env.DEMO_PASSWORD ?? 'demo1234';

/** 시험 묶음. 각 시험은 (t) => Promise. t의 도우미는 아래 makeCtx */
const SUITES = {};
const suite = (name, tests) => (SUITES[name] = tests);

function makeCtx(cdp) {
  const errors = [];
  cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '예외'));
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') errors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' '));
  });
  const t = {
    errors,
    async goto(path, wait = 2500) {
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: BASE + path });
      await loaded;
      await sleep(wait);
    },
    eval: (js) => cdp.eval(js),
    text: () => cdp.eval('document.body.innerText'),
    /** 화면 안에서 API 부르기 (브라우저 쿠키로) */
    api: (path, init = {}) =>
      cdp.eval(`fetch('/api/v1${path}', ${JSON.stringify({ ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })})
        .then(async (r) => ({ status: r.status, body: await r.text().then((x) => { try { return JSON.parse(x); } catch { return x; } }) }))`),
    async login(login) {
      // 이미 그 계정이면 다시 로그인하지 않는다 (서버는 같은 IP의 로그인을 1분 10회로 제한한다)
      const me = await t.api('/auth/me');
      if (me.body?.user?.login === login) return me.body.user;
      let r = await t.api('/auth/login', { method: 'POST', body: JSON.stringify({ login, password: PW }) });
      if (r.status === 429) {
        console.log('    (로그인 횟수 제한: 1분 기다린 뒤 다시)');
        await sleep(61_000);
        r = await t.api('/auth/login', { method: 'POST', body: JSON.stringify({ login, password: PW }) });
      }
      if (r.status >= 300) throw new Error(`${login} 로그인 실패 ${r.status}`);
      return r.body;
    },
    logout: () => t.api('/auth/logout', { method: 'POST' }),
    /** 글자가 보이는 버튼·링크를 누른다 */
    async click(label) {
      const ok = await cdp.eval(`(() => {
        const els = [...document.querySelectorAll('button, a, [role=button], [role=menuitem]')];
        const el = els.find((e) => e.innerText.trim() === ${JSON.stringify(label)}) ?? els.find((e) => e.innerText.includes(${JSON.stringify(label)}));
        if (!el) return false;
        el.click();
        return true;
      })()`);
      if (!ok) throw new Error(`누를 것을 못 찾음: ${label}`);
      await sleep(600);
    },
    /** 버튼이 막혀 있는가 */
    disabled: (label) =>
      cdp.eval(`(() => {
        const el = [...document.querySelectorAll('button')].find((e) => e.innerText.includes(${JSON.stringify(label)}));
        return el ? el.disabled : null;
      })()`),
    expect(cond, msg) {
      if (!cond) throw new Error(msg);
    },
    async waitFor(fn, msg, timeout = 30_000) {
      const end = Date.now() + timeout;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`기다려도 안 됨: ${msg}`);
        await sleep(1000);
      }
    },
  };
  return t;
}

// ─────────────── 화면이 오류 없이 열리는가 ───────────────
const PAGES = [
  ['/', '3D 공장'],
  ['/production', '생산'],
  ['/orders', '작업지시'],
  ['/losses', '로스'],
  ['/energy', '에너지'],
  ['/reports', '일보'],
  ['/ncr', '불량'],
  ['/spc', 'SPC'],
  ['/quality', '불량'],
  ['/changes', '변경점'],
  ['/control-plan', '관리계획'],
  ['/trace', '추적'],
  ['/maintenance', '보전'],
  ['/audit', '감사'],
  ['/operator', '작업자'],
  ['/operator/HL-AS-01', 'HL-AS-01'],
  ['/login', '로그인'],
];
suite(
  'pages',
  PAGES.map(([path, word]) => ({
    name: `화면 ${path}`,
    async run(t) {
      const before = t.errors.length;
      await t.goto(path, path === '/' ? 6000 : 3000);
      const text = await t.text();
      t.expect(text.includes(word), `'${word}' 글자가 안 보임`);
      t.expect(!/Application error|Unhandled Runtime Error|404/.test(text), '오류 화면');
      const errs = t.errors.slice(before).filter((e) => !/favicon|WebGL|THREE\./.test(e));
      t.expect(!errs.length, `콘솔 오류: ${errs.slice(0, 2).join(' | ')}`);
    },
  })),
);

// ─────────────── 로그인·권한 ───────────────
suite('auth', [
  {
    name: '로그인 안 하면 쓰기 401',
    async run(t) {
      await t.goto('/login');
      await t.logout();
      const me = await t.api('/auth/me');
      t.expect(me.status === 200, `/auth/me ${me.status}`);
      if (!me.body.enabled) return; // AUTH=off면 건너뛴다
      const r = await t.api('/orders', { method: 'POST', body: JSON.stringify({ line: 'HL', variant: 'HL-VX1-L', qty: 10 }) });
      t.expect(r.status === 401, `기대 401, 받은 ${r.status}`);
    },
  },
  {
    name: '작업자는 작업지시를 못 만든다 (403)',
    async run(t) {
      await t.login('op1');
      const r = await t.api('/orders', { method: 'POST', body: JSON.stringify({ line: 'HL', variant: 'HL-VX1-L', qty: 10 }) });
      t.expect(r.status === 403, `기대 403, 받은 ${r.status}`);
    },
  },
  {
    name: '시연 계정 버튼으로 로그인',
    async run(t) {
      await t.logout();
      await t.goto('/login');
      await t.click('라인 조장');
      await sleep(1500);
      const me = await t.api('/auth/me');
      t.expect(me.body?.user?.role === 'leader', `역할 ${me.body?.user?.role}`);
    },
  },
]);

// ─────────────── 실행 MES 흐름 (시뮬레이터가 돌고 있어야 한다) ───────────────
suite('execution', [
  {
    name: '라인마다 진행 중 작업지시가 있다',
    async run(t) {
      const r = await t.waitFor(async () => {
        const x = await t.api('/orders?status=RUNNING');
        const list = Array.isArray(x.body) ? x.body : (x.body?.items ?? []);
        return new Set(list.map((w) => w.line)).size >= 3 ? list : null;
      }, '세 라인 모두 RUNNING 작업지시', 90_000);
      t.expect(r.length >= 3, '작업지시 부족');
    },
  },
  {
    name: '게이트 설비가 인터록을 묻고 MES가 판정한다',
    async run(t) {
      const r = await t.waitFor(async () => {
        const x = await t.api('/interlock');
        return x.body?.stats?.live?.ok > 0 ? x.body : null;
      }, '인터록 통과 1건 이상', 90_000);
      t.expect(r.stats.byStation.length > 0, '게이트 설비 통계가 비었음');
    },
  },
  {
    name: '작업자는 작업지시 화면에서 만들기 버튼이 막힌다',
    async run(t) {
      await t.login('op1');
      await t.goto('/orders', 3000);
      const blocked = await t.eval(`(() => {
        const els = [...document.querySelectorAll('button')].filter((e) => /만들기|추가/.test(e.innerText));
        return els.length ? els.every((e) => e.disabled) : null;
      })()`);
      t.expect(blocked !== null, '만들기 버튼을 못 찾음');
      t.expect(blocked === true, '작업자인데 만들기 버튼이 열려 있음');
    },
  },
  {
    name: '조장이 작업지시를 만들고 중단한다',
    async run(t) {
      await t.login('lead1');
      const c = await t.api('/orders', { method: 'POST', body: JSON.stringify({ line: 'OSM', variant: 'OSM-VX1-R', qty: 12 }) });
      t.expect(c.status < 300, `만들기 ${c.status} ${JSON.stringify(c.body)}`);
      const id = c.body?.id;
      const x = await t.api(`/orders/${id}/cancel`, { method: 'POST' });
      t.expect(x.status < 300, `중단 ${x.status}`);
    },
  },
  {
    name: '불량 처리(NCR)가 열리고 자동 판정된다 (기밀 시험기 이상 시나리오)',
    async run(t) {
      // 기본 불량률로는 제품 경로 불량이 드물다. 제품 경로 설비(HL-LT-01 기밀 시험기)를 흐트러뜨리는 시나리오를 잠깐 켠다
      await t.login('lead1');
      const on = await t.api('/sim/scenario', { method: 'POST', body: JSON.stringify({ id: 'HL-LEAK-GAUGE', on: true }) });
      t.expect(on.status < 300, `시나리오 켜기 ${on.status}`);
      try {
        const list = await t.waitFor(async () => {
          const x = await t.api('/ncr');
          const l = x.body?.items ?? [];
          return l.length ? l : null;
        }, 'NCR 1건 이상', 300_000);
        t.expect(list.some((n) => n.disposition || n.status === 'WAIT_MRB'), '판정이 붙은 NCR이 없음');
        const mrb = list.find((n) => n.status === 'WAIT_MRB');
        if (mrb) {
          await t.login('qa1');
          const d = await t.api(`/ncr/${mrb.id}/disposition`, { method: 'POST', body: JSON.stringify({ decision: 'SCRAP', note: 'E2E 시험 MRB 판정' }) });
          t.expect(d.status < 300, `MRB 판정 ${d.status} ${JSON.stringify(d.body)}`);
        }
      } finally {
        await t.login('lead1');
        await t.api('/sim/scenario', { method: 'POST', body: JSON.stringify({ id: 'HL-LEAK-GAUGE', on: false }) });
      }
    },
  },
  {
    name: '품질이 LOT Hold를 걸고 해제한다',
    async run(t) {
      await t.login('qa1');
      const lots = await t.api('/production/lots');
      const lot = (Array.isArray(lots.body) ? lots.body : (lots.body?.items ?? [])).find((l) => l.material && l.lot);
      t.expect(lot, '쓸 LOT가 없음');
      const h = await t.api('/holds', { method: 'POST', body: JSON.stringify({ kind: 'LOT', material: lot.material, lot: lot.lot, reason: 'E2E 시험' }) });
      t.expect(h.status < 300, `Hold ${h.status} ${JSON.stringify(h.body)}`);
      const r = await t.api(`/holds/${h.body.id}/release`, { method: 'POST', body: JSON.stringify({ result: 'RELEASE', note: 'E2E 시험 해제' }) });
      t.expect(r.status < 300, `해제 ${r.status} ${JSON.stringify(r.body)}`);
    },
  },
  {
    name: '작업자가 변경점을 신고하면 초물 대기가 생긴다',
    async run(t) {
      await t.login('op1');
      const c = await t.api('/changes', { method: 'POST', body: JSON.stringify({ station: 'HL-AS-01', category: 'METHOD', kind: 'condition', detail: 'E2E 시험 조건 변경', fa: true }) });
      t.expect(c.status < 300, `신고 ${c.status} ${JSON.stringify(c.body)}`);
      const done = await t.waitFor(async () => {
        const x = await t.api('/changes?station=HL-AS-01');
        const l = Array.isArray(x.body) ? x.body : (x.body?.items ?? []);
        const me = l.find((v) => v.id === c.body.id);
        return me && me.faStatus !== 'PENDING' ? me : null;
      }, '초물 판정', 120_000);
      t.expect(['OK', 'NG'].includes(done.faStatus), `초물 상태 ${done.faStatus}`);
    },
  },
  {
    name: '품질이 초물 대기를 수동으로 판정한다',
    async run(t) {
      await t.login('op1');
      const c = await t.api('/changes', { method: 'POST', body: JSON.stringify({ station: 'OSM-FT-01', category: 'MACHINE', kind: 'condition', detail: 'E2E 시험 지그 교체', fa: true }) });
      t.expect(c.status < 300, `신고 ${c.status} ${JSON.stringify(c.body)}`);
      await t.login('qa1');
      const m = await t.api('/quality-system/fa/OSM-FT-01', { method: 'POST', body: JSON.stringify({ result: 'OK', serial: 'E2E-CHECK', note: 'E2E 시험' }) });
      // 그 사이 시뮬레이터 초물이 먼저 판정했으면 대기가 없어 400이다. 어느 쪽이든 변경점은 판정이 끝나 있어야 한다
      t.expect(m.status < 300 || (m.status === 400 && /대기가 없습니다/.test(JSON.stringify(m.body))), `수동 판정 ${m.status} ${JSON.stringify(m.body)}`);
      const done = await t.waitFor(async () => {
        const x = await t.api('/changes?station=OSM-FT-01');
        const me = (Array.isArray(x.body) ? x.body : []).find((v) => v.id === c.body.id);
        return me && me.faStatus !== 'PENDING' ? me : null;
      }, '변경점 초물 상태 반영', 15_000);
      t.expect(done.faStatus === 'OK' || done.faStatus === 'NG', `초물 상태 ${done.faStatus}`);
    },
  },
  {
    name: '교대 일보 CSV를 받는다',
    async run(t) {
      const shifts = await t.api('/reports/shifts');
      const list = shifts.body?.shifts ?? [];
      t.expect(list.length, '교대 목록이 비었음');
      const key = list[list.length - 1].key;
      const csv = await t.eval(`fetch('/api/v1/reports/shift.csv?key=${key}').then(async (r) => ({ status: r.status, type: r.headers.get('content-type'), head: (await r.text()).slice(0, 40) }))`);
      t.expect(csv.status === 200 && /csv/.test(csv.type ?? ''), `CSV ${csv.status} ${csv.type}`);
      const rep = await t.api(`/reports/shift?key=${key}`);
      t.expect(rep.status === 200, `일보 ${rep.status}`);
    },
  },
  {
    name: '관리자는 감사 기록에서 위 조작을 본다',
    async run(t) {
      await t.login('admin');
      const a = await t.api('/audit?limit=50');
      t.expect(a.status === 200, `감사 기록 ${a.status}`);
      const l = a.body?.rows ?? [];
      t.expect(l.some((x) => /^wo./.test(x.action)), '작업지시 기록 없음');
      t.expect(l.some((x) => /hold/.test(x.action)), 'Hold 기록 없음');
    },
  },
]);

async function main() {
  const pick = process.argv.slice(2);
  const names = pick.length ? pick : Object.keys(SUITES);
  for (const n of names) if (!SUITES[n]) throw new Error(`묶음 이름: ${Object.keys(SUITES).join(', ')}`);
  await waitJson(`${BASE}/api/v1/access`, 5).catch(() => {
    throw new Error(`${BASE} 에 화면이 떠 있지 않습니다 (npm run dev 먼저)`);
  });
  const { cdp, close } = await launch({ prefix: 'lumitwin-e2e-' });
  const results = [];
  const t0 = Date.now();
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const t = makeCtx(cdp);
    await t.goto('/login', 1500); // 같은 주소의 쿠키를 쓰도록 먼저 화면을 연다
    for (const n of names) {
      for (const test of SUITES[n]) {
        const s = Date.now();
        try {
          await test.run(t);
          results.push({ suite: n, name: test.name, ok: true, ms: Date.now() - s });
          console.log(`  ✔ [${n}] ${test.name} (${((Date.now() - s) / 1000).toFixed(1)}초)`);
        } catch (e) {
          results.push({ suite: n, name: test.name, ok: false, ms: Date.now() - s, error: e.message });
          console.log(`  ✘ [${n}] ${test.name} — ${e.message}`);
        }
      }
    }
  } finally {
    await close();
  }
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n[e2e] ${results.length - fail}/${results.length} 통과 · ${((Date.now() - t0) / 1000).toFixed(0)}초`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[e2e] ${e.message}`);
  process.exit(1);
});
