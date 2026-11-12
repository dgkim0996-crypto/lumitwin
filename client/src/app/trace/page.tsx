'use client';

import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FACTORY, LINES, type LineCode, type LotQuality, type LotTrace, type ProductionUnitView, type TraceNode } from '@lumitwin/shared';
import { C, ChartCard, DataTable, Empty } from '@/components/charts/kit';
import { SegmentedBar } from '@/components/charts/small';
import { StatusBadge, TraceTree, UNIT_STATUS } from '@/components/hud/TraceDialog';
import { LineSwitcher, PageShell, Stat } from '@/components/mes/PageShell';
import { api } from '@/lib/api';
import { cx, kst, pct } from '@/lib/format';
import { useLive } from '@/lib/live';
import { ITEM_NAMES, stationName } from '@/lib/names';
import { useFocusTarget, useUi } from '@/lib/ui';

const LOT_RE = /^([A-Z0-9_]+)-\d{6}-\d{3}$/;
/** 이만큼은 판정이 끝나야 LOT 불량률을 비교한다 */
const MIN_JUDGED = 20;
/** 다른 LOT 평균보다 이만큼(표준오차 배수) 높으면 편중 의심 */
const FLAG_Z = 3;
const ROWS = 60;

const MATERIAL_NAME = Object.fromEntries(FACTORY.materials.map((m) => [m.code, m.name]));
/** 자재 → 그 자재를 쓰는 라인 */
const MATERIAL_LINE: Record<string, LineCode> = {};
for (const l of LINES) for (const s of l.steps) for (const i of s.inputs) if (i.material) MATERIAL_LINE[i.material] ??= l.code;

const TOP_STATUS = [
  { key: 'DONE', label: '완성 (출하됐을 수 있음 → 회수 검토)', color: C.series },
  { key: 'NG', label: '불량 판정', color: C.ng },
  { key: 'WIP', label: '공정 중 (격리 대상)', color: '#7b8798' },
  { key: 'ETC', label: '기록 없음', color: '#3a4555' },
] as const;

interface LotRow extends LotQuality {
  judged: number;
  rate: number | null;
  /** 이 LOT를 뺀 같은 자재 LOT들의 불량률 */
  others: number | null;
  z: number | null;
  flag: boolean;
  /** 같은 라인에서 사용 기간이 겹치는 더 강한 편중 LOT. 있으면 이 LOT의 높은 불량률은 그 LOT 때문일 수 있다 */
  shadow: string | null;
}

/** 같은 자재의 다른 LOT와 비교한다: 다른 LOT를 합친 불량률 대비 이 LOT 불량률의 표준오차 배수 */
function analyze(rows: LotQuality[]): { rows: LotRow[]; avg: number | null } {
  const totNg = rows.reduce((a, r) => a + r.ng, 0);
  const totJ = rows.reduce((a, r) => a + r.ng + r.done, 0);
  const out = rows.map((r) => {
    const judged = r.ng + r.done;
    const rate = judged ? r.ng / judged : null;
    const oj = totJ - judged;
    const others = oj > 0 ? (totNg - r.ng) / oj : null;
    let z: number | null = null;
    if (rate != null && others != null && judged >= MIN_JUDGED) {
      const p = Math.max(others, 0.5 / oj); // 다른 LOT에 불량이 하나도 없어도 0으로 나누지 않게
      z = (rate - p) / Math.sqrt((p * (1 - p)) / judged);
    }
    return { ...r, judged, rate, others, z, flag: z != null && z >= FLAG_Z && r.ng >= 5, shadow: null };
  });
  return { rows: out, avg: totJ ? totNg / totJ : null };
}

/**
 * 시간 교란 거르기: 불량 LOT 하나가 들어온 동안에는 그때 함께 쓴 다른 자재 LOT도 불량률이 오른다.
 * 같은 라인에서 사용 기간이 겹치고 z가 더 큰 편중 LOT가 있으면, 약한 쪽은 그 LOT의 그림자로 표시한다.
 */
