'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { DEMO_USERS, SYSTEM_ACTOR } from '@lumitwin/shared';
import { RoleBadge } from '@/components/auth/RoleBadge';
import { PageShell } from '@/components/mes/PageShell';
import { useAccess } from '@/lib/access';
import { api } from '@/lib/api';
import { actionName, AUDIT_KEY, useAuth, type AuditView } from '@/lib/auth';
import { kst } from '@/lib/format';

const LIMITS = [100, 200, 500, 1000] as const;
const SELECT = 'rounded border border-line bg-[var(--color-chart)] px-2 py-1 text-ink';

/** 로그인 아이디 → 사람이 읽는 이름 */
function userName(login: string): string {
  if (login === SYSTEM_ACTOR.login) return SYSTEM_ACTOR.name;
  if (login === 'anonymous') return '로그인 전';
  return DEMO_USERS.find((u) => u.login === login)?.name ?? login;
}

/** detail(JSON)을 한 줄로: 'speed=5 · on=true' */
function detailText(d: unknown): string {
  if (d == null) return '';
  if (typeof d !== 'object') return String(d);
  return Object.entries(d as Record<string, unknown>)
    .map(([k, v]) => `${k}=${v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}

export default function AuditPage() {
  const auth = useAuth();
  const { readOnly } = useAccess();
  const allowed = auth.can('audit.read');
  const [user, setUser] = useState('');
  const [action, setAction] = useState('');
  const [limit, setLimit] = useState<number>(200);

  const q = useQuery({
    queryKey: [...AUDIT_KEY, user, action, limit],
    queryFn: () => {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (user) qs.set('user', user);
      if (action) qs.set('action', action);
      return api.get<AuditView>(`/audit?${qs}`);
    },
    enabled: allowed,
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });
  const data = allowed ? q.data : undefined;
  const total = useMemo(() => (data?.actions ?? []).reduce((a, x) => a + x.count, 0), [data]);
  // 동작 필터: 앞부분(sim·station·login…)으로 묶은 것('sim*', 서버가 앞부분 일치로 찾는다)과 낱낱의 동작(정확히 일치)
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of data?.actions ?? []) {
      const g = a.action.split('.')[0];
      m.set(g, (m.get(g) ?? 0) + a.count);
    }
    return [...m.entries()].filter(([g]) => (data?.actions ?? []).filter((a) => a.action.split('.')[0] === g).length > 1);
  }, [data]);

  const filters = allowed ? (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <label className="flex items-center gap-1.5 text-sub">
        사용자
        <select value={user} onChange={(e) => setUser(e.target.value)} className={SELECT}>
          <option value="">전체</option>
          {(data?.users ?? []).map((u) => (
            <option key={u.user} value={u.user}>
              {userName(u.user)} ({u.user}) · {u.count}
            </option>
          ))}
          {user && !(data?.users ?? []).some((u) => u.user === user) && <option value={user}>{userName(user)}</option>}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-sub">
        동작
        <select value={action} onChange={(e) => setAction(e.target.value)} className={SELECT}>
          <option value="">전체</option>
          {groups.length > 0 && (
            <optgroup label="묶음">
              {groups.map(([g, n]) => (
                <option key={`g-${g}`} value={`${g}*`}>
                  {g}.* 전체 · {n}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="동작">
            {(data?.actions ?? []).map((a) => (
              <option key={a.action} value={a.action}>
                {actionName(a.action)} ({a.action}) · {a.count}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-sub">
        최근
        <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className={SELECT}>
          {LIMITS.map((n) => (
            <option key={n} value={n}>
              {n}건
            </option>
          ))}
        </select>
      </label>
      {(user || action) && (
        <button
          onClick={() => {
            setUser('');
            setAction('');
          }}
          className="rounded border border-line px-2 py-0.5 text-sub hover:bg-white/10 hover:text-ink"
        >
          필터 지우기
        </button>
      )}
      <span className="text-dim">
        {data ? `${data.rows.length}건 표시 · 전체 ${total.toLocaleString('ko-KR')}건` : ''}
        {q.isFetching && data ? ' · 새로 읽는 중' : ''}
      </span>
    </div>
  ) : undefined;

  return (
    <PageShell
      title="감사 기록"
      desc={
        <>
          누가 언제 무엇을 바꿨는지(로그인·설비 조작·시뮬레이터 제어·알람 확인·작업 전 점검과 작업지시·불량 처리·Hold·변경점)를 새것부터 보여 줍니다. 실제 시각은 서버 시계(한국 시각), 가상 시각은 그때
          시뮬레이터 시계입니다. 10초마다 새로 읽습니다. 관리자만 볼 수 있습니다.
        </>
      }
      filters={filters}
    >
      {!allowed ? (
        <div className="card p-4 text-sm">
          {auth.loading ? (
            <span className="text-dim">로그인 상태를 확인하는 중…</span>
          ) : (
            <>
              <p>감사 기록은 관리자만 볼 수 있습니다.</p>
              <p className="mt-1 text-xs text-sub">{auth.why('audit.read')}</p>
              {!readOnly && (
                <Link href="/login?next=%2Faudit" className="mt-3 inline-block rounded-md border border-info/50 bg-info/10 px-3 py-1.5 text-sm text-info hover:bg-info/20">
                  관리자로 로그인
                </Link>
              )}
            </>
          )}
        </div>
      ) : (
        <section className="card p-0">
          {q.error && !data && <div className="p-4 text-xs text-down">{(q.error as Error).message}</div>}
          {!q.error && !data && <div className="p-4 text-xs text-dim">불러오는 중…</div>}
          {data && data.rows.length === 0 && <div className="p-4 text-xs text-dim">조건에 맞는 기록이 없습니다.</div>}
          {data && data.rows.length > 0 && (
            <div className="scroll-thin max-h-[calc(100vh-260px)] overflow-auto">
              <table className="w-full min-w-[1080px] text-xs">
                <thead className="sticky top-0 z-10 bg-[var(--color-chart)] text-dim">
                  <tr className="border-b border-line">
                    <th className="py-1.5 pl-3 pr-2 text-left font-normal">실제 시각</th>
                    <th className="px-2 text-left font-normal">가상 시각</th>
                    <th className="px-2 text-left font-normal">사용자</th>
                    <th className="px-2 text-left font-normal">역할</th>
                    <th className="px-2 text-left font-normal">동작</th>
                    <th className="px-2 text-left font-normal">대상</th>
                    <th className="px-2 text-left font-normal">내용</th>
                    <th className="px-2 pr-3 text-left font-normal">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => {
                    const detail = detailText(r.detail);
                    const fail = r.action.endsWith('.fail');
                    return (
                      <tr key={r.id} className="border-b border-line/60 align-top hover:bg-white/[0.03]">
                        <td className="num whitespace-nowrap py-1.5 pl-3 pr-2">{kst(r.at, true)}</td>
                        <td className="num whitespace-nowrap px-2 py-1.5 text-sub">
                          {r.vAt ? kst(r.vAt, true) : '-'}
                          {r.runId != null && <span className="ml-1 text-[10px] text-dim">실행 {r.runId}</span>}
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5">
                          {userName(r.user)} <span className="num text-dim">{r.user}</span>
                        </td>
                        <td className="px-2 py-1.5">
                          <RoleBadge role={r.role} />
                        </td>
                        <td className="whitespace-nowrap px-2 py-1.5">
                          <span className={fail ? 'text-down' : undefined}>{actionName(r.action)}</span> <span className="num text-[10px] text-dim">{r.action}</span>
                        </td>
                        <td className="num whitespace-nowrap px-2 py-1.5">{r.target ?? <span className="text-dim">-</span>}</td>
                        <td className="max-w-[380px] truncate px-2 py-1.5 text-sub" title={detail || undefined}>
                          {detail || <span className="text-dim">-</span>}
                        </td>
                        <td className="num whitespace-nowrap px-2 pr-3 py-1.5 text-dim">{r.ip ?? '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </PageShell>
  );
}
