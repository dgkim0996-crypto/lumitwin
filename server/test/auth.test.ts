import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { AUTH_COOKIE, DEMO_USERS, PERMISSIONS, ROLES, can, type ActorInfo, type PermCode, type Role } from '@lumitwin/shared';
import {
  AttemptLimiter,
  authConfigFromEnv,
  clearedCookie,
  decide,
  DEFAULT_DEMO_PASSWORD,
  hashPassword,
  LOGIN_ONLY,
  loadSecret,
  parseCookies,
  safeLoginLabel,
  SESSION_MS,
  sessionCookie,
  signSession,
  stationOpPerm,
  verifyPassword,
  verifySession,
  wantsSecure,
} from '../src/auth/auth.core';

const SECRET = Buffer.from('test-secret-0123456789-abcdefghijklmnop');
const LEAD: ActorInfo = { login: 'lead1', name: '라인 조장', role: 'leader' };
const T0 = Date.parse('2026-11-13T00:00:00Z');

/** 서명 없이 내용만 바꾼 쿠키 (위조 흉내) */
function forge(token: string, patch: Record<string, unknown>): string {
  const [body, sig] = token.split('.');
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return `${Buffer.from(JSON.stringify({ ...p, ...patch })).toString('base64url')}.${sig}`;
}

describe('설정 (server/.env)', () => {
  it('AUTH 기본은 켜짐, off·false·0이면 꺼짐', () => {
    assert.equal(authConfigFromEnv({}).enabled, true);
    assert.equal(authConfigFromEnv({ AUTH: 'on' }).enabled, true);
    for (const v of ['off', ' OFF ', 'false', '0', 'no']) assert.equal(authConfigFromEnv({ AUTH: v }).enabled, false, v);
  });

  it('DEMO_PASSWORD를 정하지 않으면 기본 비밀번호와 계정 버튼 바로 로그인', () => {
    assert.deepEqual(authConfigFromEnv({}), { enabled: true, demoPassword: DEFAULT_DEMO_PASSWORD, demoLogin: true, cookieSecure: 'auto' });
    const c = authConfigFromEnv({ DEMO_PASSWORD: 'another-pass-77' });
    assert.equal(c.demoPassword, 'another-pass-77');
    assert.equal(c.demoLogin, false);
  });

  it('AUTH_COOKIE_SECURE: on·off·그 밖은 auto', () => {
    assert.equal(authConfigFromEnv({ AUTH_COOKIE_SECURE: 'on' }).cookieSecure, 'on');
    assert.equal(authConfigFromEnv({ AUTH_COOKIE_SECURE: 'off' }).cookieSecure, 'off');
    assert.equal(authConfigFromEnv({ AUTH_COOKIE_SECURE: 'yes' }).cookieSecure, 'auto');
  });
});

