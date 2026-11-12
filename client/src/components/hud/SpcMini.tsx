'use client';

import { SPC_RULES, type SpcChart } from '@lumitwin/shared';
import { cx, kst, num } from '@/lib/format';

const W = 320;
const H = 86;
const PAD = { l: 4, r: 4, t: 8, b: 8 };

/** X̄ 관리도 한 장: 중심선·관리한계(빨강 점선)·규격(주황)·판정 규칙에 걸린 점(빨강) */
export function SpcMini({ chart }: { chart: SpcChart }) {
  const pts = chart.points.slice(-40);
  const vals = [chart.ucl, chart.lcl, ...pts.map((p) => p.mean)];
  const spec = [chart.lsl, chart.usl].filter((v): v is number => v != null);
  // 규격이 관리한계에서 너무 멀면 그래프가 납작해져서, 가까운 경우만 함께 그린다
  const span = chart.ucl - chart.lcl;
  const showSpec = spec.filter((s) => Math.abs(s - chart.cl) < span * 2.5);
  const lo = Math.min(...vals, ...showSpec) - span * 0.15;
  const hi = Math.max(...vals, ...showSpec) + span * 0.15;
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo || 1)) * (H - PAD.t - PAD.b);
  const x = (i: number) => PAD.l + (i / Math.max(1, 39)) * (W - PAD.l - PAD.r);
  const last = pts[pts.length - 1];
  const flagged = pts.slice(-10).some((p) => p.flags.length);

  return (
    <div className={cx('rounded-md border p-2', flagged && chart.alarms ? 'border-warn/50 bg-warn/[0.06]' : 'border-line bg-white/[0.02]')}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <div className="truncate">
          <span className="font-medium">{chart.name}</span>
          <span className="ml-1 text-dim">
            {chart.source === 'measure' ? '검사값' : chart.source === 'cycle' ? '공정값' : '연속값(참고)'} · n={chart.n}
          </span>
        </div>
        <div className="num shrink-0 text-dim">
          X̄ <span className="text-ink">{last ? num(last.mean) : '-'}</span> {chart.unit}
          {chart.cpk != null && (
            <span className={cx('ml-2', chart.cpk < 1.0 ? 'text-down' : chart.cpk < 1.33 ? 'text-warn' : 'text-run')}>Cpk {chart.cpk.toFixed(2)}</span>
          )}
        </div>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="block">
        {showSpec.map((s) => (
          <line key={s} x1={0} x2={W} y1={y(s)} y2={y(s)} stroke="#f5b544" strokeWidth={1} opacity={0.7} />
        ))}
        <line x1={0} x2={W} y1={y(chart.ucl)} y2={y(chart.ucl)} stroke="#ff4d5e" strokeDasharray="4 3" strokeWidth={1} opacity={0.8} />
        <line x1={0} x2={W} y1={y(chart.lcl)} y2={y(chart.lcl)} stroke="#ff4d5e" strokeDasharray="4 3" strokeWidth={1} opacity={0.8} />
        <line x1={0} x2={W} y1={y(chart.cl)} y2={y(chart.cl)} stroke="#94a3b8" strokeDasharray="2 3" strokeWidth={1} opacity={0.6} />
        {pts.length > 1 && <polyline fill="none" stroke="#4fb3ff" strokeWidth={1.4} points={pts.map((p, i) => `${x(i)},${y(p.mean)}`).join(' ')} />}
        {pts.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.mean)} r={p.flags.length ? 2.8 : 1.6} fill={p.flags.length ? '#ff4d5e' : '#4fb3ff'}>
            <title>{`${kst(p.t)} X̄=${num(p.mean)} R=${num(p.range)}${p.flags.length ? ' · ' + p.flags.map((f) => SPC_RULES[f]).join(', ') : ''}`}</title>
          </circle>
        ))}
        {pts.length === 0 && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fill="#64748b" fontSize="11">
            부분군을 모으는 중 (5개씩)
          </text>
        )}
      </svg>
      <div className="num mt-0.5 flex justify-between text-[10px] text-dim">
        <span>LCL {num(chart.lcl)}</span>
        <span>CL {num(chart.cl)}</span>
        <span>UCL {num(chart.ucl)}</span>
        {(chart.lsl != null || chart.usl != null) && (
          <span className="text-warn/80">
            규격 {chart.lsl ?? '−'} ~ {chart.usl ?? '−'}
          </span>
        )}
      </div>
    </div>
  );
}
