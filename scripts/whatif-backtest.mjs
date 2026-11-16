// What-if 되짚어 보기(백테스트): 지금 상태에서 '지금 계획 그대로' What-if로 앞으로 H시간의 양품 수를 예측하고,
// 실제 라이브 공장을 H시간(가상) 돌려 실측이 예측 범위(p10~p90) 안에 드는지 본다. 여러 번 되풀이해 적중률과 오차를 낸다.
//
// 실행: 서버·시뮬레이터가 떠 있을 때 (npm run dev 또는 운영 빌드)
//   node scripts/whatif-backtest.mjs --hours 2 --trials 4 --reps 10 --speed 60 [--out docs/perf/whatif-backtest.json]
// 계정: 조장 lead1 (비밀번호 DEMO_PASSWORD, 기본값은 서버와 같다)
//
// 주의: 라이브는 인터록 대기(초물 수동 판정·Hold)와 불량 대기 개체가 있지만 What-if는 없다 → 라이브가 조금 적게 나오는 쪽으로 치우칠 수 있다.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { root } from './pyvenv.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const HOURS = Number(arg('--hours', 2));
const TRIALS = Number(arg('--trials', 4));
const REPS = Number(arg('--reps', 10));
const SPEED = Number(arg('--speed', 60));
const OUT = arg('--out', null);
const BASE = (process.env.LT_BASE ?? 'http://localhost:8790').replace(/\/$/, '') + '/api/v1';
const PW = process.env.DEMO_PASSWORD ?? 'demo1234';
const LINES = ['HL', 'EM', 'OSM'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
async function call(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 300));
  return body;
}

const outputs = async () => {
  const s = await call('/live/snapshot');
  return { t: Date.parse(s.sim.t), out: Object.fromEntries(LINES.map((c) => [c, s.lines[c]?.output ?? 0])) };
};

async function trial(n) {
  // 기준 상태와 실측 시작점을 같은 가상 시각에 맞추려고 잠깐 멈춘다
  await call('/sim/pause', { method: 'POST' });
  await sleep(1500);
  const before = await outputs();
  const run = await call('/whatif/runs', {
    method: 'POST',
    body: JSON.stringify({ horizonH: HOURS, reps: REPS, base: 'live', scenarios: [{ name: '지금 계획' }] }),
  });
  await call('/sim/resume', { method: 'POST' });
  const startMs = Date.parse(run.vStartAt);
  const target = startMs + HOURS * 3600_000;
  process.stdout.write(`[시험 ${n}] What-if #${run.id} · 기준 ${run.vStartAt} · 실측 대기 (가상 ${HOURS}시간)\n`);

  // 라이브가 목표 가상 시각을 지날 때까지 기다린다 (60배속이면 2시간 = 실제 2분)
  let after = null;
  for (;;) {
    await sleep(500);
    const o = await outputs();
    if (o.t >= target) {
      after = o;
      break;
    }
  }
  let view;
  for (;;) {
    view = await call(`/whatif/runs/${run.id}`);
    if (view.status === 'DONE' || view.status === 'FAILED') break;
    await sleep(1000);
  }
  if (view.status !== 'DONE') throw new Error(`What-if #${run.id} 실패: ${view.error}`);
  const sc = view.result.scenarios[0];
  const overshootMin = (after.t - target) / 60000;
  const rows = LINES.map((c) => {
    const k = sc.lines.find((l) => l.line === c);
    // 목표 시각을 조금 지나서 쟀으면 그만큼 예측도 늘린다 (마지막 시간 칸의 기울기로 어림)
    const h = k.hourly.mean;
    const slope = h.length >= 2 ? h[h.length - 1] - h[h.length - 2] : h[0] ?? 0;
    const adj = (slope / 60) * overshootMin;
    const actual = after.out[c] - before.out[c];
    const lo = k.out.p10 + adj;
    const hi = k.out.p90 + adj;
    const mean = k.out.mean + adj;
    return { line: c, actual, mean: Math.round(mean * 10) / 10, p10: Math.round(lo * 10) / 10, p90: Math.round(hi * 10) / 10, inBand: actual >= lo && actual <= hi, errPct: mean > 0 ? Math.round(((actual - mean) / mean) * 1000) / 10 : null };
  });
  for (const r of rows) process.stdout.write(`  ${r.line.padEnd(4)} 실측 ${String(r.actual).padStart(4)} · 예측 평균 ${r.mean} (p10~p90 ${r.p10}~${r.p90}) ${r.inBand ? '범위 안' : '범위 밖'} · 오차 ${r.errPct}%\n`);
  return { id: run.id, vStartAt: run.vStartAt, overshootMin: Math.round(overshootMin * 100) / 100, computeMs: view.result.computeMs, elapsedMs: view.result.elapsedMs, rows };
}

async function main() {
  await call('/auth/login', { method: 'POST', body: JSON.stringify({ login: 'lead1', password: PW }) }).catch(() => null);
  await call('/sim/speed', { method: 'POST', body: JSON.stringify({ speed: SPEED }) });
  process.stdout.write(`What-if 되짚어 보기 · 시간 ${HOURS} · 반복 ${REPS} · 시험 ${TRIALS} · ${SPEED}배속\n`);
  const trials = [];
  for (let i = 1; i <= TRIALS; i++) trials.push(await trial(i));
  const all = trials.flatMap((t) => t.rows);
  const hit = all.filter((r) => r.inBand).length;
  const mae = all.reduce((a, r) => a + Math.abs(r.errPct ?? 0), 0) / all.length;
  const bias = all.reduce((a, r) => a + (r.errPct ?? 0), 0) / all.length;
  const summary = { hours: HOURS, reps: REPS, speed: SPEED, trials: TRIALS, cases: all.length, inBand: hit, inBandPct: Math.round((hit / all.length) * 1000) / 10, meanAbsErrPct: Math.round(mae * 10) / 10, meanErrPct: Math.round(bias * 10) / 10 };
  process.stdout.write(`\n범위 안 ${hit}/${all.length} (${summary.inBandPct}%) · 평균 절대 오차 ${summary.meanAbsErrPct}% · 평균 오차(치우침) ${summary.meanErrPct}%\n`);
  if (OUT) {
    const p = join(root, OUT);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), summary, trials }, null, 2) + '\n');
    process.stdout.write(`저장: ${OUT}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`[backtest] ${e.message}\n`);
  process.exit(1);
});
