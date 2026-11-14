'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { LINES, POWER_MODE_DESC, POWER_MODE_NAMES, POWER_MODES, STATIONS, type EnergyReport, type LineCode, type StationEnergy } from '@lumitwin/shared';
import { ColumnChart } from '@/components/charts/ColumnChart';
import { ChartCard, DataTable, Empty } from '@/components/charts/kit';
import { StackBars } from '@/components/insights/StackBars';
import { PageShell, Stat } from '@/components/mes/PageShell';
import { cx, kst, pct } from '@/lib/format';
import { fetchEnergy, kwh, perUnit, POWER_COLOR, POWER_LEGEND, type EnergyRange } from '@/lib/insights';
import { useLive } from '@/lib/live';

type Scope = 'ALL' | LineCode;
type RangeKey = '8h' | '24h' | 'run';

const RANGES: { key: RangeKey; label: string }[] = [
  { key: '8h', label: '최근 8시간' },
  { key: '24h', label: '최근 24시간' },
  { key: 'run', label: '이번 실행 전체' },
];
const SERIES = POWER_MODES.map((m) => ({ label: POWER_MODE_NAMES[m], color: POWER_COLOR[m] }));
const lineName = (code: string) => LINES.find((l) => l.code === code)?.name ?? code;
const order = new Map(Object.keys(STATIONS).map((c, i) => [c, i]));

/** 같은 날(한국 시각)이면 시:분, 아니면 월-일 시:분 */
function when(iso: string, ref: string | null | undefined): string {
  const day = (x: string) => new Date(Date.parse(x) + 9 * 3_600_000).toISOString().slice(5, 10);
  const t = kst(iso).slice(0, 5);
  return ref && day(iso) === day(ref) ? t : `${day(iso)} ${t}`;
}

