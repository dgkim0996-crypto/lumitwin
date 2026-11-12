'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LINES, STATIONS, type FactorAnalysis, type FactorCandidate, type LotSkew, type ProcessRecordView } from '@lumitwin/shared';
import { C, ChartCard, DataTable, Empty, Key } from '@/components/charts/kit';
import { foldPareto, PARETO_LEGEND, ParetoChart, type ParetoItem } from '@/components/charts/ParetoChart';
import { BOX_LEGEND, BoxPair } from '@/components/charts/small';
import { LineSwitcher, PageShell } from '@/components/mes/PageShell';
import { api } from '@/lib/api';
import { cx, kst } from '@/lib/format';
import { useLive } from '@/lib/live';
import { defectName, ITEM_NAMES, stationName, valueMeta } from '@/lib/names';
import { useFocusTarget, useUi } from '@/lib/ui';

interface DefectCount {
  station: string;
  defect: string;
  n: number;
}

const KIND: Record<FactorCandidate['kind'], string> = { tag: '공정 조건', attr: '부품 속성', measure: '앞 공정 검사값' };
const RELATION: Record<FactorCandidate['relation'], string> = { self: '같은 부품이 거친 앞 공정', component: '조립돼 들어간 하위 부품' };

/** 표준화 평균 차의 크기 (Cohen의 관례: 0.2 작음 · 0.5 보통 · 0.8 큼) */
function sizeLabel(d: number) {
  const a = Math.abs(d);
  return a >= 0.8 ? '큰 차이' : a >= 0.5 ? '보통 차이' : a >= 0.2 ? '작은 차이' : '거의 없음';
}

/**
 * 설비 공정값(tag)은 자재 LOT로 바뀌지 않는다. 그 값이 크게 갈리는데(|d| ≥ 0.8) 같은 설비의 LOT도 편중돼 있고
 * 불량품 거의 전부(90%)가 그 LOT를 쓴 것이 아니면, 설비 이상이 난 시기에 쓰던 LOT라서 함께 오른 것일 수 있다.
 * AI 비서의 판단 규칙과 같다 (docs/DESIGN.md 6.1).
 */
function confoundingTag(lot: LotSkew, top?: FactorCandidate) {
  return top && top.kind === 'tag' && Math.abs(top.effect) >= 0.8 && top.station === lot.station && lot.ngShare < 0.9 ? top : undefined;
}

