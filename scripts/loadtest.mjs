// 장시간·부하 측정. 앱을 띄운 상태(npm run dev 또는 npm start)에서 돌린다. 추가 패키지 없음.
//   node scripts/loadtest.mjs                        10분 관찰 + API 30초 부하 (사용자 20명)
//   node scripts/loadtest.mjs --minutes 30 --users 50 --api-seconds 60 --speed 60 --out docs/perf/run.json
// 재는 것
//   1) MQTT: 브로커에 오가는 메시지를 엿들어 초당 건수(종류별), 인터록·작업지시 요청→응답 시간(같은 reqId)
//   2) 시뮬레이터가 배속을 따라가는가 (가상 시간 진행 ÷ 실제 시간 ÷ 배속)
//   3) MES: 받은 메시지 수, DB 기록 큐(밀림·버림), 서버 프로세스 메모리, DB 크기·표 행 수
//   4) 조회 API: 동시 사용자 N명이 화면 조회 API를 번갈아 부를 때 응답 시간 p50·p95·p99, 오류
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { subscribe } from './lib/mqtt-lite.mjs';
import { root } from './pyvenv.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const MINUTES = Number(arg('--minutes', 10));
const USERS = Number(arg('--users', 20));
const API_SEC = Number(arg('--api-seconds', 30));
const SPEED = arg('--speed', null);
const OUT = arg('--out', null);
const BASE = (process.env.LT_BASE ?? 'http://localhost:8790').replace(/\/$/, '') + '/api/v1';
const MQTT_PORT = Number(process.env.MQTT_PORT ?? 1884);
const DB_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:54332/lumitwin';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

let cookie = '';
async function call(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** 서버 프로세스 메모리 (MB): API 포트를 잡고 있는 프로세스의 작업 집합 */
function serverMemMb() {
  const port = new URL(BASE).port || '8790';
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1).OwningProcess).WorkingSet64`], { encoding: 'utf8' });
    const n = Number(r.stdout.trim());
    return Number.isFinite(n) && n > 0 ? Math.round(n / 1048576) : null;
  }
  const r = spawnSync('sh', ['-c', `ss -ltnp 'sport = :${port}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 | xargs -I{} grep VmRSS /proc/{}/status`], { encoding: 'utf8' });
  const kb = Number(r.stdout.replace(/\D+/g, ' ').trim().split(' ')[0]);
  return kb ? Math.round(kb / 1024) : null;
}