describe('비밀번호 (scrypt + salt)', () => {
  it('맞는 비밀번호만 통과하고, 같은 비밀번호도 해시가 매번 다르다', async () => {
    const h1 = await hashPassword('correct horse');
    const h2 = await hashPassword('correct horse');
    assert.match(h1, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    assert.notEqual(h1, h2);
    assert.equal(await verifyPassword('correct horse', h1), true);
    assert.equal(await verifyPassword('correct horse', h2), true);
    assert.equal(await verifyPassword('correct hors', h1), false);
    assert.equal(await verifyPassword('', h1), false);
  });

  it('같은 salt면 같은 해시 (결정적), 한글은 NFC로 맞춘다', async () => {
    const salt = Buffer.alloc(16, 7);
    assert.equal(await hashPassword('비밀', salt), await hashPassword('비밀', salt));
    const h = await hashPassword('한글'.normalize('NFC'));
    assert.equal(await verifyPassword('한글'.normalize('NFD'), h), true);
  });

  it('모양이 틀리거나 매개변수가 터무니없는 해시는 계산하지 않고 false', async () => {
    const h = await hashPassword('pw');
    const parts = h.split('$');
    for (const bad of ['', 'plain', 'bcrypt$x', parts.slice(0, 5).join('$'), ['scrypt', 3, 8, 1, parts[4], parts[5]].join('$'), ['scrypt', 1 << 24, 8, 1, parts[4], parts[5]].join('$')]) {
      assert.equal(await verifyPassword('pw', bad), false, bad);
    }
  });
});

describe('로그인 쿠키 (HMAC-SHA256)', () => {
  const token = signSession(LEAD, SECRET, T0);

  it('서명한 쿠키는 그대로 읽힌다 (만료 8시간)', () => {
    const s = verifySession(token, SECRET, T0 + 1000);
    assert.deepEqual(s, { ...LEAD, exp: T0 + SESSION_MS });
    assert.equal(SESSION_MS, 8 * 3600_000);
  });

  it('역할·만료를 바꾼 쿠키, 서명을 바꾼 쿠키, 다른 키로 서명한 쿠키는 거부', () => {
    assert.equal(verifySession(forge(token, { role: 'admin' }), SECRET, T0), null);
    assert.equal(verifySession(forge(token, { exp: T0 + 365 * 86_400_000 }), SECRET, T0), null);
    const sig = token.split('.')[1];
    const flipped = `${token.split('.')[0]}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
    assert.equal(verifySession(flipped, SECRET, T0), null);
    assert.equal(verifySession(token, Buffer.from('other-secret-0123456789-abcdefghijklmno'), T0), null);
    assert.equal(verifySession(`${token}x`, SECRET, T0), null);
  });

  it('만료되면 거부 (만료 시각 정각 포함)', () => {
    assert.ok(verifySession(token, SECRET, T0 + SESSION_MS - 1));
    assert.equal(verifySession(token, SECRET, T0 + SESSION_MS), null);
    assert.equal(verifySession(token, SECRET, T0 + SESSION_MS + 60_000), null);
  });

  it('빈 값·점 없는 값·지나치게 긴 값·모르는 역할은 거부', () => {
    for (const t of [undefined, null, '', 'abc', '.abc', 'a'.repeat(3000)]) assert.equal(verifySession(t, SECRET, T0), null);
    // 키를 아는 사람이 만든 쿠키라도 역할이 표에 없으면 받지 않는다
    const weird = signSession({ ...LEAD, role: 'root' as Role }, SECRET, T0);
    assert.equal(verifySession(weird, SECRET, T0), null);
  });

  it('Cookie 머리글 읽기: 여러 개·따옴표·퍼센트 인코딩, 같은 이름은 첫 번째', () => {
    const c = parseCookies(`a=1; ${AUTH_COOKIE}=${token}; b="x y"; c=%ED%95%9C; ${AUTH_COOKIE}=second; junk; d=%E0%A4%A`);
    assert.equal(c[AUTH_COOKIE], token);
    assert.equal(c.a, '1');
    assert.equal(c.b, 'x y');
    assert.equal(c.c, '한');
    assert.equal(c.d, '%E0%A4%A');
    assert.equal(parseCookies(undefined)[AUTH_COOKIE], undefined);
    assert.equal(parseCookies('constructor=1').constructor, '1');
  });

  it('쿠키 속성: httpOnly · SameSite=Lax · /api/v1 · 8시간, Secure는 HTTPS일 때만', () => {
    const c = sessionCookie(token, false);
    assert.ok(c.startsWith(`${AUTH_COOKIE}=${token}; `));
    for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/api/v1', 'Max-Age=28800']) assert.ok(c.includes(attr), attr);
    assert.ok(!c.includes('Secure'));
    assert.ok(sessionCookie(token, true).endsWith('; Secure'));
    const gone = clearedCookie(false);
    assert.ok(gone.startsWith(`${AUTH_COOKIE}=;`) && gone.includes('Max-Age=0') && gone.includes('Path=/api/v1'));
  });

  it('Secure 자동 판단: 프록시가 알려 준 https · Cloudflare cf-visitor · 직접 TLS', () => {
    assert.equal(wantsSecure('auto', { headers: {} }), false);
    assert.equal(wantsSecure('auto', { headers: { 'x-forwarded-proto': 'https' } }), true);
    assert.equal(wantsSecure('auto', { headers: { 'x-forwarded-proto': 'https, http' } }), true);
    assert.equal(wantsSecure('auto', { headers: { 'x-forwarded-proto': 'http' } }), false);
    assert.equal(wantsSecure('auto', { headers: { 'cf-visitor': '{"scheme":"https"}' } }), true);
    assert.equal(wantsSecure('auto', { secure: true, headers: {} }), true);
    assert.equal(wantsSecure('on', { headers: {} }), true);
    assert.equal(wantsSecure('off', { headers: { 'x-forwarded-proto': 'https' } }), false);
  });
});

describe('가드 판정', () => {
  const op: ActorInfo = { login: 'op1', name: '현장 작업자', role: 'operator' };

  it('인증을 끄면 무엇이든 통과', () => {
    assert.deepEqual(decide('sim.control', null, false), { ok: true });
    assert.deepEqual(decide('audit.read', op, false), { ok: true });
  });

  it('@Perm이 없는 처리기(조회·AI 비서)는 로그인 없이 통과', () => {
    assert.deepEqual(decide(undefined, null, true), { ok: true });
  });

  it('로그인 안 했으면 401, 권한이 없으면 403 (권한 이름·역할 이름)', () => {
    assert.deepEqual(decide('sim.control', null, true), { ok: false, status: 401, message: '로그인이 필요합니다' });
    assert.deepEqual(decide('sim.control', op, true), { ok: false, status: 403, message: '시뮬레이터 제어 권한이 없습니다 (작업자)' });
    assert.deepEqual(decide('sim.control', LEAD, true), { ok: true });
    assert.deepEqual(decide('audit.read', LEAD, true), { ok: false, status: 403, message: '감사 기록 조회 권한이 없습니다 (조장)' });
  });

  it('@LoginRequired: 로그인만 보면 통과', () => {
    assert.deepEqual(decide(LOGIN_ONLY, op, true), { ok: true });
    assert.equal(decide(LOGIN_ONLY, null, true).ok, false);
  });

  it('설비 명령 권한: 수리 완료·보전은 보전 권한, 나머지는 설비 조작', () => {
    assert.equal(stationOpPerm('repair'), 'station.repair');
    assert.equal(stationOpPerm('pm'), 'station.repair');
    for (const o of ['stop', 'setup', 'start', 'fail'] as const) assert.equal(stationOpPerm(o), 'station.op');
    assert.equal(can('operator', stationOpPerm('stop')), true);
    assert.equal(can('operator', stationOpPerm('repair')), false);
    assert.equal(can('maintenance', stationOpPerm('pm')), true);
    assert.equal(can('quality', stationOpPerm('stop')), false);
  });
});

describe('권한표 (shared PERMISSIONS)', () => {
  const roles = ROLES.map((r) => r.code);
  const perms = Object.keys(PERMISSIONS) as PermCode[];

  it('관리자는 모든 권한, 감사 기록은 관리자만', () => {
    for (const p of perms) assert.equal(can('admin', p), true, p);
    assert.deepEqual(PERMISSIONS['audit.read'], ['admin']);
  });

  it('표에 있는 역할만 쓰고, 로그인 안 한 사람(null)은 아무 권한도 없다', () => {
    for (const p of perms) {
      for (const r of PERMISSIONS[p]) assert.ok(roles.includes(r), `${p}: ${r}`);
      assert.equal(can(null, p), false);
      assert.equal(can(undefined, p), false);
    }
  });

  it('현장 흐름에 맞는 몇 가지 (시뮬레이터 제어는 조장, 수리 완료는 보전, Hold 해제는 품질)', () => {
    assert.deepEqual(roles.filter((r) => can(r, 'sim.control')), ['leader', 'admin']);
    assert.deepEqual(roles.filter((r) => can(r, 'station.repair')), ['maintenance', 'admin']);
    assert.deepEqual(roles.filter((r) => can(r, 'hold.release')), ['quality', 'admin']);
    // 알람 확인·변경점 신고는 누구나
    for (const r of roles) assert.equal(can(r, 'alarm.ack') && can(r, 'change.register'), true, r);
  });

  it('시연 계정: 역할마다 하나, 아이디가 겹치지 않는다', () => {
    assert.deepEqual(DEMO_USERS.map((u) => u.role).sort(), [...roles].sort());
    assert.equal(new Set(DEMO_USERS.map((u) => u.login)).size, DEMO_USERS.length);
    for (const u of DEMO_USERS) assert.equal(safeLoginLabel(u.login), u.login);
  });
});

describe('로그인 시도 제한 (IP별 1분 10회)', () => {
  it('10번까지 받고 11번째는 남은 시간을 돌려준다. 1분이 지나면 다시 받는다', () => {
    const lim = new AttemptLimiter(10, 60_000);
    for (let i = 0; i < 10; i++) assert.equal(lim.take('1.2.3.4', T0 + i * 1000), 0, `시도 ${i + 1}`);
    const wait = lim.take('1.2.3.4', T0 + 10_000);
    assert.equal(wait, 50_000);
    // 막힌 시도는 세지 않으므로 첫 시도가 창을 벗어나면 바로 하나 열린다
    assert.ok(lim.take('1.2.3.4', T0 + 59_999) > 0);
    assert.equal(lim.take('1.2.3.4', T0 + 60_001), 0);
  });

  it('IP마다 따로 센다', () => {
    const lim = new AttemptLimiter(2, 60_000);
    assert.equal(lim.take('a', T0), 0);
    assert.equal(lim.take('a', T0), 0);
    assert.ok(lim.take('a', T0) > 0);
    assert.equal(lim.take('b', T0), 0);
  });

  it('감사 기록의 시도한 아이디: 모양이 이상하면(비밀번호를 잘못 넣었을 수 있음) 가린다', () => {
    assert.equal(safeLoginLabel('qa1'), 'qa1');
    assert.equal(safeLoginLabel('p@ss w0rd!'), '(형식 밖)');
  });
});

describe('서명 키', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lt-auth-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('AUTH_SECRET이 있으면 그것을 쓰고 파일을 만들지 않는다', () => {
    const file = path.join(dir, 'env.secret');
    const key = loadSecret({ AUTH_SECRET: 'x'.repeat(40) }, file);
    assert.equal(key.toString(), 'x'.repeat(40));
    assert.throws(() => readFileSync(file));
  });

  it('없으면 무작위로 만들어 저장하고, 다음 기동에 같은 키를 읽는다', () => {
    const file = path.join(dir, '.auth-secret');
    const logs: string[] = [];
    const k1 = loadSecret({}, file, (m) => logs.push(m));
    assert.ok(k1.length >= 32);
    assert.equal(readFileSync(file, 'utf8').trim(), k1.toString());
    const k2 = loadSecret({}, file, (m) => logs.push(m));
    assert.equal(k2.toString(), k1.toString());
    assert.equal(logs.length, 1);
    // 키가 같으니 재시작 전 쿠키가 그대로 읽힌다
    assert.ok(verifySession(signSession(LEAD, k1, T0), k2, T0));
  });

  it('파일이 짧으면 새로 만든다', () => {
    const file = path.join(dir, 'short.secret');
    writeFileSync(file, 'abc');
    const k = loadSecret({}, file);
    assert.ok(k.length >= 32);
    assert.equal(readFileSync(file, 'utf8').trim(), k.toString());
  });
});
