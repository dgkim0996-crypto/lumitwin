import type { AssistantMode } from '@lumitwin/shared';

// AI 판정·응답을 누가 하는지 환경 변수로 한 곳에서 정한다. AI 비서(AssistantService)와 TBM 대조(TbmService)가 같은 설정을 쓴다.
//   ASSISTANT_PROVIDER=auto(기본): ANTHROPIC_API_KEY가 있으면 Claude, 없으면 모의 모드
//   ASSISTANT_PROVIDER=claude | local | mock: 강제. local(사내 오픈소스 LLM)은 auto가 고르지 않고 명시적으로만 켠다
//     (켜 놓고 서버를 안 띄우면 질문마다 연결 오류가 나므로, 실수로 켜지지 않게)

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** LM Studio의 OpenAI 호환 주소. Ollama는 http://127.0.0.1:11434/v1 */
export const LOCAL_DEFAULT_BASE = 'http://127.0.0.1:1234/v1';

export interface LocalLlmConfig {
  /** …/v1 까지 (끝의 / 없음) */
  baseUrl: string;
  /** 비우면 서버가 알려 주는 첫 모델(GET /models)을 쓴다 */
  model: string | null;
  apiKey: string | null;
}

export type LlmSettings =
  | { mode: 'claude'; model: string; effort: Effort; hasKey: boolean }
  | { mode: 'local'; local: LocalLlmConfig }
  | { mode: 'mock' };

export function resolveLlmSettings(env: NodeJS.ProcessEnv = process.env): LlmSettings {
  const want = (env.ASSISTANT_PROVIDER ?? 'auto').trim().toLowerCase();
  const hasKey = !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  if (want === 'local') return { mode: 'local', local: localConfig(env) };
  if (want === 'claude' || (want === 'auto' && hasKey)) {
    const effort = (env.ASSISTANT_EFFORT ?? 'medium') as Effort;
    return { mode: 'claude', model: env.ASSISTANT_MODEL || 'claude-opus-5-5', effort: EFFORTS.includes(effort) ? effort : 'medium', hasKey };
  }
  return { mode: 'mock' };
}

export function localConfig(env: NodeJS.ProcessEnv = process.env): LocalLlmConfig {
  const raw = (env.LLM_BASE_URL || LOCAL_DEFAULT_BASE).trim().replace(/\/+$/, '');
  return { baseUrl: raw, model: env.LLM_MODEL?.trim() || null, apiKey: env.LLM_API_KEY?.trim() || null };
}

/** 화면에 보일 주소: 호스트:포트만 (경로·키는 숨긴다) */
export function endpointLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** 질문·조회 데이터·회의 내용이 이 서버 밖(외부 API)으로 나가는가 */
export const isExternal = (mode: AssistantMode) => mode === 'claude';
