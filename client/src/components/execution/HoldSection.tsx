'use client';

import { forwardRef, useEffect, useMemo, useState } from 'react';
import {
  EXEC_NOTE_MAX,
  FACTORY,
  HOLD_KIND_NAMES,
  HOLD_RESULT_NAMES,
  HOLD_SERIALS_MAX,
  HOLD_STATUS_NAMES,
  INTERLOCK_NAMES,
  LINES,
  type HoldCreate,
  type HoldDetail,
  type HoldKind,
  type HoldReleaseInput,
  type HoldResult,
  type HoldView,
  type LineCode,
  type QuarantineView,
} from '@lumitwin/shared';
import { C, ChartCard, Empty } from '@/components/charts/kit';
import { SegmentedBar } from '@/components/charts/small';
import { Stat } from '@/components/mes/PageShell';
import { api } from '@/lib/api';
import { UNIT_STATUS_NAMES, errText, useExecAction, useExecGate, useHold, useHolds } from '@/lib/execution';
import { cx, kst } from '@/lib/format';
import { useLive } from '@/lib/live';
import { ITEM_NAMES, stationName } from '@/lib/names';
import { MiniButton, Tabs, UnitStatusBadge, inputCls } from './bits';

/** 추적 화면이 넘기는 Hold 초안 (n이 바뀔 때마다 만들기 칸에 채운다) */
export interface HoldDraft {
  kind: HoldKind;
  material?: string;
  lot?: string;
  serials?: string[];
  n: number;
}

const MATERIAL_NAME: Record<string, string> = Object.fromEntries(FACTORY.materials.map((m) => [m.code, m.name]));
/** 자재 → 그 자재를 쓰는 라인 (만들기 칸에서 라인별로 묶어 보여 준다) */
const MATERIAL_LINE: Record<string, LineCode> = {};
for (const l of LINES) for (const s of l.steps) for (const i of s.inputs) if (i.material) MATERIAL_LINE[i.material] ??= l.code as LineCode;

/** 영향 범위 맨 위 제품 상태 색 */
const IMPACT_STATUS = [
  { key: 'DONE', label: '완제품 (출하됐을 수 있음)', color: C.series },
  { key: 'WIP', label: '공정 중', color: '#7b8798' },
  { key: 'HOLD', label: '격리', color: C.warn },
  { key: 'REPAIR', label: '수리대', color: 'var(--color-info)' },
  { key: 'NG', label: '불량', color: C.ng },
  { key: 'SCRAP', label: '폐기', color: '#3a4555' },
] as const;

const lineName = (code: string | null | undefined) => (code ? (LINES.find((l) => l.code === code)?.name ?? code) : '-');
const holdTarget = (h: Pick<HoldView, 'kind' | 'material' | 'lot' | 'serials'>) =>
  h.kind === 'LOT' ? `${h.material ? (MATERIAL_NAME[h.material] ?? h.material) : ''} · ${h.lot ?? ''}` : `${h.serials.slice(0, 3).join(', ')}${h.serials.length > 3 ? ` 외 ${h.serials.length - 3}개` : ''}`;
