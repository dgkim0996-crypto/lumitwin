import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, UnauthorizedException, type OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import { AUTH_COOKIE, DEMO_USERS, SYSTEM_ACTOR, type ActorInfo } from '@lumitwin/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import {
  AttemptLimiter,
  authConfigFromEnv,
  hashPassword,
  isRole,
  loadSecret,
  parseCookies,
  safeLoginLabel,
  sessionSig,
  signSession,
  verifyPassword,
  verifySession,
  wantsSecure,
  type AuthConfig,
} from './auth.core';

const WRONG = '아이디 또는 비밀번호가 맞지 않습니다';

export interface LoginResult {
  actor: ActorInfo;
  token: string;
  expiresAt: string;
}

/**
 * 로그인·쿠키. 서버에 세션 표를 두지 않고 서명한 쿠키(login·role·name·만료)만 믿는다.
 * 로그아웃한 쿠키는 만료 때까지 메모리에 기억해 다시 받지 않는다 (재시작하면 잊는다: 한계는 notes-E 참고)
 */
@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger('Auth');
  readonly config: AuthConfig = authConfigFromEnv();
  /** 쿠키 서명 키. 인증을 끄면 파일을 만들지 않는다 */
  private readonly secret: Buffer = this.config.enabled
    ? loadSecret(process.env, path.resolve(process.cwd(), '.auth-secret'), (m) => this.logger.warn(m))
    : randomBytes(32);
  private readonly limiter = new AttemptLimiter();
  /** 로그아웃한 쿠키의 서명 → 만료(ms) */
  private readonly revoked = new Map<string, number>();
  /** 없는 아이디도 해시 계산 시간이 같게 비교할 가짜 해시 */
  private dummy: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** 로그인 화면의 계정 버튼으로 비밀번호 없이 바로 들어갈 수 있나 (DEMO_PASSWORD를 따로 정하지 않았을 때) */
  get demoLogin(): boolean {
    return this.config.enabled && this.config.demoLogin;
  }

  async onModuleInit() {
    if (!this.config.enabled) {
      this.logger.warn('인증 꺼짐 (AUTH=off): 로그인 없이 모든 요청을 시스템 사용자로 처리합니다');
      return;
    }
    try {
      await this.seedDemoUsers();
      this.logger.log(
        `인증 켜짐: 시연 계정 ${DEMO_USERS.map((u) => u.login).join('·')} (${this.config.demoLogin ? '기본 비밀번호 · 로그인 화면 계정 버튼으로 바로 로그인' : 'DEMO_PASSWORD'})`,
      );
    } catch (e) {
      this.logger.error(`시연 계정을 만들지 못했습니다: ${(e as Error).message}`);
    }
  }

  /** 시연 계정을 app_user에 맞춘다. 비밀번호가 DEMO_PASSWORD와 다르면(바꿨으면) 새 해시로 바꾼다 */
  async seedDemoUsers(): Promise<void> {
    for (const u of DEMO_USERS) {
      const cur = await this.prisma.user.findUnique({ where: { login: u.login } });
      if (cur && (await verifyPassword(this.config.demoPassword, cur.passHash))) {
        if (cur.name !== u.name || cur.role !== u.role || !cur.active) {
          await this.prisma.user.update({ where: { id: cur.id }, data: { name: u.name, role: u.role, active: true } });
        }
        continue;
      }
      const passHash = await hashPassword(this.config.demoPassword);
      await this.prisma.user.upsert({
        where: { login: u.login },
        create: { login: u.login, name: u.name, role: u.role, passHash },
        update: { name: u.name, role: u.role, passHash, active: true },
      });
    }
  }

  /** 요청 쿠키의 사용자. 쿠키가 없거나 위조·만료·로그아웃이면 null. 인증을 끄면 시스템 */
  actorOf(req: Pick<Request, 'headers'>): ActorInfo | null {
    if (!this.config.enabled) return SYSTEM_ACTOR;
    const token = parseCookies(req.headers.cookie)[AUTH_COOKIE];
    const s = verifySession(token, this.secret);
    if (!s || this.revoked.has(sessionSig(token!))) return null;
    return { login: s.login, name: s.name, role: s.role };
  }

  /** 이 요청에 내려 줄 쿠키에 Secure를 붙일지 */
  secureFor(req: Request): boolean {
    return wantsSecure(this.config.cookieSecure, req);
  }

  /**
   * 로그인. demo면 비밀번호 없이 시연 계정으로 (기본 비밀번호를 쓰는 서버만).
   * 성공·실패 모두 감사 기록에 남긴다. IP별 1분 10회를 넘으면 429
   */
  async login(loginRaw: unknown, passwordRaw: unknown, demo: boolean, ip: string): Promise<LoginResult> {
    if (!this.config.enabled) throw new BadRequestException('인증이 꺼져 있습니다 (AUTH=off). 로그인 없이 모든 기능을 쓸 수 있습니다');
    const wait = this.limiter.take(ip);
    if (wait > 0) {
      this.logger.warn(`로그인 시도 한도 초과: ${ip}`);
      throw new HttpException(`로그인 시도가 너무 많습니다. ${Math.ceil(wait / 1000)}초 뒤에 다시 해 주세요`, HttpStatus.TOO_MANY_REQUESTS);
    }
    const login = typeof loginRaw === 'string' ? loginRaw.trim().slice(0, 40) : '';
    if (!login) throw new BadRequestException('아이디를 넣어 주세요');
    const label = safeLoginLabel(login);

    if (demo && !this.demoLogin) throw new BadRequestException('이 서버는 시연 계정에도 비밀번호가 필요합니다 (DEMO_PASSWORD). 아래 양식에 넣어 주세요');
    const password = typeof passwordRaw === 'string' ? passwordRaw.slice(0, 200) : '';
    if (!demo && !password) throw new BadRequestException('비밀번호를 넣어 주세요');

    const user = await this.prisma.user.findUnique({ where: { login } });
    let ok: boolean;
    if (demo) {
      ok = !!user && DEMO_USERS.some((d) => d.login === login);
    } else {
      // 없는 아이디도 같은 시간이 걸리게 가짜 해시와 비교한다 (응답 시간으로 아이디가 있는지 알아내지 못하게)
      ok = await verifyPassword(password, user?.passHash ?? (await this.dummyHash()));
    }
    if (!ok || !user || !user.active || !isRole(user.role)) {
      await this.audit.logAnonymous('login.fail', label, { reason: !user ? 'unknown-user' : !user.active ? 'inactive' : 'bad-password', ...(demo ? { demo: true } : {}) }, ip);
      throw new UnauthorizedException(WRONG);
    }
    const actor: ActorInfo = { login: user.login, name: user.name, role: user.role };
    const now = Date.now();
    const token = signSession(actor, this.secret, now);
    const exp = verifySession(token, this.secret, now)!.exp;
    await this.audit.log(actor, 'login', actor.login, demo ? { demo: true } : null, ip);
    return { actor, token, expiresAt: new Date(exp).toISOString() };
  }

  /** 로그아웃: 이 쿠키를 만료 때까지 다시 받지 않는다. 로그인해 있던 사용자를 돌려준다 (감사 기록용) */
  logout(req: Pick<Request, 'headers'>): ActorInfo | null {
    if (!this.config.enabled) return null;
    const token = parseCookies(req.headers.cookie)[AUTH_COOKIE];
    const s = verifySession(token, this.secret);
    if (!s || this.revoked.has(sessionSig(token!))) return null;
    const now = Date.now();
    for (const [k, exp] of this.revoked) if (exp <= now) this.revoked.delete(k);
    this.revoked.set(sessionSig(token!), s.exp);
    return { login: s.login, name: s.name, role: s.role };
  }

  private dummyHash(): Promise<string> {
    this.dummy ??= hashPassword(randomBytes(16).toString('hex'));
    return this.dummy;
  }
}
