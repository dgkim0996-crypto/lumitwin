import Anthropic from '@anthropic-ai/sdk';
import { LlmError } from './providers/openai-compat';

/** Claude API·로컬 LLM 오류를 현장 사용자가 읽을 문장으로 (AI 비서와 TBM 대조가 같이 쓴다) */
export function friendly(err: unknown): string {
  if (err instanceof LlmError) return err.message; // 로컬 LLM 오류는 이미 현장 문장이다
  if (err instanceof Anthropic.AuthenticationError) return 'Claude API 키가 맞지 않습니다. ANTHROPIC_API_KEY를 확인해 주세요';
  if (err instanceof Anthropic.PermissionDeniedError) return '이 API 키로는 해당 모델을 쓸 수 없습니다. ASSISTANT_MODEL을 확인해 주세요';
  if (err instanceof Anthropic.NotFoundError) return '모델을 찾지 못했습니다. ASSISTANT_MODEL을 확인해 주세요';
  if (err instanceof Anthropic.RateLimitError) return '요청이 너무 많습니다. 잠시 뒤 다시 물어봐 주세요';
  if (err instanceof Anthropic.APIConnectionError) return 'Claude API에 연결하지 못했습니다. 네트워크를 확인해 주세요';
  if (err instanceof Anthropic.InternalServerError) return 'Claude API가 일시적으로 응답하지 않습니다. 잠시 뒤 다시 물어봐 주세요';
  if (err instanceof Anthropic.BadRequestError) return `요청이 거부됐습니다: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude API 오류(${err.status ?? '?'}): ${err.message}`;
  return (err as Error)?.message || '알 수 없는 오류';
}
