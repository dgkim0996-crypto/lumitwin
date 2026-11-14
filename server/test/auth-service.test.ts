import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ForbiddenException, UnauthorizedException, type ExecutionContext, type HttpException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AUTH_COOKIE, DEMO_USERS, SYSTEM_ACTOR, type ActorInfo } from '@lumitwin/shared';
import { createAccess } from '../src/access/access';
import type { AuditService } from '../src/auth/audit.service';
import { hashPassword, LOGIN_ONLY, verifyPassword, type Need } from '../src/auth/auth.core';
import { AuthGuard } from '../src/auth/auth.guard';
import { AuthService } from '../src/auth/auth.service';
import { actorOf, actorOrNull, assertCan, type AuthedRequest } from '../src/auth/perm.decorator';
import type { PrismaService } from '../src/prisma/prisma.service';

// 키 파일을 만들지 않게 서명 키를 환경 변수로 준다 (AuthService는 만들 때 환경 변수를 읽는다)
process.env.AUTH_SECRET = 'unit-test-secret-0123456789-abcdefghijkl';
delete process.env.AUTH;
delete process.env.DEMO_PASSWORD;

interface UserRow {
  id: number;
  login: string;
  name: string;
  role: string;
  passHash: string;
  active: boolean;
}

/** app_user 표 흉내 (AuthService가 쓰는 함수만) */
function fakePrisma(seed: UserRow[] = []) {
  const rows = new Map(seed.map((u) => [u.login, { ...u }]));
  let id = seed.length;
  const user = {
    findUnique: async ({ where }: { where: { login: string } }) => rows.get(where.login) ?? null,
    update: async ({ where, data }: { where: { id: number }; data: Partial<UserRow> }) => {
      const u = [...rows.values()].find((x) => x.id === where.id)!;
      Object.assign(u, data);
      return u;
    },
    upsert: async ({ where, create, update }: { where: { login: string }; create: Omit<UserRow, 'id' | 'active'>; update: Partial<UserRow> }) => {
      const cur = rows.get(where.login);
      if (cur) return Object.assign(cur, update);
      const u = { id: ++id, active: true, ...create };
      rows.set(u.login, u);
      return u;
    },
  };
  return { rows, prisma: { user } as unknown as PrismaService };
}

function fakeAudit() {
  const logs: { who: string; action: string; target?: string | null; detail?: unknown; ip?: string | null }[] = [];
  const audit = {
    log: async (a: ActorInfo, action: string, target?: string | null, detail?: unknown, ip?: string | null) => void logs.push({ who: a.login, action, target, detail, ip }),
    logAnonymous: async (action: string, target?: string | null, detail?: unknown, ip?: string | null) => void logs.push({ who: 'anonymous', action, target, detail, ip }),
  };
  return { logs, audit: audit as unknown as AuditService };
}

async function makeService(env: Record<string, string | undefined> = {}) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const put = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  put(env);
  try {
    const db = fakePrisma();
    const au = fakeAudit();
    const svc = new AuthService(db.prisma, au.audit);
    await svc.seedDemoUsers();
    return { svc, ...db, ...au };
  } finally {
    put(saved);
  }
}

const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as unknown as Request & AuthedRequest;
const cookieOf = (token: string) => `other=1; ${AUTH_COOKIE}=${token}`;

async function rejects(p: Promise<unknown>, status: number, re?: RegExp) {
  await assert.rejects(p, (e: HttpException) => {
    assert.equal(e.getStatus(), status);
    if (re) assert.match(String(e.message), re);
    return true;
  });
}

