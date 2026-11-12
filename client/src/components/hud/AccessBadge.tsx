'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { AccessInfo } from '@lumitwin/shared';
import { api, setControlKey } from '@/lib/api';
import { ACCESS_KEY, READ_ONLY_TITLE, useAccess } from '@/lib/access';
import { cx } from '@/lib/format';

/**
 * 공개 링크에서만 보이는 표시. 서버에 제어 키가 있으면 눌러서 키를 넣고 조작을 풀 수 있다 (시연자 태블릿용).
 * 이 PC·같은 망에서 연 화면에는 아무것도 보이지 않는다.
 */
export function AccessBadge({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const { readOnly, unlockable, unlocked } = useAccess();
  const qc = useQueryClient();
  if (!readOnly && !unlocked) return null;

  const unlock = async () => {
    if (!unlockable) return;
    const key = window.prompt('제어 키를 넣으면 이 화면에서 설비를 조작할 수 있습니다')?.trim();
    if (!key) return;
    setControlKey(key);
    const next = await api.get<AccessInfo>('/access').catch(() => null);
    if (next?.readOnly) {
      setControlKey(null);
      window.alert('제어 키가 맞지 않습니다');
      return;
    }
    qc.setQueryData(ACCESS_KEY, next);
  };
  const lock = () => {
    setControlKey(null);
    void qc.invalidateQueries({ queryKey: ACCESS_KEY });
  };

  const box = size === 'lg' ? 'h-12 rounded-lg px-3 text-base' : 'h-8 rounded-md px-2 text-xs';
  if (unlocked) {
    return (
      <button onClick={lock} title="제어 키를 지우고 보기 전용으로 돌아갑니다" className={cx('shrink-0 border border-run/50 bg-run/10 text-run', box)}>
        조작 가능
      </button>
    );
  }
  return (
    <button
      onClick={unlock}
      title={unlockable ? `${READ_ONLY_TITLE}. 시연자는 눌러서 제어 키를 넣으세요` : `${READ_ONLY_TITLE}. 화면은 실시간으로 보이고 AI 비서에게도 물어볼 수 있습니다`}
      className={cx('shrink-0 border border-warn/50 bg-warn/10 text-warn', box, !unlockable && 'cursor-default')}
    >
      보기 전용
    </button>
  );
}
