'use client';

import { ASSISTANT_MODE_NAMES, type AssistantMode } from '@lumitwin/shared';
import { cx } from '@/lib/format';

const TONE: Record<AssistantMode, string> = {
  claude: 'bg-info/20 text-info',
  local: 'bg-run/15 text-run',
  mock: 'bg-white/10 text-sub',
};

/** 누가 답·판정하는지(Claude·로컬 LLM·모의 모드)와 모델 이름, 데이터가 밖으로 나가는지 */
export function ModeBadge({ mode, model, endpoint, compact }: { mode: AssistantMode; model: string | null; endpoint?: string | null; compact?: boolean }) {
  const title =
    mode === 'claude'
      ? `Claude API (${model ?? '-'}) — 질문과 조회한 공장 데이터가 Anthropic API로 나갑니다`
      : mode === 'local'
        ? `사내 오픈소스 LLM (${model ?? 'LLM_MODEL 없음: 서버의 첫 모델'}${endpoint ? ` · ${endpoint}` : ''}) — 데이터가 외부로 나가지 않습니다`
        : 'API 키 없이 규칙으로 해석하고, 같은 도구로 실제 공장 데이터를 조회합니다 — 데이터가 외부로 나가지 않습니다';
  return (
    <span data-testid="mode-badge" data-mode={mode} title={title} className={cx('inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-px text-[10.5px]', TONE[mode])}>
      <span className="font-medium">{ASSISTANT_MODE_NAMES[mode]}</span>
      {mode !== 'mock' && model && !compact && <span className="truncate opacity-80">· {model}</span>}
      {mode !== 'claude' && <span className="opacity-80">· 외부 전송 없음</span>}
    </span>
  );
}
