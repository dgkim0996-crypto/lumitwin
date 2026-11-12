'use client';

import { useState } from 'react';
import type { BoxStats } from '@lumitwin/shared';
import { num } from '@/lib/format';
import { C, Key, Tip, TipRow, TipTitle, useWidth } from './kit';

export interface Segment {
  key: string;
  label: string;
  color: string;
  value: number;
}

/**
 * 한 줄 구성 막대 (전체를 나눈 비율). 8px, 끝이 둥글고 조각 사이는 2px 틈.
 * 마우스를 올리면 모든 조각의 이름·값·비율을 한 툴팁에 보인다.
 */
export function SegmentedBar({ parts, format, height = 8, label }: { parts: Segment[]; format: (v: number) => string; height?: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState(false);
  const total = parts.reduce((a, b) => a + b.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  const aria = `${label}: ` + shown.map((p) => `${p.label} ${Math.round((p.value / (total || 1)) * 100)}%`).join(', ');
  return (
    <div ref={ref} className="relative" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} tabIndex={0} onFocus={() => setHover(true)} onBlur={() => setHover(false)} aria-label={aria}>
      <div className="flex w-full gap-[2px] overflow-hidden rounded-full" style={{ height }}>
        {total > 0 ? (
          shown.map((p) => <div key={p.key} style={{ flexGrow: p.value, flexBasis: 0, background: p.color, minWidth: 2 }} />)
        ) : (
          <div className="w-full bg-white/5" />
        )}
      </div>
      {hover && total > 0 && (
        <Tip x={width / 2} y={height + 6} width={width}>
          <TipTitle>{label}</TipTitle>
          {shown.map((p) => (
            <TipRow key={p.key} color={p.color} shape="rect" label={`${p.label} · ${Math.round((p.value / total) * 100)}%`} value={format(p.value)} />
          ))}
        </Tip>
      )}
    </div>
  );
}

const ROW = 18;

/** 불량품·양품 상자 그림 두 줄 (같은 가로축). 상자 = 사분위 범위, 굵은 세로선 = 중앙값, 가는 선 = 최소~최대 */
export function BoxPair({ ng, ok, unit = '' }: { ng: BoxStats; ok: BoxStats; unit?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<'ng' | 'ok' | null>(null);
  const lo = Math.min(ng.min, ok.min);
  const hi = Math.max(ng.max, ok.max);
  const pad = (hi - lo) * 0.04 || 1;
  const x = (v: number) => ((v - (lo - pad)) / (hi + pad - (lo - pad))) * width;
  const rows = [
    { id: 'ng' as const, s: ng, color: C.ng, label: '불량' },
    { id: 'ok' as const, s: ok, color: C.series, label: '양품' },
  ];
  const height = ROW * 2 + 14;
  return (
    <div ref={ref} className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} className="block" role="img" aria-label={`불량 중앙값 ${num(ng.median)}, 양품 중앙값 ${num(ok.median)}`}>
          {rows.map((r, i) => {
            const cy = 4 + i * ROW + ROW / 2;
            return (
              <g key={r.id} onMouseEnter={() => setHover(r.id)} opacity={hover && hover !== r.id ? 0.55 : 1}>
                <rect x={0} y={cy - ROW / 2} width={width} height={ROW} fill="transparent" />
                <line x1={x(r.s.min)} x2={x(r.s.max)} y1={cy} y2={cy} stroke={r.color} strokeWidth={1} opacity={0.7} />
                <rect x={x(r.s.q1)} y={cy - 5} width={Math.max(2, x(r.s.q3) - x(r.s.q1))} height={10} rx={2} fill={r.color} opacity={0.35} />
                <line x1={x(r.s.median)} x2={x(r.s.median)} y1={cy - 6} y2={cy + 6} stroke={r.color} strokeWidth={2.5} strokeLinecap="round" />
              </g>
            );
          })}
          <text x={0} y={height - 1} fontSize={10} fill={C.dim} className="num">
            {num(lo)}
          </text>
          <text x={width} y={height - 1} textAnchor="end" fontSize={10} fill={C.dim} className="num">
            {num(hi)}
          </text>
        </svg>
      )}
      {hover && (
        <Tip x={x(hover === 'ng' ? ng.median : ok.median)} y={hover === 'ng' ? 0 : ROW} width={width}>
          {(() => {
            const r = rows.find((q) => q.id === hover)!;
            return (
              <>
                <TipTitle>
                  {r.label} {r.s.n}개 · {unit}
                </TipTitle>
                <TipRow color={r.color} label="중앙값" value={num(r.s.median)} />
                <TipRow label="평균 ± 표준편차" value={`${num(r.s.mean)} ± ${num(r.s.sd)}`} />
                <TipRow label="사분위 (25~75%)" value={`${num(r.s.q1)} ~ ${num(r.s.q3)}`} />
                <TipRow label="최소 ~ 최대" value={`${num(r.s.min)} ~ ${num(r.s.max)}`} />
              </>
            );
          })()}
        </Tip>
      )}
    </div>
  );
}

export const BOX_LEGEND = [
  { label: '불량품', color: C.ng, shape: 'rect' as const },
  { label: '양품', color: C.series, shape: 'rect' as const },
];

/** 0~1 값 미터 (단일 색, 트랙은 같은 색의 옅은 단계) */
export function Meter({ value, color = C.series }: { value: number; color?: string }) {
  const v = Math.max(0, Math.min(1, value || 0));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: C.seriesSoft }}>
      <div className="h-full rounded-full" style={{ width: `${v * 100}%`, background: color }} />
    </div>
  );
}

export { Key };
