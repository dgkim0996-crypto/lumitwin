'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { LINES, LOSS_FACTOR_NAMES, LOSS_INFO, LOSS_KEYS, STATIONS, type LineCode, type LossKey, type LossReport, type LossTimes } from '@lumitwin/shared';
import { C, ChartCard, DataTable, Empty, Tip, TipRow, TipTitle, useWidth } from '@/components/charts/kit';
import { SegmentedBar, type Segment } from '@/components/charts/small';
import { PageShell, Stat } from '@/components/mes/PageShell';
import { api } from '@/lib/api';
import { cx, duration, pct } from '@/lib/format';
import { useLive } from '@/lib/live';

/** 가치 시간 + 6대 로스 색 (범주형 고정 순서. 어두운 바탕에서 색각 검사 통과: validate_palette) */
const VALUE_COLOR = C.series;
const LOSS_COLOR: Record<LossKey, string> = {
  breakdown: '#d95926',
  setup: '#199e70',
  minorStop: '#c98500',
  speed: '#d55181',
  defect: '#9085e9',
  startup: '#008300',
};
const LEGEND = [
  { label: '가치 시간 (= OEE)', color: VALUE_COLOR, shape: 'rect' as const },
  ...LOSS_KEYS.map((k) => ({ label: LOSS_INFO[k].name, color: LOSS_COLOR[k], shape: 'rect' as const })),
];

type Scope = 'ALL' | LineCode;

const lossTotal = (x: LossTimes) => LOSS_KEYS.reduce((a, k) => a + x.loss[k], 0);
const oeeOf = (x: LossTimes) => (x.planned > 0 ? x.valuable / x.planned : 0);
const share = (v: number, x: LossTimes) => (x.planned > 0 ? v / x.planned : 0);
const minutes = (sec: number) => (sec >= 60 ? `${Math.round(sec / 60).toLocaleString('ko-KR')}분` : `${Math.round(sec)}초`);

function segments(x: LossTimes): Segment[] {
  return [
    { key: 'value', label: '가치 시간', color: VALUE_COLOR, value: x.valuable },
    ...LOSS_KEYS.map((k) => ({ key: k, label: LOSS_INFO[k].name, color: LOSS_COLOR[k], value: x.loss[k] })),
  ];
}

function biggest(x: LossTimes): LossKey | null {
  let best: LossKey | null = null;
  for (const k of LOSS_KEYS) if (x.loss[k] > 0 && (!best || x.loss[k] > x.loss[best])) best = k;
  return best;
}