/** 불량품 쪽에 몰린 자재 LOT. 공정 값 비교보다 먼저 본다: LOT가 원인이면 설비 조건은 정상이어도 불량이 난다 */
function LotSkewBox({ lots, ngCount, okCount, top }: { lots: LotSkew[]; ngCount: number; okCount: number; top?: FactorCandidate }) {
  const router = useRouter();
  const tag = lots[0] && confoundingTag(lots[0], top);
  return (
    <div className="mb-3 rounded-md border border-warn/40 bg-warn/[0.06] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-xs font-semibold text-ink">⚠ 자재 LOT 편중</div>
        <div className="flex items-center gap-3 text-[11px] text-sub">
          {BOX_LEGEND.map((b) => (
            <span key={b.label} className="flex items-center gap-1.5">
              <Key color={b.color} /> {b.label} 중 이 LOT를 쓴 비율
            </span>
          ))}
        </div>
      </div>
      <p className="mt-0.5 text-[11px] text-sub">불량품이 특정 자재 LOT를 양품보다 훨씬 많이 썼습니다(두 비율 차이 z ≥ 3). 설비 조건이 정상인데 불량이 났다면 먼저 이 LOT를 의심합니다.</p>
      {tag && (
        <p className="mt-1.5 rounded border border-line bg-white/[0.04] px-2 py-1 text-[11px] text-ink">
          단, 같은 설비의 공정 조건 <b>{valueMeta(tag.station, tag.key).name}</b>에서도 불량품과 양품이 크게 갈립니다(d = {tag.effect.toFixed(2)}). 공정 조건은 자재 LOT로 바뀌지 않으므로, 이 LOT는 설비 이상이 난 시기에 쓰던 것이라 함께 오른 것일 수 있습니다. 설비를 먼저 보고, 바로잡은 뒤에도 이 LOT의 불량률이 높으면 LOT를 의심하세요.
        </p>
      )}
      <ul className="mt-2 space-y-2">
        {lots.map((l) => (
          <li key={`${l.lot}.${l.station}`} className="grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)] items-center gap-3 text-xs">
            <div className="min-w-0">
              <button className="num font-semibold text-info hover:underline" title="추적 화면에서 이 LOT의 불량률과 회수 범위 보기" onClick={() => router.push(`/trace?lot=${encodeURIComponent(l.lot)}`)}>
                {l.lot}
              </button>
              <div className="truncate text-[11px] text-dim">
                {ITEM_NAMES[l.material] ?? l.material} · {stationName(l.station)} 투입
              </div>
            </div>
            <div className="space-y-1">
              {[
                { label: '불량품', color: C.ng, share: l.ngShare, n: l.ng, of: ngCount },
                { label: '양품', color: C.series, share: l.okShare, n: l.ok, of: okCount },
              ].map((b) => (
                <div key={b.label} className="flex items-center gap-2">
                  <span className="num w-24 shrink-0 text-right text-ink">
                    {Math.round(b.share * 100)}% <span className="text-dim">({b.n}/{b.of})</span>
                  </span>
                  <div className="h-2 flex-1 rounded-sm bg-white/[0.04]" aria-label={`${b.label} ${b.of}개 중 ${b.n}개가 ${l.lot} 사용`}>
                    <div className="h-full rounded-r" style={{ width: `${b.share * 100}%`, background: b.color }} />
                  </div>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FactorRow({ f, rank, line, maxD }: { f: FactorCandidate; rank: number; line: string; maxD: number }) {
  const meta = valueMeta(f.station, f.key);
  const st = STATIONS[f.station];
  const otherLine = st && st.line !== line;
  const w = Math.min(1, Math.abs(f.effect) / maxD);
  return (
    <li className="grid gap-x-4 gap-y-1 border-b border-line/60 py-2.5 @2xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.8fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="num text-xs text-dim">{rank}</span>
          <span className="font-medium">{meta.name}</span>
          <span className="text-xs text-sub">{meta.unit}</span>
        </div>
        <div className="mt-0.5 text-xs text-sub">
          <span className="num">{f.station}</span> {st?.name}
          {otherLine && <span className="ml-1.5 rounded border border-warn/50 px-1 text-[10px] text-ink">다른 라인 · {LINES.find((l) => l.code === st.line)?.short}</span>}
        </div>
        <div className="mt-0.5 text-[11px] text-dim">
          {KIND[f.kind]} · {RELATION[f.relation]}
          {meta.inputs.length > 0 && <> · 계산 입력: {meta.inputs.join(', ')}</>}
        </div>
      </div>
      <div className="min-w-0 self-center">
        <div className="flex items-baseline justify-between text-xs">
          <span className="num font-semibold text-ink">
            {f.effect > 0 ? '+' : ''}
            {f.effect.toFixed(2)}σ
          </span>
          <span className="text-dim">
            {sizeLabel(f.effect)} · 불량품이 {f.effect > 0 ? '높음' : '낮음'}
          </span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full" style={{ background: C.seriesSoft }}>
          <div className="h-full rounded-full" style={{ width: `${w * 100}%`, background: C.series }} />
        </div>
      </div>
      <div className="min-w-0 self-center">
        <BoxPair ng={f.ng} ok={f.ok} unit={meta.unit} />
      </div>
    </li>
  );
}

export default function QualityPage() {
  const lineCode = useUi((s) => s.line);
  const line = LINES.find((l) => l.code === lineCode)!;
  const openTrace = useLive((s) => s.openTrace);

  // 설비·불량별 건수: DB 기록에서 센다 (서버를 재시작해도 실행 시작부터 누계가 남는다)
  const defects = useQuery({
    queryKey: ['defects', lineCode],
    queryFn: () => api.get<DefectCount[]>(`/production/defects?line=${lineCode}`),
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });

  // 파레토: 라인의 불량 코드별 누계
  const pareto = useMemo<ParetoItem[]>(() => {
    const by = new Map<string, { count: number; at: Set<string> }>();
    for (const r of defects.data ?? []) {
      const m = by.get(r.defect) ?? { count: 0, at: new Set<string>() };
      m.count += r.n;
      m.at.add(r.station);
      by.set(r.defect, m);
    }
    return foldPareto(
      [...by.entries()].map(([code, m]) => ({ key: code, label: defectName(code), count: m.count, note: `검출: ${[...m.at].map(stationName).join(', ')}` })),
    );
  }, [defects.data]);
  const ngTotal = pareto.reduce((a, b) => a + b.count, 0);

  // 요인 분석 대상: 불량이 난 설비 (많은 순)
  const candidates = useMemo(() => {
    const by = new Map<string, Record<string, number>>();
    for (const r of defects.data ?? []) by.set(r.station, { ...(by.get(r.station) ?? {}), [r.defect]: r.n });
    return line.stations
      .filter((s) => by.has(s.code))
      .map((s) => {
        const d = by.get(s.code)!;
        return { code: s.code, name: s.name, ng: Object.values(d).reduce((a, b) => a + b, 0), defects: d };
      })
      .sort((a, b) => b.ng - a.ng);
  }, [line, defects.data]);
  const [target, setTarget] = useState<{ station: string; defect: string } | null>(null);
  // AI 비서 링크 등으로 설비(와 불량)를 지정해 들어오면 그 설비의 라인으로 바꾸고 그것을 요인 비교 대상으로 둔다
  const setLine = useUi((s) => s.setLine);
  useFocusTarget((f) => {
    if (!f.station || !STATIONS[f.station]) return;
    setLine(STATIONS[f.station].line);
    setTarget({ station: f.station, defect: f.defect ?? '' });
  });
  useEffect(() => {
    // 라인을 막 바꿔 이전 라인 집계가 보이는 동안에는 고르지 않는다
    if (!candidates.length || defects.isPlaceholderData) return;
    const cur = target && candidates.find((c) => c.code === target.station);
    if (cur) {
      if (!target.defect) {
        const d = Object.entries(cur.defects).sort((a, b) => b[1] - a[1])[0]?.[0];
        if (d) setTarget({ station: cur.code, defect: d });
      }
      return;
    }
    const top = candidates[0];
    const d = Object.entries(top.defects).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    setTarget({ station: top.code, defect: d });
  }, [candidates, target, defects.isPlaceholderData]);
  const targetDefects = Object.entries(candidates.find((c) => c.code === target?.station)?.defects ?? {}).sort((a, b) => b[1] - a[1]);

  const factors = useQuery({
    queryKey: ['factors', target?.station, target?.defect],
    queryFn: () => api.get<FactorAnalysis>(`/production/factors/${target!.station}${target!.defect ? `?defect=${encodeURIComponent(target!.defect)}` : ''}`),
    enabled: !!target,
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
  });
  const fa = factors.data;
  const maxD = Math.max(1, ...(fa?.factors ?? []).map((f) => Math.abs(f.effect)));
  // 설비별로 묶어 가장 큰 차이 (원인 설비 후보)
  const byStation = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of fa?.factors ?? []) m.set(f.station, Math.max(m.get(f.station) ?? 0, Math.abs(f.effect)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [fa]);

  const escapes = useQuery({ queryKey: ['escapes'], queryFn: () => api.get<ProcessRecordView[]>('/production/escapes'), refetchInterval: 10_000, placeholderData: keepPreviousData });
  const lineEscapes = (escapes.data ?? []).filter((r) => r.line === lineCode);

  return (
    <PageShell
      title="불량 분석"
      desc="어떤 불량이 많은지(파레토) → 그 불량품이 양품과 무엇이 달랐는지(요인 비교) → 검사를 빠져나간 불량은 없는지(출하 유출) 순서로 봅니다."
      filters={<LineSwitcher />}
    >
      <ChartCard
        title={`불량 파레토 · ${line.name}`}
        subtitle={`실행 시작부터 누계 ${ngTotal.toLocaleString('ko-KR')}건 (MES 공정 기록 기준). 왼쪽부터 80% 선까지의 불량을 먼저 줄이면 효과가 큽니다.`}
        legend={PARETO_LEGEND}
        stale={defects.isFetching && defects.isPlaceholderData}
        table={
          <DataTable
            head={['불량', '건수', '비율', '검출 설비']}
            align={['l', 'r', 'r', 'l']}
            rows={pareto.map((p) => [p.label, p.count, `${((p.count / (ngTotal || 1)) * 100).toFixed(1)}%`, p.note?.replace('검출: ', '') ?? ''])}
          />
        }
      >
        {pareto.length ? (
          <ParetoChart items={pareto} />
        ) : (
          <Empty h={240}>{defects.isLoading ? '불러오는 중…' : defects.error ? (defects.error as Error).message : '아직 불량이 없습니다.'}</Empty>
        )}
      </ChartCard>

      <section className="card mt-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">불량 요인 비교 (불량품 vs 양품)</h2>
            <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-sub">
              한 검사 설비에서 불량 판정을 받은 부품과 같은 시기의 양품을 모아, 그 부품이 앞서 거친 공정과 조립된 하위 부품(다른 라인 포함)의 공정 값을 비교합니다. 차이는 표준화 평균 차(σ 단위)이며 클수록 불량과 함께 움직인
              값입니다. 상관이지 인과의 증명은 아니므로, 후보를 찾은 뒤 계보 추적으로 확인합니다.
            </p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5 text-sub">
            검사 설비
            <select
              value={target?.station ?? ''}
              onChange={(e) => {
                const c = candidates.find((x) => x.code === e.target.value);
                const d = c ? (Object.entries(c.defects).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '') : '';
                setTarget({ station: e.target.value, defect: d });
              }}
              className="rounded border border-line bg-[var(--color-chart)] px-2 py-1 text-ink"
            >
              {candidates.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} {c.name} · 불량 {c.ng}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-sub">
            불량
            <select
              value={target?.defect ?? ''}
              onChange={(e) => target && setTarget({ ...target, defect: e.target.value })}
              className="rounded border border-line bg-[var(--color-chart)] px-2 py-1 text-ink"
            >
              <option value="">전체 불량</option>
              {targetDefects.map(([code, n]) => (
                <option key={code} value={code}>
                  {defectName(code)} · {n}
                </option>
              ))}
            </select>
          </label>
          {fa && (
            <span className="text-dim">
              불량 {fa.ngCount}개 vs 양품 {fa.okCount}개 · {kst(fa.from)} ~ {kst(fa.to)}
            </span>
          )}
        </div>

        {byStation.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-dim">설비별 가장 큰 차이</span>
            {byStation.map(([code, d]) => (
              <span key={code} className={cx('rounded-md border px-2 py-0.5', STATIONS[code]?.line !== lineCode ? 'border-warn/50' : 'border-line')}>
                <span className="num">{code}</span> <span className="text-sub">{stationName(code)}</span> <span className="num text-ink">{d.toFixed(2)}σ</span>
                {STATIONS[code]?.line !== lineCode && <span className="ml-1 text-dim">다른 라인</span>}
              </span>
            ))}
          </div>
        )}

        <div className={cx('mt-2 transition-opacity', factors.isFetching && factors.isPlaceholderData && 'opacity-60')}>
          {!candidates.length ? (
            <Empty h={140}>이 라인에는 아직 불량이 없습니다. 위쪽 '이상 시나리오'를 켜 보세요.</Empty>
          ) : factors.isLoading ? (
            <Empty h={140}>계보를 따라 공정 기록을 모으는 중…</Empty>
          ) : factors.error ? (
            <Empty h={140}>{(factors.error as Error).message}</Empty>
          ) : !fa || fa.factors.length === 0 ? (
            <Empty h={140}>
              비교할 표본이 부족합니다 (불량 {fa?.ngCount ?? 0}개 · 양품 {fa?.okCount ?? 0}개, 각각 5개 이상 필요).
              <br />
              시간이 지나 불량이 더 쌓이면 다시 계산합니다.
            </Empty>
          ) : (
            <>
              {fa.lots.length > 0 && <LotSkewBox lots={fa.lots} ngCount={fa.ngCount} okCount={fa.okCount} top={fa.factors[0]} />}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-1.5 text-[11px] text-dim">
                <span>순위 · 값 · 설비 · 출처</span>
                <span className="flex items-center gap-3">
                  <span className="flex items-center gap-1.5">
                    <Key color={C.series} /> 차이 크기 (|σ|)
                  </span>
                  {BOX_LEGEND.map((b) => (
                    <span key={b.label} className="flex items-center gap-1.5">
                      <Key color={b.color} /> {b.label} 분포
                    </span>
                  ))}
                </span>
              </div>
              <ol>
                {fa.factors.map((f, i) => (
                  <FactorRow key={`${f.station}.${f.key}`} f={f} rank={i + 1} line={lineCode} maxD={maxD} />
                ))}
              </ol>
              <p className="mt-2 text-[11px] text-dim">
                계산 입력이 적힌 값은 앞 공정 값으로 계산되는 중간 속성입니다. 그 입력을 따라가면 원인 설비에 닿습니다. 판정 설비 자신의 검사값(증상)은 비교에서 뺐습니다.
              </p>
            </>
          )}
        </div>
      </section>

      <ChartCard
        className="mt-3"
        title={`출하 유출 · ${line.name}`}
        subtitle="최종 검사를 양품으로 통과했지만 시뮬레이터가 잠재 불량을 알고 있는 제품입니다. 실제 공장에서는 고객 클레임으로 늦게 드러나며, 검사 공정의 검출력을 점검하는 근거가 됩니다."
      >
        {lineEscapes.length ? (
          <DataTable
            head={['시각', '시리얼', '품목', '최종 설비', '잠재 불량']}
            rows={lineEscapes.slice(0, 50).map((r) => [
              kst(r.endedAt),
              <button key={r.serial} className="num text-info hover:underline" onClick={() => openTrace(r.serial)}>
                {r.serial}
              </button>,
              ITEM_NAMES[r.item] ?? r.item,
              `${r.station} ${stationName(r.station)}`,
              r.escaped.map(defectName).join(', '),
            ])}
          />
        ) : (
          <Empty h={70}>이 라인에서 확인된 출하 유출이 없습니다.</Empty>
        )}
      </ChartCard>
    </PageShell>
  );
}
