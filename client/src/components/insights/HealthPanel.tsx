'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { HEALTH_LEVEL_NAMES, PM_PLANS, PM_REASON, RUL_MIN_SAMPLES, STATIONS, type HealthLevel, type StationHealth } from '@lumitwin/shared';
import { ChartCard, DataTable, Empty, Key } from '@/components/charts/kit';
import { Meter } from '@/components/charts/small';
import { simCommand } from '@/lib/api';
import { deniedTitle, useAuth } from '@/lib/auth';
import { cx, kst, num } from '@/lib/format';
import { fetchHealth, HEALTH_COLOR, HEALTH_ORDER, HEALTH_SHORT, hoursText } from '@/lib/insights';
import { useLive } from '@/lib/live';
import { VibSpark } from './VibSpark';

const LEVELS: HealthLevel[] = ['danger', 'warn', 'watch', 'good'];

/** 같은 날(한국 시각)이면 시:분, 아니면 월-일 시:분 */
function when(iso: string | null | undefined, now: string | null | undefined): string {
  if (!iso) return '-';
  const day = (x: string) => new Date(Date.parse(x) + 9 * 3_600_000).toISOString().slice(5, 10);
  const t = kst(iso).slice(0, 5);
  return now && day(iso) === day(now) ? t : `${day(iso)} ${t}`;
}

/** 위험·경고 순, 같은 등급이면 남은 수명 짧은 순 */
const rank = (s: StationHealth) => [s.level ? HEALTH_ORDER[s.level] : 9, s.rul?.dangerH ?? Infinity] as const;

/**
 * 예지 보전 영역 (설비 보전 화면): 상태 감시 설비마다 진동 구역 등급, 진동 추이, 남은 수명, 보전 실시.
 * 등급은 ISO 10816 진동 구역(A/B 신품 · B/C 장기 운전 한계 · C/D 손상 우려)으로 정한다
 */
