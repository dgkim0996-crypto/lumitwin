'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { LINES, SPC_RULES, SPC_SUBGROUP, STATIONS, type ProcessRecordView, type SpcChart, type SpcRule } from '@lumitwin/shared';
import { Histogram } from '@/components/charts/Histogram';
import { C, ChartCard, DataTable, Empty, Key, TipRow } from '@/components/charts/kit';
import { LimitChart, type LimitPoint } from '@/components/charts/LimitChart';
import { LineSwitcher, PageShell } from '@/components/mes/PageShell';
import { api } from '@/lib/api';
import { cx, kst, num } from '@/lib/format';
import { useFocusTarget, useUi } from '@/lib/ui';

type Summary = Omit<SpcChart, 'points'> & { last?: SpcChart['points'][number]; flagged: number };
type Source = SpcChart['source'];

const SOURCE_LABEL: Record<Source, string> = { measure: '검사값', cycle: '공정값', continuous: '연속값(참고)' };
const FILTERS: { id: 'all' | Source; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'measure', label: '검사값' },
  { id: 'cycle', label: '공정값' },
  { id: 'continuous', label: '연속값' },
];

/** 공정능력 판정: 1.33 이상 양호 · 1.0~1.33 주의 · 1.0 미만 부족 (상태 색 + 글자를 함께) */
function cpkGrade(cpk: number | null) {
  if (cpk == null) return { label: '계산 전', color: C.dim };
  if (cpk >= 1.33) return { label: '양호', color: '#0ca30c' };
  if (cpk >= 1.0) return { label: '주의', color: '#fab219' };
  return { label: '부족', color: C.ng };
}

function CpkBadge({ cpk }: { cpk: number | null }) {
  const g = cpkGrade(cpk);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Key color={g.color} shape="dot" />
      <span className="num text-ink">{cpk == null ? '-' : cpk.toFixed(2)}</span>
      <span className="text-dim">{g.label}</span>
    </span>
  );
}

const ruleText = (fs: SpcRule[]) => fs.map((f) => `${f} ${SPC_RULES[f]}`);
const lineOf = (station: string) => STATIONS[station]?.line;
const order = new Map(LINES.flatMap((l) => l.stations.map((s, i) => [s.code, i] as const)));