function markShadows(groups: Map<string, { rows: LotRow[] }>) {
  const flagged = [...groups.values()].flatMap((g) => g.rows.filter((r) => r.flag)).sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
  const span = (r: LotRow) => [Date.parse(r.firstUsedAt), Date.parse(r.lastUsedAt)] as const;
  for (const [i, r] of flagged.entries()) {
    const [a0, a1] = span(r);
    const strong = flagged
      .slice(0, i)
      .find((s) => s.material !== r.material && !s.shadow && MATERIAL_LINE[s.material] === MATERIAL_LINE[r.material] && span(s)[0] <= a1 && a0 <= span(s)[1]);
    if (strong) r.shadow = strong.lot;
  }
}
const isSuspect = (r: LotRow) => r.flag && !r.shadow;

function downloadCsv(name: string, head: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = '﻿' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: readonly (readonly [T, string])[] }) {
  return (
    <div className="flex overflow-hidden rounded border border-line text-xs">
      {items.map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)} aria-pressed={value === k} className={cx('px-2 py-0.5', value === k ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}>
          {label}
        </button>
      ))}
    </div>
  );
}

export default function TracePage() {
  const line = useUi((s) => s.line);
  const setLine = useUi((s) => s.setLine);
  const openTrace = useLive((s) => s.openTrace);
  const [serial, setSerial] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'NG' | 'DONE'>('NG');
  // 사용자가 고른 자재·LOT. 고르기 전에는 편중 의심이 있는 것을 자동으로 보여 준다
  const [pickedMaterial, setPickedMaterial] = useState<string | null>(null);
  const [pickedLot, setPickedLot] = useState<string | null>(null);
  const lotBox = useRef<HTMLDivElement>(null);
  const genealogy = useRef<HTMLDivElement>(null);

  // ── 제품 목록과 계보 ──
  const units = useQuery({
    queryKey: ['units', line, tab],
    queryFn: () => api.get<ProductionUnitView[]>(`/production/units?line=${line}&status=${tab}&limit=40`),
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });
  useEffect(() => setSerial(null), [line]);
  useEffect(() => {
    if (!serial && units.data?.length) setSerial(units.data[0].serial);
  }, [serial, units.data]);

  const trace = useQuery({
    queryKey: ['trace', serial],
    queryFn: () => api.get<TraceNode>(`/production/trace/${encodeURIComponent(serial!)}`),
    enabled: !!serial,
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });
  const up = useQuery({
    queryKey: ['ancestors', serial],
    queryFn: () => api.get<string[]>(`/production/ancestors/${encodeURIComponent(serial!)}`),
    enabled: !!serial,
    refetchInterval: 10_000,
  });
  const missing = trace.data && !trace.data.records.length && !trace.data.children.length && !trace.data.status;

  // ── LOT 품질 ──
  const lq = useQuery({ queryKey: ['lot-quality'], queryFn: () => api.get<LotQuality[]>('/production/lot-quality'), refetchInterval: 10_000, placeholderData: keepPreviousData });
  const byMaterial = useMemo(() => {
    const g = new Map<string, LotQuality[]>();
    for (const r of lq.data ?? []) g.set(r.material, [...(g.get(r.material) ?? []), r]);
    const out = new Map([...g].map(([m, rows]) => [m, analyze(rows)]));
    markShadows(out);
    return out;
  }, [lq.data]);
  const lineMaterials = useMemo(() => FACTORY.materials.filter((m) => MATERIAL_LINE[m.code] === line).map((m) => m.code), [line]);
  const material =
    pickedMaterial && MATERIAL_LINE[pickedMaterial] === line
      ? pickedMaterial
      : (lineMaterials.find((m) => byMaterial.get(m)?.rows.some(isSuspect)) ?? lineMaterials[0] ?? null);
  const cur = material ? byMaterial.get(material) : undefined;
  const lot = pickedLot && material && pickedLot.startsWith(`${material}-`) ? pickedLot : ((cur?.rows.find(isSuspect) ?? cur?.rows[0])?.lot ?? null);
  const pickMaterial = (m: string) => {
    setPickedMaterial(m);
    setPickedLot(null);
  };
  const scaleMax = useMemo(() => {
    const m = Math.max(0.02, ...(cur?.rows ?? []).map((r) => r.rate ?? 0), (cur?.avg ?? 0) * 2);
    return Math.min(1, Math.ceil(m * 20) / 20);
  }, [cur]);

  const detail = useQuery({
    queryKey: ['lot', lot],
    queryFn: () => api.get<LotTrace>(`/production/lots/${encodeURIComponent(lot!)}`),
    enabled: !!lot,
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });

  /** LOT 번호면 LOT 품질로, 아니면 시리얼 계보로 */
  const go = (raw: string) => {
    const q = raw.trim().toUpperCase();
    if (!q) return;
    const m = LOT_RE.exec(q);
    if (m && MATERIAL_NAME[m[1]]) {
      if (MATERIAL_LINE[m[1]]) setLine(MATERIAL_LINE[m[1]]);
      setPickedMaterial(m[1]);
      setPickedLot(q);
      setTimeout(() => lotBox.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    } else {
      setSerial(q);
      genealogy.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
  const search = () => go(query);
  // 다른 화면에서 /trace?lot=… ?serial=… ?material=… 로 들어오거나(불량 분석의 LOT 편중, AI 비서 링크) 화면 안에서 링크를 누르면 그것을 연다
  useFocusTarget((f) => {
    const target = f.lot ?? f.serial;
    if (target) {
      setQuery(target);
      go(target);
    } else if (f.material && MATERIAL_NAME[f.material]) {
      if (MATERIAL_LINE[f.material]) setLine(MATERIAL_LINE[f.material]);
      pickMaterial(f.material);
      setTimeout(() => lotBox.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
  });

  return (
    <PageShell
      title="추적 (시리얼·LOT)"
      desc="제품 하나의 부품 계보를 아래로(정추적)·위로(역추적) 따라가고, 자재 LOT 단위로 불량률을 비교해 회수 범위를 뽑습니다. 모두 MES에 쌓인 공정 기록에서 계산합니다."
      filters={
        <>
          <LineSwitcher />
          <form
            className="ml-auto flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="시리얼 또는 LOT 번호"
              aria-label="시리얼 또는 LOT 번호 검색"
              className="num h-8 w-64 rounded-md border border-line bg-white/5 px-2 text-sm outline-none placeholder:text-dim focus:border-info/60"
            />
            <button className="h-8 rounded-md border border-line bg-white/5 px-3 text-sm hover:bg-white/10">조회</button>
          </form>
        </>
      }
    >
      <div className="grid gap-3 @6xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <ChartCard
          title="최근 제품"
          subtitle={`${LINES.find((l) => l.code === line)?.name} · 마지막 공정 시각 순 · 누르면 오른쪽에 계보를 엽니다`}
          right={
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                ['NG', '불량'],
                ['DONE', '완성'],
              ]}
            />
          }
          stale={units.isFetching && units.isPlaceholderData}
        >
          {units.data?.length ? (
            <div className="scroll-thin max-h-[300px] overflow-auto @6xl:max-h-[520px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[var(--color-chart)] text-dim">
                  <tr className="border-b border-line">
                    <th className="py-1.5 pr-2 text-left font-normal">시리얼 · 품목</th>
                    <th className="px-2 text-left font-normal">판정</th>
                    <th className="px-2 text-left font-normal">마지막 설비</th>
                    <th className="pl-2 text-right font-normal">시각</th>
                  </tr>
                </thead>
                <tbody>
                  {units.data.map((u) => (
                    <tr
                      key={u.serial}
                      onClick={() => {
                        setSerial(u.serial);
                        // 한 줄 배치(1280px 미만)에서는 계보가 목록 아래에 있으므로 그쪽으로 내려 준다
                        if (!window.matchMedia('(min-width: 1280px)').matches) genealogy.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                      className={cx('cursor-pointer border-b border-line/60 whitespace-nowrap', u.serial === serial ? 'bg-info/10' : 'hover:bg-white/[0.04]')}
                    >
                      <td className="py-1 pr-2">
                        <span className="num block font-semibold">{u.serial}</span>
                        <span className="block text-[11px] text-dim">{ITEM_NAMES[u.item] ?? u.item}</span>
                      </td>
                      <td className="px-2">
                        <StatusBadge status={u.status} defect={u.defect} />
                      </td>
                      <td className="num px-2 text-sub" title={stationName(u.lastStation)}>
                        {u.lastStation}
                      </td>
                      <td className="num pl-2 text-right text-dim">{kst(u.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>{units.isLoading ? '불러오는 중…' : units.error ? (units.error as Error).message : tab === 'NG' ? '이 라인에서 불량 판정된 제품이 아직 없습니다.' : '아직 완성된 제품이 없습니다.'}</Empty>
          )}
        </ChartCard>

        <div ref={genealogy} className="scroll-mt-2">
          <ChartCard
            title={serial ? <span className="num">{serial} 계보</span> : '제품 계보'}
            subtitle="거친 공정의 조건·판정과 들어간 부품을 아래로 따라갑니다. 시리얼을 누르면 그 부품으로 옮겨 갑니다."
            right={
              serial && (
                <button className="rounded border border-line px-2 py-0.5 text-xs text-sub hover:bg-white/10 hover:text-ink" onClick={() => openTrace(serial)}>
                  창으로 보기
                </button>
              )
            }
            stale={trace.isFetching && trace.isPlaceholderData}
          >
            {up.data && up.data.length > 0 && (
              <div className="mb-2 rounded-md border border-line bg-white/[0.03] px-3 py-2 text-xs text-sub">
                역추적: 이 부품은{' '}
                {up.data.map((s, i) => (
                  <span key={s}>
                    {i > 0 && ' → '}
                    <button className="num text-info hover:underline" onClick={() => setSerial(s)}>
                      {s}
                    </button>
                  </span>
                ))}
                에 조립되었습니다
              </div>
            )}
            {!serial ? (
              <Empty h={240}>왼쪽 목록에서 제품을 고르거나 위 검색 칸에 시리얼을 넣으세요.</Empty>
            ) : trace.error ? (
              <Empty h={240}>{(trace.error as Error).message}</Empty>
            ) : missing ? (
              <Empty h={240}>
                이 실행에서 <span className="num mx-1 text-ink">{serial}</span> 기록을 찾지 못했습니다.
              </Empty>
            ) : trace.data ? (
              <div className="scroll-thin max-h-[520px] overflow-y-auto pr-1">
                <TraceTree n={trace.data} onPick={setSerial} full />
              </div>
            ) : (
              <Empty h={240}>불러오는 중…</Empty>
            )}
          </ChartCard>
        </div>
      </div>

      <div ref={lotBox} className="mt-3 scroll-mt-2">
        <ChartCard
          title="자재 LOT 품질"
          subtitle={
            <>
              LOT를 쓴 부품을 조립된 상위 제품까지 따라가 판정을 모읍니다. 불량률 = 불량 ÷ 판정 끝난 수(공정 중 제외). 같은 자재의 다른 LOT들보다 통계적으로 높으면(표준오차 {FLAG_Z}배 이상, 판정{' '}
              {MIN_JUDGED}개 이상) <b className="text-ink">편중 의심</b>으로 표시합니다. 불량 LOT나 설비 이상이 있던 시기에는 그때 함께 쓴 다른 자재 LOT도 불량률이 오르므로(시간 교란), 같은 라인에서 기간이 겹치는 더 강한 편중 LOT가 있으면 &lsquo;그 영향일 수 있음&rsquo;으로 낮춰 표시합니다.
            </>
          }
          stale={lq.isFetching && lq.isPlaceholderData}
        >
          <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="자재 선택">
            {lineMaterials.map((m) => {
              const a = byMaterial.get(m);
              const flagged = a?.rows.filter(isSuspect).length ?? 0;
              return (
                <button
                  key={m}
                  role="tab"
                  aria-selected={m === material}
                  onClick={() => pickMaterial(m)}
                  className={cx('rounded-md border px-2.5 py-1 text-left text-xs', m === material ? 'border-info/60 bg-info/10' : 'border-line bg-white/[0.03] hover:bg-white/[0.07]')}
                >
                  <span className="block font-medium text-ink">{MATERIAL_NAME[m]}</span>
                  <span className="num block text-[11px] text-sub">
                    {m} · LOT {a?.rows.length ?? 0}개{a?.avg != null && ` · 불량률 ${pct(a.avg)}`}
                    {flagged > 0 && <span className="ml-1 text-warn">⚠ 편중 의심 {flagged}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          {cur?.rows.length ? (
            <div className="scroll-thin max-h-[360px] overflow-auto">
              <table className="w-full min-w-[820px] text-xs">
                <thead className="sticky top-0 bg-[var(--color-chart)] text-dim">
                  <tr className="border-b border-line">
                    <th className="py-1.5 pr-2 text-left font-normal">LOT (최근이 위)</th>
                    <th className="px-2 text-left font-normal">사용 기간</th>
                    <th className="px-2 text-right font-normal">부품</th>
                    <th className="px-2 text-right font-normal">판정 끝</th>
                    <th className="px-2 text-right font-normal">불량</th>
                    <th className="w-[30%] px-2 text-left font-normal">
                      불량률 <span className="text-dim">(점선 = 이 자재 전체 {pct(cur.avg ?? undefined)})</span>
                    </th>
                    <th className="pl-2 text-left font-normal">비교</th>
                  </tr>
                </thead>
                <tbody>
                  {cur.rows.map((r) => (
                    <tr key={r.lot} onClick={() => setPickedLot(r.lot)} className={cx('cursor-pointer border-b border-line/60', r.lot === lot ? 'bg-info/10' : 'hover:bg-white/[0.04]')}>
                      <td className="num py-1.5 pr-2 font-semibold whitespace-nowrap">{r.lot}</td>
                      <td className="num px-2 whitespace-nowrap text-sub">
                        {kst(r.firstUsedAt, true)} ~ {kst(r.lastUsedAt)}
                      </td>
                      <td className="num px-2 text-right">{r.parts.toLocaleString('ko-KR')}</td>
                      <td className="num px-2 text-right text-sub">{r.judged.toLocaleString('ko-KR')}</td>
                      <td className="num px-2 text-right">{r.ng}</td>
                      <td className="px-2">
                        <div className="flex items-center gap-2">
                          <span className="num w-12 text-right text-ink">{r.rate == null ? '-' : pct(r.rate)}</span>
                          <div className="relative h-2.5 flex-1 rounded-sm bg-white/[0.04]" aria-hidden>
                            {r.rate != null && (
                              <div
                                className="absolute inset-y-0 left-0 rounded-r"
                                style={{ width: `${Math.min(100, (r.rate / scaleMax) * 100)}%`, background: isSuspect(r) ? C.ng : C.series, opacity: r.judged < MIN_JUDGED ? 0.45 : 1 }}
                              />
                            )}
                            {cur.avg != null && <div className="absolute -inset-y-1 border-l border-dashed" style={{ left: `${(cur.avg / scaleMax) * 100}%`, borderColor: C.sub }} />}
                          </div>
                        </div>
                      </td>
                      <td className="pl-2 whitespace-nowrap">
                        {isSuspect(r) ? (
                          <span className="text-warn">⚠ 편중 의심 · 다른 LOT {pct(r.others ?? undefined)}{r.others ? `의 ${(r.rate! / r.others).toFixed(1)}배` : ' 대비 높음'}</span>
                        ) : r.shadow ? (
                          <span className="text-sub" title="이 LOT를 쓴 기간에 다른 자재의 불량 LOT도 함께 쓰였습니다. 높은 불량률은 그 LOT 때문일 수 있습니다.">
                            높지만 같은 시기{' '}
                            <button
                              className="num text-info hover:underline"
                              onClick={(e) => {
                                e.stopPropagation();
                                pickMaterial(r.shadow!.slice(0, r.shadow!.indexOf('-')));
                                setPickedLot(r.shadow);
                              }}
                            >
                              {r.shadow}
                            </button>{' '}
                            영향일 수 있음
                          </span>
                        ) : r.judged < MIN_JUDGED ? (
                          <span className="text-dim">판정 부족 (공정 중)</span>
                        ) : (
                          <span className="text-sub">다른 LOT와 비슷</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>{lq.isLoading ? '불러오는 중…' : lq.error ? (lq.error as Error).message : '이 자재를 쓴 기록이 아직 없습니다.'}</Empty>
          )}
        </ChartCard>
      </div>

      <LotDetail lot={lot} q={detail} />
    </PageShell>
  );
}

function LotDetail({ lot, q }: { lot: string | null; q: UseQueryResult<LotTrace> }) {
  const openTrace = useLive((s) => s.openTrace);
  const [filter, setFilter] = useState<'ALL' | 'DONE' | 'NG' | 'WIP'>('ALL');
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [lot, filter]);
  const d = q.data;
  const groups = useMemo(() => {
    const g: Record<string, number> = { DONE: 0, NG: 0, WIP: 0, ETC: 0 };
    for (const f of d?.finished ?? []) g[f.status === 'DONE' || f.status === 'NG' || f.status === 'WIP' ? f.status : 'ETC']++;
    return g;
  }, [d]);
  if (!lot) return null;
  const list = (d?.finished ?? []).filter((f) => filter === 'ALL' || f.status === filter);
  const shown = more ? list : list.slice(0, ROWS);
  const head = ['제품 시리얼', '품목', '라인', '판정', '이 LOT 부품 수', '마지막 공정 시각'];
  return (
    <ChartCard
      className="mt-3"
      title={
        <>
          LOT 상세 · <span className="num">{lot}</span>
        </>
      }
      subtitle="이 LOT를 쓴 부품이 조립돼 들어간 맨 위 제품입니다. 완성품은 이미 출하됐을 수 있어 회수 검토 대상, 공정 중인 것은 격리(출하 보류) 대상이 됩니다."
      legend={TOP_STATUS.filter((s) => groups[s.key] > 0).map((s) => ({ label: s.label, color: s.color, shape: 'rect' as const }))}
      right={
        d && (
          <button
            className="rounded border border-line px-2 py-0.5 text-xs text-sub hover:bg-white/10 hover:text-ink"
            onClick={() =>
              downloadCsv(
                `${lot}-영향제품.csv`,
                head,
                list.map((f) => [f.serial, (f.item && ITEM_NAMES[f.item]) ?? f.item ?? '', f.line ?? '', f.status ? (UNIT_STATUS[f.status] ?? f.status) : '', f.parts, f.lastAt ?? '']),
              )
            }
          >
            CSV 내려받기
          </button>
        )
      }
      stale={q.isFetching && q.isPlaceholderData}
    >
      {q.error ? (
        <Empty>{(q.error as Error).message}</Empty>
      ) : !d ? (
        <Empty>불러오는 중…</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4">
            <Stat label="자재" value={<span className="text-base">{d.material ? (MATERIAL_NAME[d.material] ?? d.material) : '-'}</span>} sub={d.material ?? undefined} />
            <Stat label="쓴 부품" value={`${d.parts.toLocaleString('ko-KR')}개`} sub={d.byStation.map((s) => `${stationName(s.station)} ${s.parts}`).join(' · ')} />
            <Stat label="사용 기간" value={<span className="num text-base">{kst(d.firstUsedAt, true)}</span>} sub={`~ ${kst(d.lastUsedAt, true)}`} />
            <Stat label="영향 제품" value={`${d.finished.length.toLocaleString('ko-KR')}개`} sub={`완성 ${groups.DONE} · 불량 ${groups.NG} · 공정 중 ${groups.WIP}`} />
          </div>
          <div className="mt-3">
            <SegmentedBar
              label={`${lot} 영향 제품 판정`}
              height={10}
              parts={TOP_STATUS.map((s) => ({ key: s.key, label: s.label, color: s.color, value: groups[s.key] }))}
              format={(v) => `${v}개`}
            />
          </div>
          <div className="mt-3 mb-2 flex items-center justify-between gap-2">
            <Tabs
              value={filter}
              onChange={setFilter}
              items={[
                ['ALL', `전체 ${d.finished.length}`],
                ['DONE', `완성 ${groups.DONE}`],
                ['NG', `불량 ${groups.NG}`],
                ['WIP', `공정 중 ${groups.WIP}`],
              ]}
            />
            <span className="text-[11px] text-dim">시리얼을 누르면 이력 창이 열립니다</span>
          </div>
          {list.length ? (
            <>
              <DataTable
                head={head}
                align={['l', 'l', 'l', 'l', 'r', 'r']}
                rows={shown.map((f) => [
                  <button key="s" className="num font-semibold text-info hover:underline" onClick={() => openTrace(f.serial)}>
                    {f.serial}
                  </button>,
                  <span key="i" className="text-sub">
                    {(f.item && ITEM_NAMES[f.item]) ?? f.item ?? '-'}
                  </span>,
                  f.line ?? '-',
                  <StatusBadge key="st" status={f.status} defect={f.defect} />,
                  f.parts,
                  kst(f.lastAt, true),
                ])}
              />
              {list.length > shown.length && (
                <button className="mt-2 text-xs text-info hover:underline" onClick={() => setMore(true)}>
                  {list.length - shown.length}개 더 보기
                </button>
              )}
            </>
          ) : (
            <Empty h={80}>해당하는 제품이 없습니다.</Empty>
          )}
        </>
      )}
    </ChartCard>
  );
}
