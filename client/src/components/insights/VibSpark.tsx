'use client';

import { useState, type MouseEvent } from 'react';
import { C, Tip, TipRow, TipTitle, useWidth } from '@/components/charts/kit';
import { kst, num } from '@/lib/format';

const M = { l: 4, r: 52, t: 6, b: 4 };

/**
 * 진동 추이 작은 그래프: 2px 파랑 선 + 마지막 점, 구역 경계(B/C 경고·C/D 위험)는 점선과 오른쪽 이름표.
 * 세로축은 0부터, 위 끝은 B/C 경계와 최댓값 중 큰 쪽 (C/D는 그 안에 들어올 때만 그린다)
 */
export function VibSpark({ points, zones, height = 64 }: { points: { t: string; vib: number }[]; zones: { ab: number; bc: number; cd: number }; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const innerW = Math.max(0, width - M.l - M.r);
  const innerH = height - M.t - M.b;
  const max = Math.max(...points.map((p) => p.vib), 0);
  const top = Math.max(zones.bc * 1.15, max * 1.1);
  const y = (v: number) => M.t + (1 - Math.min(v, top) / top) * innerH;
  const n = points.length;
  const x = (i: number) => M.l + (n <= 1 ? innerW : (i / (n - 1)) * innerW);
  const lines = [
    { v: zones.bc, label: `B/C ${zones.bc}`, color: C.warn },
    ...(zones.cd <= top ? [{ v: zones.cd, label: `C/D ${zones.cd}`, color: C.ng }] : []),
  ];

  const onMove = (e: MouseEvent<SVGRectElement>) => {
    if (!n) return;
    const box = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - box.left) / Math.max(1, innerW)) * (n - 1)))));
  };

  return (
    <div ref={ref} className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} className="block" role="img" aria-label={`진동 추이 ${n}점, 마지막 ${n ? num(points[n - 1].vib) : '-'} mm/s`}>
          <line x1={M.l} x2={M.l + innerW} y1={y(0)} y2={y(0)} stroke={C.axis} />
          {lines.map((l) => (
            <g key={l.label}>
              <line x1={M.l} x2={M.l + innerW} y1={y(l.v)} y2={y(l.v)} stroke={l.color} strokeDasharray="4 3" opacity={0.8} />
              <text x={M.l + innerW + 4} y={y(l.v)} dy="0.32em" fontSize={9} fill={C.sub} className="num">
                {l.label}
              </text>
            </g>
          ))}
          {n > 1 && <polyline points={points.map((p, i) => `${x(i)},${y(p.vib)}`).join(' ')} fill="none" stroke={C.series} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {n > 0 && <circle cx={x(n - 1)} cy={y(points[n - 1].vib)} r={3.5} fill={C.series} stroke={C.surface} strokeWidth={2} />}
          {hover != null && points[hover] && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={M.t + innerH} stroke={C.sub} opacity={0.6} />
              <circle cx={x(hover)} cy={y(points[hover].vib)} r={4} fill={C.series} stroke={C.surface} strokeWidth={2} />
            </g>
          )}
          <rect x={M.l} y={0} width={innerW} height={height} fill="transparent" onMouseMove={onMove} />
        </svg>
      )}
      {hover != null && points[hover] && (
        <Tip x={x(hover)} y={0} width={width}>
          <TipTitle>{kst(points[hover].t)}</TipTitle>
          <TipRow color={C.series} label="진동 RMS" value={`${num(points[hover].vib)} mm/s`} />
        </Tip>
      )}
    </div>
  );
}
