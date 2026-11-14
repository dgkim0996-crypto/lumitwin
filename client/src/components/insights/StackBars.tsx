'use client';

import { useState, type ReactNode } from 'react';
import { C, niceAxis, rightRounded, tickText, Tip, TipRow, TipTitle, useWidth } from '@/components/charts/kit';
import { cx } from '@/lib/format';

export interface StackRow {
  key: string;
  /** 왼쪽 이름 */
  label: ReactNode;
  /** 툴팁 제목 */
  title: string;
  /** 계열 순서대로 (왼쪽부터 쌓는다) */
  values: number[];
  /** 막대 끝 글자 (없으면 합계) */
  end?: ReactNode;
  /** 값이 없음(자료 없음): 막대 대신 글자 */
  missing?: ReactNode;
  /** 툴팁에 덧붙일 줄 */
  extra?: ReactNode;
}

const BAR_H = 10;
const ROW_H = 24;
const GAP = 2;

/**
 * 가로 누적 막대 (얇은 10px, 오른쪽 끝만 둥글게, 조각 사이 2px 틈). 값 축은 0부터 하나뿐이다.
 * 막대 끝에 합계를 쓰고, 마우스를 올리면 모든 조각을 한 툴팁에 보인다
 */
export function StackBars({
  rows,
  series,
  format,
  unit,
  labelW = 180,
  endW = 132,
  onPick,
  maxRows,
}: {
  rows: StackRow[];
  series: { label: string; color: string }[];
  format: (v: number) => string;
  /** 축 이름 */
  unit: string;
  labelW?: number;
  endW?: number;
  onPick?: (key: string) => void;
  /** 넘으면 스크롤 */
  maxRows?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plot = Math.max(60, width - labelW - endW - 8);
  const totals = rows.map((r) => r.values.reduce((a, b) => a + b, 0));
  const ticks = niceAxis(Math.max(0, ...totals), 4);
  const top = ticks[ticks.length - 1] || 1;
  const x = (v: number) => (v / top) * plot;
  const h = rows[hover ?? -1];
  const scroll = maxRows != null && rows.length > maxRows;

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      {/* 값 축 (위쪽 한 줄) */}
      <div className="flex text-[10px] text-dim" style={{ height: 16 }}>
        <span className="shrink-0" style={{ width: labelW }} />
        <svg width={plot} height={16} className="block shrink-0 overflow-visible" aria-hidden>
          {ticks.map((t, i) => (
            <text key={t} x={x(t)} y={11} textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'} fontSize={10} fill={C.dim} className="num">
              {tickText(t)}
            </text>
          ))}
        </svg>
        <span className="num shrink-0 pl-2" style={{ width: endW }}>
          {unit}
        </span>
      </div>
      <div className={cx(scroll && 'scroll-thin overflow-y-auto')} style={scroll ? { maxHeight: maxRows! * ROW_H } : undefined}>
        {rows.map((r, i) => {
          let acc = 0;
          const last = r.values.reduce((li, v, k) => (v > 0 ? k : li), -1);
          return (
            <div key={r.key} className={cx('flex items-center rounded', hover === i && 'bg-white/[0.05]')} style={{ height: ROW_H }} onMouseEnter={() => setHover(i)}>
              {onPick ? (
                <button className="shrink-0 truncate pr-2 text-left text-xs hover:underline" style={{ width: labelW }} onClick={() => onPick(r.key)} title="3D 공장에서 이 설비 보기">
                  {r.label}
                </button>
              ) : (
                <span className="shrink-0 truncate pr-2 text-xs" style={{ width: labelW }}>
                  {r.label}
                </span>
              )}
              <svg width={plot} height={ROW_H} className="block shrink-0" role="img" aria-label={`${r.title}: ${series.map((s, k) => `${s.label} ${format(r.values[k] ?? 0)}`).join(', ')}`}>
                {ticks.map((t) => (
                  <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={ROW_H} stroke={t === 0 ? C.axis : C.grid} />
                ))}
                {r.missing
                  ? null
                  : r.values.map((v, k) => {
                      if (v <= 0) return null;
                      const x0 = x(acc) + (acc > 0 ? GAP : 0);
                      acc += v;
                      const w = Math.max(1, x(acc) - x0);
                      const y = (ROW_H - BAR_H) / 2;
                      return k === last ? (
                        <path key={k} d={rightRounded(x0, y, w, BAR_H)} fill={series[k].color} opacity={hover != null && hover !== i ? 0.6 : 1} />
                      ) : (
                        <rect key={k} x={x0} y={y} width={w} height={BAR_H} fill={series[k].color} opacity={hover != null && hover !== i ? 0.6 : 1} />
                      );
                    })}
              </svg>
              <span className="num shrink-0 truncate pl-2 text-xs text-sub" style={{ width: endW }}>
                {r.missing ?? r.end ?? format(totals[i])}
              </span>
            </div>
          );
        })}
      </div>
      {h && hover != null && !h.missing && (
        <Tip x={labelW + x(totals[hover]) / 2} y={16 + (hover + 1) * ROW_H} width={width}>
          <TipTitle>{h.title}</TipTitle>
          {series.map((s, k) => (
            <TipRow key={s.label} color={s.color} shape="rect" label={`${s.label}${totals[hover] > 0 ? ` · ${Math.round(((h.values[k] ?? 0) / totals[hover]) * 100)}%` : ''}`} value={format(h.values[k] ?? 0)} />
          ))}
          <TipRow label="합계" value={format(totals[hover])} />
          {h.extra}
        </Tip>
      )}
    </div>
  );
}
