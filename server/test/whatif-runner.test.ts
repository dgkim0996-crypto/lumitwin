import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { FACTORY, LINES, PM_REASON, type WhatIfSimInput } from '@lumitwin/shared';
import { aggregate } from '../src/whatif/aggregate';
import { buildBase } from '../src/whatif/base';
import { normalizeRequest } from '../src/whatif/validate';
import {
  LineSplitter,
  NO_VENV_MESSAGE,
  STDERR_TAIL,
  SimRunError,
  findSimDir,
  parseSimLine,
  resolveSimCommand,
  runSim,
  venvPython,
  workerCount,
  type SimCommand,
} from '../src/whatif/whatif.runner';

// 가짜 시뮬레이터: node -e 스크립트가 표준 입력을 읽고 줄 JSON을 낸다 (Python 없이 실행기만 확인)
const node = (script: string): SimCommand => ({ command: process.execPath, args: ['-e', script], cwd: process.cwd() });
const INPUT = { horizonSec: 3600, reps: 2, seed: 7, workers: 1, base: { source: 'clean', startAt: '2026-11-16T01:00:00.000Z', lines: {}, notes: [] }, scenarios: [] } as unknown as WhatIfSimInput;

/** 입력을 다 읽은 뒤 body를 실행 (inp = 받은 JSON) */
const withInput = (body: string) => `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const inp=JSON.parse(s);${body}});`;

describe('What-if 실행기: 줄 해석', () => {
  it('조각 경계에 걸친 줄을 잇고 CRLF를 자른다', () => {
    const sp = new LineSplitter();
    assert.deepEqual(sp.push('{"a":1}\r\n{"b"'), ['{"a":1}']);
    assert.deepEqual(sp.push(':2}\n\n{"c":'), ['{"b":2}', '']);
    assert.deepEqual(sp.push('3}'), []);
    assert.deepEqual(sp.flush(), ['{"c":3}']);
    assert.deepEqual(sp.flush(), []);
  });

  it('진행률·결과·오류만 알아보고 나머지(경고 글·깨진 JSON·모르는 type)는 버린다', () => {
    assert.deepEqual(parseSimLine('{"type":"progress","done":2,"total":10}'), { type: 'progress', done: 2, total: 10 });
    assert.deepEqual(parseSimLine(' {"type":"result","runs":[]} '), { type: 'result', runs: [] });
    assert.deepEqual(parseSimLine('{"type":"error","message":"\\uace0\\uc7a5"}'), { type: 'error', message: '고장' }, 'ensure_ascii 한글');
    assert.deepEqual(parseSimLine('{"type":"error"}'), { type: 'error', message: '알 수 없는 오류' });
    assert.equal(parseSimLine('DeprecationWarning: something'), null);
    assert.equal(parseSimLine('{"type":"progress","done":"x","total":1}'), null);
    assert.equal(parseSimLine('{"type":"result","runs":{}}'), null);
    assert.equal(parseSimLine('{"type":"hello"}'), null);
    assert.equal(parseSimLine('{broken'), null);
  });
});

