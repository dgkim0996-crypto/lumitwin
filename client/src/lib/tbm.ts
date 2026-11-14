'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LineCode, TbmChecklistView, TbmFollowUpInput, TbmJobStatus, TbmMeetingDetail, TbmMeetingView, TbmStatus } from '@lumitwin/shared';
import { api } from './api';

/** 받아쓰기·대조가 진행 중인 상태 (화면이 2초마다 다시 읽는다) */
export const isBusy = (s: TbmJobStatus | undefined) => s === 'TRANSCRIBING' || s === 'ANALYZING';

export function useTbmChecklist(line: LineCode) {
  return useQuery({
    queryKey: ['tbm', 'checklist', line],
    queryFn: () => api.get<TbmChecklistView>(`/tbm/checklist?line=${line}`),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
}

export function useTbmMeetings(line: LineCode) {
  return useQuery({
    queryKey: ['tbm', 'meetings', line],
    queryFn: () => api.get<TbmMeetingView[]>(`/tbm/meetings?line=${line}&limit=30`),
    refetchInterval: (q) => (q.state.data?.some((m) => isBusy(m.status)) ? 2_000 : 15_000),
    placeholderData: keepPreviousData,
  });
}

export function useTbmMeeting(id: number | null) {
  return useQuery({
    queryKey: ['tbm', 'meeting', id],
    queryFn: () => api.get<TbmMeetingDetail>(`/tbm/meetings/${id}`),
    enabled: id != null,
    refetchInterval: (q) => (isBusy(q.state.data?.status) ? 2_000 : false),
  });
}

export function useTbmUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) => api.upload<TbmMeetingView>('/tbm/meetings', form),
    onSuccess: (m) => void qc.invalidateQueries({ queryKey: ['tbm', 'meetings', m.line] }),
  });
}

export function useTbmFollowUp(id: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: TbmFollowUpInput) => api.post<TbmMeetingDetail>(`/tbm/meetings/${id}/follow-ups`, b),
    onSuccess: (d) => {
      qc.setQueryData(['tbm', 'meeting', d.id], d);
      void qc.invalidateQueries({ queryKey: ['tbm', 'meetings', d.line] });
    },
  });
}

export const fetchTbmSample = (line: LineCode) => api.get<{ line: LineCode; fileName: string; text: string }>(`/tbm/sample?line=${line}`);

/** 판정 칩 색 */
export const TBM_TONE: Record<TbmStatus, string> = {
  COVERED: 'border-run/40 bg-run/10 text-run',
  PARTIAL: 'border-warn/40 bg-warn/10 text-warn',
  MISSING: 'border-down/40 bg-down/10 text-down',
  UNCERTAIN: 'border-info/40 bg-info/10 text-info',
};

export const JOB_TONE: Record<TbmJobStatus, string> = {
  TRANSCRIBING: 'border-info/40 bg-info/10 text-info',
  ANALYZING: 'border-info/40 bg-info/10 text-info',
  DONE: 'border-run/40 bg-run/10 text-run',
  FAILED: 'border-down/40 bg-down/10 text-down',
};

/** 녹음에 쓸 수 있는 형식 (브라우저마다 다르다) */
export function recorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) if (MediaRecorder.isTypeSupported(t)) return t;
  return undefined;
}
