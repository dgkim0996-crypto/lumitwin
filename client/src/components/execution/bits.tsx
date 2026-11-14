'use client';

import type { ReactNode } from 'react';
import { NCR_STATUS_NAMES, WO_STATUS_NAMES, type NcrStatus, type WoStatus } from '@lumitwin/shared';
import { cx } from '@/lib/format';
import { NCR_STATUS_TONE, UNIT_STATUS_NAMES, UNIT_STATUS_TONE, WO_PROGRESS_COLORS, WO_STATUS_TONE } from '@/lib/execution';
import { defectName } from '@/lib/names';

const badge = 'whitespace-nowrap rounded px-1.5 text-[11px]';

export function WoStatusBadge({ status, releasing }: { status: WoStatus; releasing?: boolean }) {
  return <span className={cx(badge, WO_STATUS_TONE[status])}>{releasing ? '투입 중' : WO_STATUS_NAMES[status]}</span>;
}

export function NcrStatusBadge({ status }: { status: NcrStatus }) {
  return <span className={cx(badge, NCR_STATUS_TONE[status])}>{NCR_STATUS_NAMES[status]}</span>;
}

/** 개체 상태 배지 (폐기·격리·수리대 포함) */
export function UnitStatusBadge({ status, defect }: { status: string | null; defect?: string | null }) {
  if (!status) return <span className={cx(badge, 'bg-white/10 text-dim')}>기록 없음</span>;
  return (
    <span className={cx(badge, UNIT_STATUS_TONE[status] ?? 'bg-white/10 text-sub')}>
      {UNIT_STATUS_NAMES[status] ?? status}
      {defect ? ` · ${defectName(defect)}` : ''}
    </span>
  );
}

/**
 * 작업지시 진척 막대: 양품 · 폐기 · 라인 안(투입했지만 아직 안 끝남) · 아직 투입 안 함. 전체 = 수량
 */
export function WoProgress({ qty, released, doneQty, scrapQty, height = 8 }: { qty: number; released: number; doneQty: number; scrapQty: number; height?: number }) {
  const total = Math.max(qty, released, 1);
  const wip = Math.max(0, released - doneQty - scrapQty);
  const left = Math.max(0, qty - released);
  const parts = [
    { k: 'done', v: doneQty, c: WO_PROGRESS_COLORS.done, label: '양품' },
    { k: 'scrap', v: scrapQty, c: WO_PROGRESS_COLORS.scrap, label: '폐기' },
    { k: 'wip', v: wip, c: WO_PROGRESS_COLORS.wip, label: '라인 안' },
    { k: 'left', v: left, c: WO_PROGRESS_COLORS.left, label: '미투입' },
  ];
  const aria = parts.map((p) => `${p.label} ${p.v}`).join(', ');
  return (
    <div className="flex w-full gap-[2px] overflow-hidden rounded-full" style={{ height }} role="img" aria-label={`진척: ${aria} (수량 ${qty})`} title={aria}>
      {parts
        .filter((p) => p.v > 0)
        .map((p) => (
          <div key={p.k} style={{ flexGrow: p.v / total, flexBasis: 0, background: p.c, minWidth: 2 }} />
        ))}
    </div>
  );
}

export const WO_PROGRESS_LEGEND = [
  { label: '양품 (최종 공정)', color: WO_PROGRESS_COLORS.done, shape: 'rect' as const },
  { label: '폐기', color: WO_PROGRESS_COLORS.scrap, shape: 'rect' as const },
  { label: '라인 안 (투입 뒤 진행 중)', color: WO_PROGRESS_COLORS.wip, shape: 'rect' as const },
  { label: '미투입', color: 'rgba(255,255,255,0.18)', shape: 'rect' as const },
];

/** 작은 버튼 (표 안 조작) */
export function MiniButton({ children, onClick, disabled, title, tone = 'default' }: { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string; tone?: 'default' | 'danger' | 'primary' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cx(
        'rounded border px-1.5 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-40',
        tone === 'danger' ? 'border-down/40 text-down hover:bg-down/10' : tone === 'primary' ? 'border-info/50 bg-info/10 text-ink hover:bg-info/20' : 'border-line text-sub hover:bg-white/10 hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

/** 탭 모양 고르기 */
export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: readonly (readonly [T, ReactNode])[]; label?: string }) {
  return (
    <div className="flex overflow-hidden rounded border border-line text-xs" role="tablist" aria-label={label}>
      {items.map(([k, text]) => (
        <button key={k} role="tab" aria-selected={value === k} onClick={() => onChange(k)} className={cx('px-2 py-0.5 whitespace-nowrap', value === k ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}>
          {text}
        </button>
      ))}
    </div>
  );
}

export const inputCls = 'h-8 rounded-md border border-line bg-white/5 px-2 text-sm outline-none placeholder:text-dim focus:border-info/60 disabled:opacity-50';
