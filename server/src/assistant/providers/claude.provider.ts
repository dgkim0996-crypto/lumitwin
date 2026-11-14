import Anthropic from '@anthropic-ai/sdk';
import type { AssistantUsage } from '@lumitwin/shared';
import { TOOL_DEFS, toolLabel, type AssistantTools } from '../assistant.tools';
import { turnContext } from '../assistant.prompt';
import type { Effort } from '../llm.settings';
import type { AssistantProvider, TurnInput } from './provider';

/** 한 질문에서 모델을 부르는 최대 횟수. 마지막 번에는 도구를 끄고 지금까지 모은 것으로 답하게 한다 */
const MAX_STEPS = 6;
const MAX_TOKENS = 16_000;

export type { Effort } from '../llm.settings';

/**
 * Claude API로 답한다. 도구 호출 루프는 직접 돌린다: 도구 호출·결과를 화면에 실시간으로 보여 주고,
 * 모의 모드와 같은 도구 실행기를 쓰기 위해서다.
 * - 시스템 프롬프트(공장 구조)와 도구 정의는 고정이라 캐시한다
 * - 질문마다 바뀌는 문맥(가상 시각, 보고 있는 화면)은 대화 중 시스템 메시지로 그 질문에만 보인다(clear_at)
 * - 거절(refusal)되면 서버 쪽 대체 모델이 이어 답한다(fallbacks: "default")
 */
export class ClaudeProvider implements AssistantProvider {
  readonly mode = 'claude' as const;
  private readonly client = new Anthropic({ maxRetries: 2 });

  constructor(
    readonly model: string,
    private readonly effort: Effort,
    private readonly system: string,
    private readonly tools: AssistantTools,
    private readonly virtualNow: () => string | null,
  ) {}

  async run({ conv, message, context, emit, signal }: TurnInput): Promise<AssistantUsage> {
    conv.messages.push({ role: 'user', content: message });
    conv.messages.push({ role: 'system', content: turnContext({ virtualTime: this.virtualNow(), ...context }), clear_at: 'next_user_message' });
    const usage: AssistantUsage = { input: 0, output: 0, cacheRead: 0, calls: 0 };
    let jsonRetries = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      const last = step === MAX_STEPS - 1;
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
          tools: TOOL_DEFS,
          tool_choice: last ? { type: 'none' } : { type: 'auto' },
          messages: conv.messages,
          thinking: { type: 'adaptive' },
          output_config: { effort: this.effort },
          betas: ['server-side-fallback-2026-07-01', 'mid-conversation-system-clear-at-2026-08-21'],
          fallbacks: 'default',
        },
        { signal },
      );
      stream.on('text', (delta) => emit({ type: 'text', delta }));

      let msg: Anthropic.Beta.Messages.BetaMessage;
      try {
        msg = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // 도구 입력을 스트리밍으로 받다가 JSON이 깨진 경우만 같은 요청을 다시 보낸다. API 오류는 위로 올린다
        if (err instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw err;
        continue;
      }
      usage.calls++;
      usage.input += msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0);
      usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
      usage.output += msg.usage.output_tokens;

      if (msg.stop_reason === 'refusal') {
        // 대체 모델까지 거절한 경우. 잘린 응답은 대화에 남기지 않는다
        emit({ type: 'text', delta: '\n\n이 요청에는 답할 수 없습니다. 질문을 바꿔 다시 물어봐 주세요.' });
        return usage;
      }
      const uses = msg.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
      if (msg.stop_reason === 'max_tokens' && uses.length) throw new Error('답이 너무 길어 도구 호출이 잘렸습니다. 질문을 나눠 주세요');
      conv.messages.push({ role: 'assistant', content: msg.content });
      if (msg.stop_reason === 'pause_turn') continue;
      if (!uses.length) return usage;

      // 한 번에 부른 도구는 함께 실행하고, 결과는 한 user 메시지에 모아 돌려준다
      for (const u of uses) emit({ type: 'tool', id: u.id, name: u.name, label: toolLabel(u.name, asInput(u.input)), input: asInput(u.input) });
      const results = await Promise.all(
        uses.map(async (u): Promise<Anthropic.Beta.Messages.BetaToolResultBlockParam> => {
          const out = await this.tools.run(u.name, asInput(u.input));
          emit({ type: 'tool_result', id: u.id, ok: out.ok, summary: out.summary, refs: out.refs });
          return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out.data), ...(out.ok ? {} : { is_error: true }) };
        }),
      );
      conv.messages.push({ role: 'user', content: results });
    }
    return usage;
  }
}

/** 도구 입력은 모델이 만든 값이라 객체인지부터 확인한다 */
function asInput(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