export default function EnergyPage() {
  const router = useRouter();
  const select = useLive((s) => s.select);
  const startedAt = useLive((s) => s.sim?.startedAt);
  const [scope, setScope] = useState<Scope>('ALL');
  const [range, setRange] = useState<RangeKey>('24h');
  const [sort, setSort] = useState<'kwh' | 'unit' | 'flow'>('kwh');

  const r: EnergyRange = range === 'run' && startedAt ? { from: startedAt } : { hours: range === '8h' ? 8 : 24 };
  const q = useQuery({
    queryKey: ['energy', scope, range, range === 'run' ? startedAt : null],
    queryFn: () => fetchEnergy(r, scope === 'ALL' ? undefined : scope),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });
  const data = q.data;
  const stale = q.isFetching && q.isPlaceholderData;

  const stations = useMemo(() => {
    const list = (data?.stations ?? []).filter((s) => s.kw);
    if (sort === 'kwh') return [...list].sort((a, b) => b.total - a.total);
    if (sort === 'unit') return [...list].sort((a, b) => (b.perUnit ?? -1) - (a.perUnit ?? -1));
    return [...list].sort((a, b) => order.get(a.station)! - order.get(b.station)!);
  }, [data, sort]);
  const missing = data?.missing ?? [];
  const noPower = !!data && data.stations.every((s) => !s.kw);

  const goStation = (code: string) => {
    select(code);
    router.push('/');
  };
  const loading = <Empty h={180}>{q.isLoading ? '불러오는 중…' : q.error ? (q.error as Error).message : '아직 기록이 없습니다. 시뮬레이터가 돌면 바로 쌓입니다.'}</Empty>;
  const lineRows = data?.lines ?? [];
  const oneLine = scope !== 'ALL' ? lineRows[0] : null;

  return (
    <PageShell
      title="에너지"
      desc={
        <>
          설비가 어느 상태에 얼마나 있었는지(상태 기록)에 상태별 소비 전력을 곱해 전력량을 셉니다. 가동(RUN)·대기(투입 대기·배출 대기·셋업)·정지(계획 정지·고장)로 나눠, 완성품 1개에 든 전력과
          아무것도 만들지 않으면서 쓴 대기 전력이 얼마인지 봅니다. 소비 전력은 공장 정의의 설비별 가정값이고, 정의가 없는 설비는 &lsquo;자료 없음&rsquo;으로 빼고 셉니다.
        </>
      }
      filters={
        <>
          <ScopeSwitcher scope={scope} setScope={setScope} report={scope === 'ALL' ? data : undefined} />
          <Toggle
            items={RANGES.map((x) => [x.key, x.label] as const)}
            value={range}
            onChange={setRange}
            className="ml-auto"
            title={data ? `${when(data.from, data.to)} ~ ${when(data.to, data.to)} (가상 시각)` : undefined}
          />
        </>
      }
    >
      {noPower && (
        <div className="mb-3 rounded-md border border-line bg-white/[0.03] px-3 py-2 text-xs text-sub">
          자료 없음: 공장 정의에 설비 소비 전력(power)이 아직 들어 있지 않아 전력량을 계산할 수 없습니다. 상태별 시간은 아래 표에서 볼 수 있습니다.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-5">
        <Stat label="전력량" value={data && !noPower ? kwh(data.total.total) : '-'} sub={data ? `${when(data.from, data.to)} ~ ${when(data.to, data.to)} · 가상 시각` : undefined} />
        <Stat
          label={oneLine ? '완성품 1개당 전력량' : '완성품 1개당 (라인별)'}
          value={oneLine ? perUnit(oneLine.perUnit) : <span className="text-base">{lineRows.map((l) => `${l.line} ${l.perUnit != null ? Number(l.perUnit.toPrecision(3)) : '-'}`).join(' · ') || '-'}</span>}
          sub={oneLine ? `완성 ${oneLine.good.toLocaleString('ko-KR')}개` : 'kWh/개 · 제품이 달라 공장 합계는 내지 않습니다'}
        />
        <Stat label="대기 전력 비중" value={pct(data?.total.idleShare ?? undefined)} sub="대기 전력량 ÷ 전체 (만들지 않으면서 쓴 전력)" />
        <Stat label="가동 전력" value={data && !noPower ? kwh(data.total.run) : '-'} sub={data && data.total.total > 0 ? `전체의 ${pct(data.total.run / data.total.total)}` : undefined} />
        <Stat
          label="자료 없음"
          value={data ? `${missing.length}대` : '-'}
          sub={data ? (missing.length ? '소비 전력 정의가 없어 합계에서 빠진 설비' : '모든 설비의 소비 전력이 있습니다') : undefined}
        />
      </div>

      <div className="mt-3 grid gap-3 @6xl:grid-cols-2">
        <ChartCard
          title="라인별 전력량"
          subtitle="막대 전체가 라인 전력량입니다. 끝에 완성품 1개당 전력량을 같이 씁니다."
          legend={POWER_LEGEND}
          stale={stale}
          table={
            data && (
              <DataTable
                head={['라인', '가동', '대기', '정지', '합계', '완성품', 'kWh/개', '대기 비중', '자료 없음']}
                align={['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r']}
                rows={lineRows.map((l) => [lineName(l.line), kwh(l.run, false), kwh(l.idle, false), kwh(l.off, false), kwh(l.total, false), l.good, l.perUnit ?? '-', pct(l.idleShare ?? undefined), `${l.missing.length}대`])}
              />
            )
          }
        >
          {!data ? (
            loading
          ) : (
            <StackBars
              rows={lineRows.map((l) => ({
                key: l.line,
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: LINES.find((x) => x.code === l.line)?.color }} />
                    {lineName(l.line)}
                  </span>
                ),
                title: lineName(l.line),
                values: [l.run, l.idle, l.off],
                missing: l.stations === 0 ? '자료 없음' : undefined,
                end: `${kwh(l.total)} · ${l.perUnit != null ? `${Number(l.perUnit.toPrecision(3))}/개` : '-'}`,
                extra: <TipNote>{`완성 ${l.good}개 · 대기 비중 ${pct(l.idleShare ?? undefined)}${l.missing.length ? ` · 자료 없음 ${l.missing.length}대` : ''}`}</TipNote>,
              }))}
              series={SERIES}
              format={(v) => kwh(v)}
              unit="kWh"
              labelW={170}
              endW={170}
            />
          )}
        </ChartCard>

        <ChartCard
          title={`시간대별 전력량 (${data?.bucketHours ?? 1}시간 단위)`}
          subtitle="한국 시각 정시 기준. 흐린 막대는 아직 끝나지 않았거나 구간 끝에 잘린 칸입니다. 생산 계획이 없거나 고장이 길면 대기·정지 몫이 커집니다."
          legend={POWER_LEGEND}
          stale={stale}
          table={
            data && (
              <DataTable
                head={['시작', '가동', '대기', '정지', '합계']}
                align={['l', 'r', 'r', 'r', 'r']}
                rows={data.hourly.map((b) => [when(b.t, data.to), kwh(b.run, false), kwh(b.idle, false), kwh(b.off, false), kwh(b.run + b.idle + b.off, false)])}
              />
            )
          }
        >
          {!data ? (
            loading
          ) : noPower ? (
            <Empty>자료 없음 (소비 전력 정의 없음)</Empty>
          ) : (
            <ColumnChart
              data={data.hourly.map((b) => ({ label: kst(b.t).slice(0, 5), title: `${when(b.t, data.to)} 부터 ${data.bucketHours}시간`, values: [b.run, b.idle, b.off], partial: b.partial }))}
              series={SERIES}
              unit=" kWh"
              height={220}
            />
          )}
        </ChartCard>
      </div>

      <ChartCard
        className="mt-3"
        title="설비별 전력량"
        subtitle="열·진공 설비(경화로·증착기·리플로우 등)는 대기 중에도 히터·펌프를 켜 두므로 대기 몫이 클 수 있습니다. 개당 전력량은 그 설비가 양품으로 처리한 수로 나눈 값입니다. 설비를 누르면 3D 공장에서 봅니다."
        legend={POWER_LEGEND}
        stale={stale}
        right={
          <Toggle
            items={[
              ['kwh', '전력량 순'],
              ['unit', '개당 순'],
              ['flow', '공정 순서'],
            ] as const}
            value={sort}
            onChange={setSort}
          />
        }
        table={
          data && (
            <DataTable
              head={['설비', '소비 전력 kW (가동/대기/정지)', '가동 h', '대기 h', '정지 h', '전력량', '양품', 'kWh/개', '대기 비중']}
              align={['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r']}
              rows={(data.stations as StationEnergy[]).map((s) => [
                `${s.station} ${STATIONS[s.station]?.name ?? ''}`,
                s.kw ? `${s.kw.run} / ${s.kw.idle} / ${s.kw.off}` : '자료 없음',
                s.hours.run.toFixed(1),
                s.hours.idle.toFixed(1),
                s.hours.off.toFixed(1),
                s.kw ? kwh(s.total, false) : '-',
                s.ok,
                s.perUnit ?? '-',
                pct(s.idleShare ?? undefined),
              ])}
            />
          )
        }
      >
        {!data ? (
          loading
        ) : stations.length ? (
          <StackBars
            rows={stations.map((s) => ({
              key: s.station,
              label: (
                <>
                  <span className="num font-semibold">{s.station}</span> <span className="text-sub">{STATIONS[s.station]?.name}</span>
                </>
              ),
              title: `${s.station} ${STATIONS[s.station]?.name ?? ''}`,
              values: [s.run, s.idle, s.off],
              end: `${kwh(s.total)} · ${s.perUnit != null ? `${Number(s.perUnit.toPrecision(3))}/개` : '-'}`,
              extra: (
                <TipNote>
                  {`소비 전력 ${s.kw?.run}/${s.kw?.idle}/${s.kw?.off} kW · 양품 ${s.ok}개 · 대기 비중 ${pct(s.idleShare ?? undefined)}`}
                </TipNote>
              ),
            }))}
            series={SERIES}
            format={(v) => kwh(v)}
            unit="kWh"
            labelW={250}
            endW={170}
            onPick={goStation}
            maxRows={18}
          />
        ) : (
          <Empty>자료 없음: 소비 전력이 정의된 설비가 없습니다.</Empty>
        )}
        {data && missing.length > 0 && !noPower && (
          <p className="mt-2 text-[11px] leading-relaxed text-dim">
            자료 없음 ({missing.length}대, 합계에서 빠짐): {missing.map((c) => `${c} ${STATIONS[c]?.name ?? ''}`).join(', ')}
          </p>
        )}
      </ChartCard>

      <section className="card mt-3 p-4 text-xs leading-relaxed text-sub">
        <h2 className="mb-2 text-sm font-semibold text-ink">이렇게 잽니다</h2>
        <ul className="grid gap-x-6 gap-y-1.5 @4xl:grid-cols-2">
          {POWER_MODES.map((m) => (
            <li key={m}>
              <span className="inline-flex items-center gap-1.5 text-ink">
                <span className="inline-block size-2.5 rounded-[3px]" style={{ background: POWER_COLOR[m] }} />
                {POWER_MODE_NAMES[m]}
              </span>{' '}
              = {POWER_MODE_DESC[m]}
            </li>
          ))}
          <li>
            <span className="text-ink">전력량(kWh)</span> = Σ 상태별 시간(h) × 그 상태의 소비 전력(kW). 상태 시간은 MES에 쌓인 상태 기록(가상 시각)에서 잽니다. 실제 공장이라면 설비별 전력량계(Modbus·OPC UA)
            값을 그대로 쓰고, 이 계산은 계량기가 없는 설비의 추정에 씁니다.
          </li>
          <li>
            <span className="text-ink">완성품 1개당 전력량</span> = 라인 전력량 ÷ 최종 공정 양품. 불량·폐기품에 든 전력도 양품이 나눠 지므로 불량이 늘면 같이 오릅니다.
          </li>
          <li>
            <span className="text-ink">대기 전력 비중</span> = 대기 전력량 ÷ 전체. 앞 공정이 멈추거나 생산 계획이 없을 때 켜 둔 채 기다린 몫입니다. 줄이는 방법은 대기 시간을 줄이거나(병목 개선) 오래 기다릴 때 절전
            모드로 내리는 것입니다.
          </li>
        </ul>
      </section>
    </PageShell>
  );
}

