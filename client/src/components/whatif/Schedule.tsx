'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LINES, variantName, type LineCode, type WhatIfApplyResult, type WhatIfOrderKpi, type WhatIfResult, type WhatIfRunView } from '@lumitwin/shared';
import { C, ChartCard, Empty, Key, Tip, TipRow, TipTitle, useWidth } from '@/components/charts/kit';
import { MiniButton } from '@/components/execution/bits';
import { isDenied } from '@/lib/api';
import { useGate } from '@/lib/auth';
import { errText, useOrders } from '@/lib/execution';
import { cx } from '@/lib/format';
import { int, lineName, mins, planColor, signed, useWhatIfApply, vclock } from '@/lib/whatif';

const ROW_H = 26;
const BAR_H = 8;

/**
 * 작업지시 일정: 라인을 골라 계획마다 지시별 '끝난 시각'을 가로 막대로 본다.
 * 막대 = 끝낸 반복들의 10~90 백분위, 세로 선 = 평균, 고리 = 계산식 예상(작업지시 화면의 예상 끝), 점선 = 납기
 */
export function OrderSchedule({ run, result }: { run: WhatIfRunView; result: WhatIfResult }) {
  const [line, setLine] = useState<LineCode>('HL');
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ plan: number; o: WhatIfOrderKpi; y: number; x: number } | null>(null);
  const narrow = width < 640;
  const labelW = narrow ? 118 : 210;
  const endW = narrow ? 0 : 196;
  const plot = Math.max(80, width - labelW - endW);
  const span = result.horizonH * 60;
  const x = (m: number) => (Math.max(0, Math.min(span, m)) / span) * plot;
  const step = Math.max(1, Math.ceil(result.horizonH / (narrow ? 4 : 8)));
  const hours = Array.from({ length: Math.floor(result.horizonH / step) + 1 }, (_, i) => i * step);
  const reps = result.reps;

  return (
    <ChartCard
      title="작업지시 일정 (끝나는 시각)"
      subtitle="시뮬레이션은 고장·불량·수리·막힘까지 돌려 본 끝 시각이고, 고리는 작업지시 화면의 계산식 예상(투입 간격 × 수량 + 셋업)입니다. 둘이 많이 벌어지면 계산식 예상을 믿기 어렵습니다. 끝낸 반복이 적으면 시간 안에 못 끝낸 반복이 있다는 뜻입니다."
      right={
        <div role="tablist" aria-label="라인 선택" className="flex overflow-hidden rounded border border-line text-xs">
          {LINES.map((l) => (
            <button
              key={l.code}
              role="tab"
              aria-selected={line === l.code}
              onClick={() => setLine(l.code as LineCode)}
              className={cx('flex items-center gap-1.5 px-2 py-0.5', line === l.code ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}
            >
              <span className="size-2 rounded-full" style={{ background: l.color }} />
              {l.short}
            </button>
          ))}
        </div>
      }
    >
      <ul className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-sub">
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-sm" style={{ background: C.sub, opacity: 0.5 }} />끝 시각 범위 (계획 색)
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-[2px]" style={{ background: C.sub }} />끝 시각 평균
        </li>
        <li className="flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden>
            <circle cx="5" cy="5" r="3.5" fill="none" stroke={C.ink} strokeWidth="1.5" />
          </svg>
          계산식 예상 끝
        </li>
        <li className="flex items-center gap-1.5">
          <Key color={C.warn} shape="dash" />
          납기
        </li>
      </ul>

      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        {/* 시간 축 */}
        <div className="flex text-[10px] text-dim" style={{ height: 16 }}>
          <span className="shrink-0" style={{ width: labelW }} />
          <svg width={plot} height={16} className="block shrink-0 overflow-visible" aria-hidden>
            {hours.map((h, i) => (
              <text key={h} x={x(h * 60)} y={11} textAnchor={i === 0 ? 'start' : h * 60 >= span ? 'end' : 'middle'} fontSize={10} fill={C.dim} className="num">
                {h}h
              </text>
            ))}
          </svg>
        </div>

        {result.scenarios.map((s, i) => {
          const orders = s.orders.filter((o) => o.line === line);
          return (
            <div key={i} className="mt-2">
              <div className="flex flex-wrap items-center gap-2 border-b border-line/60 pb-1">
                <Key color={planColor(i)} shape="dot" />
                <span className="min-w-0 truncate text-xs font-medium">{s.name}</span>
                {i === 0 && <span className="text-[10px] text-dim">기준</span>}
                <span className="ml-auto">
                  <ApplyButton run={run} scenario={i} line={line} name={s.name} />
                </span>
              </div>
              {orders.length ? (
                orders.map((o) => {
                  const f = o.finishMin;
                  const late = o.dueMin != null && (o.onTimeReps ?? 0) < reps;
                  return (
                    <div
                      key={`${o.code}-${o.id ?? ''}`}
                      className={cx('flex items-center rounded', hover?.o === o && 'bg-white/[0.05]')}
                      style={{ height: ROW_H }}
                      onMouseEnter={(e) => setHover({ plan: i, o, y: e.currentTarget.offsetTop + ROW_H, x: labelW + (f ? x(f.mean) : plot / 2) })}
                    >
                      <span className="flex min-w-0 shrink-0 items-center gap-1 pr-2 text-xs" style={{ width: labelW }}>
                        <span className={cx('num truncate', o.auto ? 'text-sub' : 'font-semibold')} title={o.code}>
                          {o.code}
                        </span>
                        {o.auto && <span className="shrink-0 rounded border border-line px-1 text-[10px] text-dim">자동</span>}
                        {!narrow && <span className="num shrink-0 text-[10px] text-dim">{o.qty}개</span>}
                      </span>
                      <svg width={plot} height={ROW_H} className="block shrink-0" role="img" aria-label={orderAria(o, s.name, reps, run.vStartAt)}>
                        {hours.map((h) => (
                          <line key={h} x1={x(h * 60)} x2={x(h * 60)} y1={0} y2={ROW_H} stroke={h === 0 ? C.axis : C.grid} />
                        ))}
                        {o.dueMin != null && o.dueMin <= span && (
                          <line x1={x(o.dueMin)} x2={x(o.dueMin)} y1={2} y2={ROW_H - 2} stroke={C.warn} strokeWidth={1.5} strokeDasharray="3 2" />
                        )}
                        {f ? (
                          <>
                            <rect
                              x={x(f.p10)}
                              y={(ROW_H - BAR_H) / 2}
                              width={Math.max(3, x(f.p90) - x(f.p10))}
                              height={BAR_H}
                              rx={2}
                              fill={planColor(i)}
                              opacity={0.45}
                            />
                            <line x1={x(f.mean)} x2={x(f.mean)} y1={ROW_H / 2 - 7} y2={ROW_H / 2 + 7} stroke={planColor(i)} strokeWidth={2} strokeLinecap="round" />
                          </>
                        ) : (
                          <text x={plot - 4} y={ROW_H / 2} dy="0.32em" textAnchor="end" fontSize={10} fill={C.dim}>
                            시간 안에 못 끝냄 →
                          </text>
                        )}
                        {o.planEndMin != null && (
                          <circle cx={o.planEndMin > span ? plot - 4 : x(o.planEndMin)} cy={ROW_H / 2} r={3.5} fill={C.surface} stroke={C.ink} strokeWidth={1.5} />
                        )}
                      </svg>
                      {endW > 0 && (
                        <span className="num shrink-0 truncate pl-2 text-[11px] text-sub" style={{ width: endW }}>
                          {f ? vclock(run.vStartAt, f.mean) : '-'} · {o.finishedReps}/{reps}회
                          {o.dueMin != null && <span className={late ? 'text-down' : 'text-run'}> · 납기 {o.onTimeReps ?? 0}/{reps}</span>}
                        </span>
                      )}
                    </div>
                  );
                })
              ) : (
                <Empty h={40}>이 라인에 작업지시가 없었습니다.</Empty>
              )}
            </div>
          );
        })}

        {hover && <OrderTip hover={hover} width={width} reps={reps} start={run.vStartAt} planName={result.scenarios[hover.plan]?.name ?? ''} />}
      </div>
    </ChartCard>
  );
}

