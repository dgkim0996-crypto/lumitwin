'use client';

import { useState } from 'react';
import { num } from '@/lib/format';
import { C, niceAxis, niceTicks, Tip, TipRow, TipTitle, topRounded, useWidth } from './kit';

const M = { l: 36, r: 12, t: 18, b: 24 };

export interface Bin {
  x0: number;
  x1: number;
  n: number;
  /** 구간 가운데가 규격 밖 */
  out: boolean;
}

export function makeBins(values: number[], lsl?: number, usl?: number): Bin[] {
  if (!values.length) return [];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lsl != null) lo = Math.min(lo, lsl);
  if (usl != null) hi = Math.max(hi, usl);
  if (hi === lo) hi = lo + 1;
  const k = Math.max(8, Math.min(28, Math.round(Math.sqrt(values.length) * 1.4)));
  const w = (hi - lo) / k;
  const bins: Bin[] = Array.from({ length: k }, (_, i) => {
    const x0 = lo + i * w;
    const mid = x0 + w / 2;
    return { x0, x1: x0 + w, n: 0, out: (lsl != null && mid < lsl) || (usl != null && mid > usl) };
  });
  for (const v of values) bins[Math.min(k - 1, Math.max(0, Math.floor((v - lo) / w)))].n++;
  return bins;
}

/** 개별값 히스토그램 + 규격(LSL·USL)과 평균. 규격 밖 구간은 불량 색 */
export function Histogram({ values, lsl, usl, unit = '', height = 200 }: { values: number[]; lsl?: number; usl?: number; unit?: string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const bins = makeBins(values, lsl, usl);
  const innerW = Math.max(0, width - M.l - M.r);
  const innerH = height - M.t - M.b;
  if (!bins.length) return <div ref={ref} style={{ height }} />;
  const lo = bins[0].x0;
  const hi = bins[bins.length - 1].x1;
  const x = (v: number) => M.l + ((v - lo) / (hi - lo)) * innerW;
  const top = Math.max(1, ...bins.map((b) => b.n));
  const yt = niceAxis(top, 3);
  const yMax = yt[yt.length - 1];
  const y = (n: number) => M.t + innerH - (n / yMax) * innerH;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const bw = innerW / bins.length;
  const xt = niceTicks(lo, hi, 5).filter((t) => t >= lo && t <= hi);
  const marks = [
    ...(lsl != null ? [{ v: lsl, label: 'LSL', color: C.warn }] : []),
    ...(usl != null ? [{ v: usl, label: 'USL', color: C.warn }] : []),
    { v: mean, label: '평균', color: C.ink },
  ];

  return (
    <div ref={ref} className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} className="block" role="img" aria-label="히스토그램">
          {yt.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={M.l + innerW} y1={y(t)} y2={y(t)} stroke={t === 0 ? C.axis : C.grid} strokeWidth={1} />
              <text x={M.l - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill={C.dim} className="num">
                {t}
              </text>
            </g>
          ))}
          {bins.map((b, i) => (
            <path
              key={i}
              // 붙은 막대 사이 2px 바탕색 틈
              d={topRounded(M.l + i * bw + 1, y(b.n), Math.max(1, bw - 2), y(0) - y(b.n), 3)}
              fill={b.out ? C.ng : C.series}
              opacity={hover != null && hover !== i ? 0.6 : 1}
            />
          ))}
          {marks.map((m) => (
            <g key={m.label}>
              <line x1={x(m.v)} x2={x(m.v)} y1={M.t - 4} y2={M.t + innerH} stroke={m.color} strokeWidth={m.label === '평균' ? 1.5 : 1} strokeDasharray={m.label === '평균' ? '3 3' : undefined} />
              <text x={x(m.v)} y={M.t - 7} textAnchor="middle" fontSize={10} fill={C.sub}>
                {m.label}
              </text>
            </g>
          ))}
          {xt.map((t) => (
            <text key={t} x={x(t)} y={height - 6} textAnchor="middle" fontSize={10} fill={C.dim} className="num">
              {num(t)}
            </text>
          ))}
          {bins.map((_, i) => (
            <rect key={i} x={M.l + i * bw} y={M.t} width={bw} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
        </svg>
      )}
      {hover != null && bins[hover] && (
        <Tip x={M.l + hover * bw + bw / 2} y={M.t} width={width}>
          <TipTitle>
            {num(bins[hover].x0)} ~ {num(bins[hover].x1)} {unit}
          </TipTitle>
          <TipRow color={bins[hover].out ? C.ng : C.series} shape="rect" label={bins[hover].out ? '개 · 규격 밖' : '개'} value={bins[hover].n} />
        </Tip>
      )}
    </div>
  );
}