export function HealthPanel({ className, inScope, onPick }: { className?: string; inScope: (code: string) => boolean; onPick: (code: string) => void }) {
  const q = useQuery({ queryKey: ['maintenance-health'], queryFn: fetchHealth, refetchInterval: 5_000, placeholderData: keepPreviousData });
  const data = q.data;
  const list = useMemo(
    () =>
      (data?.stations ?? [])
        .filter((s) => inScope(s.station))
        .sort((a, b) => {
          const [x1, y1] = rank(a);
          const [x2, y2] = rank(b);
          return x1 - x2 || y1 - y2;
        }),
    [data, inScope],
  );
  const counts = useMemo(() => {
    const c: Record<HealthLevel, number> = { good: 0, watch: 0, warn: 0, danger: 0 };
    for (const s of list) if (s.level) c[s.level]++;
    return c;
  }, [list]);

  return (
    <ChartCard
      className={className}
      title="예지 보전 (상태 감시)"
      subtitle={
        <>
          설비가 가상 1분마다 보내는 진동·전류·온도로 마모를 봅니다. 등급은 최근 가동 중 진동 5점의 중앙값을 ISO 10816 구역 경계와 견줘 정하고(B/C를 넘으면 경고, C/D를 넘으면 위험 알람), 남은 수명은 마지막 보전 뒤 최근
          진동 추세를 경계까지 직선으로 늘려 잡은 추정입니다(표본 {RUL_MIN_SAMPLES}개 미만이거나 추세가 잡음 수준이면 내지 않음). 보전 실시는 설비를 &lsquo;{PM_REASON}&rsquo;으로 잠시 세웠다가 마모를 되돌립니다.
        </>
      }
      stale={q.isFetching && q.isPlaceholderData}
      right={
        list.length ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {LEVELS.map((l) => (
              <span key={l} className="inline-flex items-center gap-1.5 rounded border border-line px-1.5 py-0.5">
                <Key color={HEALTH_COLOR[l]} shape="dot" />
                <span className="text-sub">{HEALTH_SHORT[l]}</span>
                <span className="num text-ink">{counts[l]}</span>
              </span>
            ))}
          </div>
        ) : undefined
      }
      table={
        list.length ? (
          <DataTable
            head={['설비', '등급', '진동 mm/s', 'B/C · C/D', '전류 A', '온도 °C', '건강 지수', '위험까지', '마지막 보전']}
            align={['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'l']}
            rows={list.map((s) => [
              `${s.station} ${STATIONS[s.station]?.name ?? ''}`,
              s.level ? HEALTH_LEVEL_NAMES[s.level] : '자료 없음',
              s.vib != null ? num(s.vib) : '-',
              `${s.zones.bc} · ${s.zones.cd}`,
              s.latest ? num(s.latest.cur) : '-',
              s.latest ? num(s.latest.temp) : '-',
              s.index != null ? Math.round(s.index * 100) : '-',
              s.rul ? hoursText(s.rul.dangerH) : s.rulNote,
              s.lastMaint ? `${s.lastMaint.kind === 'pm' ? '보전' : '수리'} ${when(s.lastMaint.at, data?.t)}` : '-',
            ])}
          />
        ) : undefined
      }
    >
      {!data ? (
        <Empty h={140}>{q.isLoading ? '불러오는 중…' : q.error ? (q.error as Error).message : '자료 없음'}</Empty>
      ) : !data.stations.length ? (
        <Empty h={120}>
          자료 없음: 공장 정의에 상태 감시 기준(health: 정상 진동·전류·온도, 마모 시간)이 들어간 설비가 아직 없습니다.
          <br />
          기준이 들어가면 시뮬레이터가 진동·전류·온도를 보내고 여기에 설비별 등급과 남은 수명이 나옵니다.
        </Empty>
      ) : !list.length ? (
        <Empty h={120}>이 범위에는 상태 감시 설비가 없습니다.</Empty>
      ) : (
        <div className="grid gap-3 @4xl:grid-cols-2 @7xl:grid-cols-3">
          {list.map((s) => (
            <HealthCard key={s.station} s={s} now={data.t} onPick={onPick} />
          ))}
        </div>
      )}
    </ChartCard>
  );
}

function LevelChip({ level }: { level: HealthLevel | null }) {
  if (!level) return <span className="rounded border border-line px-1.5 py-px text-[11px] text-dim">자료 없음</span>;
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded border px-1.5 py-px text-[11px]', level === 'danger' ? 'border-down/50 bg-down/10' : level === 'warn' ? 'border-warn/50 bg-warn/10' : 'border-line')}>
      <Key color={HEALTH_COLOR[level]} shape="dot" />
      <span className={level === 'danger' ? 'text-down' : level === 'warn' ? 'text-warn' : 'text-sub'}>{HEALTH_LEVEL_NAMES[level]}</span>
    </span>
  );
}

