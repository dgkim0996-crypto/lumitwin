'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CHANGE_KIND_NAMES, STATIONS, faRequired } from '@lumitwin/shared';
import { CategoryTag, FaChip } from '@/components/quality-system/badges';
import { ChangeReportForm } from '@/components/quality-system/ChangeReportForm';
import { useGate } from '@/lib/auth';
import { cx, duration, kst } from '@/lib/format';
import { useLive } from '@/lib/live';
import { useChanges, useFaStatus } from '@/lib/quality-system';
import { BottomSheet } from './BottomSheet';

/**
 * 작업자 태블릿: 이 설비의 초물 상태와 최근 4M 변경점, 변경점 신고.
 * 초물 대기면 맨 위에 크게 알린다 — 게이트 설비는 초물이 합격할 때까지 다음 투입이 멈춰 있기 때문이다
 */
export function OperatorQuality({ code, className }: { code: string; className?: string }) {
  const def = STATIONS[code];
  const simT = useLive((s) => s.sim?.t);
  const gate = useGate('change.register');
  const [sheet, setSheet] = useState(false);
  const fa = useFaStatus();
  const changes = useChanges({ station: code, limit: 5 }, 10_000);
  const mine = fa.data?.find((x) => x.station === code);
  const pending = mine?.pending ?? [];
  const ng = pending.some((p) => p.status === 'NG');
  const last = mine?.lastFirst;

  return (
    <section className={cx('card min-w-0 p-4', className)} aria-label="초물·변경점">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">초물·변경점 (4M)</h2>
        {pending.length ? <FaChip status={ng ? 'NG' : 'PENDING'} size="lg" /> : <span className="text-sm text-run">초물 대기 없음</span>}
      </div>

      {pending.length > 0 && (
        <div className={cx('mb-3 rounded-xl border px-3 py-2.5', ng ? 'border-down/50 bg-down/10' : 'border-warn/50 bg-warn/10')}>
          <p className={cx('text-lg font-semibold', ng ? 'text-down' : 'text-warn')}>
            {ng ? '초물 불합격 — 다음 개체를 다시 초물로 검사합니다' : '다음 개체가 초물입니다'}
          </p>
          <p className="mt-0.5 text-sm text-sub">
            {def?.gate ? '초물이 합격할 때까지 이 설비의 다음 투입은 MES가 대기시킵니다 (인터록).' : '초물 결과는 MES에 기록됩니다.'}
            {' '}가장 오래된 변경 {simT ? duration((Date.parse(simT) - Date.parse(pending[0].since)) / 1000) : '-'} 전
          </p>
          <ul className="mt-2 space-y-1">
            {pending.map((p) => (
              <li key={p.simId ?? p.changeId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-base">
                <CategoryTag category={p.category} size="lg" />
                <span className="min-w-0 flex-1">{p.detail}</span>
                <span className="num text-xs text-dim">
                  {kst(p.since)} · {p.simId}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-base">
        <span className="text-sub">마지막 초물</span>
        {last ? (
          <>
            <span className="num text-sub">{kst(last.at)}</span>
            <span className="num">{last.serial}</span>
            <span className={cx('font-semibold', last.result === 'NG' ? 'text-down' : 'text-run')}>{last.result === 'NG' ? '불합격' : '합격'}</span>
          </>
        ) : (
          <span className="text-dim">이번 실행에서 아직 없음{def && !faRequired(def) ? ' (평소 초물 대상 아님)' : ''}</span>
        )}
      </div>

      <div className="mt-3">
        <div className="mb-1 text-sm text-sub">최근 변경점</div>
        {(changes.data ?? []).length === 0 ? (
          <div className="py-1 text-base text-dim">{changes.isLoading ? '불러오는 중…' : '이번 실행에서 아직 없습니다'}</div>
        ) : (
          <div className="divide-y divide-line">
            {(changes.data ?? []).map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="num w-20 text-sm text-sub">{kst(c.at)}</span>
                <CategoryTag category={c.category} />
                <span className="min-w-0 flex-1 text-base leading-snug">
                  {c.detail}
                  <span className="ml-1 text-xs text-dim">{CHANGE_KIND_NAMES[c.kind] ?? c.kind}</span>
                </span>
                <FaChip status={c.faStatus} serial={c.faSerial} />
              </div>
            ))}
          </div>
        )}
        <Link href={`/changes?station=${encodeURIComponent(code)}`} className="mt-1 inline-block text-sm text-info hover:underline">
          변경점·초중종물 화면에서 전체 보기 →
        </Link>
      </div>

      <button
        disabled={!gate.ok}
        title={gate.title}
        onClick={() => setSheet(true)}
        className="mt-3 flex min-h-20 w-full flex-col items-center justify-center rounded-xl border border-warn/50 bg-warn/15 text-xl font-semibold text-warn hover:bg-warn/25 disabled:opacity-40"
      >
        변경점 신고
        <span className="mt-0.5 text-xs font-normal opacity-80">사람·설비·자재·방법이 바뀌었을 때</span>
      </button>

      {sheet && (
        <BottomSheet title="변경점 신고" desc={`${code} ${def?.name ?? ''} · 신고하면 MES에 기록되고, 초물이 필요하면 다음 개체가 초물이 됩니다.`} onClose={() => setSheet(false)}>
          <ChangeReportForm station={code} size="lg" onDone={() => setTimeout(() => setSheet(false), 1200)} />
        </BottomSheet>
      )}
    </section>
  );
}