describe('AuthService (가짜 DB)', () => {
  it('기동 때 시연 계정 5개를 scrypt 해시로 만든다 (평문 저장 없음)', async () => {
    const { rows } = await makeService();
    assert.equal(rows.size, DEMO_USERS.length);
    for (const u of DEMO_USERS) {
      const r = rows.get(u.login)!;
      assert.equal(r.role, u.role);
      assert.ok(r.passHash.startsWith('scrypt$'));
      assert.ok(!r.passHash.includes('demo1234'));
    }
  });

  it('DEMO_PASSWORD를 바꾸고 다시 기동하면 해시를 새 비밀번호로 바꾼다', async () => {
    const old = await hashPassword('demo1234');
    const db = fakePrisma([{ id: 1, login: 'qa1', name: '옛 이름', role: 'operator', passHash: old, active: false }]);
    const saved = process.env.DEMO_PASSWORD;
    process.env.DEMO_PASSWORD = 'changed-pass-42';
    try {
      const svc = new AuthService(db.prisma, fakeAudit().audit);
      assert.equal(svc.demoLogin, false);
      await svc.seedDemoUsers();
    } finally {
      if (saved === undefined) delete process.env.DEMO_PASSWORD;
      else process.env.DEMO_PASSWORD = saved;
    }
    const r = db.rows.get('qa1')!;
    assert.equal(await verifyPassword('changed-pass-42', r.passHash), true);
    assert.equal(await verifyPassword('demo1234', r.passHash), false);
    assert.deepEqual([r.name, r.role, r.active], ['품질 담당', 'quality', true]);
  });

  it('비밀번호 로그인 → 쿠키 → 요청의 사용자, 감사 기록에 로그인', async () => {
    const { svc, logs } = await makeService();
    const r = await svc.login('lead1', 'demo1234', false, '10.0.0.5');
    assert.deepEqual(r.actor, { login: 'lead1', name: '라인 조장', role: 'leader' });
    assert.ok(Date.parse(r.expiresAt) > Date.now() + 7.9 * 3600_000);
    assert.deepEqual(svc.actorOf(req(cookieOf(r.token))), r.actor);
    assert.deepEqual(logs.at(-1), { who: 'lead1', action: 'login', target: 'lead1', detail: null, ip: '10.0.0.5' });
  });

  it('틀린 비밀번호·없는 아이디는 같은 401 문구, 실패는 anonymous로 기록', async () => {
    const { svc, logs } = await makeService();
    await rejects(svc.login('lead1', 'wrong', false, 'ip1'), 401, /아이디 또는 비밀번호/);
    await rejects(svc.login('nobody', 'demo1234', false, 'ip1'), 401, /아이디 또는 비밀번호/);
    assert.deepEqual(
      logs.map((l) => [l.who, l.action, l.target, (l.detail as { reason: string }).reason]),
      [
        ['anonymous', 'login.fail', 'lead1', 'bad-password'],
        ['anonymous', 'login.fail', 'nobody', 'unknown-user'],
      ],
    );
    await rejects(svc.login('', 'x', false, 'ip1'), 400);
    await rejects(svc.login('lead1', '', false, 'ip1'), 400);
  });

  it('계정 버튼 로그인(demo): 기본 비밀번호 서버만, 시연 계정만', async () => {
    const { svc } = await makeService();
    assert.equal(svc.demoLogin, true);
    assert.equal((await svc.login('mt1', undefined, true, 'ip2')).actor.role, 'maintenance');
    await rejects(svc.login('ghost', undefined, true, 'ip2'), 401);
    const strict = await makeService({ DEMO_PASSWORD: 'changed-pass-42' });
    await rejects(strict.svc.login('mt1', undefined, true, 'ip2'), 400, /DEMO_PASSWORD/);
    assert.equal((await strict.svc.login('mt1', 'changed-pass-42', false, 'ip2')).actor.login, 'mt1');
  });

  it('IP별 1분 10회를 넘으면 429 (다른 IP는 그대로)', async () => {
    const { svc } = await makeService();
    for (let i = 0; i < 10; i++) await rejects(svc.login('op1', 'nope', false, '9.9.9.9'), 401);
    await rejects(svc.login('op1', 'demo1234', false, '9.9.9.9'), 429, /너무 많습니다/);
    assert.equal((await svc.login('op1', 'demo1234', false, '9.9.9.8')).actor.login, 'op1');
  });

  it('로그아웃한 쿠키는 만료 전이라도 다시 받지 않는다', async () => {
    const { svc } = await makeService();
    const { token } = await svc.login('admin', 'demo1234', false, 'ip3');
    const q = req(cookieOf(token));
    assert.equal(svc.actorOf(q)?.login, 'admin');
    assert.equal(svc.logout(q)?.login, 'admin');
    assert.equal(svc.actorOf(q), null);
    assert.equal(svc.logout(q), null);
  });

  it('위조 쿠키·쿠키 없음은 null', async () => {
    const { svc } = await makeService();
    const { token } = await svc.login('op1', 'demo1234', false, 'ip4');
    const [body, sig] = token.split('.');
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forged = `${Buffer.from(JSON.stringify({ ...p, role: 'admin' })).toString('base64url')}.${sig}`;
    assert.equal(svc.actorOf(req(cookieOf(forged))), null);
    assert.equal(svc.actorOf(req()), null);
  });

  it('AUTH=off면 쿠키 없이도 시스템 사용자, 로그인은 400', async () => {
    const { svc } = await makeService({ AUTH: 'off' });
    assert.equal(svc.enabled, false);
    assert.equal(svc.demoLogin, false);
    assert.deepEqual(svc.actorOf(req()), SYSTEM_ACTOR);
    await rejects(svc.login('admin', 'demo1234', false, 'ip'), 400, /AUTH=off/);
  });
});

