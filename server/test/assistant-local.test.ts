import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AssistantEvent } from '@lumitwin/shared';
import type { ToolOutcome } from '../src/assistant/assistant.common';
import { AssistantService } from '../src/assistant/assistant.service';
import { LOCAL_DEFAULT_BASE, resolveLlmSettings } from '../src/assistant/llm.settings';
import { LocalProvider, type ToolRunner } from '../src/assistant/providers/local.provider';
import { HiddenBlocks, LlmError, OpenAiCompatClient, parseJsonText } from '../src/assistant/providers/openai-compat';
import type { Conversation } from '../src/assistant/providers/provider';

// 실제 로컬 LLM 없이, OpenAI 호환 /chat/completions 를 흉내 내는 가짜 서버로 로컬 모드를 검증한다.
// 가짜 서버는 받은 요청을 적어 두고, 미리 넣어 둔 응답을 차례로 돌려준다.

type Responder = (req: Recorded, res: ServerResponse) => unknown;
interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

let server: Server;
let base = '';
const queue: Responder[] = [];
const seen: Recorded[] = [];

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      const rec: Recorded = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(rec);
      const next = queue.shift();
      if (!next) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: '테스트 응답이 준비되지 않음' } }));
        return;
      }
      void next(rec, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  queue.length = 0;
  seen.length = 0;
});

const tick = () => new Promise((r) => setImmediate(r));

/** SSE로 조각을 보낸다. data 줄 하나를 일부러 두 번에 나눠 써서 버퍼 처리도 확인한다 */
function sse(chunks: unknown[]): Responder {
  return async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const c of chunks) {
      const line = `data: ${JSON.stringify(c)}\n\n`;
      const cut = Math.floor(line.length / 2);
      res.write(line.slice(0, cut));
      await tick();
      res.write(line.slice(cut));
      await tick();
    }
    res.end('data: [DONE]\n\n');
  };
}
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
/** 텍스트 답 하나를 여러 조각으로 */
const textAnswer = (...parts: string[]) => sse([...parts.map((p) => delta({ content: p })), delta({}, 'stop'), { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } }]);
/** 도구 호출 하나. 이름·인자를 조각으로 나눠 보낸다 (실제 서버들이 이렇게 준다) */
function toolCall(name: string, args: string, id = 'call_a'): Responder {
  const half = Math.floor(args.length / 2);
  return sse([
    delta({ role: 'assistant', content: '' }),
    delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }),
    delta({}, 'tool_calls'),
  ]);
}

/** 불린 도구를 적어 두는 가짜 도구 실행기 */
function fakeTools() {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const runner: ToolRunner = {
    run: async (name, input): Promise<ToolOutcome> => {
      calls.push({ name, input });
      return { ok: true, data: { station: input.station ?? null, state: 'RUN', oee: 0.82 }, summary: '설비 상태 1건', refs: [{ kind: 'station', id: String(input.station ?? ''), label: String(input.station ?? '') }] };
    },
  };
  return { runner, calls };
}

const newConv = (): Conversation => ({ id: 't', createdAt: 0, updatedAt: 0, busy: false, messages: [], oai: [], memo: {} });

function setup(model: string | null = 'qwen3-test', apiKey: string | null = null) {
  const client = new OpenAiCompatClient({ baseUrl: base, model, apiKey });
  const tools = fakeTools();
  const provider = new LocalProvider(client, '시스템 프롬프트(테스트)', tools.runner, () => '2026-11-14T09:00:00+09:00');
  return { client, provider, ...tools };
}

async function ask(provider: LocalProvider, message: string, conv = newConv()) {
  const events: AssistantEvent[] = [];
  const usage = await provider.run({ conv, message, context: { page: '/' }, emit: (e) => events.push(e), signal: new AbortController().signal });
  const text = events.filter((e): e is Extract<AssistantEvent, { type: 'text' }> => e.type === 'text').map((e) => e.delta).join('');
  return { events, text, usage, conv };
}

