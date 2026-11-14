'use client';

import { CHANGE_CATEGORY_NAMES, FA_STATUS_NAMES, type ChangeCategory, type FaStatus } from '@lumitwin/shared';
import { cx } from '@/lib/format';
import { CATEGORY_COLOR, CATEGORY_SHORT, FA_TONE } from '@/lib/quality-system';

/** 초물 상태 칩: 색 + 글자 (색만으로 구별하지 않는다) */
export function FaChip({ status, serial, size = 'sm' }: { status: FaStatus; serial?: string | null; size?: 'sm' | 'lg' }) {
  return (
    <span
      className={cx('inline-flex items-center gap-1 rounded border whitespace-nowrap', FA_TONE[status], size === 'lg' ? 'px-2.5 py-1 text-base font-semibold' : 'px-1.5 py-px text-[11px]')}
      title={serial ? `초물 개체 ${serial}` : undefined}
    >
      {FA_STATUS_NAMES[status]}
    </span>
  );
}

/** 4M 분류 표식 */
export function CategoryTag({ category, full, size = 'sm' }: { category: ChangeCategory; full?: boolean; size?: 'sm' | 'lg' }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap', size === 'lg' ? 'text-base' : 'text-xs')}>
      <span className={cx('rounded-full', size === 'lg' ? 'size-2.5' : 'size-2')} style={{ background: CATEGORY_COLOR[category] }} />
      {full ? CHANGE_CATEGORY_NAMES[category] : CATEGORY_SHORT[category]}
    </span>
  );
}
