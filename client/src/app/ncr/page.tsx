'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AUTO_RULE_NAMES,
  DISPOSITION_NAMES,
  EXEC_NOTE_MAX,
  LINES,
  NCR_OUTCOME_NAMES,
  type Disposition,
  type LineCode,
  type NcrDetail,
  type NcrDisposeInput,
  type NcrStatus,
  type NcrView,
} from '@lumitwin/shared';
import { ChartCard, Empty } from '@/components/charts/kit';
import { MiniButton, NcrStatusBadge, Tabs, inputCls } from '@/components/execution/bits';
import { PageShell, Stat } from '@/components/mes/PageShell';
import { api } from '@/lib/api';
import { errText, useExecAction, useExecGate, useNcr, useNcrList } from '@/lib/execution';
import { cx, kst, pct } from '@/lib/format';
import { useLive } from '@/lib/live';
import { ITEM_NAMES, defectName, stationName } from '@/lib/names';
import { useFocusTarget, useUi } from '@/lib/ui';

type StatusTab = 'ALL' | 'ACTIVE' | NcrStatus;

const STATUS_TABS: readonly (readonly [StatusTab, string])[] = [
  ['ACTIVE', '처리 중 전체'],
  ['WAIT_MRB', 'MRB 판정 대기'],
  ['OPEN', '접수'],
  ['REPAIRING', '수리·재작업 중'],
  ['REINSPECT', '재검사 대기'],
  ['CLOSED', '종결'],
  ['ALL', '전부'],
];

const DECISIONS: { k: Disposition; hint: string; tone: 'default' | 'danger' | 'primary' }[] = [
  { k: 'REPAIR', hint: '수리대로 보낸다. 수리 뒤 불량이 난 공정에서 재검사한다', tone: 'primary' },
  { k: 'REWORK', hint: '재작업으로 보낸다. 끝나면 불량이 난 공정에서 재검사한다', tone: 'default' },
  { k: 'SCRAP', hint: '폐기한다. 시리얼은 더 흐르지 않는다', tone: 'danger' },
  { k: 'UAI', hint: '특채: 불량을 인정하고 그대로 다음 공정으로 보낸다. 근거 메모가 필요하다', tone: 'default' },
];

const lineName = (code: string) => LINES.find((l) => l.code === code)?.name ?? code;

