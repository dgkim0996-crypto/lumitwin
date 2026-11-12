import { timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CONTROL_KEY_HEADER, type AccessInfo } from '@lumitwin/shared';

/**
 * 공개 링크 보기 전용.
 * READ_ONLY=tunnel(기본): Cloudflare를 거쳐 온 요청(Cloudflare Tunnel 공개 링크)만 보기 전용. 이 PC·같은 망에서 연 화면은 그대로 조작
 * READ_ONLY=all: 모든 요청이 보기 전용 (서버를 통째로 공개할 때)
 * READ_ONLY=off: 끔
 * CONTROL_KEY를 정해 두면 그 키를 넣은 화면은 보기 전용이어도 조작할 수 있다 (면접장 태블릿 시연 등)
 */
type Mode = 'tunnel' | 'all' | 'off';

const mode: Mode = ((): Mode => {
  const v = (process.env.READ_ONLY ?? 'tunnel').trim().toLowerCase();
  return v === 'all' || v === 'off' ? v : 'tunnel';
})();
const controlKey = (process.env.CONTROL_KEY ?? '').trim();

/** 보기 전용이어도 받는 쓰기 요청: AI 비서 질문과 음성 받아쓰기 (공장 상태를 바꾸지 않는다) */
const ALLOWED_WRITES = new Set(['/api/v1/assistant/chat', '/api/v1/assistant/transcribe']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Cloudflare 가장자리 서버가 붙이는 머리글이 있으면 공개 링크로 들어온 요청이다 */
function viaCloudflare(req: Request): boolean {
  return typeof req.headers['cf-ray'] === 'string';
}

function keyMatches(req: Request): boolean {
  if (!controlKey) return false;
  const got = req.headers[CONTROL_KEY_HEADER];
  if (typeof got !== 'string' || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(controlKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function accessOf(req: Request): AccessInfo {
  const guarded = mode === 'all' || (mode === 'tunnel' && viaCloudflare(req));
  return { readOnly: guarded && !keyMatches(req), unlockable: guarded && !!controlKey };
}

/**
 * 질문 한도를 셀 사용자 IP. Cloudflare를 거쳐 왔으면 Cloudflare가 알려 준 접속 IP를 쓴다
 * (터널 → 화면 서버 → MES로 오면 req.ip는 늘 이 PC 주소라 모든 방문자가 한도 하나를 나눠 쓰게 된다)
 */
export function clientIp(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (viaCloudflare(req) && typeof cf === 'string' && cf) return cf;
  return req.ip ?? 'local';
}

/** 보기 전용인 접속의 쓰기 요청을 403으로 막는다 (main.ts에서 라우터보다 먼저 건다) */
export function readOnlyGuard() {
  if (mode !== 'off') {
    new Logger('Access').log(
      `보기 전용: ${mode === 'all' ? '모든 접속' : 'Cloudflare 공개 링크로 들어온 접속'}${controlKey ? ' · 제어 키를 넣으면 조작 가능' : ''}`,
    );
  }
  return (req: Request, res: Response, next: NextFunction) => {
    if (mode === 'off' || SAFE_METHODS.has(req.method) || !req.path.startsWith('/api/v1/') || ALLOWED_WRITES.has(req.path)) return next();
    if (!accessOf(req).readOnly) return next();
    res.status(403).json({
      statusCode: 403,
      message: '공개 링크는 보기 전용입니다. 설비 조작·시나리오·초기화는 시연자 화면에서만 할 수 있습니다',
    });
  };
}