async function dbStats() {
  try {
    const require = createRequire(join(root, 'server', 'package.json'));
    const { Client } = require('pg');
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    const size = (await c.query('select pg_database_size(current_database()) as b')).rows[0].b;
    const tables = ['process_record', 'production_unit', 'material_lot_use', 'state_event', 'alarm', 'work_order', 'interlock_log', 'ncr', 'hold', 'change_point', 'inspection', 'health_sample', 'action_log'];
    const rows = {};
    for (const t of tables) {
      try {
        rows[t] = Number((await c.query(`select count(*)::bigint as n from ${t}`)).rows[0].n);
      } catch {
        rows[t] = null;
      }
    }
    await c.end();
    return { sizeMb: Math.round(Number(size) / 1048576), rows };
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  const started = new Date();
  console.log(`[load] ${BASE} · 관찰 ${MINUTES}분 · API 부하 ${USERS}명 × ${API_SEC}초`);
  const first = await call('/sim/status');
  if (first.status !== 200) throw new Error(`MES가 응답하지 않습니다 (${first.status}). npm run dev 먼저`);
  if (SPEED) {
    const pw = process.env.DEMO_PASSWORD ?? 'demo1234';
    await call('/auth/login', { method: 'POST', body: JSON.stringify({ login: 'lead1', password: pw }) }).catch(() => null);
    const r = await call('/sim/speed', { method: 'POST', body: JSON.stringify({ speed: Number(SPEED) }) });
    console.log(`[load] 배속 ${SPEED}× 요청 → ${r.status}`);
  }

  // 1) MQTT 엿듣기
  const counts = {};
  const pending = new Map();
  const lat = { ilk: [], wo: [] };
  const verdicts = {};
  const probe = await subscribe({
    port: MQTT_PORT,
    topics: ['lt/v1/#'],
    onMessage(topic, payload) {
      const parts = topic.split('/').slice(2);
      const kind = parts.length >= 4 && parts[2] === 'ilk' ? `ilk/${parts[3]}` : parts[1] === 'wo' ? `wo/${parts[2]}` : parts[0] === 'sim' || parts[0] === 'edge' ? `${parts[0]}/${parts[1]}` : parts[0] === 'amr' ? 'amr' : parts[parts.length - 1];
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (kind === 'ilk/req' || kind === 'wo/req' || kind === 'ilk/res' || kind === 'wo/res') {
        let m;
        try {
          m = JSON.parse(payload.toString('utf8'));
        } catch {
          return;
        }
        const key = `${kind.split('/')[0]}:${m.reqId}`;
        if (kind.endsWith('/req')) pending.set(key, performance.now());
        else {
          const t0 = pending.get(key);
          if (t0 != null) {
            lat[kind.split('/')[0]].push(performance.now() - t0);
            pending.delete(key);
          }
          if (m.verdict) verdicts[m.verdict] = (verdicts[m.verdict] ?? 0) + 1;
        }
      }
    },
  });

  // 2·3) 주기 표본
  const samples = [];
  const until = Date.now() + MINUTES * 60_000;
  let prev = null;
  while (Date.now() < until) {
    const t = Date.now();
    const st = (await call('/sim/status')).body;
    const writer = (await call('/production/writer').catch(() => ({ body: null }))).body;
    const mem = serverMemMb();
    const s = { t, simT: st?.sim?.t ?? null, speed: st?.sim?.speed ?? null, received: st?.received ?? null, writer, mem };
    if (prev && s.simT && prev.simT) {
      const vSec = (Date.parse(s.simT) - Date.parse(prev.simT)) / 1000;
      const rSec = (t - prev.t) / 1000;
      s.keepUp = s.speed ? vSec / rSec / s.speed : null;
      s.msgPerSec = s.received != null && prev.received != null ? (s.received - prev.received) / rSec : null;
    }
    samples.push(s);
    process.stdout.write(`\r[load] ${Math.round((until - Date.now()) / 1000)}초 남음 · 메모리 ${mem ?? '-'}MB · 수신 ${r1(s.msgPerSec) ?? '-'}/초 · 배속 추종 ${s.keepUp ? `${Math.round(s.keepUp * 100)}%` : '-'}   `);
    prev = s;
    await sleep(5000);
  }
  process.stdout.write('\n');

  // 4) 조회 API 부하
  const endpoints = ['/live/snapshot', '/production/units?limit=50', '/production/defects', '/live/losses', '/maintenance', '/live/spc', '/orders', '/ncr', '/changes', '/reports/shifts', '/energy', '/maintenance/health'];
  const apiLat = {};
  const apiErr = {};
  const apiEnd = Date.now() + API_SEC * 1000;
  await Promise.all(
    Array.from({ length: USERS }, async (_, u) => {
      let i = u;
      while (Date.now() < apiEnd) {
        const ep = endpoints[i++ % endpoints.length];
        const t0 = performance.now();
        try {
          const r = await fetch(BASE + ep);
          await r.arrayBuffer();
          (apiLat[ep] ??= []).push(performance.now() - t0);
          if (!r.ok) apiErr[ep] = (apiErr[ep] ?? 0) + 1;
        } catch {
          apiErr[ep] = (apiErr[ep] ?? 0) + 1;
        }
      }
    }),
  );
  probe.close();
  const db = await dbStats();

  const keep = samples.map((s) => s.keepUp).filter((x) => x != null);
  const rate = samples.map((s) => s.msgPerSec).filter((x) => x != null);
  const mems = samples.map((s) => s.mem).filter((x) => x != null);
  const allApi = Object.values(apiLat).flat();
  const elapsedSec = MINUTES * 60;
  const report = {
    startedAt: started.toISOString(),
    minutes: MINUTES,
    speed: samples.at(-1)?.speed ?? null,
    mqtt: {
      perSec: Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, r1(n / elapsedSec)])),
      interlock: { n: lat.ilk.length, p50: r1(pct(lat.ilk, 50)), p95: r1(pct(lat.ilk, 95)), p99: r1(pct(lat.ilk, 99)), max: r1(Math.max(0, ...lat.ilk)), unanswered: [...pending.keys()].filter((k) => k.startsWith('ilk:')).length, verdicts },
      workOrder: { n: lat.wo.length, p50: r1(pct(lat.wo, 50)), p95: r1(pct(lat.wo, 95)) },
    },
    sim: { keepUpMin: keep.length ? r1(Math.min(...keep) * 100) : null, keepUpAvg: keep.length ? r1((keep.reduce((a, b) => a + b, 0) / keep.length) * 100) : null },
    mes: {
      inboundPerSecAvg: rate.length ? r1(rate.reduce((a, b) => a + b, 0) / rate.length) : null,
      memMbStart: mems[0] ?? null,
      memMbEnd: mems.at(-1) ?? null,
      memMbMax: mems.length ? Math.max(...mems) : null,
      writerEnd: samples.at(-1)?.writer ?? null,
    },
    db,
    api: {
      users: USERS,
      seconds: API_SEC,
      requests: allApi.length,
      rps: r1(allApi.length / API_SEC),
      p50: r1(pct(allApi, 50)),
      p95: r1(pct(allApi, 95)),
      p99: r1(pct(allApi, 99)),
      errors: apiErr,
      byEndpoint: Object.fromEntries(Object.entries(apiLat).map(([k, xs]) => [k, { n: xs.length, p50: r1(pct(xs, 50)), p95: r1(pct(xs, 95)) }])),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (OUT) {
    const file = join(root, OUT);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
    console.log(`[load] 저장: ${OUT}`);
  }
}

main().catch((e) => {
  console.error(`[load] ${e.message}`);
  process.exit(1);
});
