'use client';

import Link from 'next/link';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  CHANGE_CATEGORY_NAMES,
  CHANGE_KIND_NAMES,
  CHANGE_SOURCE_NAMES,
  INSPECTION_NAMES,
  LINES,
  MID_INSPECT_HOURS,
  STATIONS,
  variantName,
  type ChangeCategory,
  type ChangePointView,
  type InspectionType,
  type LineCode,
} from '@lumitwin/shared';
import { Empty } from '@/components/charts/kit';
import { PageShell, Stat } from '@/components/mes/PageShell';
import { ChangeReportForm } from '@/components/quality-system/ChangeReportForm';
import { CategoryTag, FaChip } from '@/components/quality-system/badges';
import { InspectionValues } from '@/components/quality-system/InspectionValues';
import { useGate } from '@/lib/auth';
import { cx, duration, kst } from '@/lib/format';
import { useLive } from '@/lib/live';
import { CATEGORY_COLOR, CATEGORY_ORDER, CATEGORY_SHORT, personName, useApproveChange, useChanges, useFaStatus, useInspections, useManualFirst } from '@/lib/quality-system';
import { useFocusTarget } from '@/lib/ui';

type Scope = 'ALL' | LineCode;
const PERIODS: { h: number; label: string }[] = [
  { h: 1, label: '1시간' },
  { h: 4, label: '4시간' },
  { h: 12, label: '12시간' },
  { h: 24, label: '24시간' },
  { h: 0, label: '실행 전체' },
];
const INSP_TYPES: ('ALL' | InspectionType)[] = ['ALL', 'FIRST', 'MID', 'LAST'];
const LIST_LIMIT = 1000;

/** 같은 날(한국 시각)이면 시:분:초, 아니면 월-일 시:분 */
function when(iso: string | null | undefined, now: string | null | undefined): string {
  if (!iso) return '-';
  const day = (x: string) => new Date(Date.parse(x) + 9 * 3_600_000).toISOString().slice(5, 10);
  return now && day(iso) === day(now) ? kst(iso) : `${day(iso)} ${kst(iso).slice(0, 5)}`;
}

