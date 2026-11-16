'use client';

import { useState, type MouseEvent } from 'react';
import { C, niceAxis, tickText, Tip, TipRow, TipTitle, useWidth } from '@/components/charts/kit';

export interface BandSeries {
  key: string;
  label: string;
  color: string;
  /** 점마다 평균·10·90 백분위 (같은 길이) */
  mean: number[];
  p10: number[];
  p90: number[];
}

const M = { l: 40, r: 60, t: 10, b: 22 };

/**
 * 선 + 범위 띠 (What-if 누적 양품). 계열마다 평균은 2px 선, 10~90 백분위는 같은 색의 옅은 띠.
 * 값 축은 0부터 하나뿐이고, 끝값만 오른쪽에 직접 적는다. 마우스를 올리면 그 시각의 모든 계열을 한 툴팁에 보인다
 */
export function BandChart({
  series,
  height = 190,
  xLabel,
  tipTitle,
  format,
  label,
}: {
  series: BandSeries[];
  height?: number;
  /** 점 번호 → 가로축 글자 */
  xLabel: (i: number) => string;
  tipTitle: (i: number) => string;
  format: (v: number) => string;
  /** 그림 설명 (화면 낭독기) */
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = Math.max(0, ...series.map((s) => s.mean.length));
  const innerW = Math.max(0, width - M.l - M.r);
  const innerH = height - M.t - M.b;
  const ticks = niceAxis(Math.max(0, ...series.flatMap((s) => [...s.p90, ...s.mean])), 4);
  const top = ticks[ticks.length - 1] || 1;
  const x = (i: number) => M.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => M.t + (1 - v / top) * innerH;
  const step = Math.max(1, Math.ceil((n - 1) / 6));
  const xTicks = Array.from({ length: n }, (_, i) => i).filter((i) => i % step === 0 || i === n - 1);

  // 끝값 글자가 겹치면 위아래로 민다 (선은 그대로)
  const ends = series.map((s, k) => ({ k, y: y(s.mean[s.mean.length - 1] ?? 0) })).sort((a, b) => a.y - b.y);
  for (let j = 1; j < ends.length; j++) if (ends[j].y - ends[j - 1].y < 12) ends[j].y = ends[j - 1].y + 12;
  const endY = new Map(ends.map((e) => [e.k, e.y]));

  const onMove = (e: MouseEvent<SVGRectElement>) => {
    if (n < 1) return;
    const box = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - box.left) / Math.max(1, innerW)) * (n - 1)))));
  };

  return (
    <div ref={ref} className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && n > 0 && (
        <svg width={width} height={height} className="block" role="img" aria-label={label}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={M.l + innerW} y1={y(t)} y2={y(t)} stroke={t === 0 ? C.axis : C.grid} strokeWidth={1} />
              <text x={M.l - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill={C.dim} className="num">
                {tickText(t)}
              </text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fontSize={10} fill={C.dim} className="num">
              {xLabel(i)}
            </text>
          ))}
          {series.map((s) =>
            s.mean.length > 1 ? (
              <path
                key={`band-${s.key}`}
                d={`M${s.p90.map((v, i) => `${x(i)},${y(v)}`).join('L')}L${[...s.p10]
                  .map((v, i) => [v, i] as const)
                  .reverse()
                  .map(([v, i]) => `${x(i)},${y(v)}`)
                  .join('L')}Z`}
                fill={s.color}
                opacity={0.16}
              />
            ) : null,
          )}
          {series.map((s) => (
            <polyline
              key={`line-${s.key}`}
              points={s.mean.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {series.map((s, k) => {
            const last = s.mean.length - 1;
            if (last < 0) return null;
            return (
              <g key={`end-${s.key}`}>
                <circle cx={x(last)} cy={y(s.mean[last])} r={4} fill={s.color} stroke={C.surface} strokeWidth={2} />
                {/* 끝값 글자는 글자색, 옆의 작은 점이 어느 계획인지 알려 준다 */}
                <circle cx={M.l + innerW + 10} cy={endY.get(k)} r={2.5} fill={s.color} />
                <text x={M.l + innerW + 16} y={endY.get(k)} dy="0.32em" fontSize={10} fill={C.sub} className="num">
                  {format(s.mean[last])}
                </text>
              </g>
            );
          })}
          {hover != null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={M.t + innerH} stroke={C.sub} strokeWidth={1} opacity={0.6} />
              {series.map((s) =>
                s.mean[hover] != null ? <circle key={s.key} cx={x(hover)} cy={y(s.mean[hover])} r={4} fill={s.color} stroke={C.surface} strokeWidth={2} /> : null,
              )}
            </g>
          )}
          <rect x={M.l} y={M.t} width={innerW} height={innerH} fill="transparent" onMouseMove={onMove} />
        </svg>
      )}
      {hover != null && (
        <Tip x={x(hover)} y={M.t} width={width}>
          <TipTitle>{tipTitle(hover)}</TipTitle>
          {series.map((s) => (
            <TipRow
              key={s.key}
              color={s.color}
              label={`${s.label} · 범위 ${format(s.p10[hover] ?? 0)} ~ ${format(s.p90[hover] ?? 0)}`}
              value={format(s.mean[hover] ?? 0)}
            />
          ))}
        </Tip>
      )}
    </div>
  );
}
