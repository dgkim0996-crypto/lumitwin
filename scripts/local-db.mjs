// 로컬 개발용 PostgreSQL. Docker 없이 프로젝트 폴더(.local-db) 안에서만 실행한다. (판타스틸 ERP scripts/local-db.mjs 방식)
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const databaseDir = join(root, '.local-db');
const port = Number(process.env.LOCAL_DB_PORT ?? 54332);
const dbName = 'lumitwin';

const inUse = await new Promise((resolve) => {
  const sock = createConnection({ port, host: '127.0.0.1' });
  sock.once('connect', () => { sock.destroy(); resolve(true); });
  sock.once('error', () => resolve(false));
});
if (inUse) {
  process.stdout.write(`[db] localhost:${port} 에 이미 PostgreSQL이 떠 있어 그대로 사용합니다\n`);
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}

const pg = new EmbeddedPostgres({
  databaseDir, user: 'postgres', password: 'postgres', port, persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  // Prisma는 시각을 UTC로 읽고 쓴다. DB 기본 시간대를 UTC로 고정한다
  postgresFlags: ['-c', 'timezone=UTC'],
  onLog: () => {}, onError: (e) => process.stderr.write(`[db] ${String(e)}\n`),
});

const fresh = !existsSync(join(databaseDir, 'PG_VERSION'));
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase(dbName);
process.stdout.write(`[db] PostgreSQL 실행 중 · localhost:${port}/${dbName}\n`);

const stop = async () => { try { await pg.stop(); } finally { process.exit(0); } };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
