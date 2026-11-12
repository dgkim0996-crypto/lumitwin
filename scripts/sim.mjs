// Python 시뮬레이터 실행기: sim/.venv 가상환경을 찾아 `python -m lumisim`을 띄운다
//   node scripts/sim.mjs --setup         가상환경을 만들고 requirements.txt를 설치한다
//   node scripts/sim.mjs --setup-opcua   OPC UA 경로용 패키지(asyncua)까지 설치한다 (requirements-opcua.txt)
//   node scripts/sim.mjs --test          시뮬레이터 테스트 (sim/tests, 표준 unittest)
//   node scripts/sim.mjs --edge [인자]   엣지 게이트웨이 (OPC UA → MQTT, `python -m lumisim.edge`)
//   node scripts/sim.mjs [인자]          시뮬레이터 실행 (인자는 그대로 넘긴다. 예: --link opcua)
import { join } from 'node:path';
import { root, runInVenv, setupVenv } from './pyvenv.mjs';

const simDir = join(root, 'sim');
const args = process.argv.slice(2);
const rest = (flag) => args.filter((a) => a !== flag);
if (args.includes('--setup')) {
  setupVenv('sim', simDir);
  process.exit(0);
}
if (args.includes('--setup-opcua')) {
  setupVenv('sim', simDir, 'requirements-opcua.txt');
  process.exit(0);
}
if (args.includes('--test')) {
  runInVenv('sim', simDir, ['-m', 'unittest', 'discover', '-s', 'tests', '-t', '.', ...rest('--test')]);
} else if (args.includes('--edge')) {
  runInVenv('edge', simDir, ['-m', 'lumisim.edge', ...rest('--edge')]);
} else {
  runInVenv('sim', simDir, ['-m', 'lumisim', ...args]);
}
