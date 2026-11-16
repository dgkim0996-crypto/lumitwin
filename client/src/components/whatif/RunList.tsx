'use client';

import { WHATIF_STATUS_NAMES, type WhatIfRunSummary } from '@lumitwin/shared';
import { Empty, Key } from '@/components/charts/kit';
import { errText } from '@/lib/execution';
import { cx } from '@/lib/format';
import { RUN_STATUS_TONE, SOURCE_NAMES, int, mdhm, planColor } from '@/lib/whatif';

/** 최근 실행 목록: 누르면 그 결과를 불러온다 (보기 전용 방문자도 저장된 결과를 본다) */
export function RunList({
  runs,
  loading,
  error,
  selected,
  onSelect,
}: {
  runs: WhatIfRunSummary[];
  loading: boolean;
  error: unknown;
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <section className="card min-w-0 p-4" data-testid="whatif-runs">
      <header className="mb-2">
        <h2 className="text-sm font-semibold">최근 실행</h2>
        <p className="mt-0.5 text-xs text-sub">누르면 그 실행의 결과를 아래에 불러옵니다. 숫자는 계획별 세 라인 양품 합계 평균입니다.</p>
      </header>
      {runs.length ? (
        <ul className="scroll-thin -mx-1 max-h-[26rem] space-y-1 overflow-y-auto px-1">
          {runs.map((r) => {
            const on = r.id === selected;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  data-testid="whatif-run-item"
                  data-id={r.id}
                  data-status={r.status}
                  aria-pressed={on}
                  onClick={() => onSelect(r.id)}
                  className={cx('w-full rounded-md border px-2.5 py-1.5 text-left', on ? 'border-info/60 bg-info/10' : 'border-line bg-white/[0.02] hover:bg-white/[0.06]')}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                    <span className="num font-semibold">#{r.id}</span>
                    <span className={cx('inline-flex items-center rounded border px-1.5 text-[10px]', RUN_STATUS_TONE[r.status])}>
                      {WHATIF_STATUS_NAMES[r.status]}
                      {r.status === 'RUNNING' && r.progress.total ? ` ${r.progress.done}/${r.progress.total}` : ''}
                    </span>
                    <span className="num text-sub">{mdhm(r.createdAt)}</span>
                    <span className="truncate text-dim">{r.createdBy ?? ''}</span>
                    <span className="ml-auto text-[11px] text-dim">
                      {SOURCE_NAMES[r.request.base]} · {r.request.horizonH}시간 × {r.request.reps}회
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-sub">
                    {r.request.scenarios.map((s, i) => (
                      <span key={i} className="inline-flex min-w-0 items-center gap-1">
                        <Key color={planColor(i)} shape="dot" />
                        <span className="max-w-[9rem] truncate">{s.name}</span>
                        {r.outMeans?.[i] != null && <span className="num text-ink">{int(r.outMeans[i])}</span>}
                      </span>
                    ))}
                  </div>
                  {r.status === 'FAILED' && r.error && <div className="mt-0.5 truncate text-[11px] text-down">{r.error}</div>}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty h={120}>
          {loading ? '불러오는 중…' : error ? errText(error) : '아직 실행한 계획이 없습니다. 계획을 고치고 아래 실행 설정에서 시뮬레이션을 돌리면 여기에 쌓입니다.'}
        </Empty>
      )}
    </section>
  );
}
