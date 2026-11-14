'use client';

import { useEffect, type ReactNode } from 'react';

/** 작업자 태블릿의 아래에서 올라오는 확인 창 (세로 화면은 아래, 가로 화면은 가운데). Esc·바깥 누르기로 닫는다 */
export function BottomSheet({ title, desc, onClose, children }: { title: string; desc?: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[55] flex items-end justify-center bg-black/60 p-3 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="panel scroll-thin max-h-[92vh] w-full max-w-[640px] overflow-y-auto p-4"
        style={{ background: 'var(--color-panel-solid)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xl font-semibold">{title}</div>
            {desc && <div className="mt-1 text-sm text-sub">{desc}</div>}
          </div>
          <button onClick={onClose} className="h-11 shrink-0 rounded-lg px-3 text-base text-sub hover:bg-white/10">
            취소
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
