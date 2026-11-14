'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState, type FormEvent } from 'react';
import { DEMO_USERS, PERM_NAMES, PERMISSIONS, ROLE_NAMES, ROLES, type PermCode } from '@lumitwin/shared';
import { RoleBadge } from '@/components/auth/RoleBadge';
import { PageShell } from '@/components/mes/PageShell';
import { useAccess } from '@/lib/access';
import { rolesFor, safeNext, useAuth, useLogin, useLogout } from '@/lib/auth';
import { cx } from '@/lib/format';

const PERMS = Object.keys(PERMISSIONS) as PermCode[];
const INPUT = 'h-9 w-full rounded-md border border-line bg-white/5 px-2 text-sm outline-none placeholder:text-dim focus:border-info/60 disabled:opacity-50';

export default function LoginPage() {
  return (
    <PageShell
      title="로그인"
      desc={
        <>
          역할에 따라 할 수 있는 일이 다릅니다. 조회는 로그인 없이 되고, 설비 조작·시뮬레이터 제어·알람 확인처럼 상태를 바꾸는 일은 로그인한 사람의 역할 권한을 서버가 확인한 뒤 감사 기록에 남깁니다.
          아래 계정은 실제 사람이 아닌 시연용입니다.
        </>
      }
    >
      {/* 돌아갈 주소(?next=)를 읽는 부분만 Suspense로 감싼다 (Next가 미리 그릴 때 검색어를 모른다) */}
      <Suspense fallback={<div className="card p-4 text-xs text-dim">불러오는 중…</div>}>
        <LoginBody />
      </Suspense>
    </PageShell>
  );
}