const splitSerials = (s: string) =>
  [...new Set(s.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];

/**
 * 추적 화면의 Hold 영역: 자재 LOT·시리얼 Hold를 걸고, 영향 범위(조립된 맨 위 제품)를 보고, 해제(다시 흘림) 또는 폐기한다.
 * 인터록에 걸려 격리 구역에 있는 묶음도 여기서 보여 주고, 골라서 시리얼 Hold로 묶어 처리할 수 있다
 */
export const HoldSection = forwardRef<HTMLDivElement, { line: LineCode; draft: HoldDraft | null }>(function HoldSection({ line, draft }, ref) {
  const q = useHolds();
  const [tab, setTab] = useState<'ACTIVE' | 'RELEASED'>('ACTIVE');
  const [selected, setSelected] = useState<number | null>(null);
  const [local, setLocal] = useState<HoldDraft | null>(null);
  useEffect(() => {
    if (draft) setLocal(draft);
  }, [draft]);

  const holds = q.data?.holds ?? [];
  const active = holds.filter((h) => h.status === 'ACTIVE');
  const released = holds.filter((h) => h.status === 'RELEASED');
  const list = tab === 'ACTIVE' ? active : released;
  const quarantine = q.data?.quarantine ?? [];

  // 고른 것이 없으면 활성 Hold 첫 건을 연다
  useEffect(() => {
    if (selected == null && active.length) setSelected(active[0].id);
  }, [selected, active]);

  const fromQuarantine = (serials: string[]) => setLocal({ kind: 'SERIAL', serials, n: Date.now() });

  return (
    <div ref={ref} className="mt-3 scroll-mt-2">
      <div className="grid gap-3 @6xl:grid-cols-5">
        <div className="flex flex-col gap-3 @6xl:col-span-2">
          <CreateHoldCard line={line} draft={local} onCreated={(h) => { setTab('ACTIVE'); setSelected(h.id); }} />
          <ChartCard
            title="Hold 목록"
            subtitle="활성 Hold는 게이트 설비 투입 확인(인터록)에서 대상 개체를 거부해 격리 구역으로 보냅니다."
            right={
              <Tabs
                label="Hold 상태"
                value={tab}
                onChange={setTab}
                items={[
                  ['ACTIVE', `${HOLD_STATUS_NAMES.ACTIVE} ${active.length}`],
                  ['RELEASED', `${HOLD_STATUS_NAMES.RELEASED} ${released.length}`],
                ]}
              />
            }
            stale={q.isFetching && q.isPlaceholderData}
          >
            {list.length ? (
              <ul className="scroll-thin flex max-h-[320px] flex-col gap-1 overflow-auto">
                {list.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(h.id)}
                      aria-pressed={selected === h.id}
                      className={cx('w-full rounded-md border px-2 py-1.5 text-left text-xs', selected === h.id ? 'border-info/60 bg-info/10' : 'border-line bg-white/[0.02] hover:bg-white/[0.06]')}
                    >
                      <span className="flex flex-wrap items-baseline gap-2">
                        <span className="num font-semibold">{h.code}</span>
                        <span className="rounded bg-white/10 px-1 text-[10px] text-sub">{HOLD_KIND_NAMES[h.kind]}</span>
                        {h.status === 'ACTIVE' ? (
                          h.quarantined.length > 0 && <span className="text-[11px] text-warn">격리 {h.quarantined.length}묶음</span>
                        ) : (
                          <span className={cx('text-[11px]', h.result === 'SCRAP' ? 'text-down' : 'text-run')}>{h.result ? HOLD_RESULT_NAMES[h.result] : '해제'}</span>
                        )}
                        <span className="num ml-auto text-[11px] text-dim">{kst(h.status === 'ACTIVE' ? h.createdAt : h.releasedAt, true)}</span>
                      </span>
                      <span className="num mt-0.5 block truncate text-sub">{holdTarget(h)}</span>
                      <span className="block truncate text-[11px] text-dim">{h.reason}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty h={80}>{q.isLoading ? '불러오는 중…' : q.error ? errText(q.error) : tab === 'ACTIVE' ? '걸려 있는 Hold가 없습니다.' : '해제된 Hold가 없습니다.'}</Empty>
            )}
          </ChartCard>
        </div>
        <div className="@6xl:col-span-3">
          <HoldDetailCard id={selected} />
        </div>
      </div>
      <QuarantineCard list={quarantine} onMakeHold={fromQuarantine} loading={q.isLoading} />
    </div>
  );
});

function CreateHoldCard({ line, draft, onCreated }: { line: LineCode; draft: HoldDraft | null; onCreated: (h: HoldView) => void }) {
  const gate = useExecGate('hold.create');
  const [kind, setKind] = useState<HoldKind>('LOT');
  const lineMaterials = useMemo(() => FACTORY.materials.filter((m) => MATERIAL_LINE[m.code] === line).map((m) => m.code), [line]);
  const [material, setMaterial] = useState<string>(lineMaterials[0] ?? FACTORY.materials[0]?.code ?? '');
  const [lot, setLot] = useState('');
  const [serials, setSerials] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!draft) return;
    setKind(draft.kind);
    if (draft.material) setMaterial(draft.material);
    if (draft.lot != null) setLot(draft.lot);
    if (draft.serials) setSerials(draft.serials.join('\n'));
    setError(null);
    setDone(null);
  }, [draft]);

  const create = useExecAction(
    (body: HoldCreate) => api.post<HoldView>('/holds', body),
    (h) => {
      setDone(`${h.code}을(를) 걸었습니다`);
      setError(null);
      setReason('');
      if (h.kind === 'SERIAL') setSerials('');
      onCreated(h);
    },
  );
  const list = splitSerials(serials);
  const submit = () => {
    const r = reason.trim();
    if (!r) return setError('Hold 사유를 적어 주세요');
    if (kind === 'LOT' && !lot.trim()) return setError('LOT 번호를 넣어 주세요');
    if (kind === 'SERIAL' && !list.length) return setError('Hold할 시리얼을 넣어 주세요');
    if (kind === 'SERIAL' && list.length > HOLD_SERIALS_MAX) return setError(`시리얼은 한 번에 ${HOLD_SERIALS_MAX}개까지입니다`);
    const body: HoldCreate = kind === 'LOT' ? { kind, material, lot: lot.trim().toUpperCase(), reason: r } : { kind, serials: list, reason: r };
    create.mutate(body, { onError: (e) => setError(errText(e)) });
  };
  const others = FACTORY.materials.filter((m) => !lineMaterials.includes(m.code));

  return (
    <ChartCard
      title="Hold 걸기"
      subtitle="자재 LOT Hold는 그 LOT를 쓴 부품과 그것이 조립된 제품을, 시리얼 Hold는 그 시리얼과 그것이 들어간 상위 제품을 묶습니다. 라인에 아직 투입 안 한 같은 LOT 자재도 시뮬레이터 자재 창고에서 막힙니다."
    >
      <form
        className="flex flex-col gap-2 text-xs"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Tabs
          label="Hold 종류"
          value={kind}
          onChange={setKind}
          items={[
            ['LOT', HOLD_KIND_NAMES.LOT],
            ['SERIAL', HOLD_KIND_NAMES.SERIAL],
          ]}
        />
        {kind === 'LOT' ? (
          <div className="flex flex-wrap gap-2">
            <select value={material} onChange={(e) => setMaterial(e.target.value)} aria-label="자재" className={cx(inputCls, 'text-xs')}>
              <optgroup label={lineName(line)} className="bg-[#0e141e]">
                {lineMaterials.map((m) => (
                  <option key={m} value={m} className="bg-[#0e141e]">
                    {MATERIAL_NAME[m]} ({m})
                  </option>
                ))}
              </optgroup>
              {others.length > 0 && (
                <optgroup label="다른 라인" className="bg-[#0e141e]">
                  {others.map((m) => (
                    <option key={m.code} value={m.code} className="bg-[#0e141e]">
                      {m.name} ({m.code})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <input
              value={lot}
              onChange={(e) => setLot(e.target.value)}
              placeholder={`${material}-YYMMDD-001`}
              aria-label="LOT 번호"
              className={cx(inputCls, 'num min-w-[12rem] flex-1 text-xs')}
            />
          </div>
        ) : (
          <textarea
            value={serials}
            onChange={(e) => setSerials(e.target.value)}
            rows={3}
            placeholder="시리얼 (줄바꿈·쉼표로 여러 개)"
            aria-label="Hold할 시리얼"
            className={cx(inputCls, 'num h-auto resize-y py-1 text-xs')}
          />
        )}
        {kind === 'SERIAL' && list.length > 0 && <span className="text-[11px] text-dim">시리얼 {list.length}개</span>}
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, EXEC_NOTE_MAX))}
          placeholder="사유 (필수: 수입검사 불합격 통보, 고객 클레임 등)"
          aria-label="Hold 사유"
          className={cx(inputCls, 'text-xs')}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={!gate.ok || create.isPending}
            title={gate.title}
            className="h-8 rounded-md border border-warn/50 bg-warn/10 px-3 text-sm hover:bg-warn/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Hold 걸기
          </button>
          {done && <span className="text-[11px] text-run">{done}</span>}
          {error && (
            <span role="alert" className="text-[11px] text-down">
              {error}
            </span>
          )}
        </div>
      </form>
    </ChartCard>
  );
}

function HoldDetailCard({ id }: { id: number | null }) {
  const q = useHold(id);
  const openTrace = useLive((s) => s.openTrace);
  const d = id != null && q.data?.id === id ? q.data : null;
  return (
    <ChartCard
      title={d ? <span className="num">{d.code}</span> : 'Hold 상세'}
      subtitle={d ? `${HOLD_KIND_NAMES[d.kind]} Hold · ${HOLD_STATUS_NAMES[d.status]}` : '왼쪽 목록에서 Hold를 고르세요'}
      legend={d ? IMPACT_STATUS.filter((s) => (d.impact.byStatus[s.key] ?? 0) > 0).map((s) => ({ label: s.label, color: s.color, shape: 'rect' as const })) : undefined}
      stale={q.isFetching && q.isPlaceholderData}
    >
      {!d ? (
        <Empty h={200}>{id == null ? '고른 Hold가 없습니다.' : q.error ? errText(q.error) : '불러오는 중…'}</Empty>
      ) : (
        <div className="flex flex-col gap-3 text-xs">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-dim">대상</dt>
            <dd className="num">
              {d.kind === 'LOT' ? (
                <>
                  {d.material ? (MATERIAL_NAME[d.material] ?? d.material) : ''} <span className="text-dim">({d.material})</span> · {d.lot}
                </>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {d.serials.map((s) => (
                    <button key={s} type="button" className="text-info hover:underline" onClick={() => openTrace(s)}>
                      {s}
                    </button>
                  ))}
                </span>
              )}
            </dd>
            <dt className="text-dim">사유</dt>
            <dd className="whitespace-pre-wrap">{d.reason}</dd>
            <dt className="text-dim">건 사람</dt>
            <dd>
              {d.createdBy ?? '-'} <span className="num text-dim">· {kst(d.createdAt, true)}</span>
            </dd>
            {d.status === 'RELEASED' && (
              <>
                <dt className="text-dim">판정</dt>
                <dd>
                  <span className={d.result === 'SCRAP' ? 'text-down' : 'text-run'}>{d.result ? HOLD_RESULT_NAMES[d.result] : '해제'}</span> · {d.releasedBy ?? '-'}{' '}
                  <span className="num text-dim">· {kst(d.releasedAt, true)}</span>
                </dd>
                {d.releaseNote && (
                  <>
                    <dt className="text-dim">판정 메모</dt>
                    <dd className="whitespace-pre-wrap">{d.releaseNote}</dd>
                  </>
                )}
              </>
            )}
          </dl>
          {d.status === 'RELEASED' && d.result === 'SCRAP' && (
            <div className="rounded-md border border-down/30 bg-down/[0.06] px-2 py-1.5 text-[11px] text-sub">
              폐기로 끝난 Hold입니다. 대상 개체가 게이트 설비에 다시 나타나면 인터록이 거부하고 자동으로 폐기합니다.
            </div>
          )}

          <Impact d={d} />

          {d.quarantined.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] text-dim">이 Hold로 격리 구역에 있는 묶음 ({d.quarantined.length})</div>
              <div className="num flex flex-wrap gap-1">
                {d.quarantined.map((s) => (
                  <button key={s} type="button" onClick={() => openTrace(s)} className="rounded bg-warn/15 px-1.5 text-[11px] text-warn hover:bg-warn/25">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {d.status === 'ACTIVE' && <ReleaseForm key={d.id} h={d} />}
        </div>
      )}
    </ChartCard>
  );
}

function Impact({ d }: { d: HoldDetail }) {
  const openTrace = useLive((s) => s.openTrace);
  const [more, setMore] = useState(false);
  const im = d.impact;
  const shown = more ? im.tops : im.tops.slice(0, 30);
  const etc = Object.entries(im.byStatus)
    .filter(([k]) => !IMPACT_STATUS.some((s) => s.key === k))
    .reduce((a, [, v]) => a + v, 0);
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 @4xl:grid-cols-4">
        <Stat label={d.kind === 'LOT' ? 'LOT를 쓴 부품' : 'Hold 시리얼'} value={`${im.base.toLocaleString('ko-KR')}개`} />
        <Stat label="영향 받는 맨 위 제품" value={`${im.tops.length.toLocaleString('ko-KR')}${im.truncated ? '+' : ''}개`} sub="부품이 조립돼 들어간 최종 상위 개체" />
        <Stat label="완제품" value={<span className={im.finished ? 'text-warn' : undefined}>{im.finished.toLocaleString('ko-KR')}개</span>} sub="창고·출하 대기: 회수 검토" />
        <Stat label="공정 안" value={`${im.inProcess.toLocaleString('ko-KR')}개`} sub="게이트에서 걸려 격리됩니다" />
      </div>
      <div className="mt-2">
        <SegmentedBar
          label={`${d.code} 영향 제품 상태`}
          height={10}
          parts={[
            ...IMPACT_STATUS.map((s) => ({ key: s.key, label: s.label, color: s.color, value: im.byStatus[s.key] ?? 0 })),
            { key: 'ETC', label: '기타', color: '#2a3341', value: etc },
          ]}
          format={(v) => `${v}개`}
        />
      </div>
      {im.tops.length ? (
        <div className="scroll-thin mt-2 max-h-[280px] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[var(--color-chart)] text-dim">
              <tr className="border-b border-line">
                <th className="py-1 pr-2 text-left font-normal">맨 위 제품</th>
                <th className="px-2 text-left font-normal">품목</th>
                <th className="px-2 text-left font-normal">라인</th>
                <th className="px-2 text-left font-normal">상태</th>
                <th className="px-2 text-right font-normal">대상 부품</th>
                <th className="pl-2 text-right font-normal">마지막 공정</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.serial} className="border-b border-line/60 whitespace-nowrap">
                  <td className="py-1 pr-2">
                    <button type="button" className="num font-semibold text-info hover:underline" onClick={() => openTrace(t.serial)}>
                      {t.serial}
                    </button>
                  </td>
                  <td className="px-2 text-sub">{t.item ? (ITEM_NAMES[t.item] ?? t.item) : '-'}</td>
                  <td className="px-2 text-sub">{lineName(t.line)}</td>
                  <td className="px-2">
                    <UnitStatusBadge status={t.status} defect={t.defect} />
                  </td>
                  <td className="num px-2 text-right">{t.parts}</td>
                  <td className="num pl-2 text-right text-dim">{kst(t.lastAt, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {im.tops.length > shown.length && (
            <button type="button" className="mt-1 text-xs text-info hover:underline" onClick={() => setMore(true)}>
              {im.tops.length - shown.length}개 더 보기
            </button>
          )}
          {im.truncated && <div className="mt-1 text-[11px] text-dim">영향 제품이 많아 앞부분만 보여 줍니다.</div>}
        </div>
      ) : (
        <Empty h={60}>{d.kind === 'LOT' ? '이 LOT를 쓴 기록이 아직 없습니다. 투입되는 순간 인터록이 막습니다.' : '이 시리얼의 공정 기록이 아직 없습니다.'}</Empty>
      )}
    </div>
  );
}

function ReleaseForm({ h }: { h: HoldView }) {
  const gate = useExecGate('hold.release');
  const [result, setResult] = useState<HoldResult>('RELEASE');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = useExecAction(
    (body: HoldReleaseInput) => api.post<HoldView>(`/holds/${h.id}/release`, body),
    () => {
      setError(null);
      setNote('');
    },
  );
  const submit = () => {
    const memo = note.trim();
    if (!memo) return setError('판정 근거를 메모로 남겨 주세요');
    const msg =
      result === 'SCRAP'
        ? `${h.code} 대상을 폐기할까요? 격리 구역의 묶음 ${h.quarantined.length}개를 폐기하고, 대상 개체가 다시 투입되면 자동으로 폐기합니다. 되돌릴 수 없습니다.`
        : `${h.code}을(를) 해제할까요? 격리 구역의 묶음 ${h.quarantined.length}개를 다시 라인으로 흘립니다.`;
    if (!window.confirm(msg)) return;
    act.mutate({ result, note: memo }, { onError: (e) => setError(errText(e)) });
  };
  return (
    <div className="rounded-md border border-line bg-white/[0.02] p-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-sub">Hold 판정</span>
        <Tabs
          label="Hold 판정"
          value={result}
          onChange={setResult}
          items={[
            ['RELEASE', HOLD_RESULT_NAMES.RELEASE],
            ['SCRAP', HOLD_RESULT_NAMES.SCRAP],
          ]}
        />
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, EXEC_NOTE_MAX))}
        rows={2}
        placeholder="판정 메모 (필수: 재검사 결과, 공급사 회신 등)"
        aria-label="Hold 판정 메모"
        className={cx(inputCls, 'h-auto w-full resize-y py-1 text-xs')}
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <MiniButton tone={result === 'SCRAP' ? 'danger' : 'primary'} onClick={submit} disabled={!gate.ok || act.isPending} title={gate.title}>
          {result === 'SCRAP' ? '폐기로 끝내기' : '해제하기'}
        </MiniButton>
        {error && (
          <span role="alert" className="text-[11px] text-down">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

function QuarantineCard({ list, onMakeHold, loading }: { list: QuarantineView[]; onMakeHold: (serials: string[]) => void; loading: boolean }) {
  const openTrace = useLive((s) => s.openTrace);
  const gate = useExecGate('hold.create');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // 목록에서 사라진(해제·폐기된) 묶음은 고른 것에서도 뺀다
  useEffect(() => {
    setPicked((p) => {
      const keep = new Set([...p].filter((s) => list.some((q) => q.serial === s)));
      return keep.size === p.size ? p : keep;
    });
  }, [list]);
  const free = list.filter((q) => q.holdId == null);
  const toggle = (s: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });
  return (
    <ChartCard
      className="mt-3"
      title="격리 구역"
      subtitle="게이트 설비 인터록에 걸려 라인 밖 격리 구역에 놓인 투입 묶음입니다. Hold로 걸린 것은 그 Hold를 해제·폐기하면 함께 처리됩니다. Hold 없이 걸린 것(공정 순서·불량 미처리 등)은 골라서 시리얼 Hold로 묶은 뒤 판정하세요."
      right={
        <MiniButton onClick={() => onMakeHold([...picked])} disabled={!gate.ok || picked.size === 0} title={gate.title ?? '고른 묶음의 시리얼로 Hold 만들기 칸을 채웁니다'}>
          고른 묶음으로 시리얼 Hold 만들기 ({picked.size})
        </MiniButton>
      }
    >
      {list.length ? (
        <div className="scroll-thin max-h-[320px] overflow-auto">
          <table className="w-full min-w-[820px] text-xs">
            <thead className="sticky top-0 bg-[var(--color-chart)] text-dim">
              <tr className="border-b border-line">
                <th className="w-6 py-1.5 pr-1 text-left font-normal">
                  <input
                    type="checkbox"
                    aria-label="Hold 없는 묶음 모두 고르기"
                    checked={free.length > 0 && free.every((q) => picked.has(q.serial))}
                    onChange={(e) => setPicked(e.target.checked ? new Set(free.map((q) => q.serial)) : new Set())}
                  />
                </th>
                <th className="px-2 text-left font-normal">시리얼</th>
                <th className="px-2 text-left font-normal">라인 · 설비</th>
                <th className="px-2 text-left font-normal">거부 사유</th>
                <th className="px-2 text-left font-normal">내용</th>
                <th className="px-2 text-left font-normal">Hold</th>
                <th className="pl-2 text-right font-normal">시각</th>
              </tr>
            </thead>
            <tbody>
              {list.map((q) => (
                <tr key={q.serial} className={cx('border-b border-line/60', picked.has(q.serial) && 'bg-info/10')}>
                  <td className="py-1 pr-1">
                    <input type="checkbox" aria-label={`${q.serial} 고르기`} checked={picked.has(q.serial)} onChange={() => toggle(q.serial)} />
                  </td>
                  <td className="num px-2 whitespace-nowrap">
                    <button type="button" className="text-info hover:underline" onClick={() => openTrace(q.serial)}>
                      {q.serial}
                    </button>
                    {q.comps.length > 0 && (
                      <span className="ml-1 text-dim" title={q.comps.join(', ')}>
                        +부품 {q.comps.length}
                      </span>
                    )}
                  </td>
                  <td className="px-2 whitespace-nowrap text-sub">
                    {lineName(q.line)} · {stationName(q.station)}
                  </td>
                  <td className="px-2 whitespace-nowrap">{INTERLOCK_NAMES[q.code]}</td>
                  <td className="max-w-[280px] truncate px-2 text-sub" title={q.reason}>
                    {q.reason}
                  </td>
                  <td className="num px-2 whitespace-nowrap">{q.holdCode ? <span className="text-warn">{q.holdCode}</span> : <span className="text-dim">없음</span>}</td>
                  <td className="num pl-2 text-right whitespace-nowrap text-dim">{kst(q.at, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty h={60}>{loading ? '불러오는 중…' : '격리 구역이 비어 있습니다.'}</Empty>
      )}
    </ChartCard>
  );
}

/** 추적 화면 표·CSV에 쓰는 개체 상태 이름 (P9 상태 포함) */
export const unitStatusName = (s: string | null | undefined) => (s ? (UNIT_STATUS_NAMES[s] ?? s) : '');
