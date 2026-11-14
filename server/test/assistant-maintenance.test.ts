import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PM_REASON, STATIONS, type AssistantEvent } from '@lumitwin/shared';
import { AssistantTools } from '../src/assistant/assistant.tools';
import { MockProvider } from '../src/assistant/providers/mock.provider';
import { buildMaintenance, type HaltRow } from '../src/maintenance/maintenance';

const T0 = Date.parse('2026-11-12T00:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000);
const row = (station: string, state: string, from: number, to: number | null, reason: string | null = null): HaltRow => ({
  station, state, reason, at: at(from), end: to == null ? null : at(to),
});
const MOLD = 'HL-IM-L1';
const PRINTER = 'EM-PR-L';

// 사출기 고장 4번(하나는 수리 중), 옆 사출기도 같은 사유로 한 번, 인쇄기는 계획 보전 주기(8시간)를 넘겼다
const MOLD_R = 'HL-IM-R1';
const report = buildMaintenance(
  [
    row(MOLD_R, 'DOWN', 500, 505, '노즐 막힘'),
    row(MOLD, 'DOWN', 60, 80, '히터 단선'),
    row(MOLD, 'DOWN', 200, 230, '노즐 막힘'),
    row(MOLD, 'STOP', 300, 330, PM_REASON),
    row(MOLD, 'DOWN', 400, 410, '노즐 막힘'),
    row(MOLD, 'DOWN', 590, null, '노즐 막힘 (작업자 등록)'),
  ],
  { runStartMs: T0, nowMs: T0 + 600 * 60_000 },
);

/** 보전 도구만 진짜로 돌리고, 나머지 도구는 불린 것만 적어 둔다 */
function setup() {
  const tools = new AssistantTools({} as never, {} as never, {} as never, {} as never, { report: async () => report } as never, {} as never);
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const spy = {
    run: async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      return name === 'maintenance' ? tools.run(name, input) : { ok: false, data: { error: 'test' }, summary: 'test', refs: [] };
    },
  };
  return { tools, calls, provider: new MockProvider(spy as never) };
}

async function ask(provider: MockProvider, message: string): Promise<string> {
  let text = '';
  const emit = (e: AssistantEvent) => {
    if (e.type === 'text') text += e.delta;
  };
  const conv = { id: 't', createdAt: 0, updatedAt: 0, busy: false, messages: [], memo: {} };
  // 다른 도구는 실패를 돌려주므로 그쪽 답 틀이 깨질 수 있다. 여기서는 어느 도구로 갔는지만 본다
  await provider.run({ conv, message, context: {}, emit, signal: new AbortController().signal }).catch(() => undefined);
  return text;
}

describe('AI 비서 설비 보전 도구', () => {
  it('라인으로 거르고, 고장 많은 설비·계획 보전 급한 설비·사유를 돌려준다', async () => {
    const { tools } = setup();
    const out = await tools.run('maintenance', { line: 'HL' });
    assert.equal(out.ok, true);
    const d = out.data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(d.totals.failures, 5);
    assert.equal(d.totals.downNow, 1);
    assert.equal(d.worstStations[0].station, MOLD);
    assert.equal(d.worstStations[0].fewSamples, false);
    assert.equal(d.worstStations[1].fewSamples, true);
    assert.equal(d.worstStations.every((s: { station: string }) => STATIONS[s.station].line === 'HL'), true);
    assert.equal(d.reasons[0].reason, '노즐 막힘');
    assert.equal(d.reasons[0].count, 4);
    assert.deepEqual(d.reasons[0].stations.sort(), [MOLD, MOLD_R].sort());
    assert.equal(d.recentFailures[0].repairing, true);
    assert.ok(out.refs.some((r) => r.kind === 'page' && r.id === '/maintenance'));

    // 전장 라인은 인쇄기의 계획 보전 초과가 보인다
    const em = (await tools.run('maintenance', { line: 'EM' })).data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const pr = em.pmUrgent.find((p: { station: string }) => p.station === PRINTER);
    assert.equal(pr.status, '초과');
    assert.ok(pr.leftH < 0);
  });

  it('설비 하나를 고르면 그 설비의 실적·계획 보전·점검을 준다', async () => {
    const { tools } = setup();
    const d = (await tools.run('maintenance', { station: MOLD })).data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(d.station.station, MOLD);
    assert.equal(d.station.failures, 4);
    assert.equal(d.station.downNow, true);
    assert.equal(d.station.lastFailure.repairing, true);
    assert.equal(d.station.pm.last, '11-12 14:30');
    assert.equal(d.station.lastCheck, null);
    assert.equal(d.worstStations, undefined);
  });

  it('모의 모드: 고장 이력·보전 질문은 보전 도구로, 지금 고장 대응 질문은 공장 현황으로 간다', async () => {
    const a = setup();
    const text = await ask(a.provider, '고장 잦은 설비랑 계획 보전 밀린 설비 알려 줘');
    assert.deepEqual(a.calls.map((c) => c.name), ['maintenance']);
    assert.equal(a.calls[0].input.station, undefined);
    assert.match(text, /고장 시간이 큰 설비/);
    assert.match(text, /계획 보전이 급한 설비/);
    assert.match(text, /공통 원인/);
    assert.doesNotMatch(text, /undefined|NaN/);

    const b = setup();
    const one = await ask(b.provider, `${MOLD} MTBF 어때?`);
    assert.deepEqual(b.calls.map((c) => [c.name, c.input.station]), [['maintenance', MOLD]]);
    assert.match(one, /설계/);
    assert.doesNotMatch(one, /undefined|NaN/);

    const c = setup();
    await ask(c.provider, '고장 난 설비 있어? 조치 방법도 알려 줘');
    assert.equal(c.calls[0]?.name, 'factory_overview');
  });
});
