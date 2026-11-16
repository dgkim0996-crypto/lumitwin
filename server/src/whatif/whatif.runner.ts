import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WhatIfRep, WhatIfSimInput, WhatIfSimLine } from '@lumitwin/shared';

// What-if 실행기: 시뮬레이터 가상환경의 Python으로 `python -m lumisim.whatif`를 띄워
// 표준 입력에 WhatIfSimInput JSON 한 덩어리를 넣고, 표준 출력의 줄 JSON(진행률 → 결과 또는 오류)을 읽는다.

/** 실패 메시지에 붙이는 표준 오류 꼬리 (글자) */
export const STDERR_TAIL = 2048;
export const NO_VENV_MESSAGE = '시뮬레이터 가상환경이 없습니다 (npm run sim:setup)';

/** 사람에게 보일 실패 (DB error 칸에 그대로 남는다) */
export class SimRunError extends Error {}

export interface SimCommand {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface RunOptions {
  timeoutMs: number;
  onProgress?: (done: number, total: number) => void;
  /** 서버가 꺼질 때 끊는다 */
  signal?: AbortSignal;
}

export type SimRunner = (input: WhatIfSimInput, opts: RunOptions) => Promise<WhatIfRep[]>;

/** sim/ 폴더: 서버는 보통 server/에서 돌지만 저장소 루트에서 띄워도 찾는다 */
export function findSimDir(cwd = process.cwd()): string | null {
  return [path.resolve(cwd, '../sim'), path.resolve(cwd, 'sim')].find((d) => existsSync(path.join(d, 'lumisim'))) ?? null;
}

export function venvPython(simDir: string, platform = process.platform): string {
  return platform === 'win32' ? path.join(simDir, '.venv', 'Scripts', 'python.exe') : path.join(simDir, '.venv', 'bin', 'python');
}

/** 동시에 돌릴 프로세스 수: WHATIF_WORKERS 또는 max(1, min(4, CPU − 1)) */
export function workerCount(env: NodeJS.ProcessEnv = process.env, cpus = os.cpus().length): number {
  const n = Number(env.WHATIF_WORKERS);
  if (Number.isInteger(n) && n >= 1) return Math.min(n, 32);
  return Math.max(1, Math.min(4, cpus - 1));
}

/** 실행할 명령. Python은 SIM_PYTHON 또는 sim/.venv의 것. 없으면 SimRunError */
export function resolveSimCommand(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): SimCommand {
  const dir = findSimDir(cwd);
  if (!dir) throw new SimRunError('시뮬레이터 폴더(sim/lumisim)를 찾지 못했습니다');
  const py = env.SIM_PYTHON?.trim() || venvPython(dir);
  if (!env.SIM_PYTHON?.trim() && !existsSync(py)) throw new SimRunError(NO_VENV_MESSAGE);
  return { command: py, args: ['-m', 'lumisim.whatif'], cwd: dir, env: { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } };
}

/** 표준 출력 조각을 줄로 자른다 (조각 경계에 걸친 줄은 다음 조각과 잇는다) */
export class LineSplitter {
  private rest = '';

  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split(/\r?\n/);
    this.rest = parts.pop() ?? '';
    return parts;
  }

  flush(): string[] {
    const r = this.rest;
    this.rest = '';
    return r.trim() ? [r] : [];
  }
}

/** 줄 하나 해석. JSON이 아니거나(파이썬 경고 등) 모르는 type이면 null */
export function parseSimLine(line: string): WhatIfSimLine | null {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.type === 'progress' && Number.isFinite(o.done) && Number.isFinite(o.total)) return { type: 'progress', done: o.done as number, total: o.total as number };
  if (o.type === 'result' && Array.isArray(o.runs)) return { type: 'result', runs: o.runs as WhatIfRep[] };
  if (o.type === 'error') return { type: 'error', message: typeof o.message === 'string' && o.message ? o.message : '알 수 없는 오류' };
  return null;
}

/** 자식 프로세스와 그 아래(병렬 계산 프로세스)까지 끝낸다 */
function killTree(child: ChildProcess): void {
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32' && child.pid) {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => child.kill());
    return;
  }
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

const withTail = (msg: string, tail: string) => (tail.trim() ? `${msg}\n${tail.trim()}` : msg);

/** 한 번 실행: 결과(runs)를 돌려주거나 SimRunError로 실패한다 */
export function runSim(cmd: SimCommand, input: WhatIfSimInput, opts: RunOptions): Promise<WhatIfRep[]> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd.command, cmd.args, {
        cwd: cmd.cwd,
        env: { ...process.env, ...cmd.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX: 프로세스 묶음을 따로 만들어 시간 초과 때 병렬 계산 프로세스까지 한 번에 끝낸다
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      reject(new SimRunError(`시뮬레이터를 실행하지 못했습니다: ${(e as Error).message}`));
      return;
    }
    let settled = false;
    let stderr = '';
    let runs: WhatIfRep[] | null = null;
    let simError: string | null = null;
    let timedOut = false;
    let aborted = false;
    const split = new LineSplitter();

    const finish = (err: SimRunError | null, value?: WhatIfRep[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(value!);
    };
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort);

    const take = (line: string) => {
      const m = parseSimLine(line);
      if (!m) return;
      if (m.type === 'progress') opts.onProgress?.(m.done, m.total);
      else if (m.type === 'result') runs = m.runs;
      else simError = m.message;
    };

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => split.push(chunk).forEach(take));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    child.stdin!.on('error', () => undefined); // 자식이 먼저 끝나면 EPIPE: 종료 처리에서 이유를 알린다
    child.on('error', (e) => finish(new SimRunError(`시뮬레이터를 실행하지 못했습니다: ${e.message}`)));
    child.on('close', (code, signal) => {
      split.flush().forEach(take);
      if (timedOut) return finish(new SimRunError(withTail(`계산 시간이 너무 깁니다 (한도 ${Math.round(opts.timeoutMs / 1000)}초). 반복이나 시간을 줄여 주세요`, stderr)));
      if (aborted) return finish(new SimRunError('서버가 꺼져 계산을 멈췄습니다'));
      if (simError) return finish(new SimRunError(withTail(`시뮬레이터 오류: ${simError}`, stderr)));
      if (runs) return finish(null, runs);
      finish(new SimRunError(withTail(`시뮬레이터가 결과 없이 끝났습니다 (종료 코드 ${code ?? signal ?? '?'})`, stderr)));
    });

    child.stdin!.end(`${JSON.stringify(input)}\n`);
  });
}

/** 기본 실행기: 매번 명령을 다시 찾는다 (가상환경을 서버가 켜진 뒤 만들어도 된다) */
export const defaultRunner: SimRunner = (input, opts) => {
  let cmd: SimCommand;
  try {
    cmd = resolveSimCommand();
  } catch (e) {
    return Promise.reject(e);
  }
  return runSim(cmd, input, opts);
};
