// AI 현장 비서: 서버 ↔ 화면 사이의 주고받는 모양

/** claude = Claude API로 답한다 · mock = 키 없이 규칙으로 도구를 골라 답한다(같은 도구, 같은 데이터) */
export type AssistantMode = 'claude' | 'mock';

/** 답에서 화면의 다른 곳으로 이어지는 링크 */
export interface AssistantRef {
  kind: 'station' | 'lot' | 'serial' | 'standard' | 'page';
  /** station: 설비 코드 · lot: LOT 번호 · serial: 시리얼 · standard: 'WS-HL-03#4'(문서#절) · page: 경로 */
  id: string;
  label: string;
}

/** 대화 요청. 화면 문맥(보고 있는 화면·고른 설비)을 함께 보내 "이 설비"를 알아듣게 한다 */
export interface AssistantChatRequest {
  conversationId?: string;
  message: string;
  context?: { page?: string; station?: string | null };
}

/** 답을 한 줄씩(NDJSON) 흘려보낸다 */
export type AssistantEvent =
  | { type: 'start'; conversationId: string; mode: AssistantMode; model: string | null }
  | { type: 'tool'; id: string; name: string; label: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; ok: boolean; summary: string; refs: AssistantRef[] }
  | { type: 'text'; delta: string }
  | { type: 'done'; usage?: AssistantUsage; ms: number }
  | { type: 'error'; message: string };

export interface AssistantUsage {
  input: number;
  output: number;
  /** 캐시에서 읽은 입력 토큰 (시스템 프롬프트·도구 정의) */
  cacheRead: number;
  /** 모델 호출 횟수 (도구 호출마다 한 번 더) */
  calls: number;
}

export interface AssistantInfo {
  mode: AssistantMode;
  model: string | null;
  /** 서버에 Whisper(OpenAI 호환 받아쓰기) 서버가 연결돼 있는지 */
  stt: { enabled: boolean; model: string | null };
  standards: number;
  suggestions: string[];
}

export interface StandardSection {
  n: number;
  title: string;
}

export interface StandardMeta {
  id: string;
  title: string;
  line: string | null;
  stations: string[];
  revision: string | null;
  sections: StandardSection[];
}

export interface StandardDoc extends StandardMeta {
  /** 조건표 자리표시를 공장 정의 값으로 펼친 본문 */
  markdown: string;
}
