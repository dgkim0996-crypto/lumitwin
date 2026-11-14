import { ForbiddenException, SetMetadata, UnauthorizedException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { can, SYSTEM_ACTOR, type ActorInfo, type PermCode } from '@lumitwin/shared';
import { deniedMessage, LOGIN_ONLY, LOGIN_REQUIRED } from './auth.core';

/** 이 처리기에 필요한 권한 (AuthGuard가 읽는다). 붙이지 않은 처리기는 로그인 없이 열린다 (조회) */
export const PERM_KEY = 'lumitwin:perm';
export const Perm = (perm: PermCode) => SetMetadata(PERM_KEY, perm);

/**
 * 로그인만 확인한다 (로그인 안 했으면 401). 권한은 처리기 안에서 요청 내용을 보고 assertCan으로 고른다.
 * 예: 설비 명령은 수리 완료·보전만 보전 권한
 */
export const LoginRequired = () => SetMetadata(PERM_KEY, LOGIN_ONLY);

/** AuthGuard가 요청에 붙이는 표시 */
export interface AuthedRequest {
  /** 로그인한 사용자 (인증을 끄면 시스템) */
  actor?: ActorInfo;
  /** 인증이 켜져 있는데 로그인하지 않은 요청 */
  anonymous?: boolean;
}

/**
 * AuthGuard가 요청에 붙여 둔 사용자. 인증을 끄면(AUTH=off) 또는 가드가 돌지 않은 요청(테스트 등)은 시스템.
 * 인증이 켜져 있는데 로그인하지 않은 요청이면 401을 던진다 (@Perm을 빠뜨린 처리기에서도 익명을 관리자로 보지 않게)
 */
export function actorOf(req: Request): ActorInfo {
  const r = req as Request & AuthedRequest;
  if (r.actor) return r.actor;
  if (r.anonymous) throw new UnauthorizedException(LOGIN_REQUIRED);
  return SYSTEM_ACTOR;
}

/** 로그인 안 했으면 null (열린 처리기에서 '누가'를 선택적으로 볼 때) */
export function actorOrNull(req: Request): ActorInfo | null {
  const r = req as Request & AuthedRequest;
  return r.actor ?? (r.anonymous ? null : SYSTEM_ACTOR);
}

/** 처리기 인자로 사용자 받기: `create(@Body() b, @Actor() who: ActorInfo)` */
export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): ActorInfo => actorOf(ctx.switchToHttp().getRequest<Request>()));

/** 처리기 안에서 권한 확인 (요청 내용에 따라 필요한 권한이 갈릴 때. 예: 설비 명령 중 수리 완료만 보전 권한) */
export function assertCan(actor: ActorInfo, perm: PermCode): void {
  if (!can(actor.role, perm)) throw new ForbiddenException(deniedMessage(perm, actor.role));
}
