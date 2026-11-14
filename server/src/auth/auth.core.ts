// 로그인·권한 판정의 순수 함수 (Nest·DB 없이 테스트한다): 설정, 비밀번호 해시, 쿠키 서명, 가드 판정, 시도 횟수 제한, 서명 키.
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { AUTH_COOKIE, PERM_NAMES, ROLE_NAMES, ROLES, can, type ActorInfo, type PermCode, type Role, type StationOp } from '@lumitwin/shared';

// ─────────────────────────── 설정 ───────────────────────────

/** 시연 계정 기본 비밀번호 (shared DEMO_USERS 주석과 같다). DEMO_PASSWORD로 바꾼다 */
export const DEFAULT_DEMO_PASSWORD = 'demo1234';
/** 로그인 유지 시간: 8시간 뒤에는 다시 로그인한다 (공용 태블릿에 남이 로그인한 채로 오래 남지 않게. 교대 12시간보다 짧다) assumed */
export const SESSION_HOURS = 8;
export const SESSION_MS = SESSION_HOURS * 3600_000;
/** IP별 로그인 시도 한도 (1분에 10번). 시연 계정 버튼을 여러 번 눌러도 걸리지 않고, 비밀번호 대입은 늦춘다 assumed */
export const LOGIN_MAX_PER_MIN = 10;
export const LOGIN_REQUIRED = '로그인이 필요합니다';
/** 쿠키 경로: 화면은 늘 같은 주소의 /api/v1로만 부르므로 페이지 요청에는 쿠키를 싣지 않는다 */
export const COOKIE_PATH = '/api/v1';

export type CookieSecure = 'auto' | 'on' | 'off';

export interface AuthConfig {
  /** AUTH=off면 false: 모든 요청을 시스템 사용자로 본다 */
  enabled: boolean;
  demoPassword: string;
  /** DEMO_PASSWORD를 따로 정하지 않았으면 로그인 화면의 계정 버튼으로 비밀번호 없이 바로 들어간다 (기본 비밀번호는 어차피 공개돼 있다) */
  demoLogin: boolean;
  cookieSecure: CookieSecure;
}

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const a = (env.AUTH ?? 'on').trim().toLowerCase();
  const custom = (env.DEMO_PASSWORD ?? '').trim();
  const s = (env.AUTH_COOKIE_SECURE ?? 'auto').trim().toLowerCase();
  return {
    enabled: !['off', '0', 'false', 'no'].includes(a),
    demoPassword: custom || DEFAULT_DEMO_PASSWORD,
    demoLogin: !custom,
    cookieSecure: s === 'on' || s === 'off' ? s : 'auto',
  };
}

// ─────────────────────────── 비밀번호 (scrypt) ───────────────────────────

