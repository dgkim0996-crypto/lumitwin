'use client';

import { ROLE_NAMES, type Role } from '@lumitwin/shared';
import { isRole } from '@/lib/auth';
import { cx } from '@/lib/format';

/** 역할 색: 상태색(가동·경고·고장·정보)을 빌려 쓰되 글자로 역할 이름을 늘 같이 쓴다 (색만으로 구별하지 않는다) */
const ROLE_STYLE: Record<Role, string> = {
  operator: 'border-line bg-white/5 text-sub',
  leader: 'border-info/50 bg-info/10 text-info',
  quality: 'border-warn/50 bg-warn/10 text-warn',
  maintenance: 'border-run/50 bg-run/10 text-run',
  admin: 'border-down/50 bg-down/10 text-down',
};

export function RoleBadge({ role, className }: { role: string; className?: string }) {
  const known = isRole(role);
  return (
    <span className={cx('inline-block shrink-0 rounded border px-1.5 py-px text-[11px] leading-4', known ? ROLE_STYLE[role] : 'border-line text-dim', className)}>
      {known ? ROLE_NAMES[role] : role === 'none' ? '로그인 전' : role}
    </span>
  );
}
