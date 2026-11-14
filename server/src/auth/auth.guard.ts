import { ForbiddenException, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { decide, type Need } from './auth.core';
import { AuthService } from './auth.service';
import { PERM_KEY, type AuthedRequest } from './perm.decorator';

/**
 * 전역 가드 (APP_GUARD): 쿠키 → req.actor. @Perm·@LoginRequired가 붙은 처리기만 401·403으로 막는다.
 * 공개 링크 보기 전용(main.ts의 미들웨어)이 이보다 먼저 돈다: 보기 전용 접속의 쓰기 요청은 로그인 여부와 상관없이 거기서 막힌다
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    // 실시간 소켓(socket.io)은 읽기 전용 방송이라 막지 않는다
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<Request & AuthedRequest>();
    const actor = this.auth.actorOf(req);
    if (actor) req.actor = actor;
    else req.anonymous = true;
    const need = this.reflector.getAllAndOverride<Need>(PERM_KEY, [ctx.getHandler(), ctx.getClass()]);
    const d = decide(need, actor, this.auth.enabled);
    if (d.ok) return true;
    throw d.status === 401 ? new UnauthorizedException(d.message) : new ForbiddenException(d.message);
  }
}
