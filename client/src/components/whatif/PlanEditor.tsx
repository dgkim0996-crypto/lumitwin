'use client';

import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { LINES, WHATIF_EVENT_NAMES, WHATIF_LIMITS, WO_LOT, variantName, type LineCode, type WhatIfBase } from '@lumitwin/shared';
import { Key } from '@/components/charts/kit';
import { MiniButton, inputCls } from '@/components/execution/bits';
import { cx } from '@/lib/format';
import {
  SCENARIO_GROUPS,
  STATION_GROUPS,
  copyPlan,
  emptyLine,
  lineDiff,
  newCode,
  newEvent,
  nextPlanName,
  planChanges,
  planColor,
  planFromBase,
  pmMinutes,
  uid,
  vclock,
  type DraftEvent,
  type DraftOrder,
  type DraftPlan,
  type Dues,
  type LineDiff,
} from '@/lib/whatif';

const selCls = cx(inputCls, 'h-7 min-w-0 text-xs');
const numCls = cx(inputCls, 'num h-7 text-right text-xs');
const optCls = 'bg-[#0e141e]';
const digits = (s: string) => s.replace(/[^0-9]/g, '');
const decimal = (s: string) => s.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');

/**
 * 계획 편집: 계획(최대 3개, 첫째 = 기준)을 나란히 두고, 고른 라인의 작업지시 순서·수량·납기와 사건을 고친다.
 * 지금 계획(기준 상태)과 다른 곳은 파란 테두리와 글자로 표시한다
 */
