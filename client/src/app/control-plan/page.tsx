'use client';

import { Fragment, useMemo, useState } from 'react';
import {
  CP_CHAR_NAMES,
  CP_EVAL_NAMES,
  CP_SOURCE_NAMES,
  FACTORY,
  SPECIAL_DESC,
  SPECIAL_NAMES,
  SPECIAL_SYMBOLS,
  buildControlPlan,
  type ControlPlanLine,
  type ControlPlanRow,
  type CpEval,
  type LineCode,
  type SourceGrade,
  type SpecialType,
} from '@lumitwin/shared';
import { PageShell } from '@/components/mes/PageShell';
import { GRADE_LABEL, cx } from '@/lib/format';
import { useUi } from '@/lib/ui';

/** 공장 정의에서 한 번 만든다 (순수 함수, 화면을 열 때마다 같은 표) */
const PLAN = buildControlPlan();

type Scope = 'ALL' | LineCode;
type CharFilter = 'all' | 'product' | 'process' | 'special';

const SPECIAL_COLOR: Record<SpecialType, string> = { CC: '#ff6b6b', SC: '#f5b544' };

/**
 * 인쇄: 관리계획서 영역만 A4 가로로 찍는다. MES 화면 틀(상단 바·스크롤 상자)은 그대로 두고,
 * 인쇄 영역의 조상이 아닌 요소를 숨긴 뒤 조상의 높이·스크롤 제한을 푼다 (:has 사용)
 */
