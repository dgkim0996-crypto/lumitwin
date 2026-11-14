import type Anthropic from '@anthropic-ai/sdk';
import type { AssistantEvent, AssistantMode, AssistantUsage, LineCode } from '@lumitwin/shared';
import type { OaiMessage } from './openai-compat';

/** 대화 하나. Claude 모드는 messages에 도구 호출·생각 블록까지 그대로 쌓는다(덧붙이기만 한다) */
export interface Conversation {
  id: string;
  createdAt: number;
  updatedAt: number;
  busy: boolean;
  messages: Anthropic.Beta.Messages.BetaMessageParam[];
  /** 로컬 LLM 모드의 기록 (OpenAI 형식: assistant.tool_calls · role tool). 시스템 프롬프트는 넣지 않고 부를 때마다 앞에 붙인다 */
  oai: OaiMessage[];
  /** 모의 모드가 "그 설비" 같은 이어 묻기를 알아듣게 기억해 두는 것 */
  memo: { station?: string; line?: LineCode };
}

export interface TurnInput {
  conv: Conversation;
  message: string;
  context: { page?: string; station?: string | null };
  emit: (e: AssistantEvent) => void;
  signal: AbortSignal;
}

export interface AssistantProvider {
  readonly mode: AssistantMode;
  readonly model: string | null;
  run(turn: TurnInput): Promise<AssistantUsage | undefined>;
}