/** 여러 개 중 하나 고르기 (필터 줄) */
function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex overflow-hidden rounded-md border border-line text-xs">
      {options.map((o) => (
        <button
          key={String(o.id)}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={cx('px-2.5 py-1.5', value === o.id ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ApproveCell({ c, now }: { c: ChangePointView; now: string | null | undefined }) {
  const gate = useGate('change.approve');
  const approve = useApproveChange();
  if (c.approvedBy) {
    return (
      <span className="text-xs text-run" title={`${personName(c.approvedBy)} 확인`}>
        ✓ {personName(c.approvedBy)} <span className="num text-dim">{when(c.approvedAt, now)}</span>
      </span>
    );
  }
  const waiting = c.faStatus === 'PENDING' || c.faStatus === 'NG';
  // 보기 전용 → 로그인 → 권한(change.approve) → 초물 판정 순으로 막는다
  const block = !gate.ok
    ? (gate.title ?? '승인 권한이 없습니다')
    : waiting
        ? c.faStatus === 'NG'
          ? '초물이 불합격입니다. 다시 한 초물이 합격한 뒤 승인할 수 있습니다'
          : '초물 합격 뒤 승인할 수 있습니다'
        : undefined;
  const pending = approve.isPending && approve.variables === c.id;
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <button
        disabled={!!block || pending}
        title={block ?? '품질 확인 서명 (감사 기록에 남는다)'}
        onClick={() => approve.mutate(c.id)}
        className="rounded border border-info/50 bg-info/10 px-2 py-0.5 text-xs text-info hover:bg-info/20 disabled:opacity-40"
      >
        {pending ? '승인 중…' : '승인'}
      </button>
      {approve.error && approve.variables === c.id && <span className="text-[11px] text-down">{(approve.error as Error).message}</span>}
    </span>
  );
}

/** 품질 담당 수동 초물 판정: 시뮬레이터가 초물을 못 낼 때(설비 정지·사람 신고 뒤) 사람이 직접 확인하고 대기를 푼다 */
function ManualFirst({ station }: { station: string }) {
  const gate = useGate('change.approve');
  const judge = useManualFirst();
  const [serial, setSerial] = useState('');
  const busy = judge.isPending && judge.variables?.station === station;
  const send = (result: 'OK' | 'NG') => judge.mutate({ station, result, serial: serial.trim() || undefined, note: '변경점 화면 수동 초물 판정' });
  const btn = 'rounded border px-2 py-0.5 text-[11px] disabled:opacity-40';
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5" aria-label="수동 초물 판정">
      <input
        value={serial}
        onChange={(e) => setSerial(e.target.value)}
        placeholder="확인한 시리얼 (선택)"
        aria-label="확인한 시리얼"
        disabled={!gate.ok}
        className="w-36 rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[11px] text-ink placeholder:text-dim disabled:opacity-40"
      />
      <button disabled={!gate.ok || busy} title={gate.title ?? '이 설비의 초물 대기를 합격으로 푼다 (감사 기록)'} onClick={() => send('OK')} className={cx(btn, 'border-run/50 bg-run/10 text-run hover:bg-run/20')}>
        수동 합격
      </button>
      <button disabled={!gate.ok || busy} title={gate.title ?? '초물 불합격: 다시 확인할 때까지 투입 대기 (감사 기록)'} onClick={() => send('NG')} className={cx(btn, 'border-down/50 bg-down/10 text-down hover:bg-down/20')}>
        불합격
      </button>
      {judge.error && judge.variables?.station === station && <span className="text-[11px] text-down">{(judge.error as Error).message}</span>}
    </div>
  );
}

export default function ChangesPage() {
  const simT = useLive((s) => s.sim?.t);
  const registerGate = useGate('change.register');
  const [scope, setScope] = useState<Scope>('ALL');
  const [station, setStation] = useState('');
  const [category, setCategory] = useState<'ALL' | ChangeCategory>('ALL');
  const [period, setPeriod] = useState(12);
  const [inspType, setInspType] = useState<'ALL' | InspectionType>('ALL');
  const [openInsp, setOpenInsp] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);

  // 다른 화면(AI 비서·작업자 태블릿)에서 ?station=… 으로 들어오면 그 설비로 좁힌다
  useFocusTarget((f) => {
    if (!f.station || !STATIONS[f.station]) return;
    setScope(STATIONS[f.station].line);
    setStation(f.station);
  });

  const line = scope === 'ALL' ? undefined : scope;
  const changes = useChanges({ line, station: station || undefined, category: category === 'ALL' ? undefined : category, limit: LIST_LIMIT });
  const insp = useInspections({ line, station: station || undefined, type: inspType === 'ALL' ? undefined : inspType, limit: 300 });
  const fa = useFaStatus();

  const cutoff = period && simT ? Date.parse(simT) - period * 3_600_000 : -Infinity;
  const list = useMemo(() => (changes.data ?? []).filter((c) => Date.parse(c.at) >= cutoff), [changes.data, cutoff]);
  const inspections = useMemo(() => (insp.data ?? []).filter((r) => Date.parse(r.at) >= cutoff), [insp.data, cutoff]);
  const waiting = useMemo(
    () =>
      (fa.data ?? [])
        .filter((s) => s.pending.length && (!line || s.line === line) && (!station || s.station === station))
        .sort((a, b) => Date.parse(a.pending[0].since) - Date.parse(b.pending[0].since)),
    [fa.data, line, station],
  );

  const byCat = CATEGORY_ORDER.map((c) => {
    const rows = list.filter((x) => x.category === c);
    return { c, n: rows.length, user: rows.filter((x) => x.source === 'USER').length, fa: rows.filter((x) => x.faStatus !== 'NONE').length, ng: rows.filter((x) => x.faStatus === 'NG').length };
  });
  const toApprove = list.filter((x) => !x.approvedBy && (x.faStatus === 'OK' || x.faStatus === 'NONE')).length;
  const firstNg = inspections.filter((r) => r.type === 'FIRST' && r.result === 'NG').length;
  const stations = LINES.filter((l) => !line || l.code === line).flatMap((l) => l.stations);
  const truncated = (changes.data?.length ?? 0) >= LIST_LIMIT;
  const registerBlock = registerGate.ok ? undefined : registerGate.title;

  return (
    <PageShell
      title="변경점·초중종물 (4M)"
      desc={`사람(Man)·설비(Machine)·자재(Material)·방법(Method)이 바뀌면 그 뒤 첫 개체를 초물로 검사하고 합격해야 다음 투입을 받습니다 (인터록 게이트 설비). 중물은 ${MID_INSPECT_HOURS}시간마다, 종물은 교대 끝·작업지시 마지막 개체로 검사합니다. 시각은 가상 시계(한국 시각)입니다.`}
      filters={
        <>
          <Seg<Scope>
            label="라인"
            value={scope}
            onChange={(v) => {
              setScope(v);
              setStation('');
            }}
            options={[{ id: 'ALL', label: '전체 라인' }, ...LINES.map((l) => ({ id: l.code as Scope, label: l.short }))]}
          />
          <select
            aria-label="설비"
            value={station}
            onChange={(e) => setStation(e.target.value)}
            className="h-8 rounded-md border border-line bg-[var(--color-panel-solid)] px-2 text-xs text-ink outline-none focus:border-info/60"
          >
            <option value="">모든 설비</option>
            {stations.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code} {s.name}
              </option>
            ))}
          </select>
          <Seg<'ALL' | ChangeCategory>
            label="4M 분류"
            value={category}
            onChange={setCategory}
            options={[{ id: 'ALL', label: '4M 전체' }, ...CATEGORY_ORDER.map((c) => ({ id: c, label: CATEGORY_SHORT[c] }))]}
          />
          <Seg<number> label="기간" value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ id: p.h, label: p.label }))} />
          <button
            onClick={() => setShowForm((v) => !v)}
            aria-expanded={showForm}
            title={registerBlock}
            className={cx('ml-auto rounded-md border px-3 py-1.5 text-xs font-semibold', showForm ? 'border-warn/60 bg-warn/20 text-warn' : 'border-warn/50 bg-warn/10 text-warn hover:bg-warn/20')}
          >
            {showForm ? '신고 양식 닫기' : '+ 변경점 신고'}
          </button>
        </>
      }
    >
      {showForm && (
        <section className="card @container mb-3 p-4" aria-label="변경점 신고">
          <h2 className="mb-2 text-sm font-semibold">변경점 신고</h2>
          <ChangeReportForm station={station || undefined} />
        </section>
      )}

      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-3 @6xl:grid-cols-6">
        {byCat.map(({ c, n, user, fa: f, ng }) => (
          <button
            key={c}
            onClick={() => setCategory(category === c ? 'ALL' : c)}
            aria-pressed={category === c}
            title={category === c ? '4M 전체 보기' : `${CHANGE_CATEGORY_NAMES[c]}만 보기`}
            className={cx('card min-w-0 p-3 text-left hover:bg-white/[0.04]', category === c && 'border-info/60')}
          >
            <span className="block text-xs text-sub">{CHANGE_CATEGORY_NAMES[c]}</span>
            <span className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <span className="size-2.5 rounded-full" style={{ background: CATEGORY_COLOR[c] }} />
              <span className="num">{n}</span>
            </span>
            <span className="mt-0.5 block text-[11px] text-dim">
              사람 신고 {user} · 초물 대상 {f}
              {ng ? ` · 초물 불합격 ${ng}` : ''}
            </span>
          </button>
        ))}
        <Stat label="초물 대기 설비" value={<span className={cx('num', waiting.length > 0 && 'text-warn')}>{waiting.length}</span>} sub="합격 전에는 게이트 설비 투입이 대기한다" />
        <Stat label="승인 대기" value={<span className="num">{toApprove}</span>} sub={`초물 판정이 끝난 미승인 변경점 · 초물 불합격 ${firstNg}건`} />
      </div>

      <div className="mt-3 grid gap-3 @6xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="card min-w-0 p-4" aria-label="변경점 목록">
          <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">변경점 ({list.length}건)</h2>
            <span className="text-[11px] text-dim">
              새것부터 · 설비 감지(시뮬레이터)와 사람 신고{truncated ? ` · 최근 ${LIST_LIMIT}건까지만 불러왔습니다` : ''}
            </span>
          </header>
          {list.length === 0 ? (
            <Empty h={140}>{changes.isLoading ? '불러오는 중…' : '이 조건의 변경점이 없습니다. 교대·자재 LOT·기종 변경·고장 수리 때 설비가 알려 줍니다.'}</Empty>
          ) : (
            <div className="scroll-thin max-h-[560px] overflow-auto">
              <table className="w-full min-w-[860px] text-xs">
                <thead className="sticky top-0 z-10 bg-[var(--color-chart)] text-dim">
                  <tr>
                    {['시각', '설비', '4M', '종류', '내용', '출처', '초물', '승인'].map((h) => (
                      <th key={h} className="border-b border-line px-2 py-1.5 text-left font-normal whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.map((c) => (
                    <tr key={c.id} className="border-b border-line/60 align-top">
                      <td className="num px-2 py-1.5 whitespace-nowrap text-sub">{when(c.at, simT)}</td>
                      <td className="px-2 py-1.5">
                        <span className="num text-info">{c.station}</span> <span className="text-sub">{STATIONS[c.station]?.name}</span>
                      </td>
                      <td className="px-2 py-1.5">
                        <CategoryTag category={c.category} />
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{CHANGE_KIND_NAMES[c.kind] ?? c.kind}</td>
                      <td className="px-2 py-1.5">{c.detail}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <span className={c.source === 'USER' ? 'text-warn' : 'text-sub'}>{c.source === 'USER' ? personName(c.createdBy) || CHANGE_SOURCE_NAMES.USER : CHANGE_SOURCE_NAMES.SIM}</span>{' '}
                        <span className="num text-dim">{c.simId}</span>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <FaChip status={c.faStatus} serial={c.faSerial} />
                        {c.faSerial && (
                          <span className="num ml-1 text-[11px] text-dim" title="초물 개체">
                            {c.faSerial}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <ApproveCell c={c} now={simT} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card min-w-0 p-4" aria-label="초물 대기 설비">
          <header className="mb-2">
            <h2 className="text-sm font-semibold">초물 대기 설비 ({waiting.length})</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-sub">MES 메모리의 대기 목록입니다 (인터록이 투입마다 묻는 것과 같은 답). 오래 기다린 순.</p>
          </header>
          {waiting.length === 0 ? (
            <Empty h={120}>초물을 기다리는 설비가 없습니다</Empty>
          ) : (
            <ul className="scroll-thin max-h-[520px] space-y-2 overflow-y-auto">
              {waiting.map((s) => {
                const first = s.pending[0];
                const ng = s.pending.some((p) => p.status === 'NG');
                const def = STATIONS[s.station];
                return (
                  <li key={s.station} className={cx('rounded-lg border px-3 py-2', ng ? 'border-down/40 bg-down/[0.06]' : 'border-warn/30 bg-warn/[0.05]')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm">
                        <span className="num text-info">{s.station}</span> {def?.name}
                      </span>
                      <FaChip status={ng ? 'NG' : 'PENDING'} />
                    </div>
                    <div className="mt-1 text-xs text-sub">
                      {s.pending.length}건 대기 · 가장 오래된 것 {simT ? duration((Date.parse(simT) - Date.parse(first.since)) / 1000) : '-'} 전
                      {def?.gate ? ' · 투입 대기 중 (인터록)' : ' · 기록만 (게이트 아님)'}
                    </div>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {s.pending.slice(-3).map((p) => (
                        <li key={p.simId ?? p.changeId} className="flex items-center gap-2">
                          <CategoryTag category={p.category} />
                          <span className="min-w-0 flex-1 truncate" title={p.detail}>
                            {p.detail}
                          </span>
                          <span className="num text-dim">{p.simId}</span>
                        </li>
                      ))}
                    </ul>
                    {s.lastFirst && (
                      <div className="mt-1 text-[11px] text-dim">
                        마지막 초물 <span className="num">{kst(s.lastFirst.at)}</span> {s.lastFirst.serial} ·{' '}
                        <span className={s.lastFirst.result === 'NG' ? 'text-down' : 'text-run'}>{s.lastFirst.result === 'NG' ? '불합격' : '합격'}</span>
                      </div>
                    )}
                    <ManualFirst station={s.station} />
                    <Link href={`/operator/${s.station}`} className="mt-1 inline-block text-[11px] text-info hover:underline">
                      작업자 태블릿 열기 →
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="card mt-3 min-w-0 p-4" aria-label="초·중·종물 검사 기록">
        <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">초·중·종물 검사 기록 ({inspections.length}건)</h2>
            <p className="mt-0.5 text-[11px] text-sub">행을 누르면 그 개체의 측정값·공정값을 규격과 함께 봅니다. 초물은 어느 변경점의 초물인지 번호가 붙습니다.</p>
          </div>
          <Seg<'ALL' | InspectionType>
            label="검사 종류"
            value={inspType}
            onChange={setInspType}
            options={INSP_TYPES.map((t) => ({ id: t, label: t === 'ALL' ? '전체' : INSPECTION_NAMES[t] }))}
          />
        </header>
        {inspections.length === 0 ? (
          <Empty h={120}>{insp.isLoading ? '불러오는 중…' : '이 조건의 검사 기록이 없습니다'}</Empty>
        ) : (
          <div className="scroll-thin max-h-[520px] overflow-auto">
            <table className="w-full min-w-[760px] text-xs">
              <thead className="sticky top-0 z-10 bg-[var(--color-chart)] text-dim">
                <tr>
                  {['시각', '설비', '종류', '시리얼', '기종', '판정', '변경점', '값'].map((h) => (
                    <th key={h} className="border-b border-line px-2 py-1.5 text-left font-normal whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inspections.map((r) => {
                  const open = openInsp === r.id;
                  return (
                    <Fragment key={r.id}>
                      <tr className={cx('cursor-pointer border-b border-line/60 hover:bg-white/[0.04]', open && 'bg-white/[0.04]')} onClick={() => setOpenInsp(open ? null : r.id)}>
                        <td className="num px-2 py-1.5 whitespace-nowrap text-sub">{when(r.at, simT)}</td>
                        <td className="px-2 py-1.5">
                          <span className="num text-info">{r.station}</span> <span className="text-sub">{STATIONS[r.station]?.name}</span>
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{INSPECTION_NAMES[r.type]}</td>
                        <td className="num px-2 py-1.5">{r.serial}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap text-sub">{r.variant ? variantName(r.line, r.variant) : '-'}</td>
                        <td className={cx('px-2 py-1.5 font-semibold', r.result === 'NG' ? 'text-down' : 'text-run')}>{r.result === 'NG' ? '불합격' : '합격'}</td>
                        <td className="num px-2 py-1.5 text-dim">{r.changeSimId ?? '-'}</td>
                        <td className="px-2 py-1.5">
                          <button
                            aria-expanded={open}
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenInsp(open ? null : r.id);
                            }}
                            className="rounded border border-line px-2 py-0.5 text-[11px] text-sub hover:bg-white/10"
                          >
                            {open ? '접기' : `값 ${Object.keys(r.values).length}개`}
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-line/60 bg-white/[0.02]">
                          <td colSpan={8} className="px-3 py-2">
                            <InspectionValues station={r.station} values={r.values} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PageShell>
  );
}
