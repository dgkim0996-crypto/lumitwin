'use client';

import { Fragment, useEffect, useState } from 'react';
import {
  EXEC_NOTE_MAX,
  INTERLOCK_NAMES,
  LINES,
  WO_LOT,
  WO_QTY_MAX,
  WO_SOURCE_NAMES,
  type LineCode,
  type LineDef,
  type WorkOrderCreate,
  type WorkOrderView,
} from '@lumitwin/shared';
import { ChartCard, DataTable, Empty } from '@/components/charts/kit';
import { MiniButton, WO_PROGRESS_LEGEND, WoProgress, WoStatusBadge, inputCls } from '@/components/execution/bits';
import { LineSwitcher, PageShell, Stat } from '@/components/mes/PageShell';
import { api } from '@/lib/api';
import { errText, useExecAction, useExecGate, useInterlock, useOrders } from '@/lib/execution';
import { cx, duration, pct } from '@/lib/format';
import { useLive } from '@/lib/live';
import { stationName } from '@/lib/names';
import { useUi } from '@/lib/ui';

const KST = 9 * 3600_000;

/** 가상 시각 → 'M/D HH:MM' (오늘이면 시각만) */
function when(iso: string | null | undefined, today?: string): string {
  if (!iso) return '-';
  const d = new Date(Date.parse(iso) + KST);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const day = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const now = today ? new Date(Date.parse(today) + KST) : null;
  return now && now.getUTCDate() === d.getUTCDate() && now.getUTCMonth() === d.getUTCMonth() ? hm : `${day} ${hm}`;
}

const vName = (line: LineDef, code: string) => line.variants.find((v) => v.code === code)?.name ?? code;

