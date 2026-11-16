'use client';

import { LINES, STATIONS, variantName, type LineCode, type WhatIfBase, type WhatIfBaseSource } from '@lumitwin/shared';
import { C, Empty } from '@/components/charts/kit';
import { Meter } from '@/components/charts/small';
import { cx, kst } from '@/lib/format';
import { SOURCE_DESC, SOURCE_NAMES, int, mins, scenarioName, stationLabel } from '@/lib/whatif';

/** 마모가 이보다 크면 강조 (예지 보전 화면의 경고 구간과 비슷한 어림, assumed) */
const WEAR_HIGH = 0.6;

/**
 * 기준 상태 카드: 서버가 시뮬레이터에 넘길 시작 상태를 그대로 보여 준다
 * (가상 시작 시각, 라인별 기종·작업지시 순서, 고장·보전 중 설비, 마모, 켜진 공정 이상, 어림한 것)
 */
export function BaseCard({
  source,
  onSource,
  base,
  loading,
  error,
  onReload,
  reloading,
}: {
  source: WhatIfBaseSource;
  onSource: (s: WhatIfBaseSource) => void;
  base?: WhatIfBase;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  reloading: boolean;
}) {
  const stations = Object.entries(base?.stations ?? {});
  const stopped = stations.filter(([, s]) => s.state === 'DOWN' || s.state === 'PM');
  const worn = stations.filter(([, s]) => s.wear != null).sort((a, b) => (b[1].wear ?? 0) - (a[1].wear ?? 0));
  const sum = (r?: Record<string, number>) => Object.values(r ?? {}).reduce((a, b) => a + b, 0);
  const inside = Object.values(base?.inproc ?? {}).reduce((a, slots) => a + slots.reduce((x, [n]) => x + n, 0), 0);
  const wip = sum(base?.buffers) + sum(base?.inbound) + inside;

  return (
    <section className="card min-w-0 p-4" data-testid="whatif-base" data-loaded={base ? '1' : '0'} data-error={!base && error ? '1' : '0'} data-source={base?.source ?? ''}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">기준 상태</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-sub">
            {SOURCE_DESC[source]}. 미리 보기이고, 실행하면 서버가 그 순간의 상태를 다시 복사합니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="기준 상태 고르기" className="flex overflow-hidden rounded border border-line text-xs">
            {(['live', 'clean'] as const).map((s) => (
              <button
                key={s}
                type="button"
                data-testid="whatif-source"
                data-value={s}
                aria-pressed={source === s}
                onClick={() => onSource(s)}
                title={SOURCE_DESC[s]}
                className={cx('px-2 py-1', source === s ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}
              >
                {SOURCE_NAMES[s]}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onReload}
            disabled={reloading}
            title="기준 상태를 다시 읽고 고친 계획을 지금 계획으로 되돌립니다"
            className="rounded border border-line px-2 py-1 text-xs text-sub hover:bg-white/10 hover:text-ink disabled:opacity-40"
          >
            {reloading ? '읽는 중…' : '다시 읽기'}
          </button>
        </div>
      </header>

      {!base ? (
        <Empty h={120}>
          {loading ? (
            '기준 상태를 읽는 중…'
          ) : error ? (
            <span>
              {error}
              {source === 'live' && (
                <>
                  <br />
                  <button type="button" onClick={() => onSource('clean')} className="mt-2 rounded border border-info/50 bg-info/10 px-2 py-1 text-xs text-ink hover:bg-info/20">
                    초기화한 공장(clean)으로 보기
                  </button>
                </>
              )}
            </span>
          ) : (
            '-'
          )}
        </Empty>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-sub">
            <span>
              가상 시작 <b className="num text-ink">{kst(base.startAt, true)}</b> (한국 시각)
            </span>
            <span>
              시작 상태 <b className="text-ink">{SOURCE_NAMES[base.source]}</b>
            </span>
            {base.buffers && (
              <span>
                재공 <span className="num">{int(wip)}</span>개 (버퍼·이송·설비 안)
              </span>
            )}
          </div>

          <div className="grid gap-3 @4xl:grid-cols-3">
            {LINES.map((l) => {
              const bl = base.lines?.[l.code as LineCode];
              return (
                <div key={l.code} className="min-w-0 rounded-md border border-line bg-white/[0.02] p-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-1">
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium">
                      <span className="size-2.5 rounded-full" style={{ background: l.color }} />
                      {l.name}
                    </span>
                    <span className="text-[11px] text-sub">기종 {bl?.variant ? variantName(l, bl.variant) : '-'}</span>
                  </div>
                  {bl?.orders.length ? (
                    <ol className="mt-1.5 space-y-0.5 text-[11px]">
                      {bl.orders.map((o, i) => (
                        <li key={o.id} className="flex min-w-0 items-baseline gap-1.5">
                          <span className="num w-4 shrink-0 text-right text-dim">{i + 1}</span>
                          <span className="num min-w-0 truncate font-semibold" title={o.code}>
                            {o.code}
                          </span>
                          <span className="min-w-0 truncate text-sub">{variantName(l, o.variant)}</span>
                          <span className="ml-auto shrink-0 text-sub">
                            {o.status === 'RUNNING' ? (
                              <span className="text-info" title={`투입 ${o.released} · 양품 ${o.done}`}>
                                투입 중 <span className="num">{o.released}/{o.qty}</span>
                              </span>
                            ) : (
                              <>
                                <span className="num">{o.qty}</span>개
                              </>
                            )}
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="mt-1.5 text-[11px] text-dim">대기 작업지시 없음 (자동 계획이 채웁니다)</p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-3 grid gap-3 text-xs @4xl:grid-cols-3">
            <div className="min-w-0">
              <h3 className="mb-1 text-[11px] text-dim">고장·보전 중 설비</h3>
              {stopped.length ? (
                <ul className="space-y-0.5">
                  {stopped.map(([code, s]) => (
                    <li key={code} className="flex gap-2">
                      <span className={cx('shrink-0', s.state === 'DOWN' ? 'text-down' : 'text-info')}>{s.state === 'DOWN' ? '고장 중' : '보전 중'}</span>
                      <span className="min-w-0 truncate">{stationLabel(code)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-dim">{base.source === 'clean' ? '초기화한 공장은 모두 정상으로 시작합니다' : '없음'}</p>
              )}
            </div>
            <div className="min-w-0">
              <h3 className="mb-1 text-[11px] text-dim">마모 (예지 보전 설비, 0~1 · {WEAR_HIGH} 이상 강조)</h3>
              {worn.length ? (
                <ul className="space-y-1">
                  {worn.slice(0, 6).map(([code, s]) => {
                    const high = (s.wear ?? 0) >= WEAR_HIGH;
                    return (
                      <li key={code} className="grid grid-cols-[minmax(0,1fr)_64px_36px] items-center gap-2" title={STATIONS[code]?.health?.part}>
                        <span className={cx('min-w-0 truncate', high && 'font-semibold text-warn')}>
                          {stationLabel(code)}
                          {high && <span className="ml-1 text-[10px]">마모 큼</span>}
                        </span>
                        <Meter value={s.wear ?? 0} color={high ? C.warn : C.series} />
                        <span className={cx('num text-right', high ? 'text-warn' : 'text-sub')}>{(s.wear ?? 0).toFixed(2)}</span>
                      </li>
                    );
                  })}
                  {worn.length > 6 && <li className="text-[11px] text-dim">외 {worn.length - 6}대</li>}
                </ul>
              ) : (
                <p className="text-dim">{base.source === 'clean' ? '시뮬레이터가 마모를 무작위로 정합니다' : '진동 표본이 없어 넣지 않았습니다'}</p>
              )}
            </div>
            <div className="min-w-0">
              <h3 className="mb-1 text-[11px] text-dim">켜진 공정 이상</h3>
              {base.scenarios?.length ? (
                <ul className="space-y-0.5">
                  {base.scenarios.map((s) => (
                    <li key={s.id} className="flex gap-2">
                      <span className="shrink-0 text-warn">켜짐</span>
                      <span className="min-w-0 truncate">{scenarioName(s.id)}</span>
                      <span className="num ml-auto shrink-0 text-sub">{mins(s.elapsedMin)}째</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-dim">없음</p>
              )}
            </div>
          </div>

          {base.notes.length > 0 && (
            <div className="mt-3 rounded-md border border-line bg-white/[0.02] px-3 py-2">
              <h3 className="mb-1 text-[11px] text-dim">기준 상태를 만들며 어림한 것</h3>
              <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-sub">
                {base.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
