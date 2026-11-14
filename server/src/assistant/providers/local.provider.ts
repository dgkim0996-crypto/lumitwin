import type { AssistantUsage } from '@lumitwin/shared';
import type { ToolOutcome } from '../assistant.common';
import { turnContext } from '../assistant.prompt';
import { TOOL_DEFS, toolLabel } from '../assistant.tools';
import { LlmError, toOaiTools, type OaiMessage, type OpenAiCompatClient, type RawToolCall } from './openai-compat';
import type { AssistantProvider, TurnInput } from './provider';

/** 한 질문에서 모델을 부르는 최대 횟수 (Claude 모드와 같다). 마지막 번에는 도구를 빼서 지금까지 모은 것으로 답하게 한다 */
const MAX_STEPS = 6;
/** 한 질문에서 잘못된 도구 호출(없는 도구·JSON 깨짐)을 봐주는 횟수. 넘으면 멈추고 알린다 */
const MAX_BAD_CALLS = 2;
/** 한 단계 답 길이 (assumed: 로컬 모델 문맥 8~32K를 생각해 작게) */
const MAX_TOKENS = 4096;
/** 도구를 고르는 일이라 낮게 둔다 (assumed) */
const TEMPERATURE = 0.2;

const OAI_TOOLS = toOaiTools(TOOL_DEFS);
const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

/** 도구 실행기 (AssistantTools). 테스트는 가짜를 넣는다 */
export interface ToolRunner {
  run(name: string, input: Record<string, unknown>): Promise<ToolOutcome>;
}

/** 잘못된 도구 호출 하나를 검사한 결과 */
type Checked = { ok: true; id: string; name: string; input: Record<string, unknown>; raw: RawToolCall } | { ok: false; id: string; name: string; reason: string; raw: RawToolCall };

/**
 * 로컬 오픈소스 LLM(OpenAI 호환 서버)으로 답한다. Claude 모드와 같은 시스템 프롬프트·같은 도구·같은 이벤트를 쓴다.
 * - 질문마다 바뀌는 문맥(가상 시각·보고 있는 화면)은 사용자 메시지 앞에 붙인다.
 *   일부 모델 템플릿(Qwen 등)은 시스템 메시지가 맨 앞에만 와야 해서, Claude 모드처럼 대화 중 시스템 메시지를 넣지 않는다
 * - 작은 모델은 도구 호출을 틀리게 만들기도 한다(없는 도구, 깨진 JSON). 그 호출은 실행하지 않고, 화면에 실패로 보이고,
 *   모델에게 오류를 돌려 한 번 더 고칠 기회를 준다. 한 질문에서 MAX_BAD_CALLS를 넘으면 멈추고 한국어로 알린다
 */
export class LocalProvider implements AssistantProvider {
  readonly mode = 'local' as const;

  constructor(
    private readonly client: OpenAiCompatClient,
    private readonly system: string,
    private readonly tools: ToolRunner,
    private readonly virtualNow: () => string | null,
  ) {}

  get model(): string | null {
    return this.client.modelName;
  }

  async run({ conv, message, context, emit, signal }: TurnInput): Promise<AssistantUsage> {
    const model = await this.client.resolveModel();
    conv.oai.push({ role: 'user', content: `[문맥]\n${turnContext({ virtualTime: this.virtualNow(), ...context })}\n\n[질문]\n${message}` });
    const usage: AssistantUsage = { input: 0, output: 0, cacheRead: 0, calls: 0 };
    let bad = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      const last = step === MAX_STEPS - 1;
      const messages: OaiMessage[] = [{ role: 'system', content: this.system }, ...conv.oai];
      const res = await this.client.stream({ model, messages, tools: last ? undefined : OAI_TOOLS, temperature: TEMPERATURE, maxTokens: MAX_TOKENS }, (delta) => emit({ type: 'text', delta }), signal);
      usage.calls++;
      if (res.usage) {
        usage.input += res.usage.input;
        usage.output += res.usage.output;
      }

      if (!res.toolCalls.length) {
        if (!res.content) emit({ type: 'text', delta: '로컬 모델이 빈 답을 돌려줬습니다. 질문을 바꿔 다시 물어봐 주세요.' });
        conv.oai.push({ role: 'assistant', content: res.content });
        return usage;
      }
      if (last) throw new LlmError(`로컬 모델이 도구를 ${MAX_STEPS}번 넘게 부르려 해서 멈췄습니다. 질문을 나눠 물어봐 주세요`, 'tools');
      if (res.finish === 'length') throw new LlmError('답이 너무 길어 도구 호출이 잘렸습니다. 질문을 나눠 주세요', 'tools');

      const checked = res.toolCalls.map((c, i) => check(c, `call_${step}_${i}`));
      conv.oai.push({
        role: 'assistant',
        content: res.content || null,
        tool_calls: checked.map((c) => ({ id: c.id, type: 'function', function: { name: c.name || 'invalid', arguments: c.ok ? JSON.stringify(c.input) : '{}' } })),
      });
      for (const c of checked) {
        emit({ type: 'tool', id: c.id, name: c.name || '(이름 없음)', label: c.ok ? toolLabel(c.name, c.input) : `잘못된 도구 호출 · ${c.name || '(이름 없음)'}`, input: c.ok ? c.input : {} });
      }
      const results = await Promise.all(
        checked.map(async (c): Promise<OaiMessage> => {
          if (!c.ok) {
            emit({ type: 'tool_result', id: c.id, ok: false, summary: `로컬 모델이 만든 도구 호출이 잘못돼 실행하지 않았습니다 (${c.reason})`, refs: [] });
            return { role: 'tool', tool_call_id: c.id, content: JSON.stringify({ error: `잘못된 도구 호출: ${c.reason}. 아래 도구 중 하나를 JSON 객체 인자로 다시 부르거나, 조회한 것으로 답하라`, available_tools: [...TOOL_NAMES] }) };
          }
          const out = await this.tools.run(c.name, c.input);
          emit({ type: 'tool_result', id: c.id, ok: out.ok, summary: out.summary, refs: out.refs });
          return { role: 'tool', tool_call_id: c.id, content: JSON.stringify(out.ok ? out.data : { error: out.summary, ...(out.data as object) }) };
        }),
      );
      conv.oai.push(...results);
      bad += checked.filter((c) => !c.ok).length;
      if (bad > MAX_BAD_CALLS) {
        throw new LlmError(
          `로컬 모델이 도구 호출을 제대로 만들지 못했습니다(잘못된 호출 ${bad}번). 도구 호출을 지원하는 모델(예: Qwen3, Llama 3.1 이상)로 바꾸거나 질문을 더 구체적으로 해 주세요`,
          'tools',
        );
      }
    }
    return usage;
  }
}

/** 모델이 만든 도구 호출을 실행 전에 검사한다: 있는 도구인가, 인자가 JSON 객체인가 */
function check(c: RawToolCall, fallbackId: string): Checked {
  const id = c.id || fallbackId;
  const name = c.name.trim();
  if (!name) return { ok: false, id, name, reason: '도구 이름이 없음', raw: c };
  if (!TOOL_NAMES.has(name)) return { ok: false, id, name, reason: `없는 도구 ${name.slice(0, 40)}`, raw: c };
  let v: unknown;
  try {
    v = c.arguments.trim() ? JSON.parse(c.arguments) : {};
  } catch {
    return { ok: false, id, name, reason: `${name}의 인자 JSON이 깨짐`, raw: c };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, id, name, reason: `${name}의 인자가 JSON 객체가 아님`, raw: c };
  return { ok: true, id, name, input: v as Record<string, unknown>, raw: c };
}