function HealthCard({ s, now, onPick }: { s: StationHealth; now: string | null; onPick: (code: string) => void }) {
  const { can } = useAuth();
  const allowed = can('station.repair');
  const qc = useQueryClient();
  const live = useLive((st) => st.stations[s.station]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const def = STATIONS[s.station];
  const plan = def ? PM_PLANS[def.kind] : null;
  const doing = live?.state === 'STOP' && live.reason === PM_REASON;
  const down = live?.state === 'DOWN';

  const runPm = async () => {
    if (!window.confirm(`${s.station} ${def?.name ?? ''}\n보전을 실시할까요? 설비가 '${PM_REASON}'으로 약 ${plan?.minutes ?? 20}분(가상) 멈췄다가 다시 돕니다.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await simCommand({ action: 'station', code: s.station, op: 'pm', reason: PM_REASON });
      setMsg({ ok: true, text: '보전 지시를 보냈습니다' });
      void qc.invalidateQueries({ queryKey: ['maintenance'] });
      void qc.invalidateQueries({ queryKey: ['maintenance-health'] });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const latest = s.latest;
  const curUp = latest ? latest.cur / s.base.cur - 1 : null;
  const tempUp = latest ? latest.temp - s.base.temp : null;
  const disabled = !allowed || busy || doing || down;
  const why = !allowed ? deniedTitle('station.repair') : doing ? '지금 보전 중입니다' : down ? '고장 중입니다. 수리 완료 뒤 보전하세요' : `${plan?.task ?? '보전'} · 표준 ${plan?.minutes ?? 20}분`;

  return (
    <div className={cx('rounded-md border p-3', s.level === 'danger' ? 'border-down/40' : s.level === 'warn' ? 'border-warn/40' : 'border-line')}>
      <div className="flex items-start justify-between gap-2">
        <button className="min-w-0 text-left text-xs hover:underline" onClick={() => onPick(s.station)} title="3D 공장에서 이 설비 보기">
          <span className="num font-semibold">{s.station}</span> <span className="text-sub">{def?.name}</span>
          <span className="block truncate text-[11px] text-dim">
            {s.part} · ISO 10816 등급 {s.cls}
          </span>
        </button>
        <LevelChip level={s.level} />
      </div>

      <div className="mt-2 flex items-baseline gap-3">
        <span className="text-xl font-semibold tracking-tight">
          {s.vib != null ? num(s.vib) : '-'}
          <span className="ml-1 text-xs font-normal text-sub">mm/s</span>
        </span>
        <span className="num text-[11px] text-sub">
          정상 {s.base.vib} · 경고 {s.zones.bc} · 위험 {s.zones.cd}
        </span>
      </div>

      <div className="mt-1">
        <VibTrend s={s} />
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <div className="text-dim">건강 지수</div>
          <div className="num text-ink">{s.index != null ? Math.round(s.index * 100) : '-'}</div>
          {s.index != null && <Meter value={s.index} color={s.level ? HEALTH_COLOR[s.level] : undefined} />}
        </div>
        <div title={latest ? `정상 ${s.base.cur} A` : undefined}>
          <div className="text-dim">전류</div>
          <div className="num text-ink">
            {latest ? `${num(latest.cur)} A` : '-'}
            {curUp != null && Math.abs(curUp) >= 0.05 && <span className="ml-1 text-sub">{`${curUp > 0 ? '+' : ''}${Math.round(curUp * 100)}%`}</span>}
          </div>
        </div>
        <div title={latest ? `정상 ${s.base.temp} °C` : undefined}>
          <div className="text-dim">온도</div>
          <div className="num text-ink">
            {latest ? `${num(latest.temp)} °C` : '-'}
            {tempUp != null && Math.abs(tempUp) >= 1 && <span className="ml-1 text-sub">{`${tempUp > 0 ? '+' : ''}${tempUp.toFixed(0)}`}</span>}
          </div>
        </div>
      </div>

      <div className="mt-2 rounded bg-white/[0.03] px-2 py-1.5 text-[11px]">
        {s.rul ? (
          <span className="text-sub">
            남은 수명 (추정): 경고까지 <span className={cx('num', s.rul.warnH === 0 ? 'text-warn' : 'text-ink')}>{s.rul.warnH === 0 ? '넘음' : hoursText(s.rul.warnH)}</span> · 위험까지{' '}
            <span className={cx('num', s.rul.dangerH === 0 ? 'text-down' : s.rul.dangerH < 24 ? 'text-warn' : 'text-ink')}>{s.rul.dangerH === 0 ? '넘음' : hoursText(s.rul.dangerH)}</span>
            <span className="text-dim"> · 추세 +{s.rul.slopePerH} mm/s/h</span>
          </span>
        ) : (
          <span className="text-dim">남은 수명: {s.rulNote}</span>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] text-dim">
          마지막 보전 {s.lastMaint ? `${when(s.lastMaint.at, now)} (${s.lastMaint.kind === 'pm' ? '예방·예지 보전' : '고장 수리'})` : '이번 실행에서 없음'}
          {msg && <span className={cx('ml-2', msg.ok ? 'text-run' : 'text-down')}>{msg.text}</span>}
        </span>
        <button
          onClick={() => void runPm()}
          disabled={disabled}
          title={why}
          className={cx(
            'shrink-0 rounded border px-2 py-0.5 text-xs',
            disabled ? 'cursor-not-allowed border-line text-dim' : s.level === 'danger' || s.level === 'warn' ? 'border-warn/60 bg-warn/15 text-ink hover:bg-warn/25' : 'border-line text-sub hover:bg-white/10 hover:text-ink',
          )}
        >
          {doing ? '보전 중' : busy ? '보내는 중…' : '보전 실시'}
        </button>
      </div>
    </div>
  );
}

function VibTrend({ s }: { s: StationHealth }) {
  if (!s.trend.length) return <div className="flex h-16 items-center text-[11px] text-dim">아직 가동 중 표본이 없습니다</div>;
  return <VibSpark points={s.trend} zones={s.zones} />;
}