function orderAria(o: WhatIfOrderKpi, plan: string, reps: number, start: string) {
  const f = o.finishMin;
  return `${plan} ${o.code}: ${f ? `끝 평균 ${vclock(start, f.mean)}, 범위 ${vclock(start, f.p10)}~${vclock(start, f.p90)}` : '시간 안에 못 끝냄'}, 끝낸 반복 ${o.finishedReps}/${reps}${o.planEndMin != null ? `, 계산식 예상 ${vclock(start, o.planEndMin)}` : ''}`;
}

function OrderTip({ hover, width, reps, start, planName }: { hover: { plan: number; o: WhatIfOrderKpi; y: number; x: number }; width: number; reps: number; start: string; planName: string }) {
  const { o } = hover;
  const f = o.finishMin;
  const gap = f && o.planEndMin != null ? f.mean - o.planEndMin : null;
  return (
    <Tip x={hover.x} y={hover.y} width={width}>
      <TipTitle>
        {planName} · {o.code}
        {o.auto ? ' (자동 계획)' : o.id == null ? ' (새 지시)' : ''}
      </TipTitle>
      <TipRow label="기종 · 수량" value={`${variantName(o.line, o.variant)} · ${o.qty}개`} />
      <TipRow color={planColor(hover.plan)} label="끝 평균 (시뮬레이션)" value={f ? `${vclock(start, f.mean)} (+${mins(f.mean)})` : '못 끝냄'} />
      {f && <TipRow label="끝 범위 (10~90 백분위)" value={`${vclock(start, f.p10)} ~ ${vclock(start, f.p90)}`} />}
      <TipRow label="계산식 예상 끝" value={o.planEndMin != null ? `${vclock(start, o.planEndMin)} (+${mins(o.planEndMin)})` : '-'} />
      {gap != null && <TipRow label={gap >= 0 ? '시뮬레이션이 늦음' : '시뮬레이션이 빠름'} value={signed(gap, mins)} />}
      {o.dueMin != null && <TipRow color={C.warn} label={`납기 · 지킨 반복`} value={`${vclock(start, o.dueMin)} · ${o.onTimeReps ?? 0}/${reps}`} />}
      <TipRow label="끝낸 반복 · 양품 평균" value={`${o.finishedReps}/${reps} · ${int(o.doneMean)}개`} />
    </Tip>
  );
}