export default function SpcPage() {
  const lineCode = useUi((s) => s.line);
  const [filter, setFilter] = useState<'all' | Source>('measure');
  const [sortCpk, setSortCpk] = useState(false);
  const [sel, setSel] = useState<{ station: string; key: string } | null>(null);

  const summary = useQuery({ queryKey: ['spc-summary'], queryFn: () => api.get<Summary[]>('/live/spc'), refetchInterval: 3_000, placeholderData: keepPreviousData });

  const list = useMemo(() => {
    const rows = (summary.data ?? []).filter((c) => lineOf(c.station) === lineCode && (filter === 'all' || c.source === filter));
    rows.sort((a, b) =>
      sortCpk ? (a.cpk ?? 99) - (b.cpk ?? 99) : (order.get(a.station) ?? 0) - (order.get(b.station) ?? 0) || a.name.localeCompare(b.name, 'ko'),
    );
    return rows;
  }, [summary.data, lineCode, filter, sortCpk]);

  // AI 비서 링크 등으로 설비를 지정해 들어오면 그 설비의 라인으로 바꾸고, 그 설비에서 가장 나쁜 특성을 고른다
  const setLine = useUi((s) => s.setLine);
  const [wantStation, setWantStation] = useState<string | null>(null);
  useFocusTarget((f) => {
    if (!f.station || !STATIONS[f.station]) return;
    setLine(STATIONS[f.station].line);
    setWantStation(f.station);
  });

  // 선택이 없거나 다른 라인 것이면: 최근 이탈이 있는 특성 → Cpk가 가장 낮은 특성 순으로 고른다
  useEffect(() => {
    if (wantStation && summary.data) {
      if (!summary.data.some((c) => c.station === wantStation)) return setWantStation(null);
      const mine = list.filter((c) => c.station === wantStation);
      // 지금 거르기(검사값만 등)에 그 설비 특성이 없으면 전체로 넓힌다
      if (!mine.length) return lineOf(wantStation) === lineCode ? setFilter('all') : undefined;
      const pick = [...mine].sort((a, b) => b.flagged - a.flagged || (a.cpk ?? 99) - (b.cpk ?? 99))[0];
      setSel({ station: pick.station, key: pick.key });
      setWantStation(null);
      return;
    }
    if (!list.length) return;
    if (sel && list.some((c) => c.station === sel.station && c.key === sel.key)) return;
    const pick = [...list].sort((a, b) => b.flagged - a.flagged || (a.cpk ?? 99) - (b.cpk ?? 99))[0];
    setSel({ station: pick.station, key: pick.key });
  }, [list, sel, wantStation, summary.data, lineCode]);

  const detail = useQuery({
    queryKey: ['spc', sel?.station],
    queryFn: () => api.get<SpcChart[]>(`/live/spc/${sel!.station}`),
    enabled: !!sel,
    refetchInterval: 3_000,
    placeholderData: keepPreviousData,
  });
  const chart = detail.data?.find((c) => c.station === sel?.station && c.key === sel?.key) ?? null;

  const records = useQuery({
    queryKey: ['records', sel?.station],
    queryFn: () => api.get<ProcessRecordView[]>(`/production/records?station=${sel!.station}&limit=300`),
    enabled: !!sel,
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });
  const values = useMemo(() => {
    if (!sel) return [];
    const out: number[] = [];
    let lastStart = '';
    for (const r of records.data ?? []) {
      const v = r.values?.[sel.key];
      if (typeof v !== 'number') continue;
      // 배치 설비는 같은 배치(같은 시작 시각) 값이 여러 번 실리므로 하나만 센다
      if (r.startedAt === lastStart) continue;
      lastStart = r.startedAt;
      out.push(v);
    }
    return out;
  }, [records.data, sel]);

  const xbar: LimitPoint[] = (chart?.points ?? []).map((p) => ({
    t: p.t,
    v: p.mean,
    flags: ruleText(p.flags.filter((f) => f !== 'R4')),
    extra: <TipRow label="범위 R" value={num(p.range)} />,
  }));
  const rpts: LimitPoint[] = (chart?.points ?? []).map((p) => ({ t: p.t, v: p.range, flags: ruleText(p.flags.filter((f) => f === 'R4')) }));
  const violations = (chart?.points ?? []).filter((p) => p.flags.length).reverse();
  const stats = values.length > 1 ? (() => {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
    const ppk = chart && sd > 0 ? Math.min(chart.usl != null ? (chart.usl - mean) / (3 * sd) : Infinity, chart.lsl != null ? (mean - chart.lsl) / (3 * sd) : Infinity) : null;
    const outN = chart ? values.filter((v) => (chart.lsl != null && v < chart.lsl) || (chart.usl != null && v > chart.usl)).length : 0;
    return { mean, sd, ppk: ppk != null && Number.isFinite(ppk) ? ppk : null, outN };
  })() : null;
  const def = sel ? STATIONS[sel.station] : null;

  return (
    <PageShell
      title="SPC (통계적 공정 관리)"
      desc={`X̄-R 관리도: 같은 설비에서 연속으로 나온 ${SPC_SUBGROUP}개를 한 부분군으로 묶어 평균(X̄)과 범위(R)를 찍습니다. 중심선과 관리한계는 공장 정의(설계값)에서 계산한 표준값입니다.`}
      filters={<LineSwitcher />}
    >
      <div className="grid gap-3 @4xl:grid-cols-[minmax(320px,380px)_1fr]">
        <section className="card flex max-h-[300px] flex-col p-3 @4xl:max-h-[calc(100vh-230px)] @4xl:min-h-[420px]">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex overflow-hidden rounded border border-line text-xs">
              {FILTERS.map((f) => (
                <button key={f.id} onClick={() => setFilter(f.id)} aria-pressed={filter === f.id} className={cx('px-2 py-0.5', filter === f.id ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}>
                  {f.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-sub">
              <input type="checkbox" checked={sortCpk} onChange={(e) => setSortCpk(e.target.checked)} className="accent-[var(--color-info)]" />
              Cpk 낮은 순
            </label>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            {list.length === 0 && <Empty>{summary.isLoading ? '불러오는 중…' : '이 조건의 관리 특성이 없습니다.'}</Empty>}
            {list.map((c) => {
              const on = sel?.station === c.station && sel.key === c.key;
              return (
                <button
                  key={`${c.station}.${c.key}`}
                  onClick={() => setSel({ station: c.station, key: c.key })}
                  className={cx('mb-1 block w-full rounded-md border px-2.5 py-1.5 text-left', on ? 'border-info/60 bg-info/10' : 'border-transparent hover:bg-white/[0.05]')}
                >
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{c.name}</span>
                    <span className="text-xs">
                      <CpkBadge cpk={c.cpk} />
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-dim">
                    <span className="truncate">
                      <span className="num">{c.station}</span> {STATIONS[c.station]?.name} · {SOURCE_LABEL[c.source]}
                    </span>
                    {c.flagged > 0 && (
                      <span className="inline-flex shrink-0 items-center gap-1 text-sub">
                        <Key color={C.ng} shape="dot" />
                        최근 이탈 {c.flagged}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <div className="@container min-w-0">
          {!chart ? (
            <section className="card p-4">
              <Empty h={300}>{sel ? '관리도를 불러오는 중…' : '왼쪽에서 관리 특성을 고르세요.'}</Empty>
            </section>
          ) : (
            <>
              <section className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold">
                      {chart.name} <span className="text-sm font-normal text-sub">({chart.unit || '단위 없음'})</span>
                    </div>
                    <div className="mt-0.5 text-xs text-sub">
                      <span className="num">{chart.station}</span> {def?.name} · {SOURCE_LABEL[chart.source]} · 부분군 {chart.points.length}개 (n={chart.n})
                      {!chart.alarms && ' · 알람 대상 아님 (그래프만)'}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs @md:grid-cols-4">
                    <div>
                      <div className="text-dim">Cpk (군내 σ)</div>
                      <div className="mt-0.5 text-sm">
                        <CpkBadge cpk={chart.cpk} />
                      </div>
                    </div>
                    <div>
                      <div className="text-dim">Ppk (전체 σ)</div>
                      <div className="mt-0.5 text-sm">
                        <CpkBadge cpk={stats?.ppk ?? null} />
                      </div>
                    </div>
                    <div>
                      <div className="text-dim">설계 σ</div>
                      <div className="num mt-0.5 text-sm text-ink">{num(chart.sigma)}</div>
                    </div>
                    <div>
                      <div className="text-dim">규격</div>
                      <div className="num mt-0.5 text-sm text-ink">
                        {chart.lsl ?? '−'} ~ {chart.usl ?? '−'}
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <ChartCard
                className="mt-3"
                title="X̄ 관리도 (부분군 평균)"
                subtitle="빨간 점선 = 관리한계(±3σ/√n) · 주황 = 규격 · 빨간 점 = 판정 규칙 위반. 관리한계는 '공정이 평소대로인가', 규격은 '제품이 쓸 만한가'를 묻는 다른 선입니다."
                legend={[
                  { label: 'X̄', color: C.series, shape: 'line' },
                  { label: '관리한계', color: C.ng, shape: 'dash' },
                  { label: '규격', color: C.warn, shape: 'line' },
                ]}
                stale={detail.isFetching && detail.isPlaceholderData}
                table={
                  <DataTable
                    head={['시각', 'X̄', 'R', '판정']}
                    align={['l', 'r', 'r', 'l']}
                    rows={[...chart.points].reverse().map((p) => [kst(p.t), num(p.mean), num(p.range), p.flags.length ? ruleText(p.flags).join(', ') : '정상'])}
                  />
                }
              >
                {chart.points.length ? (
                  <LimitChart points={xbar} cl={chart.cl} ucl={chart.ucl} lcl={chart.lcl} lsl={chart.lsl} usl={chart.usl} unit={chart.unit} valueLabel="X̄" height={230} />
                ) : (
                  <Empty h={230}>부분군을 모으는 중입니다 ({SPC_SUBGROUP}개씩)</Empty>
                )}
              </ChartCard>

              <div className="mt-3 grid gap-3 @2xl:grid-cols-2">
                <ChartCard title="R 관리도 (부분군 범위)" subtitle="부분군 안의 흩어짐. 위로 튀면 설비가 불안정해진 것입니다 (R4).">
                  {chart.points.length ? <LimitChart points={rpts} cl={chart.rCl} ucl={chart.rUcl} unit={chart.unit} valueLabel="R" height={170} /> : <Empty h={170}>부분군을 모으는 중</Empty>}
                </ChartCard>
                <ChartCard
                  title="개별값 분포 (최근 기록)"
                  subtitle={
                    stats
                      ? `${values.length}개 · 평균 ${num(stats.mean)} · 표준편차 ${num(stats.sd)} · 규격 밖 ${stats.outN}개`
                      : 'DB에 쌓인 공정 기록에서 이 값을 모읍니다'
                  }
                  legend={[
                    { label: '규격 안', color: C.series, shape: 'rect' },
                    { label: '규격 밖', color: C.ng, shape: 'rect' },
                  ]}
                  stale={records.isFetching && records.isPlaceholderData}
                >
                  {values.length > 5 ? <Histogram values={values} lsl={chart.lsl} usl={chart.usl} unit={chart.unit} height={170} /> : <Empty h={170}>기록을 모으는 중</Empty>}
                </ChartCard>
              </div>

              <ChartCard className="mt-3" title={`판정 규칙 위반 (${violations.length}건, 최근 ${chart.points.length}개 부분군 중)`} subtitle={Object.entries(SPC_RULES).map(([k, v]) => `${k} ${v}`).join(' · ')}>
                {violations.length ? (
                  <DataTable
                    head={['시각', 'X̄', 'R', '위반 규칙']}
                    align={['l', 'r', 'r', 'l']}
                    rows={violations.map((p) => [kst(p.t), num(p.mean), num(p.range), ruleText(p.flags).join(', ')])}
                  />
                ) : (
                  <Empty h={60}>최근 부분군에서 위반이 없습니다. 공정이 관리 상태입니다.</Empty>
                )}
              </ChartCard>
            </>
          )}
        </div>
      </div>
    </PageShell>
  );
}
