import { endpointLabel, type LocalLlmConfig } from '../llm.settings';

// 사내에서 띄운 오픈소스 LLM 서버(LM Studio·Ollama·vLLM·llama.cpp server 등)의 OpenAI 호환 /chat/completions를
// 새 패키지 없이 fetch로 부른다. 스트리밍(SSE)·도구 호출(tools/tool_calls)·JSON 응답(response_format)을 다룬다.
// 판타스틸 ERP llm.client.ts의 방식을 이 프로젝트에 필요한 만큼만 옮겼다.

export interface OaiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OaiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface OaiTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 모델이 만든 그대로의 도구 호출 (이름·인자 글은 아직 검사 전) */
export interface RawToolCall {
  id: string | null;
  name: string;
  arguments: string;
  /** 서버가 tool_calls로 준 것인지, 답 글 속 <tool_call> 블록에서 꺼낸 것인지 */
  from: 'tool_calls' | 'text';
}

export interface StreamResult {
  content: string;
  toolCalls: RawToolCall[];
  finish: string | null;
  usage: { input: number; output: number } | null;
}

export type LlmErrorKind = 'connect' | 'timeout' | 'model' | 'tools' | 'http' | 'format' | 'aborted';

/** 로컬 LLM 오류. message는 현장 사용자가 읽을 한국어 문장이다 (API 키는 넣지 않는다) */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: LlmErrorKind,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** 첫 응답(모델을 처음 불러오면 느리다)과 스트리밍 조각 사이에 기다리는 시간 (assumed) */
const FIRST_BYTE_MS = 120_000;
const IDLE_MS = 60_000;
/** JSON 응답 한 번(긴 전사 한 조각 판정)을 기다리는 시간. CPU에서 도는 작은 모델을 생각해 넉넉히 (assumed) */
const JSON_TIMEOUT_MS = Math.max(30, Number(process.env.LLM_TIMEOUT_SEC) || 300) * 1000;

export class OpenAiCompatClient {
  private resolved: string | null = null;
  readonly host: string;

  constructor(
    readonly cfg: LocalLlmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.host = endpointLabel(cfg.baseUrl);
  }

  /** 정한 모델(LLM_MODEL) 또는 처음 확인한 모델. 아직 모르면 null */
  get modelName(): string | null {
    return this.cfg.model ?? this.resolved;
  }

