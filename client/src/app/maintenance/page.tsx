'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import {
  LINES,
  MAINT_MIN_FAILURES,
  MTBF_WARN,
  MTTR_WARN,
  PM_REASON,
  PM_STATUS_NAMES,
  STATIONS,
  maintenanceTotals,
  type LineCode,
  type MaintenanceReport,
  type PmStatus,
  type StationMaintenance,
} from '@lumitwin/shared';
import { C, ChartCard, DataTable, Empty, Key, Tip, TipRow, TipTitle, useWidth } from '@/components/charts/kit';
import { Meter } from '@/components/charts/small';
import { HealthPanel } from '@/components/insights/HealthPanel';
import { PageShell, Stat } from '@/components/mes/PageShell';
import { api } from '@/lib/api';
import { cx, duration, kst, pct } from '@/lib/format';
import { useLive } from '@/lib/live';

/** 고장은 6대 로스 화면의 '고장'과 같은 색, 계획 보전은 구별되는 청록 (두 색은 어두운 바탕 색각 검사 통과) */
const FAIL_COLOR = '#d95926';
const PM_COLOR = '#199e70';
const TIMELINE_LEGEND = [
  { label: '고장', color: FAIL_COLOR, shape: 'rect' as const },
  { label: '계획 보전', color: PM_COLOR, shape: 'rect' as const },
];
/** 계획 보전 상태는 글자(여유·임박·초과·보전 중)와 함께 쓰는 상태색 */
const PM_STATUS_COLOR: Record<PmStatus, string> = { ok: C.series, soon: 'var(--color-warn)', due: 'var(--color-down)', doing: 'var(--color-info)' };
const PM_ORDER: Record<PmStatus, number> = { due: 0, soon: 1, doing: 2, ok: 3 };

type Scope = 'ALL' | LineCode;
type Sort = 'down' | 'flow' | 'pm';

/** 분 → '35분' · '12.5시간' */
const mins = (m: number | null | undefined) => (m == null || !Number.isFinite(m) ? '-' : m >= 120 ? `${(m / 60).toFixed(1)}시간` : `${Math.round(m)}분`);
const hours = (sec: number) => `${(sec / 3600).toFixed(1)}`;
const order = new Map(Object.keys(STATIONS).map((c, i) => [c, i]));

/** 같은 날(한국 시각)이면 시:분, 아니면 월-일 시:분 */
function when(iso: string | null | undefined, now: string | null | undefined): string {
  if (!iso) return '-';
  const day = (x: string) => new Date(Date.parse(x) + 9 * 3_600_000).toISOString().slice(5, 10);
  const t = kst(iso).slice(0, 5);
  return now && day(iso) === day(now) ? t : `${day(iso)} ${t}`;
}