export default function NcrPage() {
  const setUiLine = useUi((s) => s.setLine);
  const [scope, setScope] = useState<LineCode | 'ALL'>('ALL');
  const [tab, setTab] = useState<StatusTab>('ACTIVE');
  const [selected, setSelected] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const q = useNcrList(tab, scope);
  const today = useLive((s) => s.sim?.t);

  const items = useMemo(() => {
    const list = q.data?.items ?? [];
    const s = search.trim().toUpperCase();
    return s ? list.filter((n) => n.serial.toUpperCase().includes(s) || n.code.toUpperCase().includes(s) || (n.woCode ?? '').toUpperCase().includes(s)) : list;
  }, [q.data, search]);

  // 다른 화면이 시리얼을 넘기면: 전부 보기로 바꾸고 그 시리얼의 최근 NCR을 고른다
  const [want, setWant] = useState<string | null>(null);
  useFocusTarget((f) => {
    if (!f.serial) return;
    setTab('ALL');
    setSearch(f.serial);
    setWant(f.serial);
  });
  useEffect(() => {
    if (!want || !q.data) return;
    const hit = q.data.items.find((n) => n.serial === want);
    if (hit) setSelected(hit.id);
    setWant(null);
  }, [want, q.data]);

  // 처음 열면 MRB 대기 → 아무 건 순으로 첫 줄을 고른다
  useEffect(() => {
    if (selected != null || !items.length) return;
    setSelected((items.find((n) => n.status === 'WAIT_MRB') ?? items[0]).id);
  }, [items, selected]);

  // 요약은 상태 탭과 상관없이 고른 라인 전체 NCR 기준이다 (서버가 같이 준다)
  const sum = q.data?.summary;
  const pickScope = (v: LineCode | 'ALL') => {
    setScope(v);
    setSelected(null);
    if (v !== 'ALL') setUiLine(v);
  };

  return (
    <PageShell
      title="불량 처리 (NCR)"
      desc="공정에서 불량이 나면 부적합 보고(NCR)가 자동으로 열리고, MES가 불량 처리 기준에 따라 처리(수리·재작업·폐기)를 바로 정합니다. 기준이 사람 판단을 요구하는 불량(최대 광도 미달·코팅 기포·작동 소음)만 MRB 판정 대기로 남아 품질 담당자가 정합니다. 수리·재작업한 개체는 불량이 난 공정에서 재검사해야 다음 공정으로 갈 수 있습니다."
      filters={
        <Tabs
          label="라인"
          value={scope}
          onChange={pickScope}
          items={[['ALL', '전체 라인'] as const, ...LINES.map((l) => [l.code as LineCode, l.name] as const)]}
        />
      }
    >
      <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-5">
        <Stat
          label="처리 중"
          value={sum ? `${sum.open}건` : '-'}
          sub={sum ? `MRB 대기 ${sum.byStatus.WAIT_MRB} · 수리 중 ${sum.byStatus.REPAIRING} · 재검사 대기 ${sum.byStatus.REINSPECT}` : undefined}
        />
        <Stat
          label="MRB 판정 대기"
          value={<span className={sum?.byStatus.WAIT_MRB ? 'text-warn' : undefined}>{sum ? `${sum.byStatus.WAIT_MRB}건` : '-'}</span>}
          sub="기준이 사람 판단을 요구하는 불량: 품질 담당이 정해야 개체가 움직입니다"
        />
        <Stat label="수리 성공률" value={sum ? pct(sum.repairSuccess ?? undefined) : '-'} sub={sum ? `수리·재작업 끝난 ${sum.repairDone}건 중 재검사 합격` : undefined} />
        <Stat label="평균 수리 시간" value={sum?.avgRepairMin != null ? `${sum.avgRepairMin.toFixed(1)}분` : '-'} sub="수리대 투입부터 끝까지 (가상 시간)" />
        <Stat label="폐기 · 특채" value={sum ? `${sum.scrapped} · ${sum.uai}` : '-'} sub={sum ? `이번 실행 NCR ${sum.total}건 기준` : undefined} />
      </div>

      <div className="mt-3 grid gap-3 @6xl:grid-cols-5">
        <ChartCard
          className="@6xl:col-span-3"
          title="부적합 목록"
          subtitle="최근 연 것부터 (최대 300건). 노란 줄은 MRB 판정을 기다리는 건입니다."
          right={
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="시리얼·NCR·작업지시 찾기"
              aria-label="NCR 찾기"
              className={cx(inputCls, 'h-7 w-48 text-xs')}
            />
          }
          stale={q.isFetching && q.isPlaceholderData}
        >
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Tabs label="상태" value={tab} onChange={(v) => { setTab(v); setSelected(null); }} items={STATUS_TABS.map(([k, t]) => [k, k === 'ALL' || k === 'ACTIVE' || !sum ? t : `${t} ${sum.byStatus[k as NcrStatus]}`] as const)} />
          </div>
          {items.length ? (
            <div className="scroll-thin max-h-[560px] overflow-auto">
              <table className="w-full min-w-[720px] text-xs">
                <thead className="sticky top-0 bg-[var(--color-chart)] text-dim">
                  <tr className="border-b border-line">
                    <th className="py-1.5 pr-2 text-left font-normal">NCR</th>
                    <th className="px-2 text-left font-normal">시리얼</th>
                    {scope === 'ALL' && <th className="px-2 text-left font-normal">라인</th>}
                    <th className="px-2 text-left font-normal">공정</th>
                    <th className="px-2 text-left font-normal">불량</th>
                    <th className="px-2 text-left font-normal">상태</th>
                    <th className="px-2 text-left font-normal">처리</th>
                    <th className="pl-2 text-right font-normal">연 시각</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((n) => (
                    <tr
                      key={n.id}
                      onClick={() => setSelected(n.id)}
                      aria-selected={selected === n.id}
                      className={cx(
                        'cursor-pointer border-b border-line/60',
                        selected === n.id ? 'bg-info/15' : n.status === 'WAIT_MRB' ? 'bg-warn/[0.09] hover:bg-warn/15' : 'hover:bg-white/[0.04]',
                      )}
                    >
                      <td className="num py-1.5 pr-2 whitespace-nowrap">{n.code}</td>
                      <td className="num px-2 whitespace-nowrap">
                        {n.serial}
                        {n.attempt > 1 && <span className="ml-1 text-[10px] text-warn">{n.attempt}번째</span>}
                      </td>
                      {scope === 'ALL' && <td className="px-2 whitespace-nowrap text-sub">{lineName(n.line)}</td>}
                      <td className="px-2 whitespace-nowrap text-sub">{stationName(n.station)}</td>
                      <td className="px-2 whitespace-nowrap">{defectName(n.defect)}</td>
                      <td className="px-2">
                        <NcrStatusBadge status={n.status} />
                      </td>
                      <td className="px-2 whitespace-nowrap text-sub">
                        {n.outcome ? NCR_OUTCOME_NAMES[n.outcome] : n.disposition ? DISPOSITION_NAMES[n.disposition] : n.status === 'WAIT_MRB' ? '판정 필요' : '-'}
                      </td>
                      <td className="num pl-2 text-right whitespace-nowrap text-dim">{kst(n.openedAt, !sameDay(n.openedAt, today))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty h={120}>{q.isLoading ? '불러오는 중…' : q.error ? errText(q.error) : search ? '찾는 NCR이 없습니다.' : '이 조건의 NCR이 없습니다.'}</Empty>
          )}
        </ChartCard>

        <div className="flex flex-col gap-3 @6xl:col-span-2">
          <NcrDetailCard id={selected} today={today} />
          <TopDefects list={sum?.topDefects ?? []} total={sum?.total ?? 0} scopeLabel={scope === 'ALL' ? '전체 라인' : lineName(scope)} />
        </div>
      </div>
    </PageShell>
  );
}

function sameDay(iso: string, today?: string): boolean {
  if (!today) return true;
  const K = 9 * 3600_000;
  return Math.floor((Date.parse(iso) + K) / 86_400_000) === Math.floor((Date.parse(today) + K) / 86_400_000);
}

function NcrDetailCard({ id, today }: { id: number | null; today?: string }) {
  const q = useNcr(id);
  const openTrace = useLive((s) => s.openTrace);
  const d = id != null && q.data?.id === id ? q.data : null;
  return (
    <ChartCard title={d ? `${d.code}` : 'NCR 상세'} subtitle={d ? `${ITEM_NAMES[d.item] ?? d.item} · ${lineName(d.line)} ${stationName(d.station)}` : '목록에서 한 건을 고르세요'} stale={q.isFetching && q.isPlaceholderData}>
      {!d ? (
        <Empty h={120}>{id == null ? '고른 NCR이 없습니다.' : q.error ? errText(q.error) : '불러오는 중…'}</Empty>
      ) : (
        <div className="flex flex-col gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <NcrStatusBadge status={d.status} />
            <button type="button" onClick={() => openTrace(d.serial)} className="num rounded border border-line px-1.5 py-0.5 text-[11px] text-info hover:bg-white/10" title="이 시리얼의 계보·공정 기록 열기">
              {d.serial} 추적 ↗
            </button>
            {d.woCode && <span className="num text-sub">작업지시 {d.woCode}</span>}
            {d.variant && <span className="num text-sub">기종 {d.variant}</span>}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-dim">불량</dt>
            <dd>
              {defectName(d.defect)} <span className="num text-dim">({d.defect})</span>
            </dd>
            <dt className="text-dim">공정</dt>
            <dd>
              {stationName(d.station)} <span className="num text-dim">{d.step}</span>
            </dd>
            <dt className="text-dim">연 시각</dt>
            <dd className="num">{kst(d.openedAt, !sameDay(d.openedAt, today))}</dd>
            <dt className="text-dim">처리</dt>
            <dd>
              {d.disposition ? DISPOSITION_NAMES[d.disposition] : d.status === 'WAIT_MRB' ? <span className="text-warn">MRB 판정 대기</span> : '-'}
              {d.rule && <span className="text-dim"> · {AUTO_RULE_NAMES[d.rule]}</span>}
            </dd>
            {d.decidedBy && (
              <>
                <dt className="text-dim">판정</dt>
                <dd>
                  {d.decidedBy}
                  {d.decidedAt && <span className="num text-dim"> · {kst(d.decidedAt, !sameDay(d.decidedAt, today))}</span>}
                </dd>
              </>
            )}
            {(d.repairOk != null || d.repairMin != null) && (
              <>
                <dt className="text-dim">수리</dt>
                <dd>
                  {d.repairOk == null ? '진행 중' : d.repairOk ? '끝남' : <span className="text-down">실패</span>}
                  {d.repairMin != null && <span className="num text-dim"> · {d.repairMin.toFixed(1)}분</span>}
                </dd>
              </>
            )}
            {d.reinspect && (
              <>
                <dt className="text-dim">재검사</dt>
                <dd className={d.reinspect === 'OK' ? 'text-run' : 'text-down'}>{d.reinspect === 'OK' ? '합격' : '다시 불합격'}</dd>
              </>
            )}
            {d.outcome && (
              <>
                <dt className="text-dim">결말</dt>
                <dd>
                  {NCR_OUTCOME_NAMES[d.outcome]}
                  {d.closedAt && <span className="num text-dim"> · {kst(d.closedAt, !sameDay(d.closedAt, today))}</span>}
                </dd>
              </>
            )}
            {d.note && (
              <>
                <dt className="text-dim">메모</dt>
                <dd className="whitespace-pre-wrap">{d.note}</dd>
              </>
            )}
          </dl>

          <div className="rounded-md border border-line bg-white/[0.02] px-2 py-1.5 text-[11px] text-sub">
            처리 기준이 권하는 처리:{' '}
            <b className="text-ink">{d.suggested.action === 'MRB' ? 'MRB 판정 (품질 담당이 결정)' : DISPOSITION_NAMES[d.suggested.action]}</b>
            {d.suggested.action !== 'MRB' && d.suggested.action !== 'SCRAP' && (
              <span>
                {' '}
                · 약 {d.suggested.minutes}분 · 성공 {pct(d.suggested.prob, 0)}
              </span>
            )}
            <span className="text-dim"> ({AUTO_RULE_NAMES[d.suggested.rule]})</span>
          </div>

          <DisposeForm key={d.id} n={d} />

          {d.history.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] text-dim">같은 시리얼의 다른 NCR</div>
              <ul className="flex flex-col gap-0.5">
                {d.history.map((h) => (
                  <li key={h.id} className="num flex flex-wrap items-center gap-2 text-[11px]">
                    <span>{h.code}</span>
                    <span className="text-sub">
                      {stationName(h.station)} · {defectName(h.defect)}
                    </span>
                    <NcrStatusBadge status={h.status} />
                    <span className="text-dim">{h.outcome ? NCR_OUTCOME_NAMES[h.outcome] : h.disposition ? DISPOSITION_NAMES[h.disposition] : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </ChartCard>
  );
}

function DisposeForm({ n }: { n: NcrDetail }) {
  const gate = useExecGate('ncr.dispose');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const act = useExecAction(
    (body: NcrDisposeInput) => api.post<NcrView>(`/ncr/${n.id}/disposition`, body),
    (r) => {
      setDone(`${r.code}: ${r.disposition ? DISPOSITION_NAMES[r.disposition] : ''} 판정을 내렸습니다`);
      setError(null);
      setNote('');
    },
  );
  const open = n.status === 'OPEN' || n.status === 'WAIT_MRB';
  if (!open) {
    return <div className="text-[11px] text-dim">{done ?? '이미 처리가 정해진 건입니다. 수리·재검사는 라인에서 이어집니다.'}</div>;
  }
  const decide = (k: Disposition) => {
    const memo = note.trim();
    if (k === 'UAI' && !memo) return setError('특채는 근거를 메모로 남겨 주세요');
    if ((k === 'SCRAP' || k === 'UAI') && !window.confirm(`${n.serial}을(를) ${DISPOSITION_NAMES[k]} 처리할까요? 되돌릴 수 없습니다.`)) return;
    act.mutate({ decision: k, note: memo || undefined }, { onError: (e) => setError(errText(e)) });
  };
  return (
    <div className={cx('rounded-md border p-2', n.status === 'WAIT_MRB' ? 'border-warn/40 bg-warn/[0.05]' : 'border-line')}>
      <div className="mb-1.5 text-[11px] text-sub">{n.status === 'WAIT_MRB' ? 'MRB 판정: 이 개체는 판정이 날 때까지 불량 대기 구역에 있습니다' : '처리 정하기'}</div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, EXEC_NOTE_MAX))}
        rows={2}
        placeholder="메모 (특채는 필수: 고객 승인 번호, 판단 근거 등)"
        aria-label="판정 메모"
        className={cx(inputCls, 'h-auto w-full resize-y py-1 text-xs')}
      />
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {DECISIONS.map((x) => (
          <MiniButton key={x.k} tone={x.tone} onClick={() => decide(x.k)} disabled={!gate.ok || act.isPending} title={gate.title ?? x.hint}>
            {DISPOSITION_NAMES[x.k]}
          </MiniButton>
        ))}
      </div>
      {error && (
        <div role="alert" className="mt-1.5 text-[11px] text-down">
          {error}
        </div>
      )}
    </div>
  );
}

function TopDefects({ list, total, scopeLabel }: { list: { defect: string; n: number }[]; total: number; scopeLabel: string }) {
  const max = Math.max(1, ...list.map((x) => x.n));
  return (
    <ChartCard title="많이 난 불량" subtitle={`${scopeLabel} · 이번 실행 NCR ${total}건 중 상위`}>
      {list.length ? (
        <ul className="flex flex-col gap-1.5 text-xs">
          {list.map((x) => (
            <li key={x.defect} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2">
              <span className="truncate" title={x.defect}>
                {defectName(x.defect)}
              </span>
              <span className="h-2 rounded-full bg-white/5">
                <span className="block h-2 rounded-full" style={{ width: `${(x.n / max) * 100}%`, background: 'var(--color-ng)' }} />
              </span>
              <span className="num text-sub">
                {x.n}건 {total ? `(${pct(x.n / total, 0)})` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty h={60}>아직 NCR이 없습니다.</Empty>
      )}
    </ChartCard>
  );
}
