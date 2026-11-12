// npm run dev 에서 서버를 띄우기 전에 DB를 쓸 수 있게 맞춘다. 반복 실행해도 안전하다.
//   1) 로컬 DB(npm run db)가 lumitwin DB를 만들 때까지 기다린다
//   2) 아직 적용되지 않은 마이그레이션을 적용한다 (prisma migrate deploy)
// 배포 서버에서는 server/.env의 DATABASE_URL을 쓴다 (npm run db:migrate 가 cwd=server로 부른다)
import 'dotenv/config';
import { execSync } from 'node:child_process';
import pg from 'pg';

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:54332/lumitwin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// local-db.mjs는 포트를 연 뒤에 lumitwin DB를 만든다. 그 사이에 접속하면 실패하므로 잠깐 기다린다.
for (let i = 0; ; i++) {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.end();
    break;
  } catch (e) {
    await client.end().catch(() => {});
    if (i >= 30) throw e;
    await sleep(1000);
  }
}

execSync('npx prisma migrate deploy', { stdio: 'inherit' });
