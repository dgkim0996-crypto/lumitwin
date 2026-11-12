// 빌드한 공장 정의를 dist/factory.json으로 내보낸다. Python 시뮬레이터(sim/)가 이 파일을 읽는다.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const mod = await import(`${pathToFileURL(join(dist, 'index.mjs')).href}?t=${Date.now()}`);
writeFileSync(join(dist, 'factory.json'), JSON.stringify(mod.FACTORY, null, 2), 'utf8');
const stations = mod.FACTORY.lines.reduce((n, l) => n + l.stations.length, 0);
process.stdout.write(`[shared] factory.json 내보냄 · 라인 ${mod.FACTORY.lines.length} · 설비 ${stations} · 시나리오 ${mod.FACTORY.scenarios.length}\n`);
