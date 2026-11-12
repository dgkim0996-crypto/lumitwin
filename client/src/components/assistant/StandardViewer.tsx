'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { StandardDoc } from '@lumitwin/shared';
import { api } from '@/lib/api';
import { useAssistant } from '@/lib/assistant';
import { Markdown } from './Markdown';

const secId = (n: number) => `ws-sec-${n}`;

/** 작업표준서 보기 창. AI 비서 답의 [WS-… §n] 인용을 누르면 그 절로 열린다 */
export function StandardViewer() {
  const target = useAssistant((s) => s.standard);
  const open = useAssistant((s) => s.openStandard);
  const q = useQuery({
    queryKey: ['standard', target?.id],
    queryFn: () => api.get<StandardDoc>(`/assistant/standards/${encodeURIComponent(target!.id)}`),
    enabled: !!target,
    staleTime: 60_000,
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && open(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  // 문서가 그려진 뒤 인용한 절로 내려간다
  useEffect(() => {
    if (!q.data || target?.n == null) return;
    const el = document.getElementById(secId(target.n));
    el?.scrollIntoView({ block: 'start' });
    el?.classList.add('ws-flash');
    const t = setTimeout(() => el?.classList.remove('ws-flash'), 1600);
    return () => clearTimeout(t);
  }, [q.data, target?.n]);
  if (!target) return null;
  const d = q.data;
  return (
    <div className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={() => open(null)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={d?.title ?? '작업표준서'}
        className="panel flex max-h-[86vh] w-[820px] max-w-[calc(100vw-32px)] flex-col"
        style={{ background: 'var(--color-panel-solid)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <div className="num text-xs text-info">
              {target.id}
              {d ? ` · 개정 ${d.revision}` : ''}
            </div>
            <div className="text-base font-semibold">{d?.title ?? '작업표준서'}</div>
            {d && d.stations.length > 0 && <div className="mt-0.5 text-xs text-sub">적용 설비: {d.stations.join(', ')}</div>}
          </div>
          <button onClick={() => open(null)} className="shrink-0 rounded px-2 py-1 text-sm text-sub hover:bg-white/10">
            닫기
          </button>
        </div>
        {d && (
          <div className="flex flex-wrap gap-1 border-b border-line px-4 py-2">
            {d.sections.map((s) => (
              <button
                key={s.n}
                onClick={() => document.getElementById(secId(s.n))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className={`rounded px-1.5 py-0.5 text-[11px] ${s.n === target.n ? 'bg-info/20 text-info' : 'bg-white/5 text-sub hover:bg-white/10'}`}
              >
                §{s.n} {s.title}
              </button>
            ))}
          </div>
        )}
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {q.isLoading && <div className="text-sm text-dim">불러오는 중…</div>}
          {q.error && <div className="text-sm text-down">{(q.error as Error).message}</div>}
          {d && <Markdown text={d.markdown} headings sectionId={secId} />}
          <p className="mt-4 border-t border-line pt-2 text-[11px] text-dim">공개 자료를 바탕으로 만든 가상 공장의 가상 작업표준서입니다. 실제 회사의 문서가 아닙니다.</p>
        </div>
      </div>
    </div>
  );
}