function TipNote({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 max-w-64 text-[11px] text-sub">{children}</div>;
}

function Toggle<K extends string>({
  items,
  value,
  onChange,
  className,
  title,
}: {
  items: readonly (readonly [K, string])[];
  value: K;
  onChange: (k: K) => void;
  className?: string;
  title?: string;
}) {
  return (
    <div className={cx('flex overflow-hidden rounded border border-line text-xs', className)} title={title}>
      {items.map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)} aria-pressed={value === k} className={cx('px-2 py-1', value === k ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}>
          {label}
        </button>
      ))}
    </div>
  );
}

function ScopeSwitcher({ scope, setScope, report }: { scope: Scope; setScope: (s: Scope) => void; report?: EnergyReport }) {
  const items: { code: Scope; name: string; color?: string }[] = [{ code: 'ALL', name: '공장 전체' }, ...LINES.map((l) => ({ code: l.code as Scope, name: l.name, color: l.color }))];
  return (
    <div role="tablist" aria-label="범위 선택" className="flex flex-wrap gap-2">
      {items.map((it) => {
        const on = it.code === scope;
        const l = report?.lines.find((x) => x.line === it.code);
        const sub = it.code === 'ALL' ? (report ? kwh(report.total.total) : '라인 합계') : l ? `${kwh(l.total)} · ${perUnit(l.perUnit)}` : '라인 전력량';
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
              <span className="num block text-[11px] text-sub">{sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