describe('What-if 실행기: 자식 프로세스', () => {
  it('표준 입력 JSON을 넘기고, 진행률을 알리고, 결과를 돌려준다 (중간 잡글은 무시)', async () => {
    const script = withInput(`
      const w=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
      w({type:'progress',done:0,total:inp.reps});
      process.stdout.write('잡글 한 줄\\n');
      process.stdout.write('{"type":"progress","do');
      setTimeout(()=>{process.stdout.write('ne":1,"total":2}\\n');
        w({type:'result',runs:[{scenario:0,rep:0,seed:inp.seed,wallMs:5,stations:{},lines:{},orders:[]}]});},20);`);
    const seen: [number, number][] = [];
    const runs = await runSim(node(script), INPUT, { timeoutMs: 20_000, onProgress: (d, t) => seen.push([d, t]) });
    assert.deepEqual(seen, [[0, 2], [1, 2]]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].seed, 7, '받은 입력의 seed');
  });

  it('오류 줄을 내고 끝나면 그 메시지와 표준 오류 꼬리로 실패한다', async () => {
    const script = withInput(`process.stderr.write('Traceback: 마지막 줄\\n');process.stdout.write(JSON.stringify({type:'error',message:'설비 코드가 없습니다'})+'\\n');process.exitCode=1;`);
    await assert.rejects(runSim(node(script), INPUT, { timeoutMs: 20_000 }), (e: unknown) => {
      assert.ok(e instanceof SimRunError);
      assert.match(e.message, /^시뮬레이터 오류: 설비 코드가 없습니다\nTraceback: 마지막 줄$/);
      return true;
    });
  });

  it('결과 없이 끝나면 종료 코드를 알리고, 표준 오류는 마지막 2KB만 붙인다', async () => {
    const script = withInput(`process.stderr.write('x'.repeat(10000)+'끝');process.exit(3);`);
    await assert.rejects(runSim(node(script), INPUT, { timeoutMs: 20_000 }), (e: unknown) => {
      assert.ok(e instanceof SimRunError);
      const [head, tail] = e.message.split('\n');
      assert.equal(head, '시뮬레이터가 결과 없이 끝났습니다 (종료 코드 3)');
      assert.equal(tail.length, STDERR_TAIL);
      assert.ok(tail.endsWith('끝'));
      return true;
    });
  });

  it('시간 한도를 넘으면 끊고 "계산 시간이 너무 깁니다"로 실패한다', async () => {
    const t0 = Date.now();
    await assert.rejects(runSim(node(`setInterval(()=>{},1000);`), INPUT, { timeoutMs: 400 }), /계산 시간이 너무 깁니다 \(한도 0초\)/);
    assert.ok(Date.now() - t0 < 15_000);
  });

  it('서버가 꺼지면(abort) 자식을 끝낸다', async () => {
    const ac = new AbortController();
    const p = runSim(node(`setInterval(()=>{},1000);`), INPUT, { timeoutMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await assert.rejects(p, /서버가 꺼져/);
  });

  it('실행 파일이 없으면 실행하지 못했다고 실패한다', async () => {
    await assert.rejects(runSim({ command: path.join(os.tmpdir(), 'no-such-python-xyz.exe'), args: [], cwd: process.cwd() }, INPUT, { timeoutMs: 5_000 }), /실행하지 못했습니다/);
  });
});

describe('What-if 실행기: 명령 찾기', () => {
  it('SIM_PYTHON이 있으면 그것, 없으면 sim/.venv. cwd는 sim/', () => {
    const dir = findSimDir();
    assert.ok(dir, 'server/ 또는 저장소 루트에서 sim/을 찾는다');
    const cmd = resolveSimCommand({ SIM_PYTHON: 'C:/py/python.exe' });
    assert.equal(cmd.command, 'C:/py/python.exe');
    assert.deepEqual(cmd.args, ['-m', 'lumisim.whatif']);
    assert.equal(cmd.cwd, dir);
    assert.deepEqual(cmd.env, { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' });
    assert.equal(venvPython('/x/sim', 'win32'), path.join('/x/sim', '.venv', 'Scripts', 'python.exe'));
    assert.equal(venvPython('/x/sim', 'linux'), path.join('/x/sim', '.venv', 'bin', 'python'));
  });

  it('가상환경이 없으면 npm run sim:setup을 알린다', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'whatif-'));
    try {
      const fake = path.join(tmp, 'sim', 'lumisim');
      mkdirSync(fake, { recursive: true });
      assert.throws(() => resolveSimCommand({}, tmp), (e: unknown) => e instanceof SimRunError && e.message === NO_VENV_MESSAGE);
      assert.throws(() => resolveSimCommand({}, path.join(tmp, 'sim', 'lumisim')), /찾지 못했습니다/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('동시 프로세스 수: WHATIF_WORKERS 또는 max(1, min(4, CPU − 1))', () => {
    assert.equal(workerCount({ WHATIF_WORKERS: '3' }, 16), 3);
    assert.equal(workerCount({ WHATIF_WORKERS: '0' }, 16), 4);
    assert.equal(workerCount({}, 2), 1);
    assert.equal(workerCount({}, 1), 1);
    assert.equal(workerCount({}, 4), 3);
  });
});

// ───────────── 실제 시뮬레이터 (sim/.venv와 lumisim/whatif.py가 있을 때만) ─────────────

const simDir = findSimDir();
const ready = !!simDir && existsSync(venvPython(simDir)) && existsSync(path.join(simDir, 'lumisim', 'whatif.py')) && existsSync(path.join(simDir, '..', 'shared', 'dist', 'factory.json'));

describe('What-if 실행기: 실제 Python 시뮬레이터', { skip: ready ? false : 'sim/.venv 또는 sim/lumisim/whatif.py가 없어 건너뜀' }, () => {
  it('서버가 만든 입력을 받아 계획별 반복 결과를 내고, 집계가 된다', { timeout: 180_000 }, async () => {
    const base = buildBase({
      source: 'clean',
      sim: null,
      stations: {},
      vib: {},
      orders: [{ id: 5, code: 'WO-HL-261116-005', line: 'HL', variant: 'HL-VX1-L', qty: 30, seq: 1, status: 'PLANNED', released: 0, doneQty: 0, releasing: false }],
      virtualNow: '2026-11-16T01:00:00.000Z',
      nowMs: Date.now(),
    });
    const body = {
      horizonH: 1,
      reps: 2,
      base: 'clean',
      scenarios: [
        { name: '지금 계획' },
        { name: '조립기 고장', events: [{ kind: 'down', station: 'HL-AS-01', atMin: 5, minutes: 20 }], orders: { HL: [{ id: 5, variant: 'HL-VX1-L', qty: 30, dueMin: 50 }, { variant: 'HL-VX1-R', qty: 10, code: '우측 시험' }] } },
      ],
    };
    const n = normalizeRequest(body, () => base);
    const input: WhatIfSimInput = { horizonSec: 3600, reps: 2, seed: 4242, workers: 2, base, scenarios: n.sim };
    const seen: number[] = [];
    const t0 = Date.now();
    const runs = await runSim(resolveSimCommand(), input, { timeoutMs: 170_000, onProgress: (d) => seen.push(d) });
    assert.equal(runs.length, 4);
    assert.deepEqual(runs.map((r) => [r.scenario, r.rep, r.seed]), [[0, 0, 4242], [0, 1, 4243], [1, 0, 4242], [1, 1, 4243]], '계획끼리 같은 씨앗');
    assert.equal(seen.at(-1), 4);
    for (const r of runs) for (const l of LINES) assert.equal(r.lines[l.code].hourly.length, 1);
    const result = aggregate({ request: n.request, base, sim: n.sim, seed: 4242, runs, elapsedMs: Date.now() - t0 });
    assert.equal(result.scenarios.length, 2);
    const hl = result.scenarios[0].lines.find((l) => l.line === 'HL')!;
    assert.ok(hl.oee.mean >= 0 && hl.oee.mean <= 1);
    assert.ok(result.scenarios[0].total.out.mean >= 0);
    const orders = result.scenarios[1].orders.filter((o) => o.line === 'HL');
    assert.equal(orders[0].id, 5);
    assert.equal(orders[1].code, '우측 시험', '새 지시는 화면 이름으로');
    assert.equal(orders[1].id, undefined);
    assert.ok(orders[0].planEndMin != null && orders[0].planEndMin > 0);
    assert.ok(result.scenarios[1].lines.find((l) => l.line === 'HL')!.downMin.mean >= 15, '조립기 고장 20분이 들어간다');
  });

  it('live 기준 상태(투입 중 지시·고장·보전·마모·공정 이상·버퍼)를 받아들인다', { timeout: 120_000 }, async () => {
    const t = '2026-11-16T01:00:00.000Z';
    const hl = LINES.find((l) => l.code === 'HL')!;
    const base = buildBase({
      source: 'live',
      sim: {
        t, startedAt: '2026-11-15T23:00:00.000Z', speed: 10, running: true,
        scenarios: [{ id: 'HL-VAC-LEAK', startedAt: '2026-11-16T00:30:00.000Z', level: 1 }],
        buffers: { [`HL.${hl.steps[0].code}`]: 4, [`HL.${hl.release}`]: 2 },
        inbound: Object.fromEntries(FACTORY.transfers.slice(0, 1).map((x) => [x.code, 3])),
        warehouse: {}, escaped: {},
        lines: { HL: { wo: { id: 7, code: 'WO-HL-261116-007', variant: 'HL-VX1-L', qty: 40, released: 12 }, variant: 'HL-VX1-L', waitingWo: false, ngPen: 0, repair: 0, quarantine: 0 } },
      },
      stations: { 'HL-IM-L1': { state: 'DOWN' }, 'HL-VM-01': { state: 'STOP', reason: PM_REASON } },
      vib: { 'HL-AS-01': 1.2, 'EM-MT-B1': 0.69 },
      orders: [
        { id: 7, code: 'WO-HL-261116-007', line: 'HL', variant: 'HL-VX1-L', qty: 40, seq: 1, status: 'RUNNING', released: 12, doneQty: 8, releasing: true },
        { id: 8, code: 'WO-HL-261116-008', line: 'HL', variant: 'HL-VX1-R', qty: 20, seq: 2, status: 'PLANNED', released: 0, doneQty: 0, releasing: false },
      ],
      virtualNow: t,
      nowMs: Date.now(),
    });
    assert.equal(base.stations!['HL-IM-L1'].state, 'DOWN');
    const n = normalizeRequest({ horizonH: 1, reps: 1, base: 'live', scenarios: [{ name: '지금 계획', events: [{ kind: 'scenario', id: 'HL-VAC-LEAK', on: false, atMin: 30 }, { kind: 'pm', station: 'HL-AS-01', atMin: 10 }] }] }, () => base);
    const runs = await runSim(resolveSimCommand(), { horizonSec: 3600, reps: 1, seed: 11, workers: 1, base, scenarios: n.sim }, { timeoutMs: 110_000 });
    assert.equal(runs.length, 1);
    const sec = runs[0].stations['HL-IM-L1'].sec;
    assert.ok((sec.DOWN ?? 0) > 0, '고장 중이던 설비는 고장으로 시작한다');
    const w7 = runs[0].orders.find((o) => o.id === 7)!;
    assert.ok(w7.released >= 12 && w7.done >= 8, '투입 중 지시는 이미 투입·완료한 수부터 이어 간다');
  });
});