/** scrypt 매개변수: Node 기본값과 같다 (N=2^14, r=8, p=1 → 해시 한 번에 메모리 16MB, 수십 ms). OWASP 최소 권장(N=2^17)보다 낮은 시연용 값 weak */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, saltBytes: 16 } as const;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/** 'scrypt$N$r$p$salt$hash' (salt·hash는 base64url). 같은 비밀번호도 salt가 달라 해시가 매번 다르다 */
export async function hashPassword(password: string, salt: Buffer = randomBytes(SCRYPT.saltBytes)): Promise<string> {
  const { N, r, p, keylen } = SCRYPT;
  const key = await scrypt(password.normalize('NFC'), salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** 저장된 해시와 맞는지 (시간 고정 비교). 모양이 틀린 해시는 false */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  // 매개변수가 터무니없으면 계산하지 않는다 (메모리·시간 폭주 방지)
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20 || (N & (N - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const want = Buffer.from(parts[5], 'base64url');
  if (!salt.length || want.length < 16 || want.length > 128) return false;
  try {
    const got = await scrypt(password.normalize('NFC'), salt, want.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
    return timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

// ─────────────────────────── 로그인 쿠키 (HMAC-SHA256 서명) ───────────────────────────

const ROLE_CODES = new Set<string>(ROLES.map((r) => r.code));
export const isRole = (v: unknown): v is Role => typeof v === 'string' && ROLE_CODES.has(v);

export interface Session extends ActorInfo {
  /** 만료 (epoch ms) */
  exp: number;
}

function mac(body: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/** 쿠키 값: base64url(JSON{login, role, name, exp}) + '.' + HMAC. 서버에 세션 표가 없어도 서명으로 위조를 막는다 */
export function signSession(actor: ActorInfo, secret: Buffer, nowMs = Date.now(), ttlMs = SESSION_MS): string {
  const body = Buffer.from(JSON.stringify({ login: actor.login, role: actor.role, name: actor.name, exp: nowMs + ttlMs }), 'utf8').toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

/** 서명·만료·내용을 확인한 사용자. 위조·만료·모양이 틀리면 null */
export function verifySession(token: string | undefined | null, secret: Buffer, nowMs = Date.now()): Session | null {
  if (!token || token.length > 2048) return null;
  const i = token.indexOf('.');
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const got = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(mac(body, secret));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!p || typeof p !== 'object') return null;
  const { login, name, role, exp } = p;
  if (typeof login !== 'string' || !login || login.length > 40) return null;
  if (typeof name !== 'string' || name.length > 60) return null;
  if (!isRole(role)) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowMs) return null;
  return { login, name, role, exp };
}

/** 서명 부분 (로그아웃한 쿠키를 만료 전까지 기억하는 열쇠) */
export function sessionSig(token: string): string {
  return token.slice(token.indexOf('.') + 1);
}

/** Cookie 머리글 → {이름: 값}. 같은 이름이 여럿이면 첫 번째 (브라우저는 경로가 긴 쿠키를 먼저 보낸다) */
export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k || k in out) continue;
    let v = part.slice(eq + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** httpOnly(화면 스크립트가 못 읽음) · SameSite=Lax(다른 사이트에서 보낸 POST에는 안 실림) · 8시간 */
export function sessionCookie(token: string, secure: boolean, maxAgeSec = SESSION_HOURS * 3600): string {
  return [`${AUTH_COOKIE}=${token}`, `Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`, ...(secure ? ['Secure'] : [])].join('; ');
}

export function clearedCookie(secure: boolean): string {
  return [`${AUTH_COOKIE}=`, `Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT', ...(secure ? ['Secure'] : [])].join(
    '; ',
  );
}

/** Secure 속성을 붙일지: auto면 HTTPS로 들어온 요청(Cloudflare·Caddy가 알려 준 원래 주소)일 때만 */
export function wantsSecure(mode: CookieSecure, req: { secure?: boolean; headers: Record<string, string | string[] | undefined> }): boolean {
  if (mode !== 'auto') return mode === 'on';
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim().toLowerCase();
  if (first === 'https') return true;
  const visitor = req.headers['cf-visitor'];
  return typeof visitor === 'string' && /"scheme"\s*:\s*"https"/.test(visitor);
}

// ─────────────────────────── 가드 판정 ───────────────────────────

/** @LoginRequired(): 로그인만 확인하고 권한은 처리기 안에서 assertCan으로 (요청 내용에 따라 권한이 갈릴 때) */
export const LOGIN_ONLY = 'login' as const;
export type Need = PermCode | typeof LOGIN_ONLY | undefined;

export type Decision = { ok: true } | { ok: false; status: 401 | 403; message: string };

export function deniedMessage(perm: PermCode, role: Role): string {
  return `${PERM_NAMES[perm]} 권한이 없습니다 (${ROLE_NAMES[role]})`;
}

/**
 * 처리기에 필요한 것(@Perm·@LoginRequired) + 쿠키의 사용자 → 통과·401·403.
 * 인증을 끄면(AUTH=off) 늘 통과. 아무것도 붙지 않은 처리기(조회·AI 비서 질문)는 로그인 없이 열린다
 */
export function decide(need: Need, actor: ActorInfo | null, enabled: boolean): Decision {
  if (!enabled || !need) return { ok: true };
  if (!actor) return { ok: false, status: 401, message: LOGIN_REQUIRED };
  if (need === LOGIN_ONLY || can(actor.role, need)) return { ok: true };
  return { ok: false, status: 403, message: deniedMessage(need, actor.role) };
}

/** 설비 명령에 필요한 권한: 수리 완료·보전 실시는 보전 권한, 나머지(정지·셋업·재가동·고장 등록)는 설비 조작 권한 */
export function stationOpPerm(op: StationOp): PermCode {
  return op === 'repair' || op === 'pm' ? 'station.repair' : 'station.op';
}

// ─────────────────────────── 로그인 시도 제한 ───────────────────────────

/** 키(IP)별로 최근 windowMs 안의 시도를 센다. 막힌 시도는 세지 않는다 (기다리면 풀린다) */
export class AttemptLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly max = LOGIN_MAX_PER_MIN,
    readonly windowMs = 60_000,
  ) {}

  /** 시도 하나를 센다. 한도를 넘었으면 다시 해도 되는 때까지 남은 ms, 아니면 0 */
  take(key: string, now = Date.now()): number {
    const from = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > from);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return Math.max(1, list[0] + this.windowMs - now);
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 5000) this.prune(now);
    return 0;
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (!v.length || v[v.length - 1] <= now - this.windowMs) this.hits.delete(k);
  }
}

// ─────────────────────────── 서명 키 ───────────────────────────

const MIN_SECRET = 32;

/**
 * 쿠키 서명 키: AUTH_SECRET → 키 파일(server/.auth-secret) → 없으면 무작위로 만들어 키 파일에 저장 (재시작해도 로그인이 유지된다).
 * 키 파일은 git에 올리지 않는다 (.gitignore)
 */
export function loadSecret(env: NodeJS.ProcessEnv, file: string, log: (msg: string) => void = () => {}): Buffer {
  const fromEnv = (env.AUTH_SECRET ?? '').trim();
  if (fromEnv) {
    if (fromEnv.length < MIN_SECRET) log(`AUTH_SECRET이 ${MIN_SECRET}자보다 짧습니다. 길고 무작위인 값을 쓰세요`);
    return Buffer.from(fromEnv, 'utf8');
  }
  try {
    const saved = readFileSync(file, 'utf8').trim();
    if (saved.length >= MIN_SECRET) return Buffer.from(saved, 'utf8');
    log(`서명 키 파일이 비었거나 짧아 새로 만듭니다: ${file}`);
  } catch {
    /* 처음 기동: 아래에서 만든다 */
  }
  const made = randomBytes(32).toString('base64url');
  try {
    writeFileSync(file, `${made}\n`, { encoding: 'utf8', mode: 0o600 });
    log(`로그인 서명 키를 새로 만들어 저장했습니다: ${file}`);
  } catch (e) {
    log(`서명 키를 저장하지 못했습니다 (${(e as Error).message}). 서버를 다시 띄우면 로그인이 풀립니다`);
  }
  return Buffer.from(made, 'utf8');
}

/** 감사 기록에 남길 '시도한 아이디': 비밀번호를 아이디 칸에 잘못 넣은 경우까지 그대로 남지 않게 모양이 맞을 때만 */
export function safeLoginLabel(v: string): string {
  return /^[A-Za-z0-9._-]{1,40}$/.test(v) ? v : '(형식 밖)';
}