export default function LossesPage() {
  const router = useRouter();
  const select = useLive((s) => s.select);
  const [scope, setScope] = useState<Scope>('ALL');
  const [sort, setSort] = useState<'loss' | 'flow'>('loss');
  /** 우선순위에서 순간 정지·공회전을 뺄지: 대부분 앞 설비가 멈춰 생긴 대기라 그 설비에서 줄일 수 있는 로스가 아니다 */
  const [withWait, setWithWait] = useState(false);

  const q = useQuery({
    queryKey: ['losses'],
    queryFn: () => api.get<LossReport>('/live/losses'),
    refetchInterval: 3_000,
    placeholderData: keepPreviousData,
  });
  const data = q.data;
  const scoped = scope === 'ALL' ? data?.total : data?.lines.find((l) => l.line === scope);

  const stations = useMemo(() => {
    const list = (data?.stations ?? []).filter((s) => scope === 'ALL' || s.line === scope);
    if (sort === 'loss') return [...list].sort((a, b) => lossTotal(b) - lossTotal(a));
    return list;
  }, [data, scope, sort]);

  /** 개선 우선순위: 설비 × 로스 항목을 시간 큰 순으로 */
  const top = useMemo(() => {
    const keys = withWait ? LOSS_KEYS : LOSS_KEYS.filter((k) => k !== 'minorStop');
    const rows = stations.flatMap((s) => keys.map((k) => ({ station: s.station, key: k, sec: s.loss[k], of: s })));
    return rows.filter((r) => r.sec > 0).sort((a, b) => b.sec - a.sec).slice(0, 12);
  }, [stations, withWait]);

  const factorShare = (f: keyof typeof LOSS_FACTOR_NAMES) =>
    scoped ? share(LOSS_KEYS.filter((k) => LOSS_INFO[k].factor === f).reduce((a, k) => a + scoped.loss[k], 0), scoped) : 0;
  const big = scoped ? biggest(scoped) : null;
  const goStation = (code: string) => {
    select(code);
    router.push('/');
  };

  return (
    <PageShell
      title="6대 로스"
      desc={
        <>
          설비가 돌 수 있었던 계획 시간이 어디로 새는지 TPM의 6대 로스로 나눠 봅니다. 계획 시간 = 가치 시간(양품 × 이상 사이클) + 고장 + 셋업·조정 + 순간 정지·공회전 + 속도 저하 + 공정 불량 + 초기 수율이고,
          가치 시간 ÷ 계획 시간이 곧 OEE입니다. 라인·공장 값은 설비 시간을 합친 것이라, 완성 수 × 택트로 재는 생산 현황의 라인 OEE와는 다를 수 있습니다.
        </>
      }
      filters={<ScopeSwitcher scope={scope} setScope={setScope} report={data} />}
    >
      <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-5">
        <Stat label="OEE (가치 시간 비율)" value={scoped ? pct(oeeOf(scoped)) : '-'} sub={scoped ? `계획 ${minutes(scoped.planned)} 중 가치 ${minutes(scoped.valuable)}` : undefined} />
        <Stat
          label="가장 큰 로스"
          value={big ? LOSS_INFO[big].name : '-'}
          sub={
            big && scoped
              ? `계획 시간의 ${pct(share(scoped.loss[big], scoped))} · ${minutes(scoped.loss[big])}${big === 'minorStop' ? ' · 대부분 앞 공정 대기' : ''}`
              : '아직 로스가 없습니다'
          }
        />
        {(['availability', 'performance', 'quality'] as const).map((f) => (
          <Stat
            key={f}
            label={`${LOSS_FACTOR_NAMES[f]} 로스`}
            value={pct(factorShare(f))}
            sub={LOSS_KEYS.filter((k) => LOSS_INFO[k].factor === f).map((k) => LOSS_INFO[k].name).join(' · ')}
          />
        ))}
      </div>

      <ChartCard
        className="mt-3"
        title="라인별 시간 구성"
        subtitle={`막대 전체가 계획 시간(계획 정지 제외)입니다. 파란 부분이 가치 시간이고 나머지가 6대 로스입니다. 초기 수율은 고장·셋업·정지 뒤 ${Math.round((data?.startupWindowSec ?? 600) / 60)}분 안에 나온 불량입니다.`}
        legend={LEGEND}
        stale={q.isFetching && q.isPlaceholderData}
        table={
          data && (
            <DataTable
              head={['구분', '계획 시간', 'OEE', ...LOSS_KEYS.map((k) => LOSS_INFO[k].name), '계획 정지']}
              align={['l', 'r', 'r', ...LOSS_KEYS.map(() => 'r' as const), 'r']}
              rows={[{ name: '공장 전체', x: data.total }, ...data.lines.map((l) => ({ name: LINES.find((d) => d.code === l.line)?.name ?? l.line, x: l as LossTimes }))].map(({ name, x }) => [
                name,
                minutes(x.planned),
                pct(oeeOf(x)),
                ...LOSS_KEYS.map((k) => `${minutes(x.loss[k])} (${pct(share(x.loss[k], x), 0)})`),
                minutes(x.stopped),
              ])}
            />
          )
        }
      >
        {data && data.total.planned > 0 ? (
          <div className="space-y-3">
            {[{ code: 'ALL' as Scope, name: '공장 전체', x: data.total }, ...data.lines.map((l) => ({ code: l.line as Scope, name: LINES.find((d) => d.code === l.line)?.name ?? l.line, x: l as LossTimes }))].map((r) => {
              const b = biggest(r.x);
              return (
                <button
                  key={r.code}
                  onClick={() => setScope(r.code)}
                  aria-pressed={scope === r.code}
                  className={cx('grid w-full grid-cols-[120px_1fr] items-center gap-3 rounded px-2 py-1.5 text-left @3xl:grid-cols-[150px_1fr_220px]', scope === r.code ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]')}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{r.name}</span>
                    <span className="num block text-[11px] text-sub">OEE {pct(oeeOf(r.x))}</span>
                  </span>
                  <SegmentedBar label={`${r.name} 계획 시간 구성`} parts={segments(r.x)} format={duration} height={14} />
                  <span className="hidden text-xs text-sub @3xl:block">
                    {b ? (
                      <>
                        가장 큰 로스 <span className="text-ink">{LOSS_INFO[b].name}</span> {pct(share(r.x.loss[b], r.x), 0)}
                      </>
                    ) : (
                      '로스 없음'
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <Empty h={180}>{q.isLoading ? '불러오는 중…' : q.error ? (q.error as Error).message : '아직 집계된 시간이 없습니다. 시뮬레이터가 돌면 바로 쌓입니다.'}</Empty>
        )}
      </ChartCard>

      <div className="mt-3 grid gap-3 @6xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <ChartCard
          title="개선 우선순위"
          subtitle={
            withWait
              ? '설비 × 로스 항목을 잃은 시간이 큰 순서로. 순간 정지·공회전(대기)까지 넣으면 앞 공정이 멈춰 쉬는 뒤 설비들이 위로 올라옵니다.'
              : '설비 × 로스 항목을 잃은 시간이 큰 순서로. 그 설비에서 직접 줄일 수 있는 로스(고장·셋업·속도·불량·초품)만 봅니다. 줄을 누르면 3D 공장에서 그 설비를 봅니다.'
          }
          legend={LEGEND.slice(1).filter((l) => withWait || l.label !== LOSS_INFO.minorStop.name)}
          right={
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-sub">
              <input type="checkbox" checked={withWait} onChange={(e) => setWithWait(e.target.checked)} className="accent-[var(--color-info)]" />
              대기 포함
            </label>
          }
          table={
            <DataTable
              head={['순위', '설비', '로스', '잃은 시간', '설비 계획 시간 대비']}
              align={['r', 'l', 'l', 'r', 'r']}
              rows={top.map((r, i) => [i + 1, `${r.station} ${STATIONS[r.station]?.name ?? ''}`, LOSS_INFO[r.key].name, minutes(r.sec), pct(share(r.sec, r.of))])}
            />
          }
        >
          {top.length ? <PriorityBars rows={top} onPick={goStation} /> : <Empty>아직 로스가 없습니다.</Empty>}
        </ChartCard>

        <ChartCard
          title="설비별 로스 구성"
          subtitle="막대는 설비마다 자기 계획 시간을 100%로 본 구성입니다. 뒤 설비의 순간 정지가 큰 것은 대개 앞 설비가 멈춰 부품이 안 온 결과라, 고장·셋업이 큰 앞 설비부터 봅니다."
          legend={LEGEND}
          right={
            <div className="flex overflow-hidden rounded border border-line text-xs">
              {(
                [
                  ['loss', '로스 큰 순'],
                  ['flow', '공정 순서'],
                ] as const
              ).map(([k, label]) => (
                <button key={k} onClick={() => setSort(k)} aria-pressed={sort === k} className={cx('px-2 py-0.5', sort === k ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}>
                  {label}
                </button>
              ))}
            </div>
          }
        >
          <div className="scroll-thin max-h-[560px] overflow-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead className="sticky top-0 bg-[var(--color-chart)] text-dim">
                <tr className="border-b border-line">
                  <th className="py-1.5 pr-2 text-left font-normal">설비</th>
                  <th className="w-[38%] px-2 text-left font-normal">계획 시간 구성</th>
                  <th className="px-2 text-right font-normal">OEE</th>
                  <th className="px-2 text-left font-normal">가장 큰 로스</th>
                  <th className="px-2 text-right font-normal whitespace-nowrap" title="괄호 안은 재가동 직후(초기 수율) 불량">
                    불량 (초품)
                  </th>
                </tr>
              </thead>
              <tbody>
                {stations.map((s) => {
                  const b = biggest(s);
                  return (
                    <tr key={s.station} className="border-b border-line/60 align-middle hover:bg-white/[0.03]">
                      <td className="py-1.5 pr-2">
                        <button className="text-left hover:underline" title="3D 공장에서 이 설비 보기" onClick={() => goStation(s.station)}>
                          <span className="num font-semibold">{s.station}</span> <span className="text-sub">{STATIONS[s.station]?.name}</span>
                        </button>
                      </td>
                      <td className="px-2">
                        <SegmentedBar label={`${s.station} 계획 시간 구성`} parts={segments(s)} format={duration} />
                      </td>
                      <td className="num px-2 text-right">{s.planned > 0 ? pct(oeeOf(s)) : '-'}</td>
                      <td className="px-2 whitespace-nowrap">
                        {b ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="size-2 rounded-[3px]" style={{ background: LOSS_COLOR[b] }} />
                            {LOSS_INFO[b].name} <span className="num text-sub">{pct(share(s.loss[b], s), 0)}</span>
                          </span>
                        ) : (
                          <span className="text-dim">-</span>
                        )}
                      </td>
                      <td className="num px-2 text-right text-sub">
                        {s.ng}
                        {s.startupNg > 0 && ` (${s.startupNg})`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>

      <section className="card mt-3 p-4 text-xs leading-relaxed text-sub">
        <h2 className="mb-2 text-sm font-semibold text-ink">로스를 이렇게 잽니다</h2>
        <ul className="grid gap-x-6 gap-y-1.5 @4xl:grid-cols-2">
          {LOSS_KEYS.map((k) => (
            <li key={k} className="flex gap-2">
              <span className="mt-1 size-2.5 shrink-0 rounded-[3px]" style={{ background: LOSS_COLOR[k] }} />
              <span>
                <span className="text-ink">{LOSS_INFO[k].name}</span> ({LOSS_FACTOR_NAMES[LOSS_INFO[k].factor]} 로스) · {LOSS_INFO[k].desc}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-dim">
          계획 정지(작업자가 일부러 세운 시간)는 계획 시간에서 빼고 로스로 세지 않습니다. 사이클 편차로 이상보다 빨리 만든 만큼은 대기 시간과 상쇄합니다. 초기 수율 불량은 MES 메모리에서만 세므로 서버를 다시 띄우면 그 뒤
          재가동부터 다시 셉니다.
        </p>
      </section>
    </PageShell>
  );
}

function ScopeSwitcher({ scope, setScope, report }: { scope: Scope; setScope: (s: Scope) => void; report?: LossReport }) {
  const items: { code: Scope; name: string; color?: string; x?: LossTimes }[] = [
    { code: 'ALL', name: '공장 전체', x: report?.total },
    ...LINES.map((l) => ({ code: l.code as Scope, name: l.name, color: l.color, x: report?.lines.find((r) => r.line === l.code) })),
  ];
  return (
    <div role="tablist" aria-label="범위 선택" className="flex flex-wrap gap-2">
      {items.map((it) => {
        const on = it.code === scope;
        const b = it.x ? biggest(it.x) : null;
        return (
          <button
            key={it.code}
            role="tab"
            aria-selected={on}
            onClick={() => setScope(it.code)}
            className={cx('flex items-center gap-3 rounded-md border px-3 py-1.5 text-left', on ? 'border-info/60 bg-info/10' : 'border-line bg-white/[0.03] hover:bg-white/[0.07]')}
          >
            {it.color && <span className="size-2.5 rounded-full" style={{ background: it.color }} />}
            <span>
              <span className="block text-sm font-medium">{it.name}</span>
              <span className="num block text-[11px] text-sub">
                OEE {it.x ? pct(oeeOf(it.x)) : '-'}
                {b && ` · ${LOSS_INFO[b].name} ${pct(share(it.x!.loss[b], it.x!), 0)}`}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const BAR_H = 22;
const LABEL_W = 210;

/** 가로 막대 (잃은 시간). 값 축은 0부터, 막대 끝에 값을 쓴다 */
function PriorityBars({ rows, onPick }: { rows: { station: string; key: LossKey; sec: number; of: LossTimes }[]; onPick: (code: string) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...rows.map((r) => r.sec), 1);
  const plot = Math.max(40, width - LABEL_W - 64);
  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      {rows.map((r, i) => {
        const w = Math.max(2, (r.sec / max) * plot);
        return (
          <button
            key={`${r.station}-${r.key}`}
            onClick={() => onPick(r.station)}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            className={cx('flex w-full items-center gap-2 rounded text-left text-xs', hover === i && 'bg-white/[0.05]')}
            style={{ height: BAR_H + 4 }}
          >
            <span className="shrink-0 truncate pl-1" style={{ width: LABEL_W }}>
              <span className="num text-dim">{i + 1}.</span> <span className="num font-semibold">{r.station}</span> <span className="text-sub">{LOSS_INFO[r.key].name}</span>
            </span>
            <span className="block rounded-r-[4px]" style={{ width: w, height: 10, background: LOSS_COLOR[r.key], opacity: hover != null && hover !== i ? 0.55 : 1 }} />
            <span className="num shrink-0 text-sub">{minutes(r.sec)}</span>
          </button>
        );
      })}
      {hover != null && rows[hover] && (
        <Tip x={LABEL_W} y={(hover + 1) * (BAR_H + 4) + 6} width={width}>
          <TipTitle>
            {rows[hover].station} {STATIONS[rows[hover].station]?.name}
          </TipTitle>
          <TipRow color={LOSS_COLOR[rows[hover].key]} shape="rect" label={LOSS_INFO[rows[hover].key].name} value={duration(rows[hover].sec)} />
          <TipRow label="이 설비 계획 시간 대비" value={pct(share(rows[hover].sec, rows[hover].of))} />
          <div className="mt-1 max-w-56 text-[11px] text-dim">{LOSS_INFO[rows[hover].key].desc}</div>
        </Tip>
      )}
    </div>
  );
}