function LoginBody() {
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const router = useRouter();
  const auth = useAuth();
  const { readOnly } = useAccess();
  const login = useLogin();
  const logout = useLogout();
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  /** 오류를 어느 쪽(계정 버튼·양식) 아래에 보일지 */
  const [via, setVia] = useState<'demo' | 'form'>('form');
  const pwRef = useRef<HTMLInputElement>(null);

  const blocked = readOnly || !auth.enabled || auth.loading || login.isPending;
  const done = () => router.replace(next);
  const pick = (loginId: string) => {
    if (blocked) return;
    if (auth.demo) {
      setVia('demo');
      login.mutate({ login: loginId, demo: true }, { onSuccess: done });
      return;
    }
    // 이 서버는 시연 계정에도 비밀번호를 정했다 (DEMO_PASSWORD): 아이디만 채우고 비밀번호 칸으로
    setId(loginId);
    setPw('');
    login.reset();
    pwRef.current?.focus();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (blocked) return;
    setVia('form');
    login.mutate({ login: id.trim(), password: pw }, { onSuccess: done });
  };

  return (
    <div className="grid gap-3 @5xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        {readOnly && (
          <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-ink">
            공개 링크는 보기 전용이라 로그인할 수 없습니다. 화면은 실시간으로 보이고 AI 비서에게도 물어볼 수 있습니다. 시연자는 상단의 <span className="text-warn">보기 전용</span>을 눌러 제어 키를 넣은 뒤
            로그인합니다.
          </div>
        )}
        {!auth.loading && !auth.enabled && (
          <div className="rounded-md border border-info/40 bg-info/10 px-3 py-2 text-xs leading-relaxed text-ink">
            이 서버는 인증이 꺼져 있습니다 (<span className="num">AUTH=off</span>). 로그인 없이 모든 기능을 쓸 수 있고, 감사 기록에는 <span className="text-info">시스템</span>으로 남습니다.{' '}
            <Link href={next} className="text-info hover:underline">
              돌아가기
            </Link>
          </div>
        )}
        {auth.user && (
          <div className="card flex flex-wrap items-center gap-3 p-3 text-sm">
            <span>
              지금 <span className="font-semibold">{auth.user.name}</span> <span className="num text-dim">({auth.user.login})</span>으로 로그인해 있습니다
            </span>
            <RoleBadge role={auth.user.role} />
            <span className="ml-auto flex gap-2">
              <Link href={next} className="h-8 rounded-md border border-line bg-white/5 px-3 leading-8 hover:bg-white/10">
                돌아가기
              </Link>
              <button onClick={() => logout.mutate()} disabled={logout.isPending} className="h-8 rounded-md border border-line bg-white/5 px-3 text-down hover:bg-white/10 disabled:opacity-40">
                로그아웃
              </button>
            </span>
          </div>
        )}

        <section className="card p-4">
          <h2 className="text-sm font-semibold">시연 계정</h2>
          <p className="mt-0.5 text-xs text-sub">
            {auth.demo
              ? '누르면 그 역할로 바로 로그인하고 원래 보던 화면으로 돌아갑니다.'
              : '누르면 아이디를 채웁니다. 이 서버는 시연 계정 비밀번호를 따로 정했습니다 (DEMO_PASSWORD).'}
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {DEMO_USERS.map((u) => {
              const role = ROLES.find((r) => r.code === u.role);
              const mine = PERMS.filter((p) => PERMISSIONS[p].includes(u.role));
              const current = auth.user?.login === u.login;
              return (
                <li key={u.login}>
                  <button
                    onClick={() => pick(u.login)}
                    disabled={blocked}
                    aria-label={`${u.name} (${ROLE_NAMES[u.role]})로 로그인`}
                    className={cx(
                      'w-full rounded-md border px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50',
                      current ? 'border-info/60 bg-info/10' : 'border-line bg-white/[0.03] hover:bg-white/[0.07]',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <RoleBadge role={u.role} />
                      <span className="text-sm font-medium">{u.name}</span>
                      <span className="num text-xs text-dim">{u.login}</span>
                      <span className="ml-auto text-xs text-info">{current ? '로그인 중' : auth.demo ? '로그인 →' : '아이디 채우기'}</span>
                    </span>
                    <span className="mt-1 block text-xs text-sub">{role?.desc}</span>
                    <span className="mt-1 block text-[11px] text-dim">{mine.map((p) => PERM_NAMES[p]).join(' · ')}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {login.error && via === 'demo' && (
            <div role="alert" className="mt-2 text-xs text-down">
              {(login.error as Error).message}
            </div>
          )}
        </section>

        <section className="card p-4">
          <h2 className="text-sm font-semibold">아이디·비밀번호</h2>
          <form onSubmit={submit} className="mt-3 flex max-w-[420px] flex-col gap-2">
            <label className="text-xs text-sub">
              아이디
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={40}
                disabled={readOnly || !auth.enabled}
                className={cx(INPUT, 'num mt-1')}
                placeholder="예: lead1"
              />
            </label>
            <label className="text-xs text-sub">
              비밀번호
              <input
                ref={pwRef}
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoComplete="current-password"
                maxLength={200}
                disabled={readOnly || !auth.enabled}
                className={cx(INPUT, 'mt-1')}
              />
            </label>
            <div className="mt-1 flex items-center gap-3">
              <button
                type="submit"
                disabled={blocked || !id.trim() || !pw}
                className="h-9 rounded-md border border-info/60 bg-info/20 px-4 text-sm text-info hover:bg-info/30 disabled:opacity-40"
              >
                {login.isPending ? '확인 중…' : '로그인'}
              </button>
              <span className="text-[11px] text-dim">8시간 동안 유지됩니다 · 1분에 10번까지 시도할 수 있습니다</span>
            </div>
            {login.error && via === 'form' && (
              <div role="alert" className="text-xs text-down">
                {(login.error as Error).message}
              </div>
            )}
          </form>
        </section>
      </div>

      <section className="card min-w-0 p-4">
        <h2 className="text-sm font-semibold">역할별 권한</h2>
        <p className="mt-0.5 text-xs text-sub">
          서버와 화면이 같은 표(<span className="num">shared/src/mes.ts</span>의 <span className="num">PERMISSIONS</span>)를 봅니다. 화면에서 버튼을 흐리게 막는 것은 안내이고, 실제로
          막는 것은 서버입니다 (로그인 안 함 401 · 권한 없음 403).
        </p>
        <div className="scroll-thin mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] text-xs">
            <thead className="text-dim">
              <tr className="border-b border-line">
                <th className="py-1.5 pr-2 text-left font-normal">할 일</th>
                {ROLES.map((r) => (
                  <th key={r.code} className="px-1 text-center font-normal">
                    {r.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMS.map((p) => (
                <tr key={p} className="border-b border-line/60 hover:bg-white/[0.03]">
                  <td className="py-1.5 pr-2">
                    {PERM_NAMES[p]} <span className="num text-[10px] text-dim">{p}</span>
                  </td>
                  {ROLES.map((r) => {
                    const ok = PERMISSIONS[p].includes(r.code);
                    return (
                      <td key={r.code} className={cx('px-1 text-center', ok ? 'text-run' : 'text-dim')} title={ok ? `${r.name} 가능` : `${rolesFor(p)}만`}>
                        {ok ? '●' : '·'}
                        <span className="sr-only">{ok ? '가능' : '불가'}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-4 text-xs leading-relaxed text-sub">
          <li>공개 링크(Cloudflare)는 로그인보다 먼저 보기 전용으로 막습니다. 시연 계정 비밀번호가 알려져 있어도 공개 링크에서는 로그인도 조작도 할 수 없습니다.</li>
          <li>로그인은 서명한 httpOnly 쿠키로 8시간 유지됩니다. 화면 스크립트는 쿠키를 읽을 수 없습니다.</li>
          <li>로그인·로그인 실패·로그아웃과 상태를 바꾼 요청은 누가·언제(실제·가상 시각)·무엇을 했는지 감사 기록에 남고, 관리자가 봅니다.</li>
        </ul>
      </section>
    </div>
  );
}
