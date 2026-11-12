'use client';

import { useQuery } from '@tanstack/react-query';
import type { StandardDoc, StandardMeta } from '@lumitwin/shared';
import { api } from '@/lib/api';

const STATION_KEY = 'lumitwin.operator.station';
const BY_KEY = 'lumitwin.operator.by';

/** 태블릿 한 대가 설비 한 대 앞에 붙어 있다고 보고, 마지막으로 연 설비를 기억한다 (저장소가 막혀 있으면 기억하지 않는다) */
export const remembered = {
  station: () => read(STATION_KEY),
  setStation: (code: string) => write(STATION_KEY, code),
  by: () => read(BY_KEY) ?? '',
  setBy: (v: string) => write(BY_KEY, v),
};

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, v: string): void {
  try {
    if (v) window.localStorage.setItem(key, v);
    else window.localStorage.removeItem(key);
  } catch {
    /* 사생활 보호 창 등: 기억하지 않아도 화면은 돈다 */
  }
}

/** 표준서 본문에서 제목이 맞는 절(## n. 제목)의 글머리 목록(- …)을 뽑는다 */
export function sectionBullets(markdown: string, title: RegExp): string[] {
  const parts = markdown.split(/^(?=## )/m);
  const part = parts.find((p) => {
    const h = /^## (?:\d+\.\s*)?(.+)$/m.exec(p);
    return !!h && title.test(h[1]);
  });
  if (!part) return [];
  return part
    .split(/\r?\n/)
    .filter((l) => /^\s*-\s+/.test(l))
    .map((l) => l.replace(/^\s*-\s+/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean);
}

export const SECTION = {
  safety: /^안전/,
  precheck: /작업\s*전\s*점검/,
  steps: /작업\s*순서/,
  trouble: /이상\s*발생|조치/,
} as const;

/** 이 설비를 다루는 작업표준서와 태블릿이 쓰는 절(안전·작업 전 점검) */
export function useStationStandard(code: string | null) {
  const list = useQuery({ queryKey: ['standards'], queryFn: () => api.get<StandardMeta[]>('/assistant/standards'), staleTime: 300_000, enabled: !!code });
  const meta = code ? list.data?.find((d) => d.stations.includes(code)) : undefined;
  const doc = useQuery({
    queryKey: ['standard', meta?.id],
    queryFn: () => api.get<StandardDoc>(`/assistant/standards/${encodeURIComponent(meta!.id)}`),
    enabled: !!meta,
    staleTime: 300_000,
  });
  const n = (re: RegExp) => meta?.sections.find((s) => re.test(s.title))?.n;
  return {
    loading: list.isLoading || (!!meta && doc.isLoading),
    meta,
    precheck: doc.data ? sectionBullets(doc.data.markdown, SECTION.precheck) : [],
    safety: doc.data ? sectionBullets(doc.data.markdown, SECTION.safety) : [],
    section: { safety: n(SECTION.safety), precheck: n(SECTION.precheck), steps: n(SECTION.steps), trouble: n(SECTION.trouble) },
  };
}
