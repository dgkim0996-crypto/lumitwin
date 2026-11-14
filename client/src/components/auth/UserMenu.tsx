'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { PERM_NAMES, PERMISSIONS, ROLE_NAMES, ROLES, type PermCode } from '@lumitwin/shared';
import { RoleBadge } from '@/components/auth/RoleBadge';
import { useAccess } from '@/lib/access';
import { AUTH_EXPIRED_EVENT } from '@/lib/api';
import { AUTH_KEY, useAuth, useLogout } from '@/lib/auth';

const PERMS = Object.keys(PERMISSIONS) as PermCode[];

function PersonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="8" r="3.6" stroke="currentColor" strokeWidth="2" />
      <path d="M4.5 20c.8-3.6 3.8-5.6 7.5-5.6s6.7 2 7.5 5.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 상단 바의 사용자 메뉴: 로그인 안 했으면 '로그인' 버튼, 했으면 이름·역할 배지 → 할 수 있는 일·감사 기록(관리자)·로그아웃.
 * 서버 인증이 꺼져 있거나(AUTH=off) 공개 링크(보기 전용, 로그인 불가)에서 로그인 전이면 아무것도 보이지 않는다
 */
export function UserMenu() {
  const auth = useAuth();
  const { readOnly } = useAccess();
  const logout = useLogout();
  const qc = useQueryClient();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  // 버튼을 눌렀는데 서버가 401(쿠키 만료·로그아웃)을 주면 로그인 상태를 다시 읽는다
  useEffect(() => {
    const refresh = () => void qc.invalidateQueries({ queryKey: AUTH_KEY });
    window.addEventListener(AUTH_EXPIRED_EVENT, refresh);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, refresh);
  }, [qc]);

  if (!auth.enabled || auth.loading) return null;
  const loginHref = `/login?next=${encodeURIComponent(path || '/')}`;
  const u = auth.user;
  if (!u) {
    if (readOnly) return null;
    return (
      <Link
        href={loginHref}
        title="로그인하면 역할에 따라 설비 조작·시뮬레이터 제어·알람 확인을 할 수 있습니다"
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-info/50 bg-info/10 px-1.5 text-sm text-info hover:bg-info/20 xl:px-3"
      >
        <PersonIcon />
        <span>로그인</span>
      </Link>
    );
  }
  const mine = PERMS.filter((p) => PERMISSIONS[p].includes(u.role));
  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`${u.name} (${ROLE_NAMES[u.role]})`}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line bg-white/5 px-1.5 text-sm hover:bg-white/10 xl:px-2"
      >
        <PersonIcon />
        <span className="hidden max-w-28 truncate 2xl:inline">{u.name}</span>
        <RoleBadge role={u.role} />
      </button>
      {open && (
        // 머리줄의 whitespace-nowrap이 물려 내려오므로 여기서 줄바꿈을 되살린다
        <div role="menu" className="panel absolute right-0 top-10 z-50 w-[300px] whitespace-normal p-3 text-xs">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{u.name}</div>
              <div className="num text-dim">{u.login}</div>
            </div>
            <RoleBadge role={u.role} />
          </div>
          <p className="mt-2 leading-relaxed text-sub">{ROLES.find((r) => r.code === u.role)?.desc}</p>
          <div className="mt-2 text-[11px] text-dim">할 수 있는 일</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {mine.map((p) => (
              <span key={p} className="rounded bg-white/5 px-1.5 py-px text-[11px] text-sub">
                {PERM_NAMES[p]}
              </span>
            ))}
          </div>
          <div className="mt-3 flex flex-col gap-0.5 border-t border-line pt-2 text-sm">
            {auth.can('audit.read') && (
              <Link role="menuitem" href="/audit" onClick={() => setOpen(false)} className="rounded px-2 py-1 hover:bg-white/10">
                감사 기록
              </Link>
            )}
            <Link role="menuitem" href={loginHref} onClick={() => setOpen(false)} className="rounded px-2 py-1 hover:bg-white/10">
              다른 계정으로 로그인
            </Link>
            <button
              role="menuitem"
              disabled={logout.isPending}
              onClick={() => logout.mutate(undefined, { onSuccess: () => setOpen(false) })}
              className="rounded px-2 py-1 text-left text-down hover:bg-white/10 disabled:opacity-40"
            >
              로그아웃
            </button>
          </div>
          {logout.error && <div className="mt-1 text-down">{(logout.error as Error).message}</div>}
        </div>
      )}
    </div>
  );
}
