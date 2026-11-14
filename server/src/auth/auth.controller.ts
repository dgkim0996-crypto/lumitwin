import { Body, Controller, Get, Header, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuditRow, AuditView, MeView } from '@lumitwin/shared';
import { clientIp } from '../access/access';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { clearedCookie, sessionCookie } from './auth.core';
import { AuthService } from './auth.service';
import { Perm } from './perm.decorator';

const LIMIT_DEFAULT = 200;
const LIMIT_MAX = 1000;

/** 로그인·로그아웃·내 정보, 사용자 목록·감사 기록(관리자) */
@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() body: { login?: unknown; password?: unknown; demo?: unknown }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(body?.login, body?.password, body?.demo === true, clientIp(req));
    res.setHeader('Set-Cookie', sessionCookie(r.token, this.auth.secureFor(req)));
    res.setHeader('Cache-Control', 'no-store');
    return { user: r.actor, expiresAt: r.expiresAt };
  }

  /** 공개 링크 보기 전용이어도 받는다 (권한을 줄이기만 하는 요청) */
  @Post('auth/logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const who = this.auth.logout(req);
    res.setHeader('Set-Cookie', clearedCookie(this.auth.secureFor(req)));
    if (who) await this.audit.log(who, 'logout', who.login, null, clientIp(req));
    return { ok: true };
  }

  @Get('auth/me')
  @Header('Cache-Control', 'no-store')
  me(@Req() req: Request): MeView {
    const enabled = this.auth.enabled;
    return { enabled, user: enabled ? this.auth.actorOf(req) : null, demo: this.auth.demoLogin };
  }

  /** 계정 목록 (관리자). 비밀번호 해시는 내보내지 않는다 */
  @Get('auth/users')
  @Perm('audit.read')
  async users() {
    const rows = await this.prisma.user.findMany({ orderBy: { id: 'asc' }, select: { login: true, name: true, role: true, active: true, createdAt: true } });
    return rows.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() }));
  }

  /** 감사 기록 (새것부터). user는 정확히, action도 정확히 (끝에 *를 붙이면 앞부분이 같은 것: sim* → sim.speed·sim.reset) */
  @Get('audit')
  @Perm('audit.read')
  @Header('Cache-Control', 'no-store')
  async auditLog(@Query('user') user?: string, @Query('action') action?: string, @Query('limit') limit?: string): Promise<AuditView> {
    const take = Math.min(LIMIT_MAX, Math.max(1, Math.floor(Number(limit)) || LIMIT_DEFAULT));
    const u = typeof user === 'string' ? user.trim().slice(0, 40) : '';
    const a = typeof action === 'string' ? action.trim().slice(0, 60) : '';
    const prefix = a.endsWith('*') ? a.slice(0, -1) : null;
    const where = { ...(u ? { user: u } : {}), ...(prefix ? { action: { startsWith: prefix } } : a && prefix === null ? { action: a } : {}) };
    const [rows, actions, users] = await Promise.all([
      this.prisma.actionLog.findMany({ where, orderBy: { id: 'desc' }, take }),
      this.prisma.actionLog.groupBy({ by: ['action'], _count: { _all: true } }),
      this.prisma.actionLog.groupBy({ by: ['user'], _count: { _all: true } }),
    ]);
    return {
      rows: rows.map((r) => ({
        id: r.id.toString(),
        at: r.at.toISOString(),
        vAt: r.vAt ? r.vAt.toISOString() : null,
        runId: r.runId,
        user: r.user,
        role: r.role,
        action: r.action,
        target: r.target,
        detail: r.detail ?? null,
        ip: r.ip,
      })),
      actions: actions.map((x) => ({ action: x.action, count: x._count._all })).sort((p, q) => q.count - p.count),
      users: users.map((x) => ({ user: x.user, count: x._count._all })).sort((p, q) => q.count - p.count),
    };
  }
}
