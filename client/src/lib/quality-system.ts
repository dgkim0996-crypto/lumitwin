'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEMO_USERS,
  STATIONS,
  type ChangeCategory,
  type ChangePointView,
  type ChangeQuery,
  type ChangeRequest,
  type FaStationView,
  type FaStatus,
  type InspectionQuery,
  type InspectionView,
} from '@lumitwin/shared';
import { api } from './api';

/** 쿼리 문자열 (빈 값은 뺀다) */
function qs(o: object): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v != null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function useChanges(q: ChangeQuery, refetchMs = 5_000) {
  return useQuery({
    queryKey: ['changes', q],
    queryFn: () => api.get<ChangePointView[]>(`/changes${qs(q)}`),
    refetchInterval: refetchMs,
    placeholderData: keepPreviousData,
  });
}

export function useInspections(q: InspectionQuery, refetchMs = 5_000) {
  return useQuery({
    queryKey: ['inspections', q],
    queryFn: () => api.get<InspectionView[]>(`/inspections${qs(q)}`),
    refetchInterval: refetchMs,
    placeholderData: keepPreviousData,
  });
}

/** 설비별 초물 대기 (서버 메모리 = 인터록과 같은 답) */
export function useFaStatus(refetchMs = 3_000) {
  return useQuery({
    queryKey: ['fa-status'],
    queryFn: () => api.get<FaStationView[]>('/quality-system/fa-status'),
    refetchInterval: refetchMs,
    placeholderData: keepPreviousData,
  });
}

function useRefreshQuality() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['changes'] });
    void qc.invalidateQueries({ queryKey: ['fa-status'] });
  };
}

export function useRegisterChange() {
  const refresh = useRefreshQuality();
  return useMutation({ mutationFn: (b: ChangeRequest) => api.post<ChangePointView>('/changes', b), onSuccess: refresh });
}

export function useApproveChange() {
  const refresh = useRefreshQuality();
  return useMutation({ mutationFn: (id: number) => api.post<ChangePointView>(`/changes/${id}/approve`), onSuccess: refresh });
}

/** 품질 담당 수동 초물 판정 (설비 단위: 그 설비의 대기를 모두 이 결과로) */
export function useManualFirst() {
  const refresh = useRefreshQuality();
  return useMutation({
    mutationFn: (b: { station: string; result: 'OK' | 'NG'; serial?: string; note?: string }) =>
      api.post<{ station: string; result: 'OK' | 'NG'; resolved: number; serial: string }>(`/quality-system/fa/${encodeURIComponent(b.station)}`, { result: b.result, serial: b.serial, note: b.note }),
    onSuccess: refresh,
  });
}

/** 로그인 아이디 → 이름 (시연 계정이 아니면 아이디 그대로) */
export const personName = (login: string | null | undefined) => (login ? (DEMO_USERS.find((u) => u.login === login)?.name ?? login) : '');

/** 4M 분류 색 (글자와 함께 쓰는 표식 색. 상태색(빨강·초록·노랑)과 겹치지 않게 골랐다) */
export const CATEGORY_COLOR: Record<ChangeCategory, string> = {
  MAN: '#7aa2ff',
  MACHINE: '#d98c4a',
  MATERIAL: '#4fc3a1',
  METHOD: '#b48cf2',
};
export const CATEGORY_SHORT: Record<ChangeCategory, string> = { MAN: '사람', MACHINE: '설비', MATERIAL: '자재', METHOD: '방법' };
export const CATEGORY_ORDER: ChangeCategory[] = ['MAN', 'MACHINE', 'MATERIAL', 'METHOD'];

/** 초물 상태 칩 색 (상태색 + 글자) */
export const FA_TONE: Record<FaStatus, string> = {
  PENDING: 'border-warn/50 bg-warn/15 text-warn',
  OK: 'border-run/50 bg-run/15 text-run',
  NG: 'border-down/50 bg-down/15 text-down',
  NONE: 'border-line bg-white/[0.04] text-dim',
};

/** 검사 값의 이름·단위·규격 (설비 태그 또는 측정 정의) */
export function valueSpec(station: string, key: string): { name: string; unit: string; lsl?: number; usl?: number; digits?: number; measure: boolean } {
  const st = STATIONS[station];
  const m = st?.measures?.find((x) => x.key === key);
  if (m) return { name: m.name, unit: m.unit, lsl: m.lsl, usl: m.usl, digits: m.digits, measure: true };
  const t = st?.tags.find((x) => x.key === key);
  if (t) return { name: t.name, unit: t.unit, lsl: t.lsl, usl: t.usl, digits: t.digits, measure: false };
  return { name: key, unit: '', measure: false };
}

export const outOfSpec = (v: number, s: { lsl?: number; usl?: number }) => (s.lsl != null && v < s.lsl) || (s.usl != null && v > s.usl);
