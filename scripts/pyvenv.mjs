// sim·whisper가 함께 쓰는 Python 가상환경 도우미.
// 폴더마다 .venv를 따로 두고 그 폴더의 requirements.txt를 설치한다 (무거운 음성 인식 패키지가 시뮬레이터 환경에 섞이지 않게).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const systemPython = process.env.PYTHON ?? (isWin ? 'python' : 'python3');

export const venvPython = (dir) => (isWin ? join(dir, '.venv', 'Scripts', 'python.exe') : join(dir, '.venv', 'bin', 'python'));

function run(tag, dir, cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: dir });
  if (r.status !== 0) {
    process.stderr.write(`[${tag}] 실패: ${cmd} ${args.join(' ')}\n`);
    process.exit(r.status ?? 1);
  }
}

/** dir/.venv를 만들고(없을 때만) dir/requirements.txt(또는 reqFile)를 설치한다 */
export function setupVenv(tag, dir, reqFile = 'requirements.txt') {
  const py = venvPython(dir);
  if (!existsSync(py)) {
    process.stdout.write(`[${tag}] 가상환경(${relative(root, dir).replaceAll('\\', '/')}/.venv)을 만듭니다\n`);
    run(tag, dir, systemPython, ['-m', 'venv', '.venv']);
  }
  run(tag, dir, py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', reqFile]);
  process.stdout.write(`[${tag}] 준비 완료\n`);
}

/** 가상환경의 Python으로 args를 실행하고, 이 프로세스가 끝나면 함께 끝낸다 (없으면 먼저 설치) */
export function runInVenv(tag, dir, args, env = {}) {
  if (!existsSync(venvPython(dir))) setupVenv(tag, dir);
  const child = spawn(venvPython(dir), args, {
    stdio: 'inherit',
    cwd: dir,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...env },
  });
  const stop = () => child.kill();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}