function ApplyButton({ run, scenario, line, name }: { run: WhatIfRunView; scenario: number; line: LineCode; name: string }) {
  const gate = useGate('wo.manage');
  const [open, setOpen] = useState(false);
  const changed = !!run.request.scenarios[scenario]?.orders?.[line];
  const title = !changed ? `이 계획은 ${lineName(line)} 작업지시를 바꾸지 않았습니다 (지금 계획 그대로)` : (gate.title ?? `${name}의 ${lineName(line)} 순서를 MES 대기 순서에 반영합니다`);
  return (
    <>
      <MiniButton tone="primary" onClick={() => setOpen(true)} disabled={!changed || !gate.ok} title={title}>
        <span data-testid="whatif-apply">MES 대기 순서에 반영</span>
      </MiniButton>
      {open && <ApplyDialog run={run} scenario={scenario} line={line} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function ApplyDialog({ run, scenario, line, name, onClose }: { run: WhatIfRunView; scenario: number; line: LineCode; name: string; onClose: () => void }) {
  const gate = useGate('wo.manage');
  const orders = useOrders(line);
  const apply = useWhatIfApply(run.id);
  const [res, setRes] = useState<WhatIfApplyResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const plan = run.request.scenarios[scenario]?.orders?.[line] ?? [];
  const current = (orders.data ?? []).filter((o) => o.status === 'RUNNING' || o.status === 'PLANNED');
  const planned = current.filter((o) => o.status === 'PLANNED');
  const curIds = new Set(current.map((o) => o.id));
  const planIds = new Set(plan.filter((o) => o.id != null).map((o) => o.id!));
  const left = planned.filter((o) => !planIds.has(o.id));
  const qtyChanged = planned.filter((c) => plan.some((o) => o.id === c.id && o.qty !== c.qty));
  const codeOf = (id: number) => current.find((o) => o.id === id)?.code ?? (orders.data ?? []).find((o) => o.id === id)?.code ?? `#${id}`;
  let newN = 0;

  const submit = () => {
    setErr(null);
    apply.mutate(
      { scenario, line },
      {
        onSuccess: setRes,
        onError: (e) => setErr(isDenied(e) && gate.readOnly ? '공개 링크는 보기 전용이라 반영할 수 없습니다.' : errText(e, '반영하지 못했습니다')),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="MES 대기 순서에 반영"
        data-testid="whatif-apply-dialog"
        className="panel scroll-thin max-h-[86vh] w-full max-w-[720px] overflow-y-auto p-4"
        style={{ background: 'var(--color-panel-solid)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-base font-semibold">MES 대기 순서에 반영</div>
            <div className="text-xs text-sub">
              {name} · {lineName(line)} · 실행 #{run.id}
            </div>
          </div>
          <button onClick={onClose} className="rounded px-2 py-1 text-sm text-sub hover:bg-white/10">
            닫기
          </button>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-sub">
          이 계획의 작업지시 순서대로 MES 대기(계획) 작업지시를 다시 늘어놓고, 계획에서 더한 지시는 새로 만듭니다. 투입 중인 지시는 그대로 맨 앞에 둡니다. 계획에서 뺀 지시는 자동으로 중단하지 않고
          MES에 남겨 둡니다. 시뮬레이션 뒤에 MES가 바뀌었을 수 있으니 지금 순서와 견줘 보세요.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="min-w-0 rounded-md border border-line p-2">
            <h3 className="mb-1 text-[11px] text-dim">지금 MES 순서</h3>
            {orders.isPending ? (
              <p className="text-xs text-dim">불러오는 중…</p>
            ) : current.length ? (
              <ol className="space-y-0.5 text-xs">
                {current.map((o, i) => (
                  <li key={o.id} className="flex min-w-0 gap-1.5">
                    <span className="num w-4 shrink-0 text-right text-dim">{i + 1}</span>
                    <span className="num truncate">{o.code}</span>
                    <span className="num ml-auto shrink-0 text-sub">{o.status === 'RUNNING' ? '투입 중' : `${o.qty}개`}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-dim">대기 작업지시가 없습니다.</p>
            )}
          </div>
          <div className="min-w-0 rounded-md border border-info/40 bg-info/[0.05] p-2">
            <h3 className="mb-1 text-[11px] text-dim">반영할 순서 (이 계획)</h3>
            <ol className="space-y-0.5 text-xs">
              {plan.map((o, i) => {
                const gone = o.id != null && orders.data && !curIds.has(o.id);
                const label = o.id != null ? (o.code ?? codeOf(o.id)) : `NEW-${line}-${++newN}`;
                const was = o.id != null ? current.findIndex((c) => c.id === o.id) : -1;
                return (
                  <li key={i} className="flex min-w-0 flex-wrap gap-x-1.5">
                    <span className="num w-4 shrink-0 text-right text-dim">{i + 1}</span>
                    <span className={cx('num truncate', gone && 'text-dim line-through')}>{label}</span>
                    {o.id == null && <span className="text-[10px] text-info">새로 만듦 · {o.variant}</span>}
                    {was >= 0 && was !== i && <span className="text-[10px] text-info">지금 {was + 1}번째</span>}
                    {gone && <span className="text-[10px] text-warn">MES에 없음 (끝났거나 중단됨)</span>}
                    <span className="num ml-auto shrink-0 text-sub">{o.qty}개</span>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
        {qtyChanged.length > 0 && !res && (
          <p className="mt-2 text-[11px] text-sub">
            수량을 바꾼 지시({qtyChanged.map((o) => o.code).join(', ')})는 순서만 반영하고 수량은 그대로 둡니다. 수량은 작업지시 화면에서 고치세요.
          </p>
        )}
        {left.length > 0 && !res && (
          <p className="mt-2 text-[11px] text-sub">
            계획에 없는 대기 지시 {left.length}건({left.map((o) => o.code).join(', ')})은 그대로 남습니다 (순서는 반영한 지시 뒤).
          </p>
        )}

        {res ? (
          <div role="status" data-testid="whatif-apply-result" className="mt-3 rounded-md border border-run/40 bg-run/10 px-3 py-2 text-xs leading-relaxed text-ink">
            반영했습니다 ({lineName(res.line)}): 순서를 바꾼 대기 지시 <b className="num">{res.reordered.length}</b>건 · 새로 만든 지시 <b className="num">{res.created.length}</b>건 · 그대로 둔 지시{' '}
            <b className="num">{res.untouched.length}</b>건
            {res.created.length > 0 && <div className="text-sub">새로 만든 지시: {res.created.map(codeOf).join(', ')}</div>}
            {res.untouched.length > 0 && (
              <div className="text-sub">
                그대로 둔 지시({res.untouched.map(codeOf).join(', ')})는 계획에서 뺐지만 MES에 남아 있습니다. 필요하면 작업지시 화면에서 중단하세요.
              </div>
            )}
            <div className="mt-1">
              <Link href="/orders" className="text-info hover:underline">
                작업지시 화면에서 보기 →
              </Link>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            {err && (
              <span role="alert" className="mr-auto text-xs text-down">
                {err}
              </span>
            )}
            {!gate.ok && <span className="mr-auto text-xs text-sub">{gate.title}</span>}
            <button type="button" onClick={onClose} className="h-8 rounded-md border border-line px-3 text-sm text-sub hover:bg-white/10">
              취소
            </button>
            <button
              type="button"
              data-testid="whatif-apply-confirm"
              onClick={submit}
              disabled={!gate.ok || apply.isPending || !plan.length}
              title={gate.title}
              className="h-8 rounded-md border border-info/50 bg-info/15 px-3 text-sm hover:bg-info/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {apply.isPending ? '반영하는 중…' : '반영'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
