'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { cx } from '@/lib/format';

interface NavLink {
  href: string;
  label: string;
  hint: string;
}

interface NavGroup {
  label: string;
  items: NavLink[];
}

/**
 * 화면 묶음. 모니터링(3D) → 실행(생산·작업지시) → 품질 → 추적·보전 → 현장 순서로,
 * 실제 MES 메뉴처럼 하는 일 단위로 묶었다. 1024px 폭에서도 한 줄에 들어가게 묶음은 펼침 메뉴로 연다
 */
export const NAV: (NavLink | NavGroup)[] = [
  { href: '/', label: '3D 공장', hint: '실시간 디지털 트윈' },
  {
    label: '생산',
    items: [
      { href: '/production', label: '생산 현황', hint: 'OEE · 시간대별 생산 · 설비 가동' },
      { href: '/orders', label: '작업지시·계획', hint: '라인별 작업지시 순서 · 기종 · 진척 · 기종 변경' },
      { href: '/losses', label: '6대 로스', hint: '계획 시간이 어디로 새는지 · 개선 우선순위' },
      { href: '/energy', label: '에너지', hint: '설비·라인 전력량 · 개당 에너지 · 대기 전력' },
      { href: '/reports', label: '교대 일보', hint: '교대별 생산·품질·설비 요약 · CSV · 인쇄' },
    ],
  },
  {
    label: '품질',
    items: [
      { href: '/ncr', label: '불량 처리', hint: '부적합(NCR) · 수리·재작업·폐기·특채 판정 · 재검사' },
      { href: '/spc', label: 'SPC', hint: 'X̄-R 관리도 · 공정능력' },
      { href: '/quality', label: '불량 분석', hint: '파레토 · 불량 요인 비교 · 출하 유출' },
      { href: '/changes', label: '변경점·초중종물', hint: '4M 변경점 · 초물·중물·종물 검사 기록' },
      { href: '/control-plan', label: '관리계획서', hint: '공정별 관리 항목 · 방법 · 주기 · 이상 시 조치' },
    ],
  },
  { href: '/trace', label: '추적·Hold', hint: '시리얼 계보 · LOT 품질 · Hold(격리)' },
  { href: '/maintenance', label: '보전', hint: '고장 이력 · MTBF·MTTR · 계획 보전 · 예지 보전' },
  {
    label: '작업자',
    items: [
      { href: '/operator', label: '작업자 태블릿', hint: '비가동 사유 · 작업 전 점검 · 변경점 신고' },
      { href: '/tbm', label: 'TBM 점검', hint: '작업 전 안전 회의 녹음·대화록을 원청·안전팀·MES 항목과 대조' },
    ],
  },
];

const isGroup = (n: NavLink | NavGroup): n is NavGroup => 'items' in n;
const active = (path: string, href: string) => (href === '/' ? path === '/' : path.startsWith(href));

/** 화면 이동 탭. 3D 공장과 MES 화면이 같은 실시간 연결을 함께 쓴다 */
export function NavTabs() {
  const path = usePathname();
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => setOpen(null), [path]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const tab = (on: boolean) => cx('rounded px-1 py-1 text-sm whitespace-nowrap xl:px-2.5', on ? 'bg-info/20 font-medium text-ink' : 'text-sub hover:bg-white/10 hover:text-ink');

  return (
    <nav ref={ref} className="flex items-center gap-0.5 rounded-md border border-line bg-white/[0.03] p-0.5">
      {NAV.map((n) => {
        if (!isGroup(n)) {
          return (
            <Link key={n.href} href={n.href} title={n.hint} className={tab(active(path, n.href))}>
              {n.label}
            </Link>
          );
        }
        const on = n.items.some((i) => active(path, i.href));
        const cur = n.items.find((i) => active(path, i.href));
        return (
          <div key={n.label} className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={open === n.label}
              onClick={() => setOpen((o) => (o === n.label ? null : n.label))}
              className={cx(tab(on), 'flex items-center gap-1')}
            >
              {n.label}
              {cur && <span className="hidden text-xs text-sub 2xl:inline">· {cur.label}</span>}
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="opacity-60">
                <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
              </svg>
            </button>
            {open === n.label && (
              <div role="menu" className="panel absolute top-full left-0 z-40 mt-1 w-64 p-1">
                {n.items.map((i) => (
                  <Link
                    key={i.href}
                    role="menuitem"
                    href={i.href}
                    className={cx('block rounded px-3 py-2', active(path, i.href) ? 'bg-info/20' : 'hover:bg-white/10')}
                  >
                    <div className="text-sm text-ink">{i.label}</div>
                    <div className="text-xs text-dim">{i.hint}</div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