/** 가드에 넘길 실행 맥락 흉내: 처리기에 붙은 @Perm 값을 need로 준다 */
function run(guard: AuthGuard, q: Request & AuthedRequest, type = 'http') {
  const ctx = { getType: () => type, switchToHttp: () => ({ getRequest: () => q }), getHandler: () => run, getClass: () => AuthGuard } as unknown as ExecutionContext;
  try {
    return guard.canActivate(ctx) ? 'pass' : 'deny';
  } catch (e) {
    return e as HttpException;
  }
}
const guardWith = (svc: AuthService, need: Need) => new AuthGuard({ getAllAndOverride: () => need } as unknown as Reflector, svc);

describe('AuthGuard (APP_GUARD)', () => {
  it('AUTH=on: @Perm 처리기는 로그인 안 하면 401, 권한 없으면 403, 있으면 통과', async () => {
    const { svc } = await makeService();
    const op = (await svc.login('op1', 'demo1234', false, 'g1')).token;
    const lead = (await svc.login('lead1', 'demo1234', false, 'g1')).token;

    const anon = run(guardWith(svc, 'sim.control'), req());
    assert.ok(anon instanceof UnauthorizedException);
    assert.equal((anon as HttpException).getStatus(), 401);
    assert.equal((anon as HttpException).message, '로그인이 필요합니다');

    const denied = run(guardWith(svc, 'sim.control'), req(cookieOf(op)));
    assert.ok(denied instanceof ForbiddenException);
    assert.equal((denied as HttpException).message, '시뮬레이터 제어 권한이 없습니다 (작업자)');

    const q = req(cookieOf(lead));
    assert.equal(run(guardWith(svc, 'sim.control'), q), 'pass');
    assert.equal(q.actor?.login, 'lead1');
    assert.equal(actorOf(q).role, 'leader');
  });

  it('@Perm 없는 처리기는 열려 있고, 익명 요청에서 actorOf는 시스템이 아니라 401', async () => {
    const { svc } = await makeService();
    const q = req();
    assert.equal(run(guardWith(svc, undefined), q), 'pass');
    assert.equal(q.anonymous, true);
    assert.throws(() => actorOf(q), UnauthorizedException);
    assert.equal(actorOrNull(q), null);
  });

  it('@LoginRequired + assertCan: 작업자는 정지는 되고 수리 완료는 403', async () => {
    const { svc } = await makeService();
    const q = req(cookieOf((await svc.login('op1', 'demo1234', false, 'g2')).token));
    assert.equal(run(guardWith(svc, LOGIN_ONLY), q), 'pass');
    assert.doesNotThrow(() => assertCan(actorOf(q), 'station.op'));
    assert.throws(() => assertCan(actorOf(q), 'station.repair'), (e: HttpException) => e.getStatus() === 403 && e.message === '수리 완료·보전 실시 권한이 없습니다 (작업자)');
    assert.ok(run(guardWith(svc, LOGIN_ONLY), req()) instanceof UnauthorizedException);
  });

  it('AUTH=off: 모두 통과하고 사용자는 시스템', async () => {
    const { svc } = await makeService({ AUTH: 'off' });
    const q = req();
    assert.equal(run(guardWith(svc, 'audit.read'), q), 'pass');
    assert.deepEqual(q.actor, SYSTEM_ACTOR);
    assert.deepEqual(actorOf(q), SYSTEM_ACTOR);
  });

  it('HTTP가 아닌 맥락(실시간 소켓)은 보지 않는다', async () => {
    const { svc } = await makeService();
    assert.equal(run(guardWith(svc, 'sim.control'), req(), 'ws'), 'pass');
  });

  it('가드를 거치지 않은 요청은 시스템 (기존 동작)', () => {
    assert.deepEqual(actorOf(req()), SYSTEM_ACTOR);
  });
});

describe('공개 링크 보기 전용이 먼저', () => {
  const CF = { 'cf-ray': '8f-ICN' };
  const a = createAccess({ mode: 'tunnel', controlKey: '' });
  const pass = (method: string, p: string) => {
    let ok = false;
    let status = 0;
    const res = { status: (c: number) => ((status = c), res), json: () => res } as unknown as Response;
    a.guard({ method, path: p, headers: CF } as unknown as Request, res, (() => (ok = true)) as NextFunction);
    return ok ? 'pass' : status;
  };

  it('공개 링크에서는 로그인도 막고(시연 계정이 공개돼도 조작 불가), 로그아웃은 받는다', () => {
    assert.equal(pass('POST', '/api/v1/auth/login'), 403);
    assert.equal(pass('POST', '/api/v1/sim/reset'), 403);
    assert.equal(pass('POST', '/api/v1/auth/logout'), 'pass');
    assert.equal(pass('GET', '/api/v1/auth/me'), 'pass');
  });
});
