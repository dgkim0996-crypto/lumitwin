import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { CONTROL_KEY_HEADER } from '@lumitwin/shared';
import { accessConfigFromEnv, clientIp, createAccess } from '../src/access/access';

/** Express 요청 흉내 (판정에 쓰는 필드만) */
function req(method: string, path: string, headers: Record<string, string> = {}, ip = '127.0.0.1') {
  return { method, path, headers, ip } as unknown as Request;
}

/** 미들웨어를 돌려 통과했는지·막혔는지 본다 */
function run(guard: (q: Request, s: Response, n: NextFunction) => void, q: Request) {
  let status = 0;
  let passed = false;
  const res = { status: (c: number) => ((status = c), res), json: () => res } as unknown as Response;
  guard(q, res, () => (passed = true));
  return passed ? 'pass' : status;
}

const CF = { 'cf-ray': '8f-ICN', 'cf-connecting-ip': '203.0.113.7' };

describe('공개 링크 보기 전용', () => {
  it('환경 변수: 기본은 tunnel, 모르는 값도 tunnel', () => {
    assert.deepEqual(accessConfigFromEnv({}), { mode: 'tunnel', controlKey: '' });
    assert.equal(accessConfigFromEnv({ READ_ONLY: ' ALL ' }).mode, 'all');
    assert.equal(accessConfigFromEnv({ READ_ONLY: 'off' }).mode, 'off');
    assert.equal(accessConfigFromEnv({ READ_ONLY: 'yes' }).mode, 'tunnel');
  });

  describe('READ_ONLY=tunnel', () => {
    const a = createAccess({ mode: 'tunnel', controlKey: 'demo-key-1234' });

    it('이 PC·같은 망에서 온 요청은 조작할 수 있다', () => {
      assert.deepEqual(a.accessOf(req('GET', '/api/v1/access')), { readOnly: false, unlockable: false });
      assert.equal(run(a.guard, req('POST', '/api/v1/sim/reset')), 'pass');
    });

    it('Cloudflare를 거쳐 온 쓰기 요청은 403', () => {
      assert.deepEqual(a.accessOf(req('GET', '/api/v1/access', CF)), { readOnly: true, unlockable: true });
      for (const p of ['/api/v1/sim/speed', '/api/v1/sim/reset', '/api/v1/sim/station', '/api/v1/operator/checks', '/api/v1/live/alarms/3/ack']) {
        assert.equal(run(a.guard, req('POST', p, CF)), 403, p);
      }
    });

    it('읽기와 AI 비서 질문·받아쓰기는 통과한다', () => {
      assert.equal(run(a.guard, req('GET', '/api/v1/production/summary', CF)), 'pass');
      assert.equal(run(a.guard, req('OPTIONS', '/api/v1/sim/reset', CF)), 'pass');
      assert.equal(run(a.guard, req('POST', '/api/v1/assistant/chat', CF)), 'pass');
      assert.equal(run(a.guard, req('POST', '/api/v1/assistant/transcribe', CF)), 'pass');
    });

    it('맞는 제어 키를 실으면 조작할 수 있고, 틀린 키·길이가 다른 키는 막힌다', () => {
      const ok = req('POST', '/api/v1/sim/reset', { ...CF, [CONTROL_KEY_HEADER]: 'demo-key-1234' });
      assert.equal(run(a.guard, ok), 'pass');
      assert.deepEqual(a.accessOf(ok), { readOnly: false, unlockable: true });
      assert.equal(run(a.guard, req('POST', '/api/v1/sim/reset', { ...CF, [CONTROL_KEY_HEADER]: 'demo-key-1235' })), 403);
      assert.equal(run(a.guard, req('POST', '/api/v1/sim/reset', { ...CF, [CONTROL_KEY_HEADER]: 'demo' })), 403);
    });
  });

  it('제어 키가 없으면 풀 수 없다', () => {
    const a = createAccess({ mode: 'tunnel', controlKey: '' });
    const q = req('POST', '/api/v1/sim/reset', { ...CF, [CONTROL_KEY_HEADER]: '' });
    assert.deepEqual(a.accessOf(q), { readOnly: true, unlockable: false });
    assert.equal(run(a.guard, q), 403);
  });

  it('READ_ONLY=all이면 Cloudflare 머리글이 없어도 막는다', () => {
    const a = createAccess({ mode: 'all', controlKey: 'k' });
    assert.equal(run(a.guard, req('POST', '/api/v1/sim/pause')), 403);
    assert.equal(run(a.guard, req('POST', '/api/v1/sim/pause', { [CONTROL_KEY_HEADER]: 'k' })), 'pass');
  });

  it('READ_ONLY=off면 공개 링크도 조작할 수 있다', () => {
    const a = createAccess({ mode: 'off', controlKey: '' });
    assert.equal(run(a.guard, req('POST', '/api/v1/sim/reset', CF)), 'pass');
    assert.equal(a.accessOf(req('GET', '/api/v1/access', CF)).readOnly, false);
  });

  it('질문 한도용 IP: 공개 링크는 Cloudflare가 알려 준 접속 IP, 아니면 req.ip', () => {
    assert.equal(clientIp(req('POST', '/api/v1/assistant/chat', CF)), '203.0.113.7');
    assert.equal(clientIp(req('POST', '/api/v1/assistant/chat', {}, '192.168.0.5')), '192.168.0.5');
    // CF-Ray 없이 CF-Connecting-IP만 보내 IP를 바꿔 치려는 요청은 믿지 않는다
    assert.equal(clientIp(req('POST', '/api/v1/assistant/chat', { 'cf-connecting-ip': '1.2.3.4' }, '10.0.0.2')), '10.0.0.2');
  });
});