export function PlanEditor({
  base,
  plans,
  setPlans,
  dues,
  setDues,
  horizonH,
}: {
  base?: WhatIfBase;
  plans: DraftPlan[] | null;
  setPlans: Dispatch<SetStateAction<DraftPlan[] | null>>;
  dues: Dues;
  setDues: Dispatch<SetStateAction<Dues>>;
  horizonH: number;
}) {
  const [line, setLine] = useState<LineCode>('HL');
  const list = plans ?? [];
  const full = list.length >= WHATIF_LIMITS.scenarios.max;
  const changes = list.map((p) => planChanges(base, p));

  const update = (i: number, fn: (p: DraftPlan) => DraftPlan) => setPlans((ps) => (ps ? ps.map((p, j) => (j === i ? fn(p) : p)) : ps));
  const copyFrom = (i: number) => setPlans((ps) => (ps && ps.length < WHATIF_LIMITS.scenarios.max ? [...ps, copyPlan(ps[i], nextPlanName(ps))] : ps));
  const remove = (i: number) => setPlans((ps) => (ps ? ps.filter((_, j) => j !== i) : ps));
  const reset = (i: number) => {
    if (!base) return;
    if (changes[i]?.total && !window.confirm(`${list[i].name}의 바꾼 점 ${changes[i].total}개를 지우고 지금 계획으로 되돌릴까요?`)) return;
    update(i, (p) => ({ ...planFromBase(base, p.name), key: p.key }));
  };
  const setDue = (key: string, v: string) => setDues((d) => ({ ...d, [key]: v }));

  return (
    <section className="card min-w-0 p-4" data-testid="whatif-editor">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">계획 편집</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-sub">
            계획은 {WHATIF_LIMITS.scenarios.max}개까지 나란히 비교합니다. 첫째가 비교 기준이고, 처음에는 지금 MES 계획 그대로입니다. 지금 계획과 다른 곳은 파랗게 표시합니다. 투입 중인 작업지시는
            맨 앞에 고정돼 고칠 수 없습니다. 납기는 같은 지시가 든 모든 계획에 같이 적용됩니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="편집할 라인" className="flex overflow-hidden rounded border border-line text-xs">
            {LINES.map((l) => {
              const n = changes.reduce((a, c) => a + (c.byLine[l.code as LineCode] ?? 0), 0);
              return (
                <button
                  key={l.code}
                  role="tab"
                  aria-selected={line === l.code}
                  onClick={() => setLine(l.code as LineCode)}
                  className={cx('flex items-center gap-1.5 px-2 py-1', line === l.code ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}
                >
                  <span className="size-2 rounded-full" style={{ background: l.color }} />
                  {l.short}
                  {n > 0 && <span className="num rounded bg-info/20 px-1 text-[10px] text-info">{n}</span>}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            data-testid="whatif-copy-base"
            onClick={() => copyFrom(0)}
            disabled={!plans?.length || full}
            title={full ? `계획은 ${WHATIF_LIMITS.scenarios.max}개까지입니다` : '첫째(기준) 계획을 그대로 복사해 새 계획을 만듭니다'}
            className="h-7 rounded-md border border-info/50 bg-info/10 px-2.5 text-xs hover:bg-info/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            기준 계획 복사해 새 계획
          </button>
        </div>
      </header>

      {!plans ? (
        <p className="py-8 text-center text-xs text-dim">기준 상태를 읽으면 지금 계획으로 첫 계획을 만듭니다.</p>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,21rem),1fr))]">
          {list.map((p, i) => (
            <PlanColumn
              key={p.key}
              i={i}
              plan={p}
              base={base}
              line={line}
              changes={changes[i]?.total ?? 0}
              update={(fn) => update(i, fn)}
              onCopy={full ? undefined : () => copyFrom(i)}
              onRemove={i > 0 ? () => remove(i) : undefined}
              onReset={() => reset(i)}
              dues={dues}
              setDue={setDue}
              horizonH={horizonH}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Badge({ tone = 'info', children, title }: { tone?: 'info' | 'dim' | 'run'; children: ReactNode; title?: string }) {
  const c = tone === 'info' ? 'border-info/40 bg-info/10 text-info' : tone === 'run' ? 'border-info/40 bg-info/15 text-ink' : 'border-line bg-white/5 text-sub';
  return (
    <span title={title} className={cx('inline-flex shrink-0 items-center rounded border px-1.5 text-[10px] whitespace-nowrap', c)}>
      {children}
    </span>
  );
}

function PlanColumn({
  i,
  plan,
  base,
  line,
  changes,
  update,
  onCopy,
  onRemove,
  onReset,
  dues,
  setDue,
  horizonH,
}: {
  i: number;
  plan: DraftPlan;
  base?: WhatIfBase;
  line: LineCode;
  changes: number;
  update: (fn: (p: DraftPlan) => DraftPlan) => void;
  onCopy?: () => void;
  onRemove?: () => void;
  onReset: () => void;
  dues: Dues;
  setDue: (key: string, v: string) => void;
  horizonH: number;
}) {
  const ldef = LINES.find((l) => l.code === line)!;
  const orders = plan.orders[line];
  const diff = lineDiff(base?.lines?.[line] ?? emptyLine, orders);
  const setOrders = (fn: (os: DraftOrder[]) => DraftOrder[]) => update((p) => ({ ...p, orders: { ...p.orders, [line]: fn(p.orders[line]) } }));
  const move = (idx: number, dir: -1 | 1) =>
    setOrders((os) => {
      const j = idx + dir;
      if (j < 0 || j >= os.length || os[j].running || os[idx].running) return os;
      const next = [...os];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  const setEvents = (fn: (es: DraftEvent[]) => DraftEvent[]) => update((p) => ({ ...p, events: fn(p.events) }));
  const startAt = base?.startAt;

  return (
    <div className="min-w-0 rounded-md border border-line bg-white/[0.02] p-3" data-testid="whatif-plan" data-index={i} style={{ borderTopColor: planColor(i), borderTopWidth: 3 }}>
      <div className="flex flex-wrap items-center gap-2">
        <Key color={planColor(i)} shape="dot" />
        <input
          value={plan.name}
          onChange={(e) => update((p) => ({ ...p, name: e.target.value.slice(0, 30) }))}
          aria-label={`${i + 1}번 계획 이름`}
          className={cx(inputCls, 'h-7 min-w-0 flex-1 text-sm font-medium')}
        />
        {i === 0 && <Badge tone="dim">기준</Badge>}
        {changes > 0 ? <Badge title="지금 계획(MES)과 다른 곳 수 (라인 지시 + 사건 + 자동 채우기)">바꾼 점 {changes}</Badge> : <Badge tone="dim">지금 계획 그대로</Badge>}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        <MiniButton onClick={() => onCopy?.()} disabled={!onCopy} title={onCopy ? '이 계획을 복사해 새 계획을 만듭니다' : `계획은 ${WHATIF_LIMITS.scenarios.max}개까지입니다`}>
          복사
        </MiniButton>
        <MiniButton onClick={onReset} disabled={!changes || !base} title="바꾼 점을 지우고 지금 계획으로 되돌립니다">
          되돌리기
        </MiniButton>
        {onRemove && (
          <MiniButton tone="danger" onClick={onRemove} title="이 계획을 비교에서 뺍니다">
            지우기
          </MiniButton>
        )}
      </div>

      {/* 작업지시 */}
      <h3 className="mt-3 mb-1.5 flex items-center gap-1.5 text-xs font-medium">
        <span className="size-2 rounded-full" style={{ background: ldef.color }} />
        {ldef.name} 작업지시 순서
        <span className="num ml-auto text-[11px] font-normal text-dim">
          {orders.length}/{WHATIF_LIMITS.ordersPerLine}건
        </span>
      </h3>
      {orders.length ? (
        <ol className="space-y-1">
          {orders.map((o, idx) => (
            <OrderRow
              key={o.key}
              o={o}
              idx={idx}
              line={line}
              orders={orders}
              diff={diff}
              due={dues[o.key] ?? ''}
              onDue={(v) => setDue(o.key, v)}
              canUp={idx > 0 && !o.running && !orders[idx - 1].running}
              canDown={idx < orders.length - 1 && !o.running}
              onMove={(d) => move(idx, d)}
              onQty={(v) => setOrders((os) => os.map((x) => (x.key === o.key ? { ...x, qty: v } : x)))}
              onVariant={(v) => setOrders((os) => os.map((x) => (x.key === o.key ? { ...x, variant: v } : x)))}
              onRemove={() => setOrders((os) => os.filter((x) => x.key !== o.key))}
            />
          ))}
        </ol>
      ) : (
        <p className="rounded-md border border-dashed border-line px-2 py-3 text-center text-[11px] text-dim">
          이 라인 계획이 비었습니다. {plan.autoFill ? '자동 계획이 기종을 번갈아 채웁니다.' : '자동 채우기가 꺼져 있어 투입을 멈춥니다.'}
        </p>
      )}

      {diff.removed.length > 0 && (
        <div className="mt-1.5 rounded-md border border-info/40 bg-info/[0.05] px-2 py-1.5 text-[11px]">
          <span className="text-info">뺀 지시</span> <span className="text-dim">(지금 계획에는 있음)</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {diff.removed.map((r) => (
              <span key={r.id} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5">
                <span className="num">{r.code}</span>
                <button
                  type="button"
                  className="text-sub underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
                  disabled={orders.length >= WHATIF_LIMITS.ordersPerLine}
                  onClick={() => setOrders((os) => [...os, { key: `wo-${r.id}`, id: r.id, code: r.code, variant: r.variant, qty: String(r.qty) }])}
                >
                  되살리기
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <AddOrder line={line} disabled={orders.length >= WHATIF_LIMITS.ordersPerLine} onAdd={(variant, qty) => setOrders((os) => [...os, { key: uid('n'), variant, qty }])} />

      {/* 사건 */}
      <h3 className="mt-3 mb-1.5 flex items-center text-xs font-medium">
        사건 (모든 라인)
        <span className="num ml-auto text-[11px] font-normal text-dim">
          {plan.events.length}/{WHATIF_LIMITS.events}
        </span>
      </h3>
      {plan.events.length > 0 && (
        <ul className="space-y-1">
          {plan.events.map((e) => (
            <EventRow
              key={e.key}
              e={e}
              startAt={startAt}
              horizonH={horizonH}
              onChange={(next) => setEvents((es) => es.map((x) => (x.key === e.key ? next : x)))}
              onRemove={() => setEvents((es) => es.filter((x) => x.key !== e.key))}
            />
          ))}
        </ul>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {(['down', 'pm', 'scenario'] as const).map((k) => (
          <MiniButton key={k} onClick={() => setEvents((es) => [...es, newEvent(k, line)])} disabled={plan.events.length >= WHATIF_LIMITS.events} title={`${ldef.name} 설비·시나리오로 시작합니다 (바꿀 수 있음)`}>
            <span data-testid={`whatif-add-${k}`}>＋ {WHATIF_EVENT_NAMES[k]}</span>
          </MiniButton>
        ))}
      </div>

      <label className={cx('mt-3 flex items-start gap-2 rounded-md px-1 py-1 text-[11px]', !plan.autoFill && 'border border-info/40 bg-info/[0.05]')}>
        <input type="checkbox" checked={plan.autoFill} onChange={(e) => update((p) => ({ ...p, autoFill: e.target.checked }))} className="mt-0.5 accent-info" />
        <span className="text-sub">
          계획이 바닥나면 자동 계획처럼 기종을 번갈아 채우기 (작업지시 {WO_LOT[line]}개씩)
          {!plan.autoFill && <span className="block text-info">꺼짐: 계획을 다 쓴 라인은 투입을 멈춥니다</span>}
        </span>
      </label>
    </div>
  );
}

function OrderRow({
  o,
  idx,
  line,
  orders,
  diff,
  due,
  onDue,
  canUp,
  canDown,
  onMove,
  onQty,
  onVariant,
  onRemove,
}: {
  o: DraftOrder;
  idx: number;
  line: LineCode;
  orders: DraftOrder[];
  diff: LineDiff;
  due: string;
  onDue: (v: string) => void;
  canUp: boolean;
  canDown: boolean;
  onMove: (d: -1 | 1) => void;
  onQty: (v: string) => void;
  onVariant: (v: string) => void;
  onRemove: () => void;
}) {
  const ldef = LINES.find((l) => l.code === line)!;
  const isNew = diff.added.has(o.key);
  const moved = diff.moved.has(o.key);
  const baseQty = diff.qty.get(o.key);
  const changed = isNew || moved || baseQty != null;
  const code = o.code ?? newCode(line, orders, o.key);
  return (
    <li className={cx('rounded-md border px-2 py-1.5', changed ? 'border-info/40 bg-info/[0.06]' : 'border-line bg-white/[0.02]')} data-testid="whatif-order" data-code={code}>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="num w-4 shrink-0 text-right text-[11px] text-dim">{idx + 1}</span>
        <span className="num min-w-0 truncate text-xs font-semibold" title={code}>
          {code}
        </span>
        {o.running && <Badge tone="run">투입 중 · 맨 앞 고정</Badge>}
        {isNew && <Badge>새 지시</Badge>}
        {moved && <Badge title="지금 계획에서의 순서">순서 바뀜 (원래 {diff.basePos.get(o.key)}번째)</Badge>}
        <span className="ml-auto flex shrink-0 gap-1">
          {o.running ? (
            <span className="text-[10px] text-dim" title="투입 중인 작업지시는 서버가 늘 맨 앞에 둡니다">
              수정 불가
            </span>
          ) : (
            <>
              <MiniButton onClick={() => onMove(-1)} disabled={!canUp} title="순서 올리기">
                ↑
              </MiniButton>
              <MiniButton onClick={() => onMove(1)} disabled={!canDown} title="순서 내리기">
                ↓
              </MiniButton>
              <MiniButton tone="danger" onClick={onRemove} title="이 계획에서 빼기">
                빼기
              </MiniButton>
            </>
          )}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-5 text-[11px] text-sub">
        {isNew ? (
          <select value={o.variant} onChange={(e) => onVariant(e.target.value)} aria-label={`${code} 기종`} className={cx(selCls, 'max-w-full')}>
            {ldef.variants.map((v) => (
              <option key={v.code} value={v.code} className={optCls}>
                {v.code} {v.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 truncate">{variantName(ldef, o.variant)}</span>
        )}
        {o.running ? (
          <span className="num">
            {o.qty}개 · 투입 {o.released ?? 0}
          </span>
        ) : (
          <label className="flex items-center gap-1">
            수량
            <input value={o.qty} onChange={(e) => onQty(digits(e.target.value))} inputMode="numeric" aria-label={`${code} 수량`} className={cx(numCls, 'w-16')} />
            {baseQty != null && <span className="num text-info">원래 {baseQty}</span>}
          </label>
        )}
        <label className="flex items-center gap-1" title="시작에서 몇 시간 뒤까지 마쳐야 하나 (선택). 결과에서 납기를 지킨 반복 수를 셉니다">
          납기
          <input value={due} onChange={(e) => onDue(decimal(e.target.value))} inputMode="decimal" placeholder="없음" aria-label={`${code} 납기 (시작 뒤 시간)`} className={cx(numCls, 'w-14')} />
          시간 뒤
        </label>
      </div>
    </li>
  );
}

function AddOrder({ line, disabled, onAdd }: { line: LineCode; disabled: boolean; onAdd: (variant: string, qty: string) => void }) {
  const ldef = LINES.find((l) => l.code === line)!;
  const [variant, setVariant] = useState(ldef.variants[0].code);
  const [qty, setQty] = useState(String(WO_LOT[line]));
  useEffect(() => {
    setVariant(ldef.variants[0].code);
    setQty(String(WO_LOT[line]));
  }, [ldef, line]);
  return (
    <form
      className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-line px-2 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) onAdd(variant, qty);
      }}
    >
      <span className="text-[11px] text-sub">지시 더하기</span>
      <select value={variant} onChange={(e) => setVariant(e.target.value)} aria-label="더할 지시 기종" className={cx(selCls, 'max-w-[11rem] min-w-[7rem] flex-1')}>
        {ldef.variants.map((v) => (
          <option key={v.code} value={v.code} className={optCls}>
            {v.code} {v.name}
          </option>
        ))}
      </select>
      <input value={qty} onChange={(e) => setQty(digits(e.target.value))} inputMode="numeric" aria-label="더할 지시 수량" className={cx(numCls, 'w-16')} />
      <MiniButton tone="primary" onClick={() => onAdd(variant, qty)} disabled={disabled} title={disabled ? `라인마다 ${WHATIF_LIMITS.ordersPerLine}건까지입니다` : '맨 뒤에 새 지시를 더합니다'}>
        더하기
      </MiniButton>
    </form>
  );
}

function EventRow({ e, startAt, horizonH, onChange, onRemove }: { e: DraftEvent; startAt?: string; horizonH: number; onChange: (e: DraftEvent) => void; onRemove: () => void }) {
  const at = Number(e.at);
  const outside = !/^\d+$/.test(e.at) || at >= horizonH * 60;
  const pm = e.kind === 'pm' ? pmMinutes(e.station) : null;
  const end = e.kind === 'down' && /^\d+$/.test(e.minutes) ? at + Number(e.minutes) : e.kind === 'pm' && pm ? at + pm : null;
  return (
    <li className="rounded-md border border-info/40 bg-info/[0.06] px-2 py-1.5" data-testid="whatif-event" data-kind={e.kind}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs font-medium">{WHATIF_EVENT_NAMES[e.kind]}</span>
        <span className={cx('num text-[11px]', outside ? 'text-down' : 'text-dim')}>
          {outside ? `실행 시간(${horizonH}시간) 밖` : `가상 ${vclock(startAt, at)}${end != null ? ` ~ ${vclock(startAt, end)}` : ''}`}
        </span>
        <span className="ml-auto">
          <MiniButton tone="danger" onClick={onRemove} title="이 사건 빼기">
            빼기
          </MiniButton>
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-sub">
        {e.kind === 'scenario' ? (
          <>
            <select value={e.id} onChange={(x) => onChange({ ...e, id: x.target.value })} aria-label="공정 이상 시나리오" className={cx(selCls, 'w-full')}>
              {SCENARIO_GROUPS.map((g) => (
                <optgroup key={g.line} label={g.name} className={optCls}>
                  {g.scenarios.map((s) => (
                    <option key={s.id} value={s.id} className={optCls}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <div role="group" aria-label="켜기·끄기" className="flex overflow-hidden rounded border border-line">
              {[true, false].map((on) => (
                <button key={String(on)} type="button" aria-pressed={e.on === on} onClick={() => onChange({ ...e, on })} className={cx('px-2 py-0.5', e.on === on ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}>
                  {on ? '켜기' : '끄기'}
                </button>
              ))}
            </div>
          </>
        ) : (
          <select value={e.station} onChange={(x) => onChange({ ...e, station: x.target.value })} aria-label="설비" className={cx(selCls, 'w-full')}>
            {STATION_GROUPS.map((g) => (
              <optgroup key={g.line} label={g.name} className={optCls}>
                {g.stations.map((c) => (
                  <option key={c} value={c} className={optCls}>
                    {c} {LINES.find((l) => l.code === g.line)?.stations.find((s) => s.code === c)?.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
        <label className="flex items-center gap-1">
          시작 +
          <input value={e.at} onChange={(x) => onChange({ ...e, at: digits(x.target.value) })} inputMode="numeric" aria-label="시작에서 몇 분 뒤" className={cx(numCls, 'w-14', outside && 'border-down/60')} />분
        </label>
        {e.kind === 'down' && (
          <label className="flex items-center gap-1">
            <input value={e.minutes} onChange={(x) => onChange({ ...e, minutes: digits(x.target.value) })} inputMode="numeric" aria-label="고장 시간 (분)" className={cx(numCls, 'w-14')} />분 동안 멈춤
          </label>
        )}
        {e.kind === 'pm' && <span>보전 약 {pm ?? '-'}분 (공장 정의)</span>}
      </div>
    </li>
  );
}