const PRINT_CSS = `
@media print {
  @page { size: A4 landscape; margin: 8mm; }
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  body *:not(:has(.cp-print)):not(.cp-print):not(.cp-print *) { display: none !important; }
  body *:has(.cp-print) { display: block !important; height: auto !important; max-height: none !important; overflow: visible !important;
    padding: 0 !important; margin: 0 !important; background: none !important; border: 0 !important; }
  .cp-noprint { display: none !important; }
  .cp-print { color: #000 !important; font-size: 7.5pt; }
  .cp-print * { color: #000 !important; border-color: #999 !important; background: transparent !important; box-shadow: none !important; }
  .cp-print .cp-sym-CC { color: #c00 !important; }
  .cp-print .cp-sym-SC { color: #b36b00 !important; }
  .cp-print .card { border: 0 !important; padding: 0 !important; }
  .cp-print .cp-scroll { overflow: visible !important; max-height: none !important; }
  .cp-print table { width: 100% !important; min-width: 0 !important; border-collapse: collapse; }
  .cp-print th, .cp-print td { border: 1px solid #999 !important; padding: 2px 3px !important; vertical-align: top; }
  .cp-print thead { display: table-header-group; position: static !important; }
  .cp-print tr { break-inside: avoid; }
  .cp-line + .cp-line { break-before: page; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex overflow-hidden rounded-md border border-line text-xs">
      {options.map((o) => (
        <button key={o.id} aria-pressed={value === o.id} onClick={() => onChange(o.id)} className={cx('px-2.5 py-1.5', value === o.id ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Grade({ g, prefix }: { g: SourceGrade; prefix?: string }) {
  const x = GRADE_LABEL[g];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" title={x.hint}>
      <span className="size-1.5 rounded-full" style={{ background: x.color }} />
      {prefix}
      {x.text}
    </span>
  );
}

function SpecialSym({ r }: { r: ControlPlanRow }) {
  if (!r.special) return <span className="text-dim">-</span>;
  return (
    <span className={cx('text-base leading-none font-bold', `cp-sym-${r.special.type}`)} style={{ color: SPECIAL_COLOR[r.special.type] }} title={`${SPECIAL_NAMES[r.special.type]}: ${r.special.reason}`}>
      {r.special.symbol}
    </span>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="space-y-0.5">
      {items.map((t) => (
        <li key={t} className="flex gap-1">
          <span className="text-dim">·</span>
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

function LineTable({ plan, filter }: { plan: ControlPlanLine; filter: CharFilter }) {
  const rows = plan.rows.filter((r) => (filter === 'all' ? true : filter === 'special' ? !!r.special : r.charKind === filter));
  // 같은 설비 행을 묶어 공정·설비 칸을 한 번만 쓴다 (인쇄했을 때 읽기 쉽게)
  const groups: { station: string; rows: ControlPlanRow[] }[] = [];
  for (const r of rows) {
    const g = groups[groups.length - 1];
    if (g && g.station === r.station) g.rows.push(r);
    else groups.push({ station: r.station, rows: [r] });
  }
  const specials = rows.filter((r) => r.special);
  const head = ['공정·설비', '번호', '특성', '특별', '규격', '평가·측정 방법', '시료·주기', '관리 방법', '이상 시 조치', '근거'];

  return (
    <section className="cp-line card mb-3 min-w-0 p-4" aria-label={`${plan.name} 관리계획서`}>
      <header className="mb-3 grid gap-x-6 gap-y-1 text-xs @3xl:grid-cols-[1fr_auto]">
        <div>
          <h2 className="text-base font-semibold">
            관리계획서 · {plan.name}
            <span className="num ml-2 text-sm font-normal text-sub">{plan.docNo}</span>
          </h2>
          <p className="mt-1 text-sub">
            제품 <b className="text-ink">{plan.product.name}</b> ({plan.product.code}) · 기종 {plan.variants.map((v) => `${v.code} ${v.name}`).join(', ')}
          </p>
          <p className="mt-0.5 text-sub">
            단계 {plan.phase} · 설비 {plan.counts.stations}대 · 특성 {plan.rows.length}개 (제품 {plan.counts.product} · 공정 {plan.counts.process}) · 특별 특성 ◆ {plan.counts.cc} · ▲ {plan.counts.sc}
          </p>
        </div>
        <div className="text-sub @3xl:text-right">
          <div>{FACTORY.site} · 공장 정의에서 자동 생성</div>
          <div className="mt-0.5">
            SPC 부분군 {PLAN.basis.spcSubgroup}개 · 중물 {PLAN.basis.midInspectHours}시간 · 인터록 응답 {PLAN.basis.ilkTimeoutSec}초
          </div>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="py-6 text-center text-xs text-dim">이 조건의 특성이 없습니다</div>
      ) : (
        <div className="cp-scroll scroll-thin max-h-[calc(100vh-260px)] overflow-auto">
          <table className="w-full min-w-[1280px] text-[11px] leading-snug">
            <thead className="sticky top-0 z-10 bg-[var(--color-chart)] text-dim">
              <tr>
                {head.map((h) => (
                  <th key={h} className="border-b border-line px-2 py-1.5 text-left font-normal whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) =>
                g.rows.map((r, i) => (
                  <tr key={r.id} className={cx('align-top', i === g.rows.length - 1 ? 'border-b border-line' : 'border-b border-line/40')}>
                    {i === 0 && (
                      <td rowSpan={g.rows.length} className="w-44 border-r border-line/60 px-2 py-1.5">
                        <div className="num text-dim">OP{r.opNo}</div>
                        <div className="font-medium text-ink">{r.stepName}</div>
                        <div className="mt-1">
                          <span className="num text-info">{r.station}</span>
                        </div>
                        <div className="text-sub">{r.stationName}</div>
                      </td>
                    )}
                    <td className="num px-2 py-1.5 whitespace-nowrap text-sub">{r.no}</td>
                    <td className="px-2 py-1.5">
                      <div className="font-medium text-ink">{r.name}</div>
                      <div className="text-dim">
                        {CP_CHAR_NAMES[r.charKind]} · {CP_SOURCE_NAMES[r.source]}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <SpecialSym r={r} />
                    </td>
                    <td className="num px-2 py-1.5">{r.spec.text}</td>
                    <td className="px-2 py-1.5">{r.evaluation}</td>
                    <td className="px-2 py-1.5">
                      <div>{r.sampleSize}</div>
                      <div className="text-sub">{r.frequency}</div>
                    </td>
                    <td className="px-2 py-1.5">
                      <List items={r.controls} />
                    </td>
                    <td className="px-2 py-1.5">
                      <List items={r.reactions} />
                    </td>
                    <td className="px-2 py-1.5 text-sub" title={r.note}>
                      <Grade g={r.grade} />
                      {r.special && (
                        <div className="mt-0.5">
                          <Grade g={r.special.grade} prefix={`${r.special.symbol} `} />
                        </div>
                      )}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}

      {specials.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-semibold">특별 특성 지정 근거</h3>
          <table className="mt-1 w-full text-[11px] leading-snug">
            <tbody>
              {specials.map((r) => (
                <tr key={r.id} className="border-b border-line/40 align-top">
                  <td className="w-6 px-1 py-1 text-center">
                    <SpecialSym r={r} />
                  </td>
                  <td className="num w-14 px-1 py-1 text-sub">{r.no}</td>
                  <td className="w-56 px-1 py-1">
                    {r.name} <span className="num text-dim">{r.station}</span>
                  </td>
                  <td className="px-1 py-1 text-sub">{r.special!.reason}</td>
                  <td className="w-24 px-1 py-1 text-sub">
                    <Grade g={r.special!.grade} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Legend() {
  const evals: CpEval[] = ['auto100', 'detect', 'inline', 'sensor', 'cycle', 'fa', 'mes'];
  return (
    <section className="card mb-3 grid gap-x-6 gap-y-3 p-4 text-[11px] leading-relaxed @4xl:grid-cols-3" aria-label="범례">
      <div>
        <h2 className="mb-1 text-xs font-semibold">특별 특성 기호</h2>
        {(['CC', 'SC'] as const).map((t) => (
          <div key={t} className="flex gap-2">
            <span className={cx('w-4 text-center text-base leading-tight font-bold', `cp-sym-${t}`)} style={{ color: SPECIAL_COLOR[t] }}>
              {SPECIAL_SYMBOLS[t]}
            </span>
            <span>
              <b className="text-ink">{SPECIAL_NAMES[t]}</b> <span className="text-sub">— {SPECIAL_DESC[t]}</span>
            </span>
          </div>
        ))}
        <p className="mt-1 text-dim">기호는 고객사마다 다르다. 지정은 고객 요구 + FMEA 심각도로 하며, 여기서는 공개 법규·자료와 공장 모델의 인과로 정했다.</p>
      </div>
      <div>
        <h2 className="mb-1 text-xs font-semibold">근거 등급</h2>
        {(Object.keys(GRADE_LABEL) as SourceGrade[]).map((g) => (
          <div key={g} className="flex items-center gap-2">
            <Grade g={g} />
            <span className="text-sub">{GRADE_LABEL[g].hint}</span>
          </div>
        ))}
        <p className="mt-1 text-dim">첫 줄은 규격·불량 모델의 근거, ◆·▲ 줄은 특별 특성 지정의 근거다.</p>
      </div>
      <div>
        <h2 className="mb-1 text-xs font-semibold">평가·측정 방법</h2>
        <ul className="grid grid-cols-2 gap-x-3">
          {evals.map((e) => (
            <li key={e} className="text-sub">
              <b className="font-medium text-ink">{CP_EVAL_NAMES[e]}</b>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-dim">제품 특성 = 만든 물건의 성질 (측정값·검출 불량) · 공정 특성 = 그것을 만드는 조건 (규격 있는 설비 태그).</p>
      </div>
    </section>
  );
}

export default function ControlPlanPage() {
  const uiLine = useUi((s) => s.line);
  const setUiLine = useUi((s) => s.setLine);
  const [scope, setScope] = useState<Scope>(uiLine);
  const [filter, setFilter] = useState<CharFilter>('all');
  const lines = useMemo(() => PLAN.lines.filter((l) => scope === 'ALL' || l.line === scope), [scope]);

  return (
    <PageShell
      title="관리계획서 (Control Plan)"
      desc="공정마다 무엇을(제품·공정 특성), 어떤 규격으로, 어떻게·얼마나 자주 재고, 어떻게 관리하며, 벗어나면 무엇을 하는지 정한 문서입니다. 공장 정의(설비 태그·측정·불량·검사)에서 자동으로 만들어, 정의가 바뀌면 같이 바뀝니다."
      filters={
        <div className="cp-noprint flex w-full flex-wrap items-center gap-2">
          <Seg<Scope>
            label="라인"
            value={scope}
            onChange={(v) => {
              setScope(v);
              if (v !== 'ALL') setUiLine(v);
            }}
            options={[...PLAN.lines.map((l) => ({ id: l.line as Scope, label: l.name })), { id: 'ALL', label: '전체 라인' }]}
          />
          <Seg<CharFilter>
            label="특성"
            value={filter}
            onChange={setFilter}
            options={[
              { id: 'all', label: '전체 특성' },
              { id: 'product', label: '제품 특성' },
              { id: 'process', label: '공정 특성' },
              { id: 'special', label: '특별 특성만 ◆▲' },
            ]}
          />
          <button onClick={() => window.print()} className="ml-auto rounded-md border border-line bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10" title="A4 가로로 인쇄 (라인마다 새 쪽)">
            인쇄
          </button>
        </div>
      }
    >
      <style>{PRINT_CSS}</style>
      <div className="cp-print">
        <Legend />
        {lines.map((l) => (
          <Fragment key={l.line}>
            <LineTable plan={l} filter={filter} />
          </Fragment>
        ))}
      </div>
    </PageShell>
  );
}
