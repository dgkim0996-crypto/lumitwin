'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ExecutionSummary,
  HoldDetail,
  HoldList,
  InterlockReport,
  LineCode,
  NcrDetail,
  NcrList,
  NcrStatus,
  PermCode,
  WoStatus,
  WorkOrderView,
} from '@lumitwin/shared';
import { api } from './api';
import { useGate } from './auth';

/**
 * 실행 MES 화면 공용: 조회(react-query, 몇 초마다 다시 부름)·조작(성공하면 관련 조회를 다시 부름)·상태 이름과 색.
 * 서버 API는 server/src/execution (계약 3장 A)
 */

const REFRESH_MS = 3_000;

export const EXEC_KEYS = {
  orders: ['exec', 'orders'] as const,
  ncr: ['exec', 'ncr'] as const,
  holds: ['exec', 'holds'] as const,
  summary: ['exec', 'summary'] as const,
  interlock: ['exec', 'interlock'] as const,
};

export function useOrders(line: LineCode) {
  return useQuery({
    queryKey: [...EXEC_KEYS.orders, line],
    queryFn: () => api.get<WorkOrderView[]>(`/orders?line=${line}`),
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

export function useNcrList(status: string, line: LineCode | 'ALL') {
  const qs = new URLSearchParams();
  if (status !== 'ALL') qs.set('status', status);
  if (line !== 'ALL') qs.set('line', line);
  return useQuery({
    queryKey: [...EXEC_KEYS.ncr, 'list', status, line],
    queryFn: () => api.get<NcrList>(`/ncr?${qs}`),
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

export function useNcr(id: number | null) {
  return useQuery({
    queryKey: [...EXEC_KEYS.ncr, 'one', id],
    queryFn: () => api.get<NcrDetail>(`/ncr/${id}`),
    enabled: id != null,
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}

export function useHolds() {
  return useQuery({ queryKey: [...EXEC_KEYS.holds, 'list'], queryFn: () => api.get<HoldList>('/holds'), refetchInterval: REFRESH_MS, placeholderData: keepPreviousData });
}

export function useHold(id: number | null) {
  return useQuery({
    queryKey: [...EXEC_KEYS.holds, 'one', id],
    queryFn: () => api.get<HoldDetail>(`/holds/${id}`),
    enabled: id != null,
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });
}

export function useExecSummary() {
  return useQuery({ queryKey: EXEC_KEYS.summary, queryFn: () => api.get<ExecutionSummary>('/execution/summary'), refetchInterval: REFRESH_MS, placeholderData: keepPreviousData });
}

export function useInterlock(line: LineCode) {
  return useQuery({
    queryKey: [...EXEC_KEYS.interlock, line],
    queryFn: () => api.get<InterlockReport>(`/interlock?line=${line}`),
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });
}

/** 실행 MES 조작: 성공하면 실행 MES 조회를 모두 다시 부른다 (작업지시·NCR·Hold·요약이 서로 엮여 있다) */
export function useExecAction<V, R = unknown>(fn: (v: V) => Promise<R>, onDone?: (r: R) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      onDone?.(r);
      void qc.invalidateQueries({ queryKey: ['exec'] });
    },
  });
}

/** 버튼을 막을지: 공개 링크 보기 전용 → 로그인 → 권한 (lib/auth.ts useGate). title은 막힌 이유 */
export function useExecGate(perm: PermCode): { ok: boolean; title?: string } {
  const g = useGate(perm);
  return { ok: g.ok, title: g.title };
}

// ─────────────────────────── 이름·색 ───────────────────────────

/** 개체 상태 (production_unit). P9: 폐기·격리·수리대 */
export const UNIT_STATUS_NAMES: Record<string, string> = {
  WIP: '공정 중',
  NG: '불량',
  DONE: '완성',
  CONSUMED: '조립됨',
  SCRAP: '폐기',
  HOLD: '격리',
  REPAIR: '수리대',
};

/** 배지 색 (글자 + 바탕). 상태 색 체계: 위험 = down, 주의 = warn, 진행 = info, 정상 = run */
export const UNIT_STATUS_TONE: Record<string, string> = {
  WIP: 'bg-white/10 text-sub',
  NG: 'bg-down/20 text-down',
  DONE: 'bg-run/20 text-run',
  CONSUMED: 'bg-white/10 text-sub',
  SCRAP: 'bg-white/10 text-dim line-through',
  HOLD: 'bg-warn/20 text-warn',
  REPAIR: 'bg-info/20 text-info',
};

export const WO_STATUS_TONE: Record<WoStatus, string> = {
  PLANNED: 'bg-white/10 text-sub',
  RUNNING: 'bg-info/20 text-info',
  DONE: 'bg-run/20 text-run',
  CANCELLED: 'bg-white/10 text-dim',
};

export const NCR_STATUS_TONE: Record<NcrStatus, string> = {
  OPEN: 'bg-white/10 text-sub',
  WAIT_MRB: 'bg-warn/20 text-warn',
  REPAIRING: 'bg-info/20 text-info',
  REINSPECT: 'bg-info/20 text-info',
  CLOSED: 'bg-white/10 text-dim',
};

/** 진척 막대 색: 양품 · 폐기 · 라인 안 · 아직 투입 안 함 */
export const WO_PROGRESS_COLORS = { done: 'var(--color-series)', scrap: 'var(--color-ng)', wip: '#7b8798', left: 'rgba(255,255,255,0.06)' } as const;

/** 서버 오류 메시지 (없으면 기본 문구) */
export const errText = (e: unknown, fallback = '요청이 실패했습니다') => (e instanceof Error && e.message ? e.message : fallback);
