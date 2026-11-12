'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { LINES, type StationState } from '@lumitwin/shared';
import { ColumnChart, type ColumnDatum } from '@/components/charts/ColumnChart';
import { C, ChartCard, DataTable, Empty } from '@/components/charts/kit';
import { Meter, SegmentedBar } from '@/components/charts/small';
import { LineSwitcher, PageShell, Stat } from '@/components/mes/PageShell';
import { api } from '@/lib/api';
import { cx, duration, pct, STATE_COLOR, STATE_LABEL } from '@/lib/format';
import { useLive } from '@/lib/live';
import { useUi } from '@/lib/ui';

interface HourRow {
  hour: string;
  station: string;
  ok: number;
  ng: number;
}

const HOUR = 3600_000;
const KST = 9 * HOUR;
const SHOW_HOURS = 24;
const STATE_ORDER: StationState[] = ['RUN', 'IDLE', 'BLOCKED', 'SETUP', 'DOWN', 'STOP'];
const hourLabel = (ms: number) => `${new Date(ms + KST).getUTCHours()}시`;
const hourTitle = (ms: number) => {
  const d = new Date(ms + KST);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours()}:00 ~ ${d.getUTCHours() + 1}:00`;
};

const SERIES = [
  { label: '완성 (최종 공정 양품)', color: C.series },
  { label: '불량 (라인 전체)', color: C.ng },
];

export default function ProductionPage() {
  const lineCode = useUi((s) => s.line);
  const line = LINES.find((l) => l.code === lineCode)!;
  const lv = useLive((s) => s.lines[lineCode]);
  const stations = useLive((s) => s.stations);
  const simT = useLive((s) => s.sim?.t);
  const select = useLive((s) => s.select);
  const router = useRouter();
  const [sort, setSort] = useState<'flow' | 'oee'>('flow');

  const hourly = useQuery({
    queryKey: ['hourly', lineCode],
    queryFn: () => api.get<HourRow[]>(`/production/hourly/${lineCode}`),
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });

  const target = 3600 / line.taktSec;
  const columns = useMemo<ColumnDatum[]>(() => {
    const rows = hourly.data ?? [];
    if (!rows.length) return [];
    const finals = new Set(line.stations.filter((s) => s.step === line.finalStep).map((s) => s.code));
    const by = new Map<number, { done: number; ng: number }>();
    for (const r of rows) {
      const k = Date.parse(r.hour);
      const m = by.get(k) ?? { done: 0, ng: 0 };
      if (finals.has(r.station)) m.done += r.ok;
      m.ng += r.ng;
      by.set(k, m);
    }
    const keys = [...by.keys()].sort((a, b) => a - b);
    const now = simT ? Date.parse(simT) : keys[keys.length - 1] + HOUR;
    const out: ColumnDatum[] = [];
    // 비어 있는 시간도 0으로 채운다 (고장으로 한 개도 못 만든 시간이 빠지지 않게)
    for (let k = Math.max(keys[0], keys[keys.length - 1] - (SHOW_HOURS - 1) * HOUR); k <= keys[keys.length - 1]; k += HOUR) {
      const m = by.get(k) ?? { done: 0, ng: 0 };
      out.push({ label: hourLabel(k), title: hourTitle(k), values: [m.done, m.ng], partial: k + HOUR > now });
    }
    return out;
  }, [hourly.data, line, simT]);

  const rows = useMemo(() => {
    const list = line.stations.map((def, idx) => {
      const st = stations[def.code];
      const sec = st?.stateSec ?? {};
      // 실제로 일한 시간 비율 = 가동률 × 성능. 터널형 설비는 비어 있어도 상태가 RUN이라 RUN 시간 비율로는 못 잰다
      const busy = st ? st.oee.availability * st.oee.performance : 0;
      return { def, idx, st, sec, busy };
    });
    if (sort === 'oee') list.sort((a, b) => (a.st?.oee.oee ?? 1) - (b.st?.oee.oee ?? 1));
    return list;
  }, [line, stations, sort]);
  const busiest = rows.reduce<(typeof rows)[number] | null>((best, r) => (r.def.cycle > 0 && (!best || r.busy > best.busy) ? r : best), null);

  const running = line.stations.filter((s) => stations[s.code]?.state === 'RUN').length;
  const down = lv?.downStations.length ?? 0;
  const finished = columns.filter((c) => !c.partial);
  const avgDone = finished.length ? finished.reduce((a, c) => a + c.values[0], 0) / finished.length : null;

  return (
    <PageShell title="생산 현황" desc="라인별 실적과 OEE. 설비 데이터(MQTT)를 MES가 실시간으로 모은 값이고, 시간대별 막대는 DB에 쌓인 공정 기록에서 다시 계산합니다." filters={<LineSwitcher />}>
      <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-5">
        <Stat label="완성 누계" value={(lv?.output ?? 0).toLocaleString('ko-KR')} sub={`${line.product.name} · 불량 ${lv?.ng ?? 0}건`} />
        <Stat label="최근 1시간 실적" value={`${lv?.lastHour ?? 0}개`} sub={`목표 ${target.toFixed(0)}개/h (택트 ${line.taktSec}초)`}>
          <Meter value={(lv?.lastHour ?? 0) / target} />
        </Stat>
        <Stat label="OEE (종합 설비 효율)" value={pct(lv?.oee.oee)} sub={`가동률 ${pct(lv?.oee.availability, 0)} · 성능 ${pct(lv?.oee.performance, 0)} · 양품률 ${pct(lv?.oee.quality, 0)}`}>
          <Meter value={lv?.oee.oee ?? 0} />
        </Stat>
        <Stat label="FPY (직행률)" value={pct(lv?.fpy)} sub="공정별 양품률의 곱 · 재작업 없이 한 번에 통과한 비율" />
        <Stat label="설비 상태" value={`${running} / ${line.stations.length} 가동`} sub={down ? `고장 ${down}대: ${lv!.downStations.join(', ')}` : '고장 설비 없음'} />
      </div>

      <ChartCard
        className="mt-3"
        title="시간대별 생산"
        subtitle={
          <>
            가상 시각 1시간 단위 · 점선은 목표({target.toFixed(0)}개/h) · 흐린 막대는 아직 진행 중인 시간
            {avgDone != null && ` · 마감된 시간 평균 ${avgDone.toFixed(1)}개 (목표의 ${Math.round((avgDone / target) * 100)}%)`}
          </>
        }
        legend={SERIES.map((s) => ({ ...s, shape: 'rect' as const }))}
        stale={hourly.isFetching && hourly.isPlaceholderData}
        table={
          <DataTable
            head={['시간', '완성', '불량', '목표 대비']}
            align={['l', 'r', 'r', 'r']}
            rows={[...columns].reverse().map((c) => [c.title + (c.partial ? ' (진행 중)' : ''), c.values[0], c.values[1], `${Math.round((c.values[0] / target) * 100)}%`])}
          />
        }
      >
        {columns.length ? (
          <ColumnChart data={columns} series={SERIES} target={{ value: target, label: `목표 ${target.toFixed(0)}` }} unit="개" />
        ) : (
          <Empty h={220}>{hourly.isLoading ? '불러오는 중…' : hourly.error ? (hourly.error as Error).message : '아직 기록이 없습니다. 시뮬레이터가 돌면 1초마다 DB에 쌓입니다.'}</Empty>
        )}
      </ChartCard>

      <ChartCard
        className="mt-3"
        title="설비별 OEE와 가동 상태"
        subtitle="막대는 실행 시작부터 누적한 상태 시간 구성입니다. 뒤 설비들의 OEE가 낮은 것은 대개 앞에서 부품이 안 와서(투입 대기)이므로, 가동률이 떨어진 앞 설비부터 봅니다."
        legend={STATE_ORDER.map((s) => ({ label: STATE_LABEL[s], color: STATE_COLOR[s], shape: 'rect' as const }))}
        right={
          <div className="flex overflow-hidden rounded border border-line text-xs">
            {(
              [
                ['flow', '공정 순서'],
                ['oee', 'OEE 낮은 순'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} onClick={() => setSort(k)} aria-pressed={sort === k} className={cx('px-2 py-0.5', sort === k ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}>
                {label}
              </button>
            ))}
          </div>
        }
      >
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[920px] text-xs">
            <thead className="text-dim">
              <tr className="border-b border-line">
                <th className="py-1.5 pr-2 text-left font-normal">설비</th>
                <th className="px-2 text-left font-normal">현재</th>
                <th className="w-[26%] px-2 text-left font-normal">상태 시간 구성</th>
                <th className="w-[14%] px-2 text-left font-normal">OEE</th>
                <th className="px-2 text-right font-normal">가동률</th>
                <th className="px-2 text-right font-normal">성능</th>
                <th className="px-2 text-right font-normal">양품률</th>
                <th className="px-2 text-right font-normal">처리</th>
                <th className="px-2 text-right font-normal">불량</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ def, st, sec, busy }) => {
                const state = st?.state ?? 'IDLE';
                return (
                  <tr key={def.code} className="border-b border-line/60 align-middle hover:bg-white/[0.03]">
                    <td className="py-1.5 pr-2">
                      <button
                        className="text-left hover:underline"
                        title="3D 공장에서 이 설비 보기"
                        onClick={() => {
                          select(def.code);
                          router.push('/');
                        }}
                      >
                        <span className="num font-semibold">{def.code}</span> <span className="text-sub">{def.name}</span>
                      </button>
                      {busiest?.def.code === def.code && busy > 0.5 && (
                        <span className="ml-1.5 rounded border border-line px-1 text-[10px] text-sub" title="가동률 × 성능이 가장 높은 설비: 쉬지 않고 일하는데도 뒤 공정을 못 따라가면 이 설비가 라인 속도를 정한다">
                          병목 후보 · 실가동 {Math.round(busy * 100)}%
                        </span>
                      )}
                    </td>
                    <td className="px-2 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="size-2 rounded-full" style={{ background: STATE_COLOR[state] }} />
                        {STATE_LABEL[state]}
                      </span>
                    </td>
                    <td className="px-2">
                      <SegmentedBar
                        label={`${def.code} 상태 시간`}
                        parts={STATE_ORDER.map((s) => ({ key: s, label: STATE_LABEL[s], color: STATE_COLOR[s], value: sec[s] ?? 0 }))}
                        format={duration}
                      />
                    </td>
                    <td className="px-2">
                      <div className="flex items-center gap-2">
                        <span className="num w-12 text-right text-ink">{pct(st?.oee.oee)}</span>
                        <Meter value={st?.oee.oee ?? 0} />
                      </div>
                    </td>
                    <td className="num px-2 text-right text-sub">{pct(st?.oee.availability)}</td>
                    <td className="num px-2 text-right text-sub">{pct(st?.oee.performance)}</td>
                    <td className="num px-2 text-right text-sub">{pct(st?.oee.quality)}</td>
                    <td className="num px-2 text-right">{((st?.ok ?? 0) + (st?.ng ?? 0)).toLocaleString('ko-KR')}</td>
                    <td className="num px-2 text-right">{st?.ng ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </PageShell>
  );
}
