'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { LINES, STATIONS, WHATIF_STATUS_NAMES, type WhatIfResult, type WhatIfRunView, type WhatIfScenarioResult } from '@lumitwin/shared';
import { C, ChartCard, DataTable, Empty, Key } from '@/components/charts/kit';
import { cx, kst, pct } from '@/lib/format';
import { stationName } from '@/lib/names';
import {
  JUDGE_NAMES,
  JUDGE_TONE,
  METRICS,
  RUN_STATUS_TONE,
  SOURCE_NAMES,
  eventText,
  int,
  isRunBusy,
  judge,
  lineColor,
  lineKpi,
  mdhm,
  mins,
  perUnitNum,
  planColor,
  range,
  signed,
  vclock,
  type MetricDef,
} from '@/lib/whatif';
import { BandChart } from './BandChart';
import { OrderSchedule } from './Schedule';

const sec = (ms: number | null | undefined) => (ms == null ? '-' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}초`);
const chip = 'inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[11px] whitespace-nowrap';
const cols = (n: number) => (n >= 3 ? '@4xl:grid-cols-3' : n === 2 ? '@4xl:grid-cols-2' : '');
const OUT_METRIC: Pick<MetricDef, 'better' | 'eps'> = { better: 'up', eps: 0.5 };

/** 차이 글자: 색(좋아짐·나빠짐) + 낭독기·툴팁용 이름. 색만으로 뜻을 전하지 않게 범례도 함께 둔다 */
function Diff({ m, base, v, children }: { m: Pick<MetricDef, 'better' | 'eps'>; base: number; v: number; children: ReactNode }) {
  const j = judge(m, base, v);
  return (
    <span className={cx('num', JUDGE_TONE[j])} title={`기준 대비 ${JUDGE_NAMES[j]}`}>
      {children}
      <span className="sr-only"> ({JUDGE_NAMES[j]})</span>
    </span>
  );
}

/** 실행 하나의 결과 전체 (머리 → 요약 → 비교 표 → 누적 그래프 → 작업지시 일정 → 고장 설비) */
export function RunResult({ run }: { run: WhatIfRunView }) {
  const r = run.result;
  return (
    <div className="space-y-3" data-testid="whatif-results" data-id={run.id} data-status={run.status}>
      <RunHeader run={run} />
      {run.status === 'DONE' && r && (
        <>
          <SummaryCards run={run} result={r} />
          <CompareTable result={r} />
          <HourlyCharts run={run} result={r} />
          <OrderSchedule run={run} result={r} />
          <FailureCard result={r} />
        </>
      )}
    </div>
  );
}

function RunHeader({ run }: { run: WhatIfRunView }) {
  const r = run.result;
  const busy = isRunBusy(run.status);
  const { done, total } = run.progress;
  const names = run.request.scenarios.map((s) => s.name);
  return (
    <section className="card min-w-0 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">결과 · 실행 #{run.id}</h2>
        <span data-testid="whatif-status" data-status={run.status} data-id={run.id} className={cx(chip, RUN_STATUS_TONE[run.status])}>
          {WHATIF_STATUS_NAMES[run.status]}
        </span>
        <span className="text-xs text-sub">
          {run.createdBy ?? '누군가'} · {mdhm(run.createdAt)} 실행 (실제 시각)
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-sub">
        <span>
          기준 {SOURCE_NAMES[run.request.base]} · 가상 시작 <span className="num">{kst(run.vStartAt, true)}</span>
        </span>
        <span>
          {run.request.horizonH}시간 × {run.request.reps}회 × 계획 {names.length}개
        </span>
        {r && r.seeds.length > 0 && <span>씨앗 {r.seeds.length > 1 ? `${r.seeds[0]} ~ ${r.seeds[r.seeds.length - 1]}` : r.seeds[0]}</span>}
        {r && (
          <span>
            계산 {sec(r.computeMs)} · 걸린 시간 {sec(r.elapsedMs)}
          </span>
        )}
      </div>

      {busy && (
        <div className="mt-3" data-testid="whatif-progress">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-sub">{run.status === 'QUEUED' ? '대기 중: 앞 실행이 끝나면 시작합니다' : '시뮬레이터가 계산 중입니다 (가상 시간을 최대 속도로)'}</span>
            <span className="num text-ink">
              {done} / {total || '-'} 반복
            </span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full" style={{ background: C.seriesSoft }} role="progressbar" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={done}>
            <div className="h-full rounded-full transition-[width]" style={{ width: `${total ? (done / total) * 100 : 0}%`, background: C.series }} />
          </div>
        </div>
      )}
      {run.status === 'FAILED' && (
        <div role="alert" className="mt-3 rounded-md border border-down/40 bg-down/10 px-3 py-2 text-xs whitespace-pre-wrap text-ink">
          {run.error ?? '계산이 실패했습니다'}
        </div>
      )}

      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-sub hover:text-ink">이 실행의 계획 입력과 기준 상태에서 어림한 것</summary>
        <div className="mt-2 grid gap-3 @4xl:grid-cols-2">
          <ul className="space-y-1.5">
            {run.request.scenarios.map((s, i) => (
              <li key={i} className="min-w-0">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <Key color={planColor(i)} shape="dot" />
                  {s.name}
                  {i === 0 && <span className="text-[10px] text-dim">기준</span>}
                </span>
                <div className="pl-4 text-[11px] leading-relaxed text-sub">
                  {Object.keys(s.orders ?? {}).length ? `순서를 바꾼 라인: ${Object.keys(s.orders ?? {}).join(', ')}` : '작업지시는 지금 계획 그대로'}
                  {s.autoFill === false && ' · 자동 채우기 끔'}
                  {(s.events ?? []).map((e, k) => (
                    <div key={k}>· {eventText(e, run.vStartAt)}</div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-sub">
            {(run.base?.notes ?? []).map((n) => (
              <li key={n}>{n}</li>
            ))}
            {!run.base?.notes?.length && <li className="list-none text-dim">어림한 것 없음</li>}
          </ul>
        </div>
      </details>
    </section>
  );
}

/** 납기가 있는 지시 중 한 반복이라도 납기를 넘긴 지시 */
function lateOrders(s: WhatIfScenarioResult, reps: number) {
  const due = s.orders.filter((o) => o.dueMin != null);
  return { due: due.length, late: due.filter((o) => (o.onTimeReps ?? 0) < reps).length };
}

function SummaryCards({ run, result }: { run: WhatIfRunView; result: WhatIfResult }) {
  const base = result.scenarios[0];
  return (
    <div className={cx('grid gap-3', cols(result.scenarios.length))}>
      {result.scenarios.map((s, i) => {
        const late = lateOrders(s, result.reps);
        const d = s.total.out.mean - base.total.out.mean;
        return (
          <section key={i} className="card min-w-0 p-3" data-testid="whatif-summary" style={{ borderTopColor: planColor(i), borderTopWidth: 3 }}>
            <div className="flex min-w-0 items-center gap-1.5">
              <Key color={planColor(i)} shape="dot" />
              <span className="min-w-0 truncate text-sm font-medium">{s.name}</span>
              {i === 0 && <span className={cx(chip, 'border-line text-sub')}>기준</span>}
            </div>
            <div className="mt-2 text-[11px] text-sub">세 라인 양품 합계 (제품이 달라 참고용)</div>
            <div className="num text-2xl font-semibold tracking-tight">
              {int(s.total.out.mean)}
              <span className="ml-1 text-xs font-normal text-sub">개</span>
            </div>
            <div className="text-[11px] text-dim">
              범위 <span className="num">{range(s.total.out, int)}</span> (10~90 백분위)
            </div>
            <div className="mt-0.5 text-xs">
              {i === 0 ? (
                <span className="text-dim">비교 기준</span>
              ) : (
                <>
                  <span className="text-sub">기준 대비 </span>
                  <Diff m={OUT_METRIC} base={base.total.out.mean} v={s.total.out.mean}>
                    {signed(d, int)}개{base.total.out.mean > 0 ? ` (${signed((d / base.total.out.mean) * 100, (x) => `${x.toFixed(1)}%`)})` : ''}
                  </Diff>
                </>
              )}
            </div>

            <table className="mt-2 w-full text-[11px]">
              <thead className="text-dim">
                <tr>
                  <th className="py-0.5 text-left font-normal">라인</th>
                  <th className="text-right font-normal">양품</th>
                  <th className="text-right font-normal">OEE</th>
                  <th className="text-right font-normal">kWh/개</th>
                </tr>
              </thead>
              <tbody>
                {LINES.map((l) => {
                  const k = lineKpi(s.lines, l.code);
                  const b = lineKpi(base.lines, l.code);
                  if (!k) return null;
                  const oee = METRICS.find((m) => m.key === 'oee')!;
                  const kpu = METRICS.find((m) => m.key === 'kwhPerUnit')!;
                  return (
                    <tr key={l.code} className="border-t border-line/60">
                      <td className="py-0.5">
                        <span className="inline-flex items-center gap-1">
                          <span className="size-2 rounded-full" style={{ background: l.color }} />
                          {l.short}
                        </span>
                      </td>
                      <td className="num text-right">{int(k.out.mean)}</td>
                      <td className="num text-right">
                        {i > 0 && b ? (
                          <Diff m={oee} base={b.oee.mean} v={k.oee.mean}>
                            {pct(k.oee.mean)}
                          </Diff>
                        ) : (
                          pct(k.oee.mean)
                        )}
                      </td>
                      <td className="num text-right">
                        {i > 0 && b ? (
                          <Diff m={kpu} base={b.kwhPerUnit.mean} v={k.kwhPerUnit.mean}>
                            {perUnitNum(k.kwhPerUnit.mean)}
                          </Diff>
                        ) : (
                          perUnitNum(k.kwhPerUnit.mean)
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="mt-2 text-[11px]">
              <span className="text-sub">납기 못 지킨 지시 </span>
              {late.due ? (
                <span className={cx('num font-semibold', late.late ? 'text-down' : 'text-ink')} title="납기가 있는 지시 중 한 반복이라도 납기를 넘긴 지시">
                  {late.late}건 <span className="font-normal text-dim">/ 납기 있는 {late.due}건</span>
                </span>
              ) : (
                <span className="text-dim">납기 입력 없음</span>
              )}
            </div>
            {s.events.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-[11px] text-sub">
                {s.events.map((e, k) => (
                  <li key={k} className="truncate" title={eventText(e, run.vStartAt)}>
                    · {eventText(e, run.vStartAt)}
                  </li>
                ))}
              </ul>
            )}
            {!s.autoFill && <div className="mt-1 text-[11px] text-sub">· 자동 채우기 끔</div>}
          </section>
        );
      })}
    </div>
  );
}

function CompareTable({ result }: { result: WhatIfResult }) {
  const [all, setAll] = useState(false);
  const metrics = METRICS.filter((m) => all || m.core);
  const plans = result.scenarios;
  const base = plans[0];
  return (
    <ChartCard
      title="라인별 지표 비교"
      subtitle={
        <>
          칸마다 반복 평균과 그 아래 범위(10~90 백분위)입니다. 둘째 계획부터 기준과의 차이를{' '}
          <span className="text-run">좋아짐</span>·<span className="text-down">나빠짐</span>·<span className="text-dim">차이 없음(기준의 0.5% 이내)</span>으로 적습니다. 좋은 방향은 지표마다 다릅니다: 생산량·OEE는
          클수록, 폐기·고장·셋업·개당 전력량은 작을수록 좋습니다. 범위가 많이 겹치면 반복을 늘려 다시 보세요.
        </>
      }
      right={
        <button type="button" onClick={() => setAll((v) => !v)} aria-pressed={all} className="rounded border border-line px-2 py-0.5 text-xs text-sub hover:bg-white/10 hover:text-ink">
          {all ? '핵심 지표만' : '모든 지표'}
        </button>
      }
    >
      <div className="scroll-thin relative overflow-x-auto">
        <table data-testid="whatif-compare" className="w-full min-w-[520px] text-xs">
          <thead className="text-dim">
            <tr className="border-b border-line">
              <th className="py-1.5 pr-2 text-left font-normal">지표</th>
              {plans.map((s, i) => (
                <th key={i} className="px-2 text-right font-normal">
                  <span className="inline-flex items-center justify-end gap-1.5">
                    <Key color={planColor(i)} shape="dot" />
                    <span className="max-w-[10rem] truncate text-sub">{s.name}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LINES.map((l) => (
              <LineRows key={l.code} line={l.code} name={l.name} metrics={metrics} plans={plans} base={base} />
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

function LineRows({ line, name, metrics, plans, base }: { line: string; name: string; metrics: MetricDef[]; plans: WhatIfScenarioResult[]; base: WhatIfScenarioResult }) {
  const b = lineKpi(base.lines, line);
  if (!b) return null;
  return (
    <>
      <tr className="bg-white/[0.03]">
        <td colSpan={plans.length + 1} className="py-1 pl-1 text-[11px] font-medium text-ink">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: lineColor(line) }} />
            {name}
          </span>
        </td>
      </tr>
      {metrics.map((m) => (
        <tr key={m.key} className="border-b border-line/60 align-top">
          <td className="py-1 pr-2" title={m.hint}>
            <div>{m.label}</div>
            <div className="text-[10px] text-dim">{m.better === 'up' ? '클수록 좋음' : m.better === 'down' ? '작을수록 좋음' : '좋고 나쁨 없음'}</div>
          </td>
          {plans.map((s, i) => {
            const k = lineKpi(s.lines, line);
            if (!k) return <td key={i} className="px-2 text-right text-dim">-</td>;
            const v = k[m.key];
            return (
              <td key={i} className="num px-2 py-1 text-right">
                <div className="text-ink">{m.fmt(v.mean)}</div>
                <div className="text-[10px] text-dim">{range(v, m.short ?? m.fmt)}</div>
                {i > 0 && (
                  <div className="text-[11px]">
                    <Diff m={m} base={b[m.key].mean} v={v.mean}>
                      {judge(m, b[m.key].mean, v.mean) === 'same' ? '±0' : m.diff(v.mean - b[m.key].mean)}
                    </Diff>
                  </div>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

function HourlyCharts({ run, result }: { run: WhatIfRunView; result: WhatIfResult }) {
  const plans = result.scenarios;
  const legend = plans.map((s, i) => ({ label: s.name, color: planColor(i), shape: 'line' as const }));
  const tableRows = useMemo(
    () =>
      LINES.flatMap((l) => {
        const ks = plans.map((s) => lineKpi(s.lines, l.code));
        const n = Math.max(0, ...ks.map((k) => k?.hourly.mean.length ?? 0));
        return Array.from({ length: n }, (_, h) => [
          l.short,
          `${h + 1}h (${vclock(run.vStartAt, (h + 1) * 60)})`,
          ...ks.map((k) => (k ? `${int(k.hourly.mean[h])} (${int(k.hourly.p10[h])} ~ ${int(k.hourly.p90[h])})` : '-')),
        ]);
      }),
    [plans, run.vStartAt],
  );
  return (
    <ChartCard
      title="라인별 누적 양품"
      subtitle={`선 = 반복 평균, 옅은 띠 = 10~90 백분위. 가로축은 가상 시작(${vclock(run.vStartAt)})에서 지난 시간입니다. 고장·막힘이 있으면 선이 눕고, 띠가 넓으면 반복마다 결과가 크게 흔들린 것입니다.`}
      legend={legend}
      table={<DataTable head={['라인', '시간', ...plans.map((s) => s.name)]} align={['l', 'l', ...plans.map(() => 'r' as const)]} rows={tableRows} />}
    >
      <div className="grid gap-4 @5xl:grid-cols-3">
        {LINES.map((l) => {
          const series = plans
            .map((s, i) => {
              const k = lineKpi(s.lines, l.code);
              if (!k) return null;
              return { key: String(i), label: s.name, color: planColor(i), mean: [0, ...k.hourly.mean], p10: [0, ...k.hourly.p10], p90: [0, ...k.hourly.p90] };
            })
            .filter((x): x is NonNullable<typeof x> => !!x);
          return (
            <div key={l.code} className="min-w-0">
              <h3 className="mb-1 inline-flex items-center gap-1.5 text-xs font-medium">
                <span className="size-2 rounded-full" style={{ background: l.color }} />
                {l.name}
              </h3>
              {series.length ? (
                <BandChart
                  series={series}
                  xLabel={(i) => `${i}h`}
                  tipTitle={(i) => `시작 + ${i}시간 (가상 ${vclock(run.vStartAt, i * 60)})`}
                  format={int}
                  label={`${l.name} 누적 양품: ${series.map((s) => `${s.label} ${int(s.mean[s.mean.length - 1])}개`).join(', ')}`}
                />
              ) : (
                <Empty h={120}>자료 없음</Empty>
              )}
            </div>
          );
        })}
      </div>
    </ChartCard>
  );
}

function FailureCard({ result }: { result: WhatIfResult }) {
  const plans = result.scenarios;
  const stations = useMemo(() => {
    const set = new Map<string, number>();
    for (const s of plans) for (const f of s.failures) set.set(f.station, Math.max(set.get(f.station) ?? 0, f.mean));
    return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [plans]);
  const head = ['설비', ...plans.map((s) => s.name)];
  const align = ['l' as const, ...plans.map(() => 'r' as const)];
  return (
    <ChartCard title="고장 많은 설비" subtitle="계획마다 반복 평균 고장 횟수 상위 5대를 모았습니다. 사건으로 넣은 고장도 셉니다. 아래는 라인마다 가장 오래 멈춘 설비(고장+셋업+정지, 반복 평균)입니다.">
      {stations.length ? (
        <DataTable
          head={head}
          align={align}
          rows={stations.map((c) => [
            <span key="s" className="inline-flex min-w-0 items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-full" style={{ background: lineColor(STATIONS[c]?.line ?? '') }} />
              <span className="num">{c}</span> <span className="truncate text-sub">{stationName(c)}</span>
            </span>,
            ...plans.map((s) => {
              const f = s.failures.find((x) => x.station === c);
              return f ? `${f.mean.toFixed(1)}회` : '-';
            }),
          ])}
        />
      ) : (
        <Empty h={60}>계산한 시간 안에 고장이 없었습니다.</Empty>
      )}
      <div className="mt-3">
        <DataTable
          head={['라인 · 가장 오래 멈춘 설비', ...plans.map((s) => s.name)]}
          align={align}
          rows={LINES.map((l) => [
            l.name,
            ...plans.map((s) => {
              const t = lineKpi(s.lines, l.code)?.topLoss;
              return t ? (
                <span key={s.name} title={stationName(t.station)}>
                  {t.station} · {mins(t.minutes)}
                </span>
              ) : (
                '-'
              );
            }),
          ])}
        />
      </div>
    </ChartCard>
  );
}