export default function OrdersPage() {
  const lineCode = useUi((s) => s.line);
  const line = LINES.find((l) => l.code === lineCode)!;
  const q = useOrders(lineCode);
  const simLine = useLive((s) => s.sim?.lines?.[lineCode]);
  const simT = useLive((s) => s.sim?.t);
  const gate = useExecGate('wo.manage');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [lineCode]);

  const orders = q.data ?? [];
  const running = orders.filter((o) => o.status === 'RUNNING');
  const planned = orders.filter((o) => o.status === 'PLANNED');
  const past = orders.filter((o) => o.status === 'DONE' || o.status === 'CANCELLED');
  const current = running.find((o) => o.releasing) ?? null;
  const nextChange = planned.find((o) => o.plan?.changeover);
  const plannedQty = planned.reduce((a, o) => a + o.qty, 0);
  const lastEnd = planned.at(-1)?.plan?.end;

  const act = useExecAction((fn: () => Promise<unknown>) => fn(), () => setError(null));
  const run = (fn: () => Promise<unknown>) => act.mutate(fn, { onError: (e) => setError(errText(e)) });
  const cancel = (o: WorkOrderView) => {
    const msg =
      o.status === 'RUNNING'
        ? `${o.code}을(를) 중단할까요? 라인이 이 작업지시 투입을 멈추고 다음 작업지시를 받습니다. 이미 투입한 ${o.released}개는 그대로 흘러갑니다.`
        : `${o.code}을(를) 계획에서 뺄까요?`;
    if (window.confirm(msg)) run(() => api.post(`/orders/${o.id}/cancel`));
  };
  const move = (idx: number, dir: -1 | 1) => {
    const ids = planned.map((o) => o.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    run(() => api.post('/orders/reorder', { line: lineCode, ids }));
  };

  return (
    <PageShell
      title="작업지시·생산 계획"
      desc="라인 투입 공정은 MES가 내려 준 작업지시 순서대로 기종·수량만큼 투입합니다. 대기 건이 3건보다 적어지면 자동 계획이 기종을 번갈아 채우고, 앞뒤 기종이 다르면 기종 변경 셋업이 들어갑니다. 예상 시각은 택트(기종별 병목)로 계산한 가상 시각입니다."
      filters={<LineSwitcher />}
    >
      <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4">
        <Stat
          label="투입 중 작업지시"
          value={<span className="num text-lg">{current?.code ?? (simLine?.waitingWo ? '요청 중' : '-')}</span>}
          sub={current ? `${current.variant} ${vName(line, current.variant)} · 투입 ${current.released}/${current.qty}` : simLine?.waitingWo ? '라인이 다음 작업지시를 기다립니다 (생산 계획 없음 정지)' : '투입을 끝낸 작업지시가 라인 안에서 마무리 중'}
        >
          {current && <WoProgress qty={current.qty} released={current.released} doneQty={current.doneQty} scrapQty={current.scrapQty} />}
        </Stat>
        <Stat
          label="라인에 걸린 기종"
          value={<span className="num text-lg">{simLine?.variant ?? current?.variant ?? '-'}</span>}
          sub={simLine ? `불량 대기 ${simLine.ngPen} · 수리대 ${simLine.repair} · 격리 ${simLine.quarantine}` : '시뮬레이터 라인 상태 없음'}
        />
        <Stat label="대기 작업지시" value={`${planned.length}건`} sub={`수량 ${plannedQty.toLocaleString('ko-KR')}개${lastEnd ? ` · 끝 예상 ${when(lastEnd, simT)}` : ''}`} />
        <Stat
          label="다음 기종 변경"
          value={<span className="num text-lg">{nextChange ? when(nextChange.plan!.start, simT) : '없음'}</span>}
          sub={nextChange ? `${nextChange.code} ${vName(line, nextChange.variant)} · 셋업 약 ${nextChange.plan!.setupMin}분` : '대기 순서 안에 기종 변경이 없습니다'}
        />
      </div>

      {error && (
        <div role="alert" className="mt-3 rounded-md border border-down/40 bg-down/10 px-3 py-2 text-xs text-ink">
          {error}
        </div>
      )}

      <ChartCard
        className="mt-3"
        title="진행 중"
        subtitle="투입 중인 작업지시와, 투입은 끝났지만 아직 라인 안에 남은 작업지시. 투입한 개체가 모두 양품(최종 공정) 또는 폐기로 끝나면 완료됩니다."
        legend={WO_PROGRESS_LEGEND}
        stale={q.isFetching && q.isPlaceholderData}
      >
        {running.length ? (
          <div className="flex flex-col gap-3">
            {running.map((o) => (
              <RunningRow key={o.id} o={o} line={line} today={simT} gate={gate} onCancel={() => cancel(o)} />
            ))}
          </div>
        ) : (
          <Empty h={80}>{q.isLoading ? '불러오는 중…' : q.error ? errText(q.error) : '진행 중인 작업지시가 없습니다. 시뮬레이터가 돌면 라인이 대기 순서의 첫 작업지시를 받아 갑니다.'}</Empty>
        )}
      </ChartCard>

      <ChartCard
        className="mt-3"
        title="대기 순서 (생산 계획)"
        subtitle={
          <>
            위에서부터 투입합니다. 기종이 바뀌는 곳에는 라인 설비 셋업(
            {line.changeover.map((c) => `${stationName(c.station)} ${c.minutes}분`).join(' · ')}
            )이 차례로 들어갑니다. 예상 시각의 셋업은 합계로 잡은 보수적인 값입니다.
          </>
        }
        stale={q.isFetching && q.isPlaceholderData}
      >
        <CreateForm line={line} gate={gate} onError={setError} />
        {planned.length ? (
          <div className="scroll-thin mt-3 overflow-x-auto">
            <table className="w-full min-w-[880px] text-xs">
              <thead className="text-dim">
                <tr className="border-b border-line">
                  <th className="py-1.5 pr-2 text-left font-normal">순서</th>
                  <th className="px-2 text-left font-normal">작업지시</th>
                  <th className="px-2 text-left font-normal">기종</th>
                  <th className="px-2 text-right font-normal">수량</th>
                  <th className="px-2 text-left font-normal">예상 투입 (가상 시각)</th>
                  <th className="px-2 text-left font-normal">만든 곳</th>
                  <th className="px-2 text-left font-normal">메모</th>
                  <th className="pl-2 text-right font-normal">조작</th>
                </tr>
              </thead>
              <tbody>
                {planned.map((o, i) => {
                  const prev = i === 0 ? (current?.variant ?? simLine?.variant ?? null) : planned[i - 1].variant;
                  return (
                    <Fragment key={o.id}>
                      {o.plan?.changeover && (
                        <tr className="border-b border-line/60 bg-warn/[0.06]">
                          <td colSpan={8} className="py-1 pl-2 text-[11px] text-warn">
                            ⇄ 기종 변경 {prev ? `${vName(line, prev)} → ` : ''}
                            {vName(line, o.variant)} · 셋업 약 {o.plan.setupMin}분 (4M 변경점 · 셋업한 설비는 초물 검사)
                          </td>
                        </tr>
                      )}
                      <PlannedRow o={o} idx={i} last={i === planned.length - 1} line={line} today={simT} gate={gate} onMove={move} onCancel={() => cancel(o)} onError={setError} />
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty h={80}>{q.isLoading ? '불러오는 중…' : '대기 작업지시가 없습니다.'}</Empty>
        )}
      </ChartCard>

      <ChartCard className="mt-3" title="지난 작업지시" subtitle="완료·중단된 작업지시 (최근 끝난 것부터 30건)">
        {past.length ? (
          <DataTable
            head={['작업지시', '기종', '상태', '수량', '투입', '양품', '폐기', '양품률', '시작', '끝', '걸린 시간']}
            align={['l', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r']}
            rows={past.map((o) => [
              <span key="c" className="num font-semibold">
                {o.code}
              </span>,
              <span key="v" className="text-sub">
                {vName(line, o.variant)}
              </span>,
              <WoStatusBadge key="s" status={o.status} />,
              o.qty,
              o.released,
              o.doneQty,
              o.scrapQty,
              o.doneQty + o.scrapQty ? pct(o.doneQty / (o.doneQty + o.scrapQty)) : '-',
              when(o.startedAt, simT),
              when(o.endedAt, simT),
              o.startedAt && o.endedAt ? duration((Date.parse(o.endedAt) - Date.parse(o.startedAt)) / 1000) : '-',
            ])}
          />
        ) : (
          <Empty h={60}>아직 끝난 작업지시가 없습니다.</Empty>
        )}
      </ChartCard>

      <InterlockCard line={lineCode} />
    </PageShell>
  );
}

function RunningRow({ o, line, today, gate, onCancel }: { o: WorkOrderView; line: LineDef; today?: string; gate: { ok: boolean; title?: string }; onCancel: () => void }) {
  const judged = o.doneQty + o.scrapQty;
  return (
    <div className={cx('rounded-md border p-3', o.releasing ? 'border-info/40 bg-info/[0.05]' : 'border-line bg-white/[0.02]')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="num text-sm font-semibold">{o.code}</span>
          <WoStatusBadge status={o.status} releasing={o.releasing} />
          <span className="text-xs text-sub">
            {o.variant} {vName(line, o.variant)}
          </span>
          <span className="text-[11px] text-dim">
            {WO_SOURCE_NAMES[o.source]}
            {o.createdBy ? ` · ${o.createdBy}` : ''} · 시작 {when(o.startedAt, today)}
            {o.releasing && o.plan ? ` · 투입 끝 예상 ${when(o.plan.end, today)}` : ''}
          </span>
        </div>
        <MiniButton tone="danger" onClick={onCancel} disabled={!gate.ok} title={gate.title ?? '투입을 멈추고 다음 작업지시로 넘어갑니다'}>
          중단
        </MiniButton>
      </div>
      <div className="mt-2">
        <WoProgress qty={o.qty} released={o.released} doneQty={o.doneQty} scrapQty={o.scrapQty} height={10} />
      </div>
      <div className="num mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-sub">
        <span>
          투입 <b className="text-ink">{o.released}</b> / {o.qty}
        </span>
        <span>
          양품 <b className="text-ink">{o.doneQty}</b>
        </span>
        <span>
          폐기 <b className={o.scrapQty ? 'text-down' : 'text-ink'}>{o.scrapQty}</b>
        </span>
        <span>
          라인 안 <b className="text-ink">{o.wip}</b>
        </span>
        <span>양품률 {judged ? pct(o.doneQty / judged) : '-'}</span>
        {o.note && <span className="text-dim">메모: {o.note}</span>}
      </div>
    </div>
  );
}

function PlannedRow({
  o,
  idx,
  last,
  line,
  today,
  gate,
  onMove,
  onCancel,
  onError,
}: {
  o: WorkOrderView;
  idx: number;
  last: boolean;
  line: LineDef;
  today?: string;
  gate: { ok: boolean; title?: string };
  onMove: (idx: number, dir: -1 | 1) => void;
  onCancel: () => void;
  onError: (m: string | null) => void;
}) {
  const [edit, setEdit] = useState<string | null>(null);
  const save = useExecAction((qty: number) => api.patch(`/orders/${o.id}`, { qty }), () => setEdit(null));
  const submit = () => {
    const n = Number(edit);
    if (!Number.isInteger(n) || n < 1 || n > WO_QTY_MAX) return onError(`수량은 1 ~ ${WO_QTY_MAX} 사이 정수입니다`);
    save.mutate(n, { onError: (e) => onError(errText(e)) });
  };
  return (
    <tr className="border-b border-line/60 align-middle hover:bg-white/[0.03]">
      <td className="num py-1.5 pr-2 text-dim">{idx + 1}</td>
      <td className="num px-2 font-semibold whitespace-nowrap">{o.code}</td>
      <td className="px-2 whitespace-nowrap">
        <span className="num">{o.variant}</span> <span className="text-sub">{vName(line, o.variant)}</span>
      </td>
      <td className="num px-2 text-right">
        {edit != null ? (
          <form
            className="flex items-center justify-end gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              autoFocus
              value={edit}
              onChange={(e) => setEdit(e.target.value.replace(/[^0-9]/g, ''))}
              aria-label={`${o.code} 수량`}
              className={cx(inputCls, 'h-6 w-16 text-right text-xs')}
            />
            <MiniButton tone="primary" onClick={submit} disabled={save.isPending}>
              저장
            </MiniButton>
            <MiniButton onClick={() => setEdit(null)}>취소</MiniButton>
          </form>
        ) : (
          o.qty
        )}
      </td>
      <td className="num px-2 whitespace-nowrap text-sub">
        {o.plan ? (
          <>
            {when(o.plan.start, today)} ~ {when(o.plan.end, today)}
            <span className="ml-1 text-dim" title="한 개 투입 간격: 계획 택트와 이 기종의 병목 사이클 중 긴 것">
              ({o.plan.pitchSec}초/개)
            </span>
          </>
        ) : (
          '-'
        )}
      </td>
      <td className="px-2 whitespace-nowrap text-sub">
        {WO_SOURCE_NAMES[o.source]}
        {o.createdBy ? ` · ${o.createdBy}` : ''}
      </td>
      <td className="max-w-[220px] truncate px-2 text-dim" title={o.note ?? undefined}>
        {o.note ?? ''}
      </td>
      <td className="pl-2">
        <div className="flex justify-end gap-1">
          <MiniButton onClick={() => onMove(idx, -1)} disabled={!gate.ok || idx === 0} title={gate.title ?? '순서 올리기'}>
            ▲
          </MiniButton>
          <MiniButton onClick={() => onMove(idx, 1)} disabled={!gate.ok || last} title={gate.title ?? '순서 내리기'}>
            ▼
          </MiniButton>
          <MiniButton onClick={() => setEdit(String(o.qty))} disabled={!gate.ok || edit != null} title={gate.title ?? '수량 고치기'}>
            수량
          </MiniButton>
          <MiniButton tone="danger" onClick={onCancel} disabled={!gate.ok} title={gate.title ?? '계획에서 빼기'}>
            중단
          </MiniButton>
        </div>
      </td>
    </tr>
  );
}

function CreateForm({ line, gate, onError }: { line: LineDef; gate: { ok: boolean; title?: string }; onError: (m: string | null) => void }) {
  const [variant, setVariant] = useState(line.variants[0].code);
  const [qty, setQty] = useState(String(WO_LOT[line.code]));
  const [note, setNote] = useState('');
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    setVariant(line.variants[0].code);
    setQty(String(WO_LOT[line.code]));
    setDone(null);
  }, [line]);
  const create = useExecAction(
    (body: WorkOrderCreate) => api.post<WorkOrderView>('/orders', body),
    (w) => {
      setDone(`${w.code}을(를) 대기 순서 맨 뒤에 넣었습니다`);
      setNote('');
      onError(null);
    },
  );
  const submit = () => {
    const n = Number(qty);
    if (!Number.isInteger(n) || n < 1 || n > WO_QTY_MAX) return onError(`수량은 1 ~ ${WO_QTY_MAX} 사이 정수입니다`);
    create.mutate({ line: line.code as LineCode, variant, qty: n, note: note.trim() || undefined }, { onError: (e) => onError(errText(e)) });
  };
  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-white/[0.02] p-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <span className="text-xs text-sub">작업지시 만들기</span>
      <select value={variant} onChange={(e) => setVariant(e.target.value)} aria-label="기종" className={cx(inputCls, 'text-xs')}>
        {line.variants.map((v) => (
          <option key={v.code} value={v.code} className="bg-[#0e141e]">
            {v.code} {v.name}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-xs text-sub">
        수량
        <input value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" aria-label="수량" className={cx(inputCls, 'num w-20 text-right text-xs')} />
      </label>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, EXEC_NOTE_MAX))}
        placeholder="메모 (선택: 긴급 주문 등)"
        aria-label="메모"
        className={cx(inputCls, 'min-w-[12rem] flex-1 text-xs')}
      />
      <button type="submit" disabled={!gate.ok || create.isPending} title={gate.title} className="h-8 rounded-md border border-info/50 bg-info/10 px-3 text-sm hover:bg-info/20 disabled:cursor-not-allowed disabled:opacity-40">
        만들기
      </button>
      {done && <span className="text-[11px] text-run">{done}</span>}
    </form>
  );
}

/** 공정 인터록: 이 라인 게이트 설비의 통과·거부·대기 수와 최근 거부 */
function InterlockCard({ line }: { line: LineCode }) {
  const q = useInterlock(line);
  const today = useLive((s) => s.sim?.t);
  const d = q.data;
  return (
    <ChartCard
      className="mt-3"
      title="공정 인터록 (투입 확인)"
      subtitle="게이트 설비는 투입하는 순간 MES에 묻습니다: Hold → 불량 미처리 → 재검사 순서 → 공정 순서 → 작업지시 → 초물 순으로 보고 처음 걸리는 것으로 거부(격리)하거나 대기시킵니다. 통과 수는 서버가 켜진 뒤 센 값입니다."
      stale={q.isFetching && q.isPlaceholderData}
    >
      {!d ? (
        <Empty h={80}>{q.isLoading ? '불러오는 중…' : q.error ? errText(q.error) : '-'}</Empty>
      ) : (
        <>
          <div className="num flex flex-wrap gap-x-5 gap-y-1 text-xs text-sub">
            <span>
              통과 <b className="text-ink">{d.stats.live.ok.toLocaleString('ko-KR')}</b>
            </span>
            <span>
              거부 <b className={d.stats.live.ng ? 'text-down' : 'text-ink'}>{d.stats.live.ng}</b>
            </span>
            <span>
              대기 응답 <b className="text-ink">{d.stats.live.wait}</b>
            </span>
            <span title="MES 응답이 늦어(3초) 확인 없이 통과시킨 개체 (공정 기록에 표시)">
              무응답 통과 <b className={d.stats.skipped ? 'text-warn' : 'text-ink'}>{d.stats.skipped}</b>
            </span>
            {d.stats.byCode.map((c) => (
              <span key={c.code}>
                {INTERLOCK_NAMES[c.code]} 거부 {c.ng}
                {c.wait ? ` · 대기 ${c.wait}` : ''}
              </span>
            ))}
          </div>
          {d.recent.length ? (
            <div className="mt-2">
              <DataTable
                head={['시각', '설비', '시리얼', '판정', '사유', '내용']}
                rows={d.recent.slice(0, 30).map((r) => [
                  <span key="t" className="num text-dim">
                    {when(r.at, today)}
                  </span>,
                  stationName(r.station),
                  <span key="s" className="num">
                    {r.serial}
                    {r.comps.length ? <span className="text-dim"> +부품 {r.comps.length}</span> : null}
                  </span>,
                  <span key="v" className={r.verdict === 'NG' ? 'text-down' : 'text-warn'}>
                    {r.verdict === 'NG' ? '거부' : '대기'}
                  </span>,
                  INTERLOCK_NAMES[r.code],
                  <span key="r" className="text-sub">
                    {r.reason}
                  </span>,
                ])}
              />
            </div>
          ) : (
            <Empty h={60}>이번 실행에서 거부·대기된 투입이 없습니다.</Empty>
          )}
        </>
      )}
    </ChartCard>
  );
}