  private headers(json = true): Record<string, string> {
    return { ...(json ? { 'content-type': 'application/json' } : {}), ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) };
  }

  /** 서버에 있는 모델 목록 (GET /models). 임베딩 모델은 뺀다 */
  async models(timeoutMs = 2_000): Promise<string[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}/models`, { headers: this.headers(false), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw this.connectError(e);
    }
    if (!res.ok) throw new LlmError(`로컬 LLM 서버가 모델 목록 요청에 오류(${res.status})로 답했습니다. LLM_BASE_URL이 …/v1 까지 맞는지 확인해 주세요`, 'http', res.status);
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: unknown }[] };
    return (body.data ?? []).map((m) => (typeof m.id === 'string' ? m.id : '')).filter((id) => id && !/embed/i.test(id));
  }

  /** 부를 모델. LLM_MODEL이 없으면 서버가 알려 주는 첫 모델 */
  async resolveModel(): Promise<string> {
    if (this.modelName) return this.modelName;
    const list = await this.models(5_000);
    if (!list.length) throw new LlmError(`로컬 LLM 서버(${this.host})에 불러온 모델이 없습니다. LM Studio·Ollama에서 모델을 불러오거나 LLM_MODEL을 정해 주세요`, 'model');
    this.resolved = list[0];
    return list[0];
  }

  /**
   * 대화 한 단계를 스트리밍으로 받는다. 답 글은 오는 대로 onText로 넘기고(생각 글·<tool_call> 블록은 숨긴다),
   * 도구 호출은 조각을 모아 끝에 돌려준다. 서버가 스트리밍을 무시하고 JSON 한 번에 주면 그것도 받는다.
   */
  async stream(
    req: { model: string; messages: OaiMessage[]; tools?: OaiTool[]; temperature?: number; maxTokens?: number },
    onText: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<StreamResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(req.temperature != null ? { temperature: req.temperature } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.tools?.length ? { tools: req.tools, tool_choice: 'auto' } : {}),
    };
    const timer = new AbortController();
    let clock = setTimeout(() => timer.abort(), FIRST_BYTE_MS);
    const bump = () => {
      clearTimeout(clock);
      clock = setTimeout(() => timer.abort(), IDLE_MS);
    };
    const combined = AbortSignal.any([signal, timer.signal]);
    const hidden = new HiddenBlocks(onText);
    const calls = new Map<number, { id: string | null; name: string; arguments: string }>();
    let content = '';
    let finish: string | null = null;
    let usage: StreamResult['usage'] = null;

    const onChunk = (chunk: StreamChunk) => {
      if (chunk.error) throw new LlmError(`로컬 LLM 서버 오류: ${errText(chunk.error)}`, 'http');
      if (chunk.usage) usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finish = choice.finish_reason;
      // 스트리밍을 무시한 서버: delta 대신 message가 온다
      const d = choice.delta ?? choice.message;
      if (!d) return;
      if (typeof d.content === 'string' && d.content) {
        content += d.content;
        hidden.push(d.content);
      }
      for (const [i, c] of (d.tool_calls ?? []).entries()) {
        const idx = typeof c.index === 'number' ? c.index : i;
        const e = calls.get(idx) ?? { id: null, name: '', arguments: '' };
        if (c.id) e.id = c.id;
        if (c.function?.name) e.name += c.function.name;
        if (c.function?.arguments != null) e.arguments += typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments);
        calls.set(idx, e);
      }
    };

    try {
      const res = await this.post('/chat/completions', body, combined, () => timer.signal.aborted);
      bump();
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('text/event-stream') && type.includes('json')) {
        onChunk((await res.json()) as StreamChunk);
      } else {
        const reader = res.body?.getReader();
        if (!reader) throw new LlmError('로컬 LLM 서버 응답을 읽을 수 없습니다', 'http');
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read().catch((e: unknown) => {
            throw this.readError(e, signal, timer.signal);
          });
          if (done) break;
          bump();
          buf += decoder.decode(value, { stream: true });
          for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            dataLine(line, onChunk);
          }
        }
        dataLine((buf + decoder.decode()).trim(), onChunk);
      }
      hidden.flush();
    } finally {
      clearTimeout(clock);
    }

    const toolCalls: RawToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]) => ({ id: c.id, name: c.name.trim(), arguments: c.arguments, from: 'tool_calls' as const }));
    // 서버가 도구 호출을 해석하지 못하고 글로 흘린 경우(Qwen·Hermes 형식 <tool_call>{"name":…,"arguments":…}</tool_call>)
    if (!toolCalls.length) for (const block of hidden.toolBlocks) toolCalls.push(parseTextToolCall(block));
    return { content: stripHidden(content).trim(), toolCalls, finish, usage };
  }

  /**
   * JSON 스키마로 답 모양을 정해 한 번 부른다 (스트리밍 없음). 서버가 response_format을 몰라 400이면 형식 없이 다시 부른다
   * (프롬프트가 JSON만 달라고 요구한다). 모델이 쓴 값은 믿을 수 없으므로 unknown으로 돌려주고 부르는 쪽이 검증한다
   */
  async json(
    req: { model: string; messages: OaiMessage[]; schema: { name: string; schema: Record<string, unknown> }; temperature?: number; maxTokens?: number },
    signal?: AbortSignal,
  ): Promise<{ value: unknown; text: string; usage: { input: number; output: number } | null }> {
    const base = { model: req.model, messages: req.messages, stream: false, temperature: req.temperature ?? 0, ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}) };
    const timer = AbortSignal.timeout(JSON_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timer]) : timer;
    let res: Response;
    try {
      res = await this.post('/chat/completions', { ...base, response_format: { type: 'json_schema', json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema } } }, combined, () => timer.aborted);
    } catch (e) {
      if (!(e instanceof LlmError) || e.kind !== 'http' || e.status !== 400) throw e;
      res = await this.post('/chat/completions', base, combined, () => timer.aborted);
    }
    const body = (await res.json().catch(() => null)) as StreamChunk | null;
    const msg = body?.choices?.[0]?.message;
    // 일부 추론 모델은 형식을 강제해도 JSON을 reasoning_content에 담고 content를 비운다
    const raw = (typeof msg?.content === 'string' && msg.content.trim() ? msg.content : (msg?.reasoning_content ?? '')) as string;
    const text = stripHidden(raw).trim();
    const usage = body?.usage ? { input: body.usage.prompt_tokens ?? 0, output: body.usage.completion_tokens ?? 0 } : null;
    return { value: parseJsonText(text), text, usage };
  }

  /** POST 하나. 연결·HTTP 오류를 현장 문장으로 바꾼다 */
  private async post(path: string, body: unknown, signal: AbortSignal, timedOut: () => boolean): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    } catch (e) {
      if (timedOut()) throw new LlmError(`로컬 LLM(${this.host})이 응답하지 않습니다. 모델이 너무 크거나 서버가 바쁜지 확인해 주세요`, 'timeout');
      if (signal.aborted) throw new LlmError('요청을 멈췄습니다', 'aborted');
      throw this.connectError(e);
    }
    if (res.ok) return res;
    const text = (await res.text().catch(() => '')).slice(0, 400);
    const detail = errText(safeJson(text)?.error ?? text) || res.statusText;
    const model = (body as { model?: string }).model ?? '';
    if (res.status === 404 && /model/i.test(detail)) {
      throw new LlmError(`로컬 LLM 서버에 모델 '${model}'이(가) 없습니다. LLM_MODEL을 확인하거나 LM Studio·Ollama에서 모델을 불러와 주세요`, 'model', 404);
    }
    if (res.status === 400 && /tool/i.test(detail) && (body as { tools?: unknown }).tools) {
      throw new LlmError(`이 모델(${model})이나 서버는 도구 호출을 지원하지 않습니다. 도구 호출을 지원하는 모델(예: Qwen3, Llama 3.1 이상)을 불러와 주세요`, 'tools', 400);
    }
    throw new LlmError(`로컬 LLM 서버 오류(${res.status}): ${detail}`, 'http', res.status);
  }

  private connectError(e: unknown): LlmError {
    const code = (e as { cause?: { code?: string } })?.cause?.code;
    return new LlmError(
      `로컬 LLM 서버(${this.host})에 연결하지 못했습니다${code ? ` (${code})` : ''}. LM Studio·Ollama가 켜져 있는지, LLM_BASE_URL을 확인해 주세요`,
      'connect',
    );
  }

  private readError(e: unknown, user: AbortSignal, idle: AbortSignal): LlmError {
    if (user.aborted) return new LlmError('요청을 멈췄습니다', 'aborted');
    if (idle.aborted) return new LlmError(`로컬 LLM(${this.host})이 답하다가 ${IDLE_MS / 1000}초 동안 멈췄습니다`, 'timeout');
    return new LlmError(`로컬 LLM 응답을 받다가 연결이 끊겼습니다: ${(e as Error)?.message ?? e}`, 'connect');
  }
}

/** 도구 정의(Anthropic 모양: name·description·input_schema)를 OpenAI 모양으로 */
export function toOaiTools(defs: readonly { name: string; description?: string; input_schema: unknown }[]): OaiTool[] {
  return defs.map((d) => ({ type: 'function', function: { name: d.name, description: d.description ?? '', parameters: d.input_schema as Record<string, unknown> } }));
}

// ───────────── 내부 도우미 ─────────────

interface StreamChunk {
  error?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: {
    finish_reason?: string | null;
    delta?: ChunkDelta;
    message?: ChunkDelta;
  }[];
}

interface ChunkDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: unknown } }[];
}

function dataLine(line: string, onChunk: (c: StreamChunk) => void): void {
  if (!line.startsWith('data:')) return;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return;
  let chunk: StreamChunk;
  try {
    chunk = JSON.parse(data) as StreamChunk;
  } catch {
    return; // 깨진 한 줄은 건너뛴다
  }
  onChunk(chunk);
}

function safeJson(text: string): { error?: unknown } | null {
  try {
    return JSON.parse(text) as { error?: unknown };
  } catch {
    return null;
  }
}

function errText(e: unknown): string {
  if (typeof e === 'string') return e.slice(0, 300);
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return ((e as { message: string }).message).slice(0, 300);
  return '';
}

/** 생각 글과 <tool_call> 블록을 뺀 답 글 */
export function stripHidden(s: string): string {
  return s
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/^[\s\S]*?<\/think>/, '') // 여는 태그 없이 생각이 먼저 온 경우 (템플릿이 <think>를 넣어 둔 모델)
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '');
}

/** JSON만 달라고 했는데 코드 블록·앞뒤 말을 붙인 답에서 JSON을 꺼낸다 */
export function parseJsonText(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new LlmError('로컬 LLM이 JSON 형식으로 답하지 않았습니다', 'format');
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    throw new LlmError('로컬 LLM이 보낸 JSON이 깨져 있습니다', 'format');
  }
}

/** <tool_call> 블록 하나 → 도구 호출. 깨져 있으면 이름 없이 돌려주고 부르는 쪽이 잘못된 호출로 다룬다 */
function parseTextToolCall(block: string): RawToolCall {
  try {
    const v = JSON.parse(block.trim()) as { name?: unknown; arguments?: unknown };
    const name = typeof v.name === 'string' ? v.name : '';
    const args = typeof v.arguments === 'string' ? v.arguments : JSON.stringify(v.arguments ?? {});
    return { id: null, name, arguments: args, from: 'text' };
  } catch {
    return { id: null, name: '', arguments: block.trim().slice(0, 500), from: 'text' };
  }
}

/**
 * 스트리밍 글에서 <think>…</think>와 <tool_call>…</tool_call>을 숨긴다. 태그가 조각 경계에 걸쳐도 되게
 * 태그 앞부분일 수 있는 끝 글자는 다음 조각이 올 때까지 잡아 둔다. <tool_call> 안쪽 글은 모아 둔다
 */
export class HiddenBlocks {
  private buf = '';
  private inside: 'think' | 'tool_call' | null = null;
  private captured = '';
  private started = false;
  readonly toolBlocks: string[] = [];

  constructor(private readonly emit: (s: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    this.drain(false);
  }

  flush(): void {
    this.drain(true);
  }

  private out(s: string): void {
    // 생각 블록 뒤의 빈 줄로 답이 시작하지 않게 앞 공백은 버린다
    const t = this.started ? s : s.replace(/^\s+/, '');
    if (!t) return;
    this.started = true;
    this.emit(t);
  }

  private drain(final: boolean): void {
    for (;;) {
      if (!this.inside) {
        const m = /<(think|tool_call)>/.exec(this.buf);
        if (m) {
          this.out(this.buf.slice(0, m.index));
          this.inside = m[1] as 'think' | 'tool_call';
          this.buf = this.buf.slice(m.index + m[0].length);
          continue;
        }
        const lt = this.buf.lastIndexOf('<');
        const tail = lt >= 0 ? this.buf.slice(lt) : '';
        if (!final && tail && ('<think>'.startsWith(tail) || '<tool_call>'.startsWith(tail))) {
          this.out(this.buf.slice(0, lt));
          this.buf = tail;
          return;
        }
        this.out(this.buf);
        this.buf = '';
        return;
      }
      const close = `</${this.inside}>`;
      const i = this.buf.indexOf(close);
      if (i >= 0) {
        if (this.inside === 'tool_call') this.toolBlocks.push(this.captured + this.buf.slice(0, i));
        this.captured = '';
        this.buf = this.buf.slice(i + close.length);
        this.inside = null;
        continue;
      }
      if (final) {
        if (this.inside === 'tool_call') this.toolBlocks.push(this.captured + this.buf);
        this.captured = '';
        this.buf = '';
        return;
      }
      const keep = Math.min(this.buf.length, close.length - 1);
      if (this.inside === 'tool_call') this.captured += this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      return;
    }
  }
}
