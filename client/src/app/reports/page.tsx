'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  INTERLOCK_NAMES,
  LINES,
  WO_STATUS_NAMES,
  variantName,
  type InterlockCode,
  type LineCode,
  type ShiftLineReport,
  type ShiftReport,
  type StationState,
} from '@lumitwin/shared';
import { Empty, Key } from '@/components/charts/kit';
import { Meter } from '@/components/charts/small';
import { TopBar } from '@/components/hud/TopBar';
import { cx, duration, kst, pct } from '@/lib/format';
import { fetchShift, fetchShifts, kwh, perUnit, shiftCsvUrl } from '@/lib/insights';
import { useLive } from '@/lib/live';
import { useUi } from '@/lib/ui';

type Scope = 'ALL' | LineCode;

const lineDef = (code: string) => LINES.find((l) => l.code === code);
const HALT_NAMES: Partial<Record<StationState, string>> = { DOWN: '고장', SETUP: '셋업', STOP: '계획 정지' };
const n = (v: number) => v.toLocaleString('ko-KR');

/**
 * 인쇄(A4 세로): 메뉴·버튼·다른 창은 숨기고, 어두운 화면 색을 흰 종이 색으로 바꾼다.
 * 화면 전체가 한 화면 높이로 잘려 있으므로(overflow hidden) 인쇄할 때는 높이·스크롤을 풀어 여러 쪽으로 흘린다
 */
const PRINT_CSS = `
@media print {
  @page { size: A4 portrait; margin: 10mm; }
  html { font-size: 11px !important; }
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  body > *:not(#report-print):not(:has(#report-print)) { display: none !important; }
  #report-print {
    display: block !important; height: auto !important; padding: 0 !important; color: #111; font-size: 10px;
    --color-chart: #fff; --color-bg: #fff; --color-panel: #fff; --color-ink: #111; --color-sub: #3a3a3a; --color-dim: #666;
    --color-line: #bdbdbd; --color-grid: #ddd; --color-axis: #999;
    --color-warn: #9a5b00; --color-down: #b3121f; --color-run: #12703a; --color-info: #1d5fa8;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  #report-print .card { break-inside: avoid; border-color: #bdbdbd; }
  #report-print .report-scroll { overflow: visible !important; height: auto !important; padding: 0 !important; }
  #report-print table { font-size: 9px; }
  #report-print tr { break-inside: avoid; }
}
`;

