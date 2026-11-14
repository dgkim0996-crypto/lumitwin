import Anthropic from '@anthropic-ai/sdk';
import type { AssistantMode, TbmItem, TbmLine } from '@lumitwin/shared';
import type { Effort } from '../assistant/llm.settings';
import type { OpenAiCompatClient } from '../assistant/providers/openai-compat';
import { tbmSchema, tbmSystemPrompt, tbmUserPrompt } from './tbm.prompt';
import { ruleJudge } from './tbm.rules';

/** 판정기에 함께 주는 회의 정보 */
export interface JudgeContext {
  lineName: string;
  shiftLabel: string;
  part?: { index: number; total: number };
}

/** TBM 대조 판정기. 출력은 믿을 수 없는 값(unknown)이고, 서비스가 parseJudge → validate로 확인한다 */
export interface TbmJudge {
  readonly mode: AssistantMode;
  readonly model: string | null;
  /** 한 번에 보낼 전사 글자 수. 넘으면 조각으로 나눠 판정하고 합친다 */
  readonly chunkChars: number;
  /** 조각끼리 겹치는 줄 수 */
  readonly overlap: number;
  judge(items: TbmItem[], lines: TbmLine[], ctx: JudgeContext, signal?: AbortSignal): Promise<unknown>;
}

/** 모의 모드: 낱말 규칙 (tbm.rules.ts). 전사 전체를 한 번에 본다 */
export class MockJudge implements TbmJudge {
  readonly mode = 'mock' as const;
  readonly model = null;
  readonly chunkChars = Number.MAX_SAFE_INTEGER;
  readonly overlap = 0;

  async judge(items: TbmItem[], lines: TbmLine[]): Promise<unknown> {
    return { items: ruleJudge(items, lines) };
  }
}

/**
 * 로컬 오픈소스 LLM (OpenAI 호환 서버). 회의 음성·대화록이 이 망 밖으로 나가지 않는다.
 * 작은 모델의 문맥 길이(8~32K 토큰)를 생각해 전사를 12,000자(한국어 약 6~8K 토큰) 조각으로 나눈다 (assumed)
 */
export class LocalJudge implements TbmJudge {
  readonly mode = 'local' as const;
  readonly chunkChars = 12_000;
  readonly overlap = 8;

  constructor(private readonly client: OpenAiCompatClient) {}

  get model(): string | null {
    return this.client.modelName;
  }

  async judge(items: TbmItem[], lines: TbmLine[], ctx: JudgeContext, signal?: AbortSignal): Promise<unknown> {
    const model = await this.client.resolveModel();
    const out = await this.client.json(
      {
        model,
        messages: [
          { role: 'system', content: tbmSystemPrompt() },
          { role: 'user', content: tbmUserPrompt(items, lines, ctx) },
        ],
        schema: tbmSchema(items.map((i) => i.code)),
        temperature: 0,
        maxTokens: 4096,
      },
      signal,
    );
    return out.value;
  }
}

/**
 * Claude API. 구조화 출력(output_config.format)으로 JSON 모양을 정하고, 거절되면 서버 쪽 대체 모델이 잇는다(fallbacks).
 * 전사 한도(60,000자)가 문맥에 넉넉히 들어가므로 나누지 않는다
 */
export class ClaudeJudge implements TbmJudge {
  readonly mode = 'claude' as const;
  readonly chunkChars = 200_000;
  readonly overlap = 0;
  private readonly client = new Anthropic({ maxRetries: 2 });

  constructor(
    readonly model: string,
    private readonly effort: Effort,
  ) {}

  async judge(items: TbmItem[], lines: TbmLine[], ctx: JudgeContext, signal?: AbortSignal): Promise<unknown> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 16_000,
        system: tbmSystemPrompt(),
        messages: [{ role: 'user', content: tbmUserPrompt(items, lines, ctx) }],
        thinking: { type: 'adaptive' },
        output_config: { effort: this.effort, format: { type: 'json_schema', schema: tbmSchema(items.map((i) => i.code)).schema } },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal },
    );
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('Claude가 이 대화록 판정을 거절했습니다. 대화록 내용을 확인해 다시 올려 주세요');
    if (msg.stop_reason === 'max_tokens') throw new Error('판정 결과가 너무 길어 잘렸습니다. 대화록을 나눠 올려 주세요');
    const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Claude 판정 결과를 JSON으로 읽지 못했습니다');
    }
  }
}
