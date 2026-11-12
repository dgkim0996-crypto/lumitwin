'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/lib/format';

export const NAV = [
  { href: '/', label: '3D 공장', hint: '실시간 디지털 트윈' },
  { href: '/production', label: '생산 현황', hint: 'OEE · 시간대별 생산 · 설비 가동' },
  { href: '/losses', label: '6대 로스', hint: '계획 시간이 어디로 새는지 · 개선 우선순위' },
  { href: '/maintenance', label: '보전', hint: '고장 이력 · MTBF·MTTR 실적과 설계 · 계획 보전' },
  { href: '/spc', label: 'SPC', hint: 'X̄-R 관리도 · 공정능력' },
  { href: '/quality', label: '불량 분석', hint: '파레토 · 불량 요인 비교 · 출하 유출' },
  { href: '/trace', label: '추적', hint: '시리얼 계보 · LOT 품질' },
  { href: '/operator', label: '작업자', hint: '작업자 태블릿 · 비가동 사유 · 작업 전 점검' },
] as const;

/** 화면 이동 탭. 3D 공장과 MES 화면이 같은 실시간 연결을 함께 쓴다 */
export function NavTabs() {
  const path = usePathname();
  return (
    <nav className="flex items-center gap-0.5 rounded-md border border-line bg-white/[0.03] p-0.5">
      {NAV.map((n) => {
        const on = n.href === '/' ? path === '/' : path.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            title={n.hint}
            className={cx('rounded px-1 py-1 text-sm whitespace-nowrap xl:px-2.5', on ? 'bg-info/20 font-medium text-ink' : 'text-sub hover:bg-white/10 hover:text-ink')}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