describe('로컬 LLM 모드 (OpenAI 호환 서버)', () => {
  it('조각난 도구 호출을 모아 실행하고, 결과를 돌려준 뒤 답을 스트리밍한다', async () => {
    const { provider, calls } = setup('qwen3-test', 'local-test-key');
    queue.push(toolCall('station_status', '{"station":"HL-IM-L1"}'));
    queue.push(textAnswer('<thi', 'nk>설비 상태를 보고 답한다</th', 'ink>\n\nHL-IM-L1은 ', '가동 중이고 OEE는 82%입니다.'));
    const { events, text, usage, conv } = await ask(provider, 'HL-IM-L1 상태 어때?');

    // 도구는 한 번, 모델이 준 인자 그대로
    assert.deepEqual(calls, [{ name: 'station_status', input: { station: 'HL-IM-L1' } }]);
    const tool = events.find((e) => e.type === 'tool');
    assert.ok(tool && tool.type === 'tool');
    assert.equal(tool.label, '설비 상태 조회 · HL-IM-L1');
    const result = events.find((e) => e.type === 'tool_result');
    assert.ok(result && result.type === 'tool_result' && result.ok);
    // 생각 글은 화면에 나가지 않고, 앞 빈 줄도 없다
    assert.equal(text, 'HL-IM-L1은 가동 중이고 OEE는 82%입니다.');
    assert.equal(usage.calls, 2);
    assert.equal(usage.input, 120);

    // 요청 모양: 시스템 프롬프트가 맨 앞, 도구 정의 포함, 문맥은 사용자 메시지 앞에, API 키는 헤더로만
    const [first, second] = seen;
    assert.equal(first.path, '/v1/chat/completions');
    assert.equal(first.body.model, 'qwen3-test');
    assert.equal(first.body.stream, true);
    assert.equal(first.body.messages[0].role, 'system');
    assert.equal(first.body.messages.filter((m: { role: string }) => m.role === 'system').length, 1);
    assert.match(first.body.messages[1].content, /^\[문맥\][\s\S]*2026-11-14[\s\S]*\[질문\]\nHL-IM-L1 상태 어때\?$/);
    assert.ok(first.body.tools.some((t: { function: { name: string } }) => t.function.name === 'station_status'));
    assert.equal(first.headers.authorization, 'Bearer local-test-key');
    assert.ok(!JSON.stringify(first.body).includes('local-test-key'));
    // 두 번째 요청에는 도구 결과가 tool 메시지로 들어간다
    const toolMsg = second.body.messages.find((m: { role: string }) => m.role === 'tool');
    assert.equal(toolMsg.tool_call_id, 'call_a');
    assert.equal(JSON.parse(toolMsg.content).oee, 0.82);

    // 대화 기록: user → assistant(tool_calls) → tool → assistant(답)
    assert.deepEqual(conv.oai.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
    assert.equal((conv.oai[3] as { content: string }).content, 'HL-IM-L1은 가동 중이고 OEE는 82%입니다.');
  });

  it('없는 도구를 부르면 실행하지 않고 실패로 보이고, 모델이 고쳐 답할 기회를 준다', async () => {
    const { provider, calls } = setup();
    queue.push(toolCall('drop_all_tables', '{}', 'call_x'));
    queue.push(textAnswer('조회 없이 답하면, 지금은 확인할 수 없습니다.'));
    const { events, text } = await ask(provider, '테이블 지워');

    assert.equal(calls.length, 0);
    const tool = events.find((e) => e.type === 'tool');
    assert.ok(tool && tool.type === 'tool');
    assert.match(tool.label, /^잘못된 도구 호출 · drop_all_tables/);
    const result = events.find((e) => e.type === 'tool_result');
    assert.ok(result && result.type === 'tool_result');
    assert.equal(result.ok, false);
    assert.match(result.summary, /실행하지 않았습니다 \(없는 도구 drop_all_tables\)/);
    // 모델에게는 오류와 쓸 수 있는 도구 목록을 돌려준다
    const back = JSON.parse(seen[1].body.messages.find((m: { role: string }) => m.role === 'tool').content);
    assert.match(back.error, /잘못된 도구 호출/);
    assert.ok(back.available_tools.includes('station_status'));
    assert.equal(text, '조회 없이 답하면, 지금은 확인할 수 없습니다.');
  });

  it('인자 JSON이 깨진 호출은 실행하지 않는다', async () => {
    const { provider, calls } = setup();
    queue.push(toolCall('station_status', '{"station": "HL-IM-L1"', 'call_b'));
    queue.push(textAnswer('다시 확인해 주세요.'));
    const { events } = await ask(provider, 'HL-IM-L1 상태');
    assert.equal(calls.length, 0);
    const result = events.find((e) => e.type === 'tool_result');
    assert.ok(result && result.type === 'tool_result' && !result.ok);
    assert.match(result.summary, /station_status의 인자 JSON이 깨짐/);
  });

  it('잘못된 호출이 되풀이되면 멈추고 한국어로 모델을 바꾸라고 알린다', async () => {
    const { provider, calls } = setup();
    for (let i = 0; i < 3; i++) queue.push(toolCall('no_such_tool', '{}', `call_${i}`));
    const conv = newConv();
    await assert.rejects(ask(provider, '아무거나', conv), (e: unknown) => {
      assert.ok(e instanceof LlmError);
      assert.equal(e.kind, 'tools');
      assert.match(e.message, /도구 호출을 제대로 만들지 못했습니다\(잘못된 호출 3번\)/);
      assert.match(e.message, /Qwen3/);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it('도구 호출을 글로 흘린 모델(<tool_call> 블록)도 알아듣고, 그 글은 화면에 내보내지 않는다', async () => {
    const { provider, calls } = setup();
    queue.push(textAnswer('확인해 볼게요.<tool_', 'call>{"name": "station_status", "arguments": {"station": "EM-PR-L"}}</tool_call>'));
    queue.push(textAnswer('EM-PR-L은 가동 중입니다.'));
    const { text } = await ask(provider, 'EM-PR-L 상태');
    assert.deepEqual(calls, [{ name: 'station_status', input: { station: 'EM-PR-L' } }]);
    assert.ok(!text.includes('tool_call'));
    assert.ok(!text.includes('"name"'));
    assert.match(text, /^확인해 볼게요\.EM-PR-L은 가동 중입니다\.$/);
  });

  it('스트리밍을 무시하고 JSON 한 번에 답하는 서버도 받는다', async () => {
    const { provider } = setup();
    queue.push((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '한 번에 온 답입니다.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
    const { text, usage } = await ask(provider, '안녕');
    assert.equal(text, '한 번에 온 답입니다.');
    assert.equal(usage.output, 5);
  });

  it('LLM_MODEL이 없으면 서버 모델 목록의 첫 모델(임베딩 제외)을 쓴다', async () => {
    const { provider, client } = setup(null);
    queue.push((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'text-embedding-nomic' }, { id: 'qwen3-8b' }, { id: 'llama-3.1-8b' }] }));
    });
    queue.push(textAnswer('네.'));
    assert.equal(provider.model, null);
    await ask(provider, '안녕');
    assert.equal(seen[0].path, '/v1/models');
    assert.equal(seen[1].body.model, 'qwen3-8b');
    assert.equal(client.modelName, 'qwen3-8b');
  });

  it('모델이 없다는 404와 도구 미지원 400을 현장 문장으로 바꾼다', async () => {
    const { provider } = setup('none-model');
    queue.push((_req, res) => res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'model "none-model" not found' } })));
    await assert.rejects(ask(provider, '안녕'), (e: unknown) => e instanceof LlmError && e.kind === 'model' && /LLM_MODEL을 확인/.test(e.message));

    queue.push((_req, res) => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'this model does not support tools' } })));
    await assert.rejects(ask(provider, '안녕'), (e: unknown) => e instanceof LlmError && e.kind === 'tools' && /도구 호출을 지원하지 않습니다/.test(e.message));
  });

  it('서버가 꺼져 있으면 연결 오류를 한국어로 알린다', async () => {
    // 잠깐 열었다 닫은 포트 = 아무도 듣지 않는 주소
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const client = new OpenAiCompatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: null });
    const provider = new LocalProvider(client, 's', fakeTools().runner, () => null);
    await assert.rejects(ask(provider, '안녕'), (e: unknown) => {
      assert.ok(e instanceof LlmError);
      assert.equal(e.kind, 'connect');
      assert.match(e.message, new RegExp(`로컬 LLM 서버\\(127\\.0\\.0\\.1:${port}\\)에 연결하지 못했습니다`));
      return true;
    });
    await assert.rejects(client.models(1_000), (e: unknown) => e instanceof LlmError && e.kind === 'connect');
  });

  it('JSON 응답: json_schema를 모르는 서버(400)면 형식 없이 다시 묻고, 코드 블록 속 JSON을 꺼낸다', async () => {
    const client = new OpenAiCompatClient({ baseUrl: base, model: 'm', apiKey: null });
    queue.push((_req, res) => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: "'response_format.type' must be 'json_object' or 'text'" } })));
    queue.push((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '<think>생각</think>결과입니다:\n```json\n{"items":[{"code":"PPE"}]}\n```' } }] })));
    const out = await client.json({ model: 'm', messages: [{ role: 'user', content: 'x' }], schema: { name: 'tbm', schema: { type: 'object' } } });
    assert.deepEqual(out.value, { items: [{ code: 'PPE' }] });
    assert.equal(seen[0].body.response_format.type, 'json_schema');
    assert.equal(seen[0].body.response_format.json_schema.name, 'tbm');
    assert.equal(seen[1].body.response_format, undefined);
    assert.throws(() => parseJsonText('JSON이 없음'), (e: unknown) => e instanceof LlmError && e.kind === 'format');
  });
});

