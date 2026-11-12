'use client';

import { useState, type MouseEvent, type ReactNode } from 'react';
import { kst, num } from '@/lib/format';
import { C, niceTicks, Tip, TipRow, TipTitle, useWidth } from './kit';

export interface LimitPoint {
  t: string;
  v: number;
  /** 판정 규칙에 걸렸으면 규칙 이름들 */
  flags: string[];
  /** 툴팁에 덧붙일 줄 */
  extra?: ReactNode;
}

const M = { l: 48, r: 72, t: 10, b: 22 };

/**
 * 관리도 한 장 (X̄ 또는 R). 계열은 2px 파랑 선, 점은 규칙 위반과 마지막 점만 찍는다(나머지는 선이 대신한다).
 * 중심선·관리한계·규격은 오른쪽 끝에 이름을 직접 단다.
 */
export function LimitChart({
  points,
  cl,
  ucl,
  lcl,
  lsl,
  usl,
  height = 200,
  unit = '',
  valueLabel,
}: {
  points: LimitPoint[];
  cl: number;
  ucl: number;
  lcl?: number;
  lsl?: number;
  usl?: number;
  height?: number;
  unit?: string;
  valueLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const innerW = Math.max(0, width - M.l - M.r);
  const innerH = height - M.t - M.b;
  const lo0 = lcl ?? 0;
  const span = Math.max(ucl - lo0, 1e-9);
  // 규격이 관리한계에서 아주 멀면 그래프가 납작해지므로 가까울 때만 함께 그린다
  const spec = [lsl, usl].filter((s): s is number => s != null && Math.abs(s - cl) < span * 2.5);
  const vals = [ucl, lo0, ...points.map((p) => p.v), ...spec];
  const lo = Math.min(...vals) - span * 0.12;
  const hi = Math.max(...vals) + span * 0.12;
  const y = (v: number) => M.t + (1 - (v - lo) / (hi - lo || 1)) * innerH;
  const n = points.length;
  const x = (i: number) => M.l + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const ticks = niceTicks(lo, hi, 4).filter((t) => t >= lo && t <= hi);
  const timeTicks = n > 1 ? [0, Math.floor((n - 1) / 2), n - 1] : n ? [0] : [];

  const refLines: { v: number; label: string; color: string; dash?: string }[] = [
    { v: ucl, label: `UCL ${num(ucl)}`, color: C.ng, dash: '4 3' },
    { v: cl, label: `CL ${num(cl)}`, color: C.sub },
    ...(lcl != null ? [{ v: lcl, label: `LCL ${num(lcl)}`, color: C.ng, dash: '4 3' }] : []),
    ...(lsl != null && spec.includes(lsl) ? [{ v: lsl, label: `LSL ${num(lsl)}`, color: C.warn }] : []),
    ...(usl != null && spec.includes(usl) ? [{ v: usl, label: `USL ${num(usl)}`, color: C.warn }] : []),
  ];
  // 오른쪽 이름표가 겹치면 위아래로 조금 민다 (선은 그대로)
  const labelY = refLines.map((r) => y(r.v)).map((v) => v);
  const order = labelY.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  for (let k = 1; k < order.length; k++) {
    const [prevY] = order[k - 1];
    const i = order[k][1];
    if (labelY[i] - prevY < 11) labelY[i] = prevY + 11;
    order[k] = [labelY[i], i];
  }

  const onMove = (e: MouseEvent<SVGRectElement>) => {
    if (!n) return;
    const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - box.left;
    setHover(Math.max(0, Math.min(n - 1, Math.round((px / innerW) * (n - 1)))));
  };

  return (
    <div ref={ref} className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} className="block" role="img" aria-label={`${valueLabel} 관리도`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={M.l + innerW} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth={1} />
              <text x={M.l - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill={C.dim} className="num">
                {num(t)}
              </text>
            </g>
          ))}
          {refLines.map((r, i) => (
            <g key={r.label}>
              <line x1={M.l} x2={M.l + innerW} y1={y(r.v)} y2={y(r.v)} stroke={r.color} strokeWidth={1} strokeDasharray={r.dash} opacity={0.9} />
              <text x={M.l + innerW + 6} y={labelY[i]} dy="0.32em" fontSize={10} fill={C.sub} className="num">
                {r.label}
              </text>
            </g>
          ))}
          {n > 1 && (
            <polyline points={points.map((p, i) => `${x(i)},${y(p.v)}`).join(' ')} fill="none" stroke={C.series} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          )}
          {points.map((p, i) =>
            p.flags.length || i === n - 1 ? (
              <circle key={i} cx={x(i)} cy={y(p.v)} r={4} fill={p.flags.length ? C.ng : C.series} stroke={C.surface} strokeWidth={2} />
            ) : null,
          )}
          {timeTicks.map((i) => (
            <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fontSize={10} fill={C.dim} className="num">
              {kst(points[i].t).slice(0, 5)}
            </text>
          ))}
          {hover != null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={M.t + innerH} stroke={C.sub} strokeWidth={1} opacity={0.6} />
              <circle cx={x(hover)} cy={y(points[hover].v)} r={4.5} fill={points[hover].flags.length ? C.ng : C.series} stroke={C.surface} strokeWidth={2} />
            </g>
          )}
          <rect x={M.l} y={M.t} width={innerW} height={innerH} fill="transparent" onMouseMove={onMove} />
        </svg>
      )}
      {hover != null && points[hover] && (
        <Tip x={x(hover)} y={M.t} width={width}>
          <TipTitle>
            {kst(points[hover].t)} · {hover + 1}번째 부분군
          </TipTitle>
          <TipRow color={C.series} label={valueLabel} value={`${num(points[hover].v)} ${unit}`} />
          {points[hover].extra}
          {points[hover].flags.map((f) => (
            <TipRow key={f} color={C.ng} shape="dot" label="" value={f} />
          ))}
        </Tip>
      )}
    </div>
  );
}