export default function MaintenancePage() {
  const router = useRouter();
  const select = useLive((s) => s.select);
  const [scope, setScope] = useState<Scope>('ALL');
  const [sort, setSort] = useState<Sort>('down');

  const q = useQuery({
    queryKey: ['maintenance'],
    queryFn: () => api.get<MaintenanceReport>('/maintenance'),
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });
  const data = q.data;
  const inScope = useCallback((code: string) => scope === 'ALL' || STATIONS[code]?.line === scope, [scope]);

  const scoped = useMemo(() => (data?.stations ?? []).filter((s) => inScope(s.station)), [data, inScope]);
  const totals = useMemo(() => maintenanceTotals(scoped), [scoped]);
  const rows = useMemo(() => {
    const list = [...scoped];
    if (sort === 'down') list.sort((a, b) => b.downSec - a.downSec || b.failures - a.failures);
    else if (sort === 'pm') list.sort((a, b) => PM_ORDER[a.pm.status] - PM_ORDER[b.pm.status] || b.pm.sinceSec / b.pm.plan.every - a.pm.sinceSec / a.pm.plan.every);
    else list.sort((a, b) => order.get(a.station)! - order.get(b.station)!);
    return list;
  }, [scoped, sort]);
  const failures = useMemo(() => (data?.failures ?? []).filter((f) => inScope(f.station)), [data, inScope]);
  const reasons = useMemo(() => {
    if (scope === 'ALL') return data?.reasons ?? [];
    // 라인을 고르면 이력에서 다시 모은다 (이력은 최근 300건까지라 아주 긴 실행에서는 앞쪽이 빠질 수 있다)
    const m = new Map<string, { reason: string; count: number; sec: number; stations: Set<string> }>();
    for (const f of failures) {
      const r = m.get(f.reason) ?? { reason: f.reason, count: 0, sec: 0, stations: new Set<string>() };
      r.count++;
      r.sec += f.sec;
      r.stations.add(f.station);
      m.set(f.reason, r);
    }
    return [...m.values()].map((r) => ({ ...r, stations: [...r.stations] })).sort((a, b) => b.sec - a.sec);
  }, [data, scope, failures]);
  const pmQueue = useMemo(() => [...scoped].sort((a, b) => PM_ORDER[a.pm.status] - PM_ORDER[b.pm.status] || remain(a) - remain(b)).slice(0, 8), [scoped]);

  const goStation = (code: string) => {
    select(code);
    router.push('/');
  };
  const loading = <Empty h={180}>{q.isLoading ? '불러오는 중…' : q.error ? (q.error as Error).message : '아직 기록이 없습니다. 시뮬레이터가 돌면 바로 쌓입니다.'}</Empty>;

  return (
    <PageShell
      title="설비 보전"
      desc={
        <>
          설비가 언제, 왜, 얼마나 멈췄는지(고장 이력)와 MTBF·MTTR을 공장 정의의 설계값과 비교하고, 가동 시간 기준 계획 보전(PM)이 밀린 설비와 진동이 오르는 설비(예지 보전)를 찾습니다. 값은 MES에 쌓인 상태 기록에서
          계산해 서버를 다시 띄워도 같습니다. 계획 보전은 작업자 태블릿에서 계획 정지 사유를 <span className="text-ink">{PM_REASON}</span>으로 세웠다가 다시 돌리면 기록됩니다.
        </>
      }
      filters={<ScopeSwitcher scope={scope} setScope={setScope} report={data} />}
    >
      <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-5">
        <Stat
          label="고장"
          value={data ? `${totals.failures}건` : '-'}
          sub={data ? (totals.downNow ? <span className="text-down">지금 고장 {totals.downNow}대</span> : '지금 고장 난 설비 없음') : undefined}
        />
        <Stat
          label="고장 정지 시간"
          value={data ? duration(totals.downSec) : '-'}
          sub={data && totals.availability != null ? `가용도 ${pct(totals.availability)} (가동 ÷ (가동 + 고장))` : undefined}
        />
        <Stat label="MTBF (평균 고장 간격)" value={mins(totals.mtbf)} sub="설비 가동 시간 합 ÷ 고장 수" />
        <Stat label="MTTR (평균 수리 시간)" value={mins(totals.mttr)} sub="수리를 끝낸 고장의 평균" />
        <Stat
          label="계획 보전"
          value={data ? (totals.pmDue ? <span className="text-down">초과 {totals.pmDue}대</span> : '초과 없음') : '-'}
          sub={data ? `임박 ${totals.pmSoon}대 · 가동 시간 기준 주기` : undefined}
        />
      </div>

      <HealthPanel className="mt-3" inScope={inScope} onPick={goStation} />

      <TimelineCard className="mt-3" data={data} inScope={inScope} onPick={goStation} stale={q.isFetching && q.isPlaceholderData} empty={loading} />

      <ChartCard
        className="mt-3"
        title="설비별 보전 지표"
        subtitle={`실적은 이번 실행 기록, 설계는 공장 정의(시뮬레이터 고장 모델의 평균)입니다. MTBF가 설계의 ${MTBF_WARN * 100}% 밑이면 '잦음', MTTR이 설계의 ${MTTR_WARN}배 위면 '오래 걸림'으로 표시하고, 고장이 ${MAINT_MIN_FAILURES}건 미만이면 표본이 작아 흐리게 보입니다. 설비를 누르면 3D 공장에서 봅니다.`}
        right={
          <div className="flex overflow-hidden rounded border border-line text-xs">
            {(
              [
                ['down', '고장 시간 순'],
                ['pm', '계획 보전 급한 순'],
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
        {data ? <StationTable rows={rows} now={data.t} onPick={goStation} /> : loading}
      </ChartCard>

      <div className="mt-3 grid gap-3 @6xl:grid-cols-3">
        <ChartCard
          title="고장 사유"
          subtitle="사유별로 멈춘 시간을 합쳤습니다. 같은 사유가 여러 설비에서 나면 공통 부품·유틸리티(공압·전원)를 먼저 의심합니다."
          table={<DataTable head={['사유', '건수', '고장 시간', '설비']} align={['l', 'r', 'r', 'l']} rows={reasons.map((r) => [r.reason, r.count, duration(r.sec), r.stations.join(', ')])} />}
        >
          {reasons.length ? <ReasonBars rows={reasons.slice(0, 10)} /> : <Empty>아직 고장이 없습니다.</Empty>}
        </ChartCard>

        <ChartCard
          title="계획 보전 일정"
          subtitle="마지막 계획 보전(없으면 실행 시작) 뒤 쌓인 가동 시간을 주기와 비교해 급한 순으로 8대(전체는 위 표의 '계획 보전 급한 순'). 태블릿을 누르면 그 설비의 작업자 화면이 열립니다."
          table={
            <DataTable
              head={['설비', '할 일', '주기', '가동', '상태', '마지막']}
              align={['l', 'l', 'r', 'r', 'l', 'l']}
              rows={pmQueue.map((s) => [s.station, s.pm.plan.task, `${s.pm.plan.every}시간`, `${hours(s.pm.sinceSec)}시간`, PM_STATUS_NAMES[s.pm.status], s.pm.lastAt ? when(s.pm.lastAt, data?.t) : '실행 시작'])}
            />
          }
        >
          {data ? <PmList rows={pmQueue} now={data.t} /> : loading}
        </ChartCard>

        <ChartCard
          title="최근 고장"
          subtitle="새것부터. 작업자 등록은 태블릿에서 사람이 고장을 올린 것이고, 나머지는 설비가 스스로 멈춘 것입니다."
          table={
            <DataTable
              head={['시작', '설비', '사유', '고장 시간', '등록']}
              align={['l', 'l', 'l', 'r', 'l']}
              rows={failures.slice(0, 50).map((f) => [when(f.start, data?.t), f.station, f.reason, f.end ? duration(f.sec) : `수리 중 ${duration(f.sec)}`, f.byOperator ? '작업자' : '설비'])}
            />
          }
        >
          {failures.length ? <RecentFailures rows={failures.slice(0, 10)} now={data?.t} onPick={goStation} /> : <Empty>아직 고장이 없습니다.</Empty>}
        </ChartCard>
      </div>

      <section className="card mt-3 p-4 text-xs leading-relaxed text-sub">
        <h2 className="mb-2 text-sm font-semibold text-ink">이렇게 잽니다</h2>
        <ul className="grid gap-x-6 gap-y-1.5 @4xl:grid-cols-2">
          <li>
            <span className="text-ink">가동 시간</span> = 실행 시간 − 고장 − 계획 정지 − 셋업. 시뮬레이터 고장 모델은 이 시간 동안만 고장을 내므로 실적 MTBF를 설계 MTBF와 바로 비교할 수 있습니다.
          </li>
          <li>
            <span className="text-ink">MTBF</span> = 가동 시간 ÷ 고장 수. 공장·라인 값은 설비 가동 시간을 모두 더해 고장 수로 나눈 것입니다(설비 하나가 아니라 설비 무리의 평균 고장 간격).
          </li>
          <li>
            <span className="text-ink">MTTR</span> = 수리를 끝낸 고장의 평균 고장 시간. 진행 중인 고장은 고장 수·고장 시간에는 넣고 MTTR에서는 뺍니다. 작업자 등록 고장은 수리 완료를 누를 때까지 이어집니다.
          </li>
          <li>
            <span className="text-ink">가용도</span> = 가동 ÷ (가동 + 고장) = MTBF ÷ (MTBF + MTTR). OEE의 가동률과 달리 계획 정지·셋업을 빼고 고장만 봅니다.
          </li>
          <li>
            <span className="text-ink">계획 보전</span> 주기와 할 일은 설비 종류별 가정값입니다(공장 정의 PM_PLANS). 주기의 85%를 넘으면 임박, 넘기면 초과입니다. 계획 보전을 미뤄도 시뮬레이터의 고장률은
            아직 바뀌지 않습니다.
          </li>
          <li>
            <span className="text-ink">작업 전 점검</span>(자주보전)은 작업자 태블릿 기록입니다. 이번 실행에서 안 했으면 비어 있습니다.
          </li>
          <li>
            <span className="text-ink">예지 보전</span>은 시간이 아니라 상태로 보전 시점을 정합니다. 진동 RMS(mm/s)를 ISO 10816 기계 등급별 구역 경계와 견줘 B/C(장기 운전 한계)를 넘으면 보전 계획, C/D(손상
            우려)를 넘으면 즉시 보전 알람을 냅니다. 남은 수명은 진동 추세를 직선으로 늘린 추정이라, 마모가 빨라지는(진동이 가속하는) 끝 무렵에는 실제보다 길게 나옵니다.
          </li>
        </ul>
      </section>
    </PageShell>
  );
}

/** 주기까지 남은 가동 시간 (초, 음수면 초과) */
const remain = (s: StationMaintenance) => s.pm.plan.every * 3600 - s.pm.sinceSec;

function ScopeSwitcher({ scope, setScope, report }: { scope: Scope; setScope: (s: Scope) => void; report?: MaintenanceReport }) {
  const items: { code: Scope; name: string; color?: string }[] = [{ code: 'ALL', name: '공장 전체' }, ...LINES.map((l) => ({ code: l.code as Scope, name: l.name, color: l.color }))];
  return (
    <div role="tablist" aria-label="범위 선택" className="flex flex-wrap gap-2">
      {items.map((it) => {
        const on = it.code === scope;
        const t = report ? maintenanceTotals(report.stations.filter((s) => it.code === 'ALL' || s.line === it.code)) : null;
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
                고장 {t?.failures ?? '-'}건 · MTBF {mins(t?.mtbf)}
                {t?.pmDue ? ` · PM 초과 ${t.pmDue}` : ''}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ───────────── 고장 타임라인 ─────────────

const LABEL_W = 190;
const ROW_H = 20;
const AXIS_H = 20;
const WINDOW_H = 12;

interface Item {
  kind: 'fail' | 'pm';
  s: number;
  e: number;
  open: boolean;
  reason?: string;
  byOperator?: boolean;
}

/** 시간 눈금 간격: 눈금이 8개 이하가 되는 가장 작은 시간 단위 */
function tickStep(spanMs: number): number {
  for (const h of [0.5, 1, 2, 3, 4, 6, 12, 24]) if (spanMs / (h * 3_600_000) <= 8) return h * 3_600_000;
  return 48 * 3_600_000;
}

function TimelineCard({
  data,
  inScope,
  onPick,
  className,
  stale,
  empty,
}: {
  data?: MaintenanceReport;
  inScope: (code: string) => boolean;
  onPick: (code: string) => void;
  className?: string;
  stale: boolean;
  empty: React.ReactNode;
}) {
  const [all, setAll] = useState(false);
  const now = data?.t ? Date.parse(data.t) : 0;
  const start = data?.runStartedAt ? Date.parse(data.runStartedAt) : 0;
  const long = now - start > WINDOW_H * 3_600_000;
  const from = all || !long ? start : now - WINDOW_H * 3_600_000;

  const rows = useMemo(() => {
    if (!data) return [];
    const m = new Map<string, Item[]>();
    const put = (code: string, it: Item) => {
      if (!inScope(code) || it.e < from) return;
      m.set(code, [...(m.get(code) ?? []), it]);
    };
    for (const f of data.failures) {
      const s = Date.parse(f.start);
      put(f.station, { kind: 'fail', s, e: f.end ? Date.parse(f.end) : now, open: !f.end, reason: f.reason, byOperator: f.byOperator });
    }
    for (const p of data.pmWork) put(p.station, { kind: 'pm', s: Date.parse(p.start), e: p.end ? Date.parse(p.end) : now, open: !p.end });
    return [...m.entries()].sort((a, b) => order.get(a[0])! - order.get(b[0])!).map(([station, items]) => ({ station, items }));
  }, [data, inScope, from, now]);

  return (
    <ChartCard
      className={className}
      title="고장 타임라인"
      subtitle={`설비마다 고장(주황)과 계획 보전(청록)이 언제 얼마나 이어졌는지. 고장이나 보전이 있었던 설비만 보입니다. 오른쪽 끝이 지금입니다.${long && !all ? ` 최근 ${WINDOW_H}시간(가상)만 보고 있습니다.` : ''}`}
      legend={TIMELINE_LEGEND}
      stale={stale}
      right={
        long ? (
          <div className="flex overflow-hidden rounded border border-line text-xs">
            {(
              [
                [false, `최근 ${WINDOW_H}시간`],
                [true, '실행 전체'],
              ] as const
            ).map(([k, label]) => (
              <button key={label} onClick={() => setAll(k)} aria-pressed={all === k} className={cx('px-2 py-0.5', all === k ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}>
                {label}
              </button>
            ))}
          </div>
        ) : undefined
      }
      table={
        data && (
          <DataTable
            head={['설비', '구분', '시작', '끝', '시간', '사유']}
            align={['l', 'l', 'l', 'l', 'r', 'l']}
            rows={rows.flatMap((r) =>
              [...r.items]
                .sort((a, b) => b.s - a.s)
                .map((it) => [
                  r.station,
                  it.kind === 'fail' ? '고장' : '계획 보전',
                  when(new Date(it.s).toISOString(), data.t),
                  it.open ? '진행 중' : when(new Date(it.e).toISOString(), data.t),
                  duration((it.e - it.s) / 1000),
                  it.kind === 'fail' ? `${it.reason}${it.byOperator ? ' (작업자 등록)' : ''}` : PM_REASON,
                ]),
            )}
          />
        )
      }
    >
      {!data ? empty : rows.length ? <Timeline rows={rows} from={from} to={now} nowIso={data.t} onPick={onPick} /> : <Empty h={120}>이 범위에는 아직 고장·계획 보전이 없습니다.</Empty>}
    </ChartCard>
  );
}

function Timeline({ rows, from, to, nowIso, onPick }: { rows: { station: string; items: Item[] }[]; from: number; to: number; nowIso: string | null; onPick: (code: string) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const plot = Math.max(80, width - LABEL_W - 8);
  const span = Math.max(1, to - from);
  const x = (ms: number) => ((Math.max(from, Math.min(to, ms)) - from) / span) * plot;
  const step = tickStep(span);
  const ticks: number[] = [];
  // 한국 시각 정시에 맞춘 눈금
  const kstOffset = 9 * 3_600_000;
  for (let t = Math.ceil((from + kstOffset) / step) * step - kstOffset; t <= to; t += step) ticks.push(t);
  const h = hover ? rows[hover.i]?.items[hover.j] : null;

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      <svg width={width} height={AXIS_H} className="block" aria-hidden>
        {ticks.map((t) => {
          // 시각만 쓰고, 날이 바뀌는 자정 눈금에만 날짜를 쓴다
          const k = new Date(t + kstOffset).toISOString();
          const midnight = k.slice(11, 16) === '00:00';
          return (
            <text key={t} x={LABEL_W + x(t)} y={13} textAnchor="middle" fontSize={10} fill={midnight ? C.sub : C.dim} className="num">
              {midnight ? k.slice(5, 10) : k.slice(11, 16)}
            </text>
          );
        })}
      </svg>
      <div className="scroll-thin max-h-[420px] overflow-y-auto">
        {rows.map((r, i) => (
          <div key={r.station} className="flex items-center hover:bg-white/[0.03]" style={{ height: ROW_H }}>
            <button className="shrink-0 truncate pr-2 text-left text-xs hover:underline" style={{ width: LABEL_W }} title="3D 공장에서 이 설비 보기" onClick={() => onPick(r.station)}>
              <span className="num font-semibold">{r.station}</span> <span className="text-sub">{STATIONS[r.station]?.name}</span>
            </button>
            <svg width={plot} height={ROW_H} className="block shrink-0" role="img" aria-label={`${r.station} 고장·계획 보전 ${r.items.length}건`}>
              <line x1={0} x2={plot} y1={ROW_H / 2} y2={ROW_H / 2} stroke={C.grid} />
              {ticks.map((t) => (
                <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={ROW_H} stroke={C.grid} />
              ))}
              {r.items.map((it, j) => {
                const x0 = x(it.s);
                const w = Math.max(3, x(it.e) - x0);
                const on = hover?.i === i && hover.j === j;
                return (
                  <g key={j} onMouseEnter={() => setHover({ i, j })}>
                    {/* 막대보다 넓은 투명 영역으로 짧은 고장도 짚기 쉽게 */}
                    <rect x={x0 - 3} y={0} width={w + 6} height={ROW_H} fill="transparent" />
                    <rect
                      x={x0}
                      y={5}
                      width={w}
                      height={ROW_H - 10}
                      rx={2}
                      fill={it.kind === 'fail' ? FAIL_COLOR : PM_COLOR}
                      opacity={hover && !on ? 0.55 : 1}
                      stroke={on ? C.ink : undefined}
                    />
                  </g>
                );
              })}
            </svg>
          </div>
        ))}
      </div>
      {h && hover && (
        <Tip x={LABEL_W + x(h.s)} y={AXIS_H + (hover.i + 1) * ROW_H} width={width}>
          <TipTitle>
            {rows[hover.i].station} {STATIONS[rows[hover.i].station]?.name}
          </TipTitle>
          <TipRow color={h.kind === 'fail' ? FAIL_COLOR : PM_COLOR} shape="rect" label={h.kind === 'fail' ? (h.open ? '고장 · 수리 중' : '고장') : h.open ? '계획 보전 중' : '계획 보전'} value={duration((h.e - h.s) / 1000)} />
          <div className="mt-1 text-[11px] text-sub">
            {when(new Date(h.s).toISOString(), nowIso)} ~ {h.open ? '지금' : when(new Date(h.e).toISOString(), nowIso)}
          </div>
          {h.kind === 'fail' && (
            <div className="mt-0.5 max-w-60 text-[11px] text-sub">
              사유 {h.reason}
              {h.byOperator && ' · 작업자 등록'}
            </div>
          )}
        </Tip>
      )}
    </div>
  );
}

// ───────────── 설비별 표 ─────────────

function Ratio({ actual, design, unit, worse, label, few }: { actual: number | null; design: number; unit: 'mtbf' | 'mttr'; worse: boolean; label: string; few: boolean }) {
  return (
    <span className={cx('whitespace-nowrap', few && 'opacity-50')} title={few ? `고장 ${MAINT_MIN_FAILURES}건 미만이라 표본이 작습니다` : undefined}>
      <span className="num text-ink">{mins(actual)}</span>
      <span className="num text-dim"> / {mins(design)}</span>
      {worse && !few && (
        <span className={cx('ml-1.5 rounded px-1 py-px text-[10px]', unit === 'mtbf' ? 'bg-warn/15 text-warn' : 'bg-warn/15 text-warn')}>{label}</span>
      )}
    </span>
  );
}

function PmCell({ s }: { s: StationMaintenance }) {
  const ratio = s.pm.sinceSec / (s.pm.plan.every * 3600);
  return (
    <div className="min-w-[150px]" title={`${s.pm.plan.task} · 표준 ${s.pm.plan.minutes}분`}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="inline-flex items-center gap-1.5">
          <Key color={PM_STATUS_COLOR[s.pm.status]} shape="dot" />
          <span className={cx(s.pm.status === 'due' ? 'text-down' : s.pm.status === 'soon' ? 'text-warn' : 'text-sub')}>{PM_STATUS_NAMES[s.pm.status]}</span>
        </span>
        <span className="num text-[11px] text-sub">
          {hours(s.pm.sinceSec)} / {s.pm.plan.every}시간
        </span>
      </div>
      <Meter value={Math.min(1, ratio)} color={PM_STATUS_COLOR[s.pm.status]} />
    </div>
  );
}

function StationTable({ rows, now, onPick }: { rows: StationMaintenance[]; now: string | null; onPick: (code: string) => void }) {
  return (
    <div className="scroll-thin max-h-[560px] overflow-auto">
      <table className="w-full min-w-[980px] text-xs">
        <thead className="sticky top-0 z-10 bg-[var(--color-chart)] text-dim">
          <tr className="border-b border-line">
            <th className="py-1.5 pr-2 text-left font-normal">설비</th>
            <th className="px-2 text-left font-normal">지금</th>
            <th className="px-2 text-right font-normal">고장</th>
            <th className="px-2 text-right font-normal">고장 시간</th>
            <th className="px-2 text-left font-normal" title="실적 / 설계">
              MTBF 실적 / 설계
            </th>
            <th className="px-2 text-left font-normal" title="실적 / 설계">
              MTTR 실적 / 설계
            </th>
            <th className="px-2 text-right font-normal">가용도</th>
            <th className="w-[190px] px-2 text-left font-normal">계획 보전 (가동 / 주기)</th>
            <th className="px-2 text-left font-normal">작업 전 점검</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const few = s.failures < MAINT_MIN_FAILURES;
            return (
              <tr key={s.station} className="border-b border-line/60 align-middle hover:bg-white/[0.03]">
                <td className="py-1.5 pr-2">
                  <button className="text-left hover:underline" title="3D 공장에서 이 설비 보기" onClick={() => onPick(s.station)}>
                    <span className="num font-semibold">{s.station}</span> <span className="text-sub">{STATIONS[s.station]?.name}</span>
                  </button>
                </td>
                <td className="px-2 whitespace-nowrap">
                  {s.down ? (
                    <span className="inline-flex items-center gap-1.5 text-down">
                      <Key color="var(--color-down)" shape="dot" />
                      고장
                    </span>
                  ) : s.pm.status === 'doing' ? (
                    <span className="text-info">계획 보전 중</span>
                  ) : (
                    <span className="text-dim">-</span>
                  )}
                </td>
                <td className="num px-2 text-right">{s.failures || <span className="text-dim">0</span>}</td>
                <td className="num px-2 text-right text-sub">{s.downSec > 0 ? duration(s.downSec) : '-'}</td>
                <td className="px-2">
                  <Ratio actual={s.mtbf} design={s.designMtbf} unit="mtbf" worse={s.mtbf != null && s.mtbf < s.designMtbf * MTBF_WARN} label="잦음" few={few} />
                </td>
                <td className="px-2">
                  <Ratio actual={s.mttr} design={s.designMttr} unit="mttr" worse={s.mttr != null && s.mttr > s.designMttr * MTTR_WARN} label="오래 걸림" few={few} />
                </td>
                <td className="num px-2 text-right">{s.availability != null ? pct(s.availability) : '-'}</td>
                <td className="px-2 py-1">
                  <PmCell s={s} />
                </td>
                <td className="px-2 whitespace-nowrap">
                  {s.check ? (
                    <span className={s.check.ngCount ? 'text-warn' : 'text-sub'}>
                      {when(s.check.at, now)} · {s.check.ngCount ? `이상 ${s.check.ngCount}` : '이상 없음'}
                    </span>
                  ) : (
                    <span className="text-dim">안 함</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ───────────── 사유 · 계획 보전 · 최근 고장 ─────────────

const BAR_H = 24;
const REASON_W = 150;

/** 사유별 고장 시간 가로 막대. 값 축은 0부터, 막대 끝에 시간을 쓴다 */
function ReasonBars({ rows }: { rows: { reason: string; count: number; sec: number; stations: string[] }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...rows.map((r) => r.sec), 1);
  const plot = Math.max(40, width - REASON_W - 76);
  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      {rows.map((r, i) => (
        <div
          key={r.reason}
          onMouseEnter={() => setHover(i)}
          className={cx('flex items-center gap-2 rounded text-xs', hover === i && 'bg-white/[0.05]')}
          style={{ height: BAR_H }}
        >
          <span className="shrink-0 truncate pl-1 text-sub" style={{ width: REASON_W }} title={r.reason}>
            {r.reason}
          </span>
          <span className="block rounded-r-[4px]" style={{ width: Math.max(2, (r.sec / max) * plot), height: 10, background: FAIL_COLOR, opacity: hover != null && hover !== i ? 0.55 : 1 }} />
          <span className="num shrink-0 text-sub">
            {duration(r.sec)} · {r.count}건
          </span>
        </div>
      ))}
      {hover != null && rows[hover] && (
        <Tip x={REASON_W} y={(hover + 1) * BAR_H + 4} width={width}>
          <TipTitle>{rows[hover].reason}</TipTitle>
          <TipRow color={FAIL_COLOR} shape="rect" label="고장 시간" value={duration(rows[hover].sec)} />
          <TipRow label="건수" value={`${rows[hover].count}건`} />
          <div className="mt-1 max-w-60 text-[11px] text-dim">{rows[hover].stations.map((c) => `${c} ${STATIONS[c]?.name ?? ''}`).join(', ')}</div>
        </Tip>
      )}
    </div>
  );
}

function PmList({ rows, now }: { rows: StationMaintenance[]; now: string | null }) {
  if (!rows.length) return <Empty>설비가 없습니다.</Empty>;
  return (
    <ul className="divide-y divide-line/60">
      {rows.map((s) => {
        const left = remain(s);
        return (
          <li key={s.station} className="py-1.5 text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate">
                <span className="num font-semibold">{s.station}</span> <span className="text-sub">{s.pm.plan.task}</span>
              </span>
              <Link href={`/operator/${s.station}`} className="shrink-0 rounded border border-line px-1.5 py-px text-[11px] text-sub hover:bg-white/10 hover:text-ink">
                태블릿
              </Link>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div className="flex-1">
                <Meter value={Math.min(1, s.pm.sinceSec / (s.pm.plan.every * 3600))} color={PM_STATUS_COLOR[s.pm.status]} />
              </div>
              <span className={cx('num w-[124px] shrink-0 text-right text-[11px]', s.pm.status === 'due' ? 'text-down' : s.pm.status === 'soon' ? 'text-warn' : 'text-sub')}>
                {s.pm.status === 'doing' ? '보전 중' : left >= 0 ? `${hours(left)}시간 남음` : `${hours(-left)}시간 초과`}
              </span>
            </div>
            <div className="mt-0.5 text-[11px] text-dim">
              주기 {s.pm.plan.every}시간 · 표준 {s.pm.plan.minutes}분 · 마지막 {s.pm.lastAt ? when(s.pm.lastAt, now) : '이번 실행에서 안 함'}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function RecentFailures({ rows, now, onPick }: { rows: MaintenanceReport['failures']; now?: string | null; onPick: (code: string) => void }) {
  return (
    <ul className="divide-y divide-line/60">
      {rows.map((f) => (
        <li key={`${f.station}-${f.start}`} className="flex items-start gap-2 py-1.5 text-xs">
          <span className="num w-[84px] shrink-0 whitespace-nowrap text-dim">{when(f.start, now)}</span>
          <span className="min-w-0 flex-1">
            <button className="hover:underline" onClick={() => onPick(f.station)} title="3D 공장에서 이 설비 보기">
              <span className="num font-semibold">{f.station}</span>
            </button>{' '}
            <span className="text-sub">{f.reason}</span>
            {f.byOperator && <span className="ml-1.5 rounded bg-white/10 px-1 py-px text-[10px] text-sub">작업자 등록</span>}
          </span>
          <span className={cx('num shrink-0', f.end ? 'text-sub' : 'text-down')}>{f.end ? duration(f.sec) : `수리 중 ${duration(f.sec)}`}</span>
        </li>
      ))}
    </ul>
  );
}