describe('생각 글·<tool_call> 숨김 (조각 경계)', () => {
  it('태그가 조각 사이에 걸쳐도 숨기고, 태그 아닌 < 는 그대로 둔다', () => {
    let out = '';
    const h = new HiddenBlocks((s) => (out += s));
    for (const c of ['  <', 'think>비밀', '</thi', 'nk>\n답: 3 < 5', ' 이고 <tool', '_call>{"name":"x"}</tool_c', 'all> 끝']) h.push(c);
    h.flush();
    assert.equal(out, '답: 3 < 5 이고  끝');
    assert.deepEqual(h.toolBlocks, ['{"name":"x"}']);
  });

  it('닫히지 않은 블록은 끝에서 버리되 도구 블록은 모은다', () => {
    let out = '';
    const h = new HiddenBlocks((s) => (out += s));
    h.push('앞<tool_call>{"name":"a","arguments":{}}');
    h.flush();
    assert.equal(out, '앞');
    assert.deepEqual(h.toolBlocks, ['{"name":"a","arguments":{}}']);
  });
});

describe('응답기 고르기 (환경 변수)', () => {
  it('local은 명시해야만 고르고, auto는 지금처럼 키가 있으면 Claude, 없으면 모의 모드', () => {
    assert.equal(resolveLlmSettings({}).mode, 'mock');
    assert.equal(resolveLlmSettings({ ANTHROPIC_API_KEY: 'x' }).mode, 'claude');
    // LLM_BASE_URL만 있어도 auto는 local로 가지 않는다
    assert.equal(resolveLlmSettings({ LLM_BASE_URL: 'http://127.0.0.1:11434/v1' }).mode, 'mock');
    const local = resolveLlmSettings({ ASSISTANT_PROVIDER: 'local', ANTHROPIC_API_KEY: 'x' });
    assert.equal(local.mode, 'local');
    assert.ok(local.mode === 'local');
    assert.equal(local.local.baseUrl, LOCAL_DEFAULT_BASE);
    assert.equal(local.local.model, null);
    const ollama = resolveLlmSettings({ ASSISTANT_PROVIDER: 'LOCAL', LLM_BASE_URL: 'http://127.0.0.1:11434/v1/', LLM_MODEL: ' qwen3:8b ' });
    assert.ok(ollama.mode === 'local');
    assert.equal(ollama.local.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(ollama.local.model, 'qwen3:8b');
  });
});

describe('AI 비서 서비스 — 로컬 모드', () => {
  const saved = { ...process.env };
  after(() => {
    for (const k of ['ASSISTANT_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY']) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** 서비스를 만들고, 시작할 때 모델 목록으로 연결을 확인하는 요청까지 끝나기를 기다린다 */
  async function service() {
    process.env.ASSISTANT_PROVIDER = 'local';
    process.env.LLM_BASE_URL = base;
    process.env.LLM_MODEL = 'qwen3-test';
    delete process.env.LLM_API_KEY;
    const live = { virtualNow: null } as never;
    const standards = { size: 0 } as never;
    const stt = { available: async () => false, model: null } as never;
    const svc = new AssistantService(fakeTools().runner as never, live, standards, stt);
    queue.push((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'qwen3-test' }] })));
    svc.onModuleInit();
    for (let i = 0; i < 100 && queue.length; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen.at(-1)?.path, '/v1/models');
    seen.length = 0;
    return svc;
  }

  it('화면 정보에 로컬 모드·모델·주소를 주고, 외부 전송이 아니라고 표시한다', async () => {
    const svc = await service();
    const info = await svc.info();
    assert.equal(info.mode, 'local');
    assert.equal(info.model, 'qwen3-test');
    assert.equal(info.external, false);
    assert.equal(info.endpoint, new URL(base).host);
  });

  it('실패한 질문은 대화 기록에서 빠져, 다음 질문이 짝 안 맞는 기록 없이 나간다', async () => {
    const svc = await service();

    const events: AssistantEvent[] = [];
    // 첫 질문: 도구 호출 뒤 서버 오류
    queue.push(toolCall('station_status', '{"station":"HL-IM-L1"}'));
    queue.push((_req, res) => res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'out of memory' } })));
    await svc.chat({ message: 'HL-IM-L1 상태?' }, (e) => events.push(e), new AbortController().signal);
    const err = events.find((e) => e.type === 'error');
    assert.ok(err && err.type === 'error');
    assert.equal(err.message, '로컬 LLM 서버 오류(500): out of memory');
    const start = events.find((e) => e.type === 'start');
    assert.ok(start && start.type === 'start');
    assert.equal(start.mode, 'local');

    // 같은 대화로 다시 물으면 앞 질문의 tool_calls·tool 기록 없이 새 질문만 간다
    seen.length = 0;
    queue.push(textAnswer('가동 중입니다.'));
    const again: AssistantEvent[] = [];
    await svc.chat({ message: '다시', conversationId: start.conversationId }, (e) => again.push(e), new AbortController().signal);
    assert.ok(again.some((e) => e.type === 'done'));
    assert.deepEqual(seen[0].body.messages.map((m: { role: string }) => m.role), ['system', 'user']);
  });
});
