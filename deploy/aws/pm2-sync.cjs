// pm2에 떠 있는 시뮬레이터·엣지 게이트웨이가 deploy/aws/ecosystem.config.cjs와 다르면 내린다.
// SIM_LINK·SIM_SPEED를 바꾸면 엣지 게이트웨이가 생기거나 없어지고 시뮬레이터 인자가 바뀌는데,
// pm2 startOrReload는 이미 떠 있는 프로세스의 인자를 새로 읽지 않는다. 내려 두면 다음 startOrReload가 새 설정으로 띄운다.
// 쓰는 법: node deploy/aws/pm2-sync.cjs && pm2 startOrReload deploy/aws/ecosystem.config.cjs --update-env
// 서버·화면·DB·받아쓰기는 건드리지 않는다 (setup-ubuntu.sh 13단계)
const { execFileSync } = require('node:child_process');
const { apps } = require('./ecosystem.config.cjs');

const MANAGED = ['lumitwin-sim', 'lumitwin-edge'];
const words = (a) => (Array.isArray(a) ? a.map(String) : String(a ?? '').split(/\s+/)).filter(Boolean).join(' ');
const want = new Map(apps.map((a) => [a.name, words(a.args)]));

let running = [];
try {
  // 데몬이 처음 뜰 때 안내 줄이 먼저 나올 수 있어 JSON 줄만 고른다
  const out = execFileSync('pm2', ['jlist'], { encoding: 'utf8' });
  const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith('[{') || l.trim() === '[]');
  running = line ? JSON.parse(line) : [];
} catch {
  process.exit(0); // pm2가 없거나 아직 아무것도 띄우지 않았다
}

for (const p of running) {
  if (!MANAGED.includes(p.name)) continue;
  const args = want.get(p.name);
  if (args !== undefined && args === words(p.pm2_env?.args)) continue;
  console.log(`${p.name}: ${args === undefined ? '설정에 없어 내립니다' : `인자가 바뀌어 다시 띄웁니다 (${words(p.pm2_env?.args)} → ${args})`}`);
  execFileSync('pm2', ['delete', p.name], { stdio: 'inherit' });
}
