'use client';

import { useState } from 'react';
import { C, niceAxis, tickText, Tip, TipRow, TipTitle, topRounded, useWidth } from './kit';

export interface ColumnSeries {
  label: string;
  color: string;
}

export interface ColumnDatum {
  /** x축 글자 */
  label: string;
  /** 툴팁 제목 (없으면 label) */
  title?: string;
  /** 계열 순서대로, 아래부터 쌓는다 */
  values: number[];
  /** 아직 끝나지 않은 구간 (흐리게) */
  partial?: boolean;
}

const M = { l: 40, r: 56, t: 12, b: 26 };
const GAP = 2;

/** 누적 세로 막대 + 목표선. 막대는 24px 이하, 바닥은 각지고 위만 둥글다. 쌓인 조각 사이는 2px 바탕색 틈 */
export function ColumnChart({
  data,
  series,
  target,
  height = 220,
  unit = '',
}: {
  data: ColumnDatum[];
  series: ColumnSeries[];
  target?: { value: number; label: string };
  height?: number;
  unit?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const innerW = Math.max(0, width - M.l - M.r);
  const innerH = height - M.t - M.b;
  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const top = Math.max(1, ...totals, target ? target.value * 1.1 : 0);
  const ticks = niceAxis(top, 4);
  const yMax = ticks[ticks.length - 1];
  const y = (v: number) => M.t + innerH - (v / yMax) * innerH;
  const band = data.length ? innerW / data.length : 0;
  const barW = Math.max(2, Math.min(24, band * 0.62));
  // 글자가 겹치지 않게 몇 칸마다 하나씩
  const every = Math.max(1, Math.ceil(34 / Math.max(1, band)));

  return (
    <div ref={ref} className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} className="block" role="img" aria-label="시간대별 막대 차트">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={M.l + innerW} y1={y(t)} y2={y(t)} stroke={t === 0 ? C.axis : C.grid} strokeWidth={1} />
              <text x={M.l - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill={C.dim} className="num">
                {tickText(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = M.l + band * i + band / 2;
            const x = cx - barW / 2;
            let acc = 0;
            const last = d.values.reduce((li, v, k) => (v > 0 ? k : li), -1);
            return (
              <g key={i} opacity={d.partial ? 0.45 : hover != null && hover !== i ? 0.75 : 1}>
                {d.values.map((v, k) => {
                  if (v <= 0) return null;
                  const y0 = y(acc);
                  acc += v;
                  const y1 = y(acc);
                  // 아래 조각과의 사이에 2px 틈 (맨 아래 조각은 바닥에 붙인다)
                  const gapBelow = acc - v > 0 ? GAP : 0;
                  const h = Math.max(0, y0 - y1 - gapBelow);
                  return k === last ? (
                    <path key={k} d={topRounded(x, y1, barW, h)} fill={series[k].color} />
                  ) : (
                    <rect key={k} x={x} y={y1} width={barW} height={h} fill={series[k].color} />
                  );
                })}
                {i % every === 0 && (
                  <text x={cx} y={height - 8} textAnchor="middle" fontSize={10} fill={C.dim} className="num">
                    {d.label}
                  </text>
                )}
                {/* 막대보다 넓은 마우스 영역 */}
                <rect x={M.l + band * i} y={M.t} width={band} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
          {target && (
            <g>
              <line x1={M.l} x2={M.l + innerW} y1={y(target.value)} y2={y(target.value)} stroke={C.sub} strokeWidth={1} strokeDasharray="4 3" />
              <text x={M.l + innerW + 6} y={y(target.value)} dy="0.32em" fontSize={10} fill={C.sub}>
                {target.label}
              </text>
            </g>
          )}
        </svg>
      )}
      {hover != null && data[hover] && (
        <Tip x={M.l + band * hover + band / 2} y={M.t} width={width}>
          <TipTitle>
            {data[hover].title ?? data[hover].label}
            {data[hover].partial ? ' · 진행 중' : ''}
          </TipTitle>
          {series.map((s, k) => (
            <TipRow key={s.label} color={s.color} shape="rect" label={s.label} value={`${tickText(data[hover].values[k] ?? 0)}${unit}`} />
          ))}
          {target && <TipRow label={`${target.label} 대비`} value={`${Math.round(((data[hover].values[0] ?? 0) / target.value) * 100)}%`} />}
        </Tip>
      )}
    </div>
  );
}