export default function ReportsPage() {
  const assistant = useUi((s) => s.assistantOpen);
  const socket = useLive((s) => s.socket);
  const [picked, setPicked] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>('ALL');

  const list = useQuery({ queryKey: ['report-shifts'], queryFn: fetchShifts, refetchInterval: 30_000 });
  const shifts = list.data?.shifts ?? [];
  const key = picked && shifts.some((s) => s.key === picked) ? picked : (shifts[0]?.key ?? null);
  const opt = shifts.find((s) => s.key === key);
  const q = useQuery({
    queryKey: ['report-shift', key],
    queryFn: () => fetchShift(key!),
    enabled: !!key,
    refetchInterval: opt?.current ? 15_000 : false,
    placeholderData: keepPreviousData,
  });
  const report = q.data;
  const lines = (report?.lines ?? []).filter((l) => scope === 'ALL' || l.line === scope);

  const status = list.isLoading
    ? '불러오는 중…'
    : list.error
      ? (list.error as Error).message
      : !shifts.length
        ? '아직 기록된 실행이 없습니다. 시뮬레이터를 켜면 교대가 쌓입니다.'
        : q.isLoading
          ? '불러오는 중…'
          : q.error
            ? (q.error as Error).message
            : null;

  return (
    <main id="report-print" className="flex h-screen flex-col gap-2 p-2">
      <style>{PRINT_CSS}</style>
      <div className="print:hidden">
        <TopBar />
      </div>
      <div className={cx('report-scroll scroll-thin min-h-0 flex-1 overflow-y-auto', assistant && 'pr-[448px] print:pr-0')}>
        <div className="@container mx-auto max-w-[1680px] px-2 pb-10 print:max-w-none print:px-0 print:pb-0">
          <div className="pt-3 pb-3 print:hidden">
            <h1 className="text-lg font-semibold">교대 일보</h1>
            <p className="mt-0.5 text-xs text-sub">
              교대(주간 08~20시 · 야간 20~익일 08시, 가상 한국 시각) 한 번 동안의 생산 계획 대비 실적, 품질(불량·NCR·초중종물), 설비(OEE·비가동), 변경점, 인터록, 전력을 라인별로 모읍니다. 값은 MES에 쌓인 기록에서
              계산하고, 진행 중인 교대는 지금까지의 값입니다. CSV는 엑셀에서 바로 열리고, 인쇄는 A4 세로로 맞춥니다.
            </p>
          </div>
          {!socket && <div className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-ink print:hidden">MES 서버(8790)에 연결하는 중입니다.</div>}

          <div className="mb-3 flex flex-wrap items-center gap-2 print:hidden">
            <label className="flex items-center gap-2 text-xs text-sub">
              교대
              <select
                value={key ?? ''}
                onChange={(e) => setPicked(e.target.value)}
                disabled={!shifts.length}
                className="rounded border border-line bg-[var(--color-chart)] px-2 py-1 text-sm text-ink"
              >
                {shifts.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.name} ({kst(s.start).slice(0, 5)}~{kst(s.end).slice(0, 5)}){s.current ? ' · 진행 중' : ''}
                  </option>
                ))}
              </select>
            </label>
            <div role="tablist" aria-label="라인 선택" className="flex overflow-hidden rounded border border-line text-xs">
              {(['ALL', ...LINES.map((l) => l.code)] as Scope[]).map((c) => (
                <button key={c} role="tab" aria-selected={scope === c} onClick={() => setScope(c)} className={cx('px-2.5 py-1', scope === c ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}>
                  {c === 'ALL' ? '전체 라인' : lineDef(c)?.name}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
              {key ? (
                <a href={shiftCsvUrl(key)} download className="rounded border border-line px-2.5 py-1 text-xs text-sub hover:bg-white/10 hover:text-ink" title="모든 라인을 한 파일로 (엑셀용 UTF-8)">
                  CSV 내려받기
                </a>
              ) : (
                <span className="cursor-not-allowed rounded border border-line px-2.5 py-1 text-xs text-dim">CSV 내려받기</span>
              )}
              <button
                onClick={() => window.print()}
                disabled={!report}
                className={cx('rounded border px-2.5 py-1 text-xs', report ? 'border-info/60 bg-info/15 text-ink hover:bg-info/25' : 'cursor-not-allowed border-line text-dim')}
                title="브라우저 인쇄 창에서 'PDF로 저장'을 고르면 PDF가 됩니다"
              >
                인쇄 / PDF 저장
              </button>
            </div>
          </div>

          {status || !report ? (
            <section className="card p-4">
              <Empty h={200}>{status ?? '교대를 고르세요.'}</Empty>
            </section>
          ) : (
            <div className={cx('transition-opacity', q.isFetching && q.isPlaceholderData && 'opacity-60')}>
              <ReportHead r={report} />
              <div className="mt-3 grid gap-3 @5xl:grid-cols-3 print:grid-cols-3 print:gap-2">
                {lines.map((l) => (
                  <LineCard key={l.line} l={l} />
                ))}
              </div>
              <SummaryTable r={report} lines={lines} />
              <OrdersTable lines={lines} />
              <div className="mt-3 grid gap-3 @5xl:grid-cols-2 print:grid-cols-2 print:gap-2">
                <DowntimeTable lines={lines} />
                <DefectTable lines={lines} />
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-dim">
                가상 공장(공개 자료 기반 시뮬레이션)의 기록입니다. 목표는 집계 구간 ÷ 택트(계획 정지 포함한 상한), OEE는 라인 가공 설비의 시간을 합친 값(6대 로스 화면과 같은 정의), 직행률은 공정별 첫 판정 합격률의
                곱입니다. 폐기 = 제품 경로 밖 불량(바로 버림) + 불량 처리의 폐기·수리 실패 + Hold 폐기.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function ReportHead({ r }: { r: ShiftReport }) {
  return (
    <section className="card flex flex-wrap items-start justify-between gap-3 p-4">
      <div>
        <div className="text-xs text-sub">교대 일보 · 실행 #{r.runId}</div>
        <h2 className="mt-0.5 text-xl font-semibold">
          {r.date} {r.code === 'D' ? '주간' : '야간'}
          <span className="ml-2 text-sm font-normal text-sub">
            {kst(r.start).slice(0, 5)} ~ {kst(r.end).slice(0, 5)}
          </span>
          {r.current && <span className="ml-2 rounded bg-info/15 px-1.5 py-px align-middle text-xs font-normal text-info">진행 중</span>}
        </h2>
        <div className="num mt-1 text-[11px] text-dim">
          집계 {kst(r.from, true).slice(0, 16)} ~ {kst(r.to, true).slice(0, 16)} (가상 한국 시각){r.current ? ' · 지금까지' : ''}
          {Date.parse(r.from) > Date.parse(r.start) ? ' · 실행이 교대 중에 시작' : ''}
        </div>
      </div>
      {/* 결재란: 종이 일보처럼 작성·검토·승인 칸 (인쇄에서만) */}
      <table className="hidden border-collapse text-center text-[10px] print:table">
        <tbody>
          <tr>
            {['작성', '검토', '승인'].map((x) => (
              <td key={x} className="w-16 border border-line px-2 py-0.5 text-sub">
                {x}
              </td>
            ))}
          </tr>
          <tr>
            {['작성', '검토', '승인'].map((x) => (
              <td key={x} className="h-10 border border-line" />
            ))}
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function Mini({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'warn' | 'down' }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-dim">{label}</div>
      <div className={cx('num text-sm font-semibold', tone === 'warn' ? 'text-warn' : tone === 'down' ? 'text-down' : 'text-ink')}>{value}</div>
      {sub && <div className="num truncate text-[10px] text-dim">{sub}</div>}
    </div>
  );
}

function LineCard({ l }: { l: ShiftLineReport }) {
  const def = lineDef(l.line);
  const rate = l.target > 0 ? l.ok / l.target : null;
  const ilk = Object.entries(l.interlock.byCode)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([c, v]) => `${INTERLOCK_NAMES[c as InterlockCode] ?? c} ${v}`)
    .join(' · ');
  return (
    <section className="card min-w-0 p-4 print:p-2.5">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <span className="size-2.5 rounded-full" style={{ background: def?.color }} />
          {def?.name ?? l.line}
        </h3>
        <span className="text-xs text-sub">
          OEE <span className="num text-base font-semibold text-ink">{pct(l.oee?.oee)}</span>
        </span>
      </header>

      <div className="mt-2">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-sub">
            생산 OK <span className="num text-lg font-semibold text-ink">{n(l.ok)}</span> / 목표 <span className="num">{n(l.target)}</span>
          </span>
          <span className="num text-sub">{rate != null ? `달성 ${pct(rate, 0)}` : '-'}</span>
        </div>
        <div className="mt-1">
          <Meter value={rate ?? 0} />
        </div>
        <div className="num mt-1 text-[11px] text-dim">
          투입 {n(l.input)} · 작업지시 {l.orders.length}건{l.orders.length ? ` (${l.orders.map((o) => o.variant.split('-').pop()).join('→')})` : ''}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2 print:grid-cols-2">
        <Mini label="NG 판정" value={n(l.ng)} tone={l.ng ? 'warn' : undefined} />
        <Mini label="폐기" value={n(l.scrap)} tone={l.scrap ? 'down' : undefined} />
        <Mini label="직행률" value={pct(l.fpy ?? undefined)} />
        <Mini label="가동·성능·양품" value={l.oee ? `${pct(l.oee.availability, 0)}` : '-'} sub={l.oee ? `${pct(l.oee.performance, 0)} · ${pct(l.oee.quality, 0)}` : undefined} />
        <Mini label="NCR 발생·종결" value={`${l.ncr.opened} · ${l.ncr.closed}`} sub={`미결 ${l.ncr.openAtEnd}`} tone={l.ncr.openAtEnd ? 'warn' : undefined} />
        <Mini label="4M 변경점" value={l.changes.total} sub={l.changes.faNg ? `초물 불합격 ${l.changes.faNg}` : `사람 ${l.changes.byCategory.MAN} · 설비 ${l.changes.byCategory.MACHINE} · 자재 ${l.changes.byCategory.MATERIAL} · 방법 ${l.changes.byCategory.METHOD}`} />
        <Mini label="초·중·종물" value={`${l.inspections.FIRST} · ${l.inspections.MID} · ${l.inspections.LAST}`} sub={l.inspections.ng ? `불합격 ${l.inspections.ng}` : '불합격 없음'} tone={l.inspections.ng ? 'warn' : undefined} />
        <Mini label="인터록 거부" value={l.interlock.ng} sub={ilk || `대기 ${l.interlock.wait}`} tone={l.interlock.ng ? 'warn' : undefined} />
      </div>

      <div className="mt-3 flex items-baseline justify-between gap-2 border-t border-line pt-2 text-xs">
        <span className="text-sub">전력량</span>
        <span className="num">
          {l.energy.kwh != null ? (
            <>
              {kwh(l.energy.kwh)} · {perUnit(l.energy.perUnit)}
              {l.energy.missing > 0 && <span className="ml-1 text-dim">(자료 없음 {l.energy.missing}대 제외)</span>}
            </>
          ) : (
            <span className="text-dim">자료 없음</span>
          )}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-3 text-[11px]">
        <div className="min-w-0">
          <div className="mb-0.5 text-dim">비가동 상위</div>
          {l.downtime.length ? (
            <ul>
              {l.downtime.slice(0, 3).map((d) => (
                <li key={`${d.state}-${d.reason}`} className="flex justify-between gap-2">
                  <span className="truncate text-sub" title={`${HALT_NAMES[d.state]} · ${d.reason} · ${d.stations.join(', ')}`}>
                    {d.reason}
                  </span>
                  <span className="num shrink-0">{duration(d.sec)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-dim">없음</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="mb-0.5 text-dim">불량 상위</div>
          {l.defects.length ? (
            <ul>
              {l.defects.slice(0, 3).map((d) => (
                <li key={d.code} className="flex justify-between gap-2">
                  <span className="truncate text-sub" title={`${d.code} · ${d.stations.join(', ')}`}>
                    {d.name}
                  </span>
                  <span className="num shrink-0">{n(d.count)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-dim">없음</span>
          )}
        </div>
      </div>
    </section>
  );
}

function TableCard({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="card mt-3 min-w-0 p-4 print:mt-2 print:p-2.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {sub && <p className="mt-0.5 text-[11px] text-sub">{sub}</p>}
      <div className="scroll-thin mt-2 overflow-x-auto">{children}</div>
    </section>
  );
}

const th = 'border-b border-line px-2 py-1 font-normal text-dim';
const td = 'border-b border-line/60 px-2 py-1';

function SummaryTable({ r, lines }: { r: ShiftReport; lines: ShiftLineReport[] }) {
  const rows: [string, (l: ShiftLineReport) => ReactNode][] = [
    ['목표 (택트 기준)', (l) => n(l.target)],
    ['투입', (l) => n(l.input)],
    ['생산 OK (최종 양품)', (l) => n(l.ok)],
    ['달성률', (l) => (l.target > 0 ? pct(l.ok / l.target) : '-')],
    ['NG 판정', (l) => n(l.ng)],
    ['폐기', (l) => n(l.scrap)],
    ['직행률 (FPY)', (l) => pct(l.fpy ?? undefined)],
    ['OEE', (l) => pct(l.oee?.oee)],
    ['가동률 · 성능 · 양품률', (l) => (l.oee ? `${pct(l.oee.availability)} · ${pct(l.oee.performance)} · ${pct(l.oee.quality)}` : '-')],
    ['NCR 발생 · 종결 · 미결', (l) => `${l.ncr.opened} · ${l.ncr.closed} · ${l.ncr.openAtEnd}`],
    ['4M 변경점 (사람·설비·자재·방법)', (l) => `${l.changes.total} (${l.changes.byCategory.MAN}·${l.changes.byCategory.MACHINE}·${l.changes.byCategory.MATERIAL}·${l.changes.byCategory.METHOD})`],
    ['초물 · 중물 · 종물 (불합격)', (l) => `${l.inspections.FIRST} · ${l.inspections.MID} · ${l.inspections.LAST} (${l.inspections.ng})`],
    ['인터록 거부 · 대기', (l) => `${l.interlock.ng} · ${l.interlock.wait}`],
    ['전력량', (l) => (l.energy.kwh != null ? kwh(l.energy.kwh) : '자료 없음')],
    ['개당 전력량', (l) => perUnit(l.energy.perUnit)],
  ];
  return (
    <TableCard title="라인별 요약" sub={`${r.date} ${r.code === 'D' ? '주간' : '야간'} · CSV와 같은 항목`}>
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className={cx(th, 'text-left')}>항목</th>
            {lines.map((l) => (
              <th key={l.line} className={cx(th, 'text-right')}>
                <span className="inline-flex items-center gap-1.5">
                  <Key color={lineDef(l.line)?.color ?? 'var(--color-sub)'} shape="dot" />
                  {lineDef(l.line)?.name}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, f]) => (
            <tr key={name}>
              <td className={cx(td, 'text-sub')}>{name}</td>
              {lines.map((l) => (
                <td key={l.line} className={cx(td, 'num text-right')}>
                  {f(l)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableCard>
  );
}

function OrdersTable({ lines }: { lines: ShiftLineReport[] }) {
  const rows = lines.flatMap((l) => l.orders.map((o) => ({ line: l.line, o })));
  return (
    <TableCard title="작업지시 (계획 대비 실적)" sub="교대 중에 돈 작업지시. 지시 수량·누계는 작업지시 전체, 교대 투입·양품은 이 교대 몫입니다.">
      {rows.length ? (
        <table className="w-full min-w-[760px] text-xs">
          <thead>
            <tr>
              {['라인', '작업지시', '기종', '상태', '지시 수량', '누계 투입', '누계 양품', '누계 폐기', '교대 투입', '교대 양품', '시작', '끝'].map((h, i) => (
                <th key={h} className={cx(th, i >= 4 && i <= 9 ? 'text-right' : 'text-left')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ line, o }) => (
              <tr key={o.id}>
                <td className={td}>{line}</td>
                <td className={cx(td, 'num')}>{o.code}</td>
                <td className={cx(td, 'text-sub')}>{variantName(line as LineCode, o.variant)}</td>
                <td className={td}>{WO_STATUS_NAMES[o.status] ?? o.status}</td>
                <td className={cx(td, 'num text-right')}>{n(o.qty)}</td>
                <td className={cx(td, 'num text-right')}>{n(o.released)}</td>
                <td className={cx(td, 'num text-right')}>{n(o.doneQty)}</td>
                <td className={cx(td, 'num text-right')}>{n(o.scrapQty)}</td>
                <td className={cx(td, 'num text-right text-ink')}>{n(o.input)}</td>
                <td className={cx(td, 'num text-right text-ink')}>{n(o.good)}</td>
                <td className={cx(td, 'num text-sub')}>{o.startedAt ? kst(o.startedAt).slice(0, 5) : '-'}</td>
                <td className={cx(td, 'num text-sub')}>{o.endedAt ? kst(o.endedAt).slice(0, 5) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty h={60}>이 교대에 돈 작업지시가 없습니다.</Empty>
      )}
    </TableCard>
  );
}

function DowntimeTable({ lines }: { lines: ShiftLineReport[] }) {
  const rows = lines.flatMap((l) => l.downtime.map((d) => ({ line: l.line, d }))).sort((a, b) => b.d.sec - a.d.sec);
  return (
    <TableCard title="비가동 사유 상위" sub="고장·셋업·계획 정지의 설비 시간 합 (라인마다 상위 8개)">
      {rows.length ? (
        <table className="w-full text-xs">
          <thead>
            <tr>
              {['라인', '구분', '사유', '시간', '건수', '설비'].map((h, i) => (
                <th key={h} className={cx(th, i === 3 || i === 4 ? 'text-right' : 'text-left')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ line, d }) => (
              <tr key={`${line}-${d.state}-${d.reason}`}>
                <td className={td}>{line}</td>
                <td className={cx(td, d.state === 'DOWN' ? 'text-down' : 'text-sub')}>{HALT_NAMES[d.state] ?? d.state}</td>
                <td className={td}>{d.reason}</td>
                <td className={cx(td, 'num text-right')}>{duration(d.sec)}</td>
                <td className={cx(td, 'num text-right')}>{d.count}</td>
                <td className={cx(td, 'num text-sub')}>{d.stations.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty h={60}>비가동이 없었습니다.</Empty>
      )}
    </TableCard>
  );
}

function DefectTable({ lines }: { lines: ShiftLineReport[] }) {
  const rows = lines.flatMap((l) => l.defects.map((d) => ({ line: l.line, d }))).sort((a, b) => b.d.count - a.d.count);
  return (
    <TableCard title="불량 상위" sub="모든 공정의 불량 판정 (재검사 불합격 포함, 라인마다 상위 8개)">
      {rows.length ? (
        <table className="w-full text-xs">
          <thead>
            <tr>
              {['라인', '불량', '코드', '수량', '설비'].map((h, i) => (
                <th key={h} className={cx(th, i === 3 ? 'text-right' : 'text-left')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ line, d }) => (
              <tr key={`${line}-${d.code}`}>
                <td className={td}>{line}</td>
                <td className={td}>{d.name}</td>
                <td className={cx(td, 'num text-sub')}>{d.code}</td>
                <td className={cx(td, 'num text-right')}>{n(d.count)}</td>
                <td className={cx(td, 'num text-sub')}>{d.stations.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty h={60}>불량이 없었습니다.</Empty>
      )}
    </TableCard>
  );
}
