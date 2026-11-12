'use client';

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cx } from '@/lib/format';

/**
 * 차트 공통 부품. 규칙(dataviz):
 * - 글자는 글자색(ink/sub/dim)만 쓴다. 계열 색은 막대·선·점과 그 옆 표식에만
 * - 계열이 둘 이상이면 범례를 늘 단다. 숫자는 끝점·극값만 직접 표시하고 나머지는 축·툴팁·표로
 * - 모든 차트에 표 보기를 둔다 (툴팁은 보조일 뿐 값을 읽는 유일한 길이 되면 안 된다)
 */

export const C = {
  series: 'var(--color-series)',
  seriesSoft: 'var(--color-series-soft)',
  ng: 'var(--color-ng)',
  warn: 'var(--color-warn)',
  grid: 'var(--color-grid)',
  axis: 'var(--color-axis)',
  surface: 'var(--color-chart)',
  ink: 'var(--color-ink)',
  sub: 'var(--color-sub)',
  dim: 'var(--color-dim)',
} as const;

/** 요소 폭을 따라간다 (SVG를 실제 픽셀 크기로 그려 글자가 늘어나지 않게) */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** 깔끔한 눈금 (1·2·5 × 10^n) */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max === min) max = min + 1;
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** 0부터 시작하는 값 축: 마지막 눈금이 최댓값을 반드시 덮는다 */
export function niceAxis(max: number, count = 4): number[] {
  const top = max > 0 ? max : 1;
  const raw = top / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const n = Math.ceil(top / step - 1e-9);
  return Array.from({ length: n + 1 }, (_, i) => Number((i * step).toFixed(10)));
}

/** 축 눈금 글자: 1만 미만은 그대로, 넘으면 짧게 */
export function tickText(v: number, digits?: number): string {
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(0)}K`;
  if (digits != null) return v.toFixed(digits);
  return Number.isInteger(v) ? v.toLocaleString('ko-KR') : String(Number(v.toPrecision(4)));
}

/** 바닥은 각지고 데이터 끝(위)만 4px 둥근 막대 */
export function topRounded(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** 오른쪽 끝이 둥근 가로 막대 */
export function rightRounded(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}

export interface LegendItem {
  label: string;
  color: string;
  shape?: 'rect' | 'line' | 'dash' | 'dot';
}

export function Key({ color, shape = 'rect' }: { color: string; shape?: LegendItem['shape'] }) {
  if (shape === 'line') return <span className="inline-block h-[2px] w-3.5 rounded" style={{ background: color }} />;
  if (shape === 'dash') return <span className="inline-block h-0 w-3.5 border-t border-dashed" style={{ borderColor: color }} />;
  if (shape === 'dot') return <span className="inline-block size-2 rounded-full" style={{ background: color }} />;
  return <span className="inline-block size-2.5 rounded-[3px]" style={{ background: color }} />;
}

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-sub">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <Key color={i.color} shape={i.shape} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** 차트 카드: 제목 · 설명 · 범례 · 표/차트 전환 */
export function ChartCard({
  title,
  subtitle,
  legend,
  right,
  table,
  children,
  className,
  stale,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  legend?: LegendItem[];
  right?: ReactNode;
  table?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 다시 불러오는 중: 이전 그림을 흐리게 유지한다 (깜빡임 없이) */
  stale?: boolean;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={cx('card min-w-0 p-4', className)}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-sub">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {right}
          {table && (
            <button
              onClick={() => setAsTable((v) => !v)}
              aria-pressed={asTable}
              className="rounded border border-line px-2 py-0.5 text-xs text-sub hover:bg-white/10 hover:text-ink"
            >
              {asTable ? '차트로 보기' : '표로 보기'}
            </button>
          )}
        </div>
      </header>
      {legend && legend.length > 1 && !asTable && (
        <div className="mb-2">
          <Legend items={legend} />
        </div>
      )}
      <div className={cx('transition-opacity', stale && 'opacity-60')}>{asTable ? table : children}</div>
    </section>
  );
}

/** 툴팁: 값이 앞에(굵게), 이름이 뒤에. 계열 표식은 짧은 선 */
export function Tip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = x > width - 200 ? x - 12 : x + 12;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-20 min-w-36 rounded-md border border-line bg-[#0a0f16]/95 px-2.5 py-2 text-xs shadow-lg"
      style={{ left, top: Math.max(0, y - 8), transform: x > width - 200 ? 'translateX(-100%)' : undefined }}
    >
      {children}
    </div>
  );
}

export function TipTitle({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-[11px] text-dim">{children}</div>;
}

export function TipRow({ color, label, value, shape = 'line' }: { color?: string; label: ReactNode; value: ReactNode; shape?: LegendItem['shape'] }) {
  return (
    <div className="flex items-center gap-2 py-px">
      {color ? <Key color={color} shape={shape} /> : <span className="w-3.5" />}
      <span className="num font-semibold text-ink">{value}</span>
      <span className="text-sub">{label}</span>
    </div>
  );
}

/** 표 보기 공통 모양 */
export function DataTable({ head, rows, align }: { head: ReactNode[]; rows: ReactNode[][]; align?: ('l' | 'r')[] }) {
  return (
    <div className="scroll-thin max-h-80 overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-[var(--color-chart)] text-dim">
          <tr>
            {head.map((h, i) => (
              <th key={i} className={cx('border-b border-line px-2 py-1.5 font-normal', align?.[i] === 'r' ? 'text-right' : 'text-left')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line/60">
              {r.map((c, j) => (
                <td key={j} className={cx('px-2 py-1', align?.[j] === 'r' ? 'num text-right' : '')}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Empty({ children, h = 160 }: { children: ReactNode; h?: number }) {
  return (
    <div className="flex items-center justify-center text-center text-xs leading-relaxed text-dim" style={{ height: h }}>
      {children}
    </div>
  );
}
