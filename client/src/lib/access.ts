'use client';

import { useQuery } from '@tanstack/react-query';
import type { AccessInfo } from '@lumitwin/shared';
import { api } from './api';

export const ACCESS_KEY = ['access'] as const;

/** 공개 링크로 들어온 방문자는 보기 전용: 조작 버튼을 막고 이유를 보여 준다 (서버도 같은 요청을 403으로 막는다) */
export function useAccess(): AccessInfo & { unlocked: boolean } {
  const q = useQuery({ queryKey: ACCESS_KEY, queryFn: () => api.get<AccessInfo>('/access'), staleTime: 5 * 60_000 });
  const readOnly = q.data?.readOnly ?? false;
  const unlockable = q.data?.unlockable ?? false;
  return { readOnly, unlockable, unlocked: unlockable && !readOnly };
}

export const READ_ONLY_TITLE = '공개 링크는 보기 전용입니다';
