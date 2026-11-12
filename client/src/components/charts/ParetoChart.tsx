'use client';

import { useState } from 'react';
import { C, Tip, TipRow, TipTitle, topRounded, useWidth } from './kit';

export interface ParetoItem {
  key: string;
  label: string;
  count: number;
  /** 툴팁에 덧붙일 설명 (예: 검출 설비) */
  note?: string;
}

const M = { l: 40, r: 12, t: 14, b: 40 };
const CUM = 'var(--color-sub)';

/** 두 줄로 접고, 넘치면 말줄임 (전체 이름은 툴팁·표에 있다) */
function wrap(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  const out = lines.slice(0, 2).map((l) => (l.length > maxChars ? l.slice(0, Math.max(1, maxChars - 1)) + '…' : l));
  if (lines.length > 2) out[1] = out[1].slice(0, Math.max(1, maxChars - 1)) + '…';
  return out;
}

/**
 * 파레토도. 막대(불량 비율)와 누적 비율 선을 같은 0~100% 축 하나에 그린다 (이중 축 금지).
 * 80% 기준선까지의 항목이 먼저 손댈 불량이다.
 */
export function ParetoChart({ items, height = 240 }: { items: ParetoItem[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const total = items.reduce((a, b) => a + b.count, 0);
  const innerW = Math.max(0, width - M.l - M.r);
  const innerH = height - M.t - M.b;
  const y = (p: number) => M.t + innerH - p * innerH;
  const band = items.length ? innerW / items.length : 0;
  const barW = Math.max(4, Math.min(24, band * 0.55));
  let acc = 0;
  const rows = items.map((it) => {
    acc += it.count;
    return { ...it, share: total ? it.count / total : 0, cum: total ? acc / total : 0 };
  });
  const xs = rows.map((_, i) => M.l + band * i + band / 2);
  const maxChars = Math.max(3, Math.floor(band / 10.5));

  return (
    <div ref={ref} className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} className="block" role="img" aria-label="불량 파레토도">
          {[0, 0.25, 0.5, 0.75, 1].map((p) => (
            <g key={p}>
              <line x1={M.l} x2={M.l + innerW} y1={y(p)} y2={y(p)} stroke={p === 0 ? C.axis : C.grid} strokeWidth={1} />
              <text x={M.l - 6} y={y(p)} dy="0.32em" textAnchor="end" fontSize={10} fill={C.dim} className="num">
                {p * 100}%
              </text>
            </g>
          ))}
          <line x1={M.l} x2={M.l + innerW} y1={y(0.8)} y2={y(0.8)} stroke={C.dim} strokeWidth={1} strokeDasharray="4 3" />
          <text x={M.l + innerW} y={y(0.8) - 4} textAnchor="end" fontSize={10} fill={C.dim}>
            80%
          </text>
          {rows.map((r, i) => (
            <g key={r.key} opacity={hover != null && hover !== i ? 0.6 : 1}>
              <path d={topRounded(xs[i] - barW / 2, y(r.share), barW, y(0) - y(r.share))} fill={C.series} />
              {wrap(r.label, maxChars).map((line, k) => (
                <text key={k} x={xs[i]} y={height - M.b + 14 + k * 12} textAnchor="middle" fontSize={10} fill={C.sub}>
                  {line}
                </text>
              ))}
            </g>
          ))}
          {rows.length > 1 && (
            <polyline points={rows.map((r, i) => `${xs[i]},${y(r.cum)}`).join(' ')} fill="none" stroke={CUM} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          )}
          {rows.map((r, i) => (
            <circle key={r.key} cx={xs[i]} cy={y(r.cum)} r={hover === i ? 4.5 : 3} fill={CUM} stroke={C.surface} strokeWidth={2} />
          ))}
          {/* 첫 막대(가장 큰 불량)만 값을 직접 단다 */}
          {rows[0] && (
            <text x={xs[0]} y={y(rows[0].share) - 6} textAnchor="middle" fontSize={10} fill={C.ink} className="num">
              {Math.round(rows[0].share * 100)}%
            </text>
          )}
          {rows.map((r, i) => (
            <rect key={r.key} x={M.l + band * i} y={M.t} width={band} height={innerH + 20} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
        </svg>
      )}
      {hover != null && rows[hover] && (
        <Tip x={xs[hover]} y={M.t} width={width}>
          <TipTitle>{rows[hover].label}</TipTitle>
          <TipRow color={C.series} shape="rect" label={`불량 비율 · ${rows[hover].count.toLocaleString('ko-KR')}건`} value={`${(rows[hover].share * 100).toFixed(1)}%`} />
          <TipRow color={CUM} label="누적 비율" value={`${(rows[hover].cum * 100).toFixed(1)}%`} />
          {rows[hover].note && <div className="mt-1 text-[11px] text-dim">{rows[hover].note}</div>}
        </Tip>
      )}
    </div>
  );
}

export const PARETO_LEGEND = [
  { label: '불량 비율', color: C.series, shape: 'rect' as const },
  { label: '누적 비율', color: CUM, shape: 'line' as const },
];

/** 상위 n개 + 나머지는 "기타" (9번째 색을 만들지 않고 접는다) */
export function foldPareto(items: ParetoItem[], n = 8): ParetoItem[] {
  const sorted = [...items].sort((a, b) => b.count - a.count);
  if (sorted.length <= n) return sorted;
  const rest = sorted.slice(n - 1);
  return [...sorted.slice(0, n - 1), { key: '__other', label: `기타 ${rest.length}종`, count: rest.reduce((a, b) => a + b.count, 0) }];
}
