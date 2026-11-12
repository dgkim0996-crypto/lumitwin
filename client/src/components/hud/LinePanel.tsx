'use client';

import { LINES, STATIONS } from '@lumitwin/shared';
import { cx, pct } from '@/lib/format';
import { useLive } from '@/lib/live';

function Bar({ v, color }: { v: number; color: string }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded bg-white/10">
      <div className="h-full rounded" style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%`, background: color }} />
    </div>
  );
}

/** 라인별 생산 현황: 완성 수 · 최근 1시간 vs 목표 · OEE(가동률×성능×양품률) · FPY */
export function LinePanel() {
  const lines = useLive((s) => s.lines);
  const select = useLive((s) => s.select);
  return (
    <div className="flex flex-col gap-2">
      {LINES.map((def) => {
        const l = lines[def.code];
        const target = Math.round(3600 / def.taktSec);
        const rate = l ? l.lastHour / target : 0;
        return (
          <div key={def.code} className="panel pointer-events-auto overflow-hidden">
            <div className="h-0.5" style={{ background: def.color }} />
            <div className="p-3">
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="text-sm font-semibold">{def.name}</div>
                  <div className="text-xs text-dim">
                    {def.product.name} · 택트 {def.taktSec}초
                  </div>
                </div>
                <div className="text-right">
                  <div className="num text-xl font-semibold">{l?.output ?? 0}</div>
                  <div className="text-[11px] text-dim">완성</div>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <div className="text-dim">최근 1시간</div>
                  <div className={cx('num font-medium', rate < 0.8 && l ? 'text-warn' : '')}>
                    {l?.lastHour ?? 0} <span className="text-dim">/ {target}</span>
                  </div>
                </div>
                <div>
                  <div className="text-dim">OEE</div>
                  <div className="num font-medium">{pct(l?.oee.oee)}</div>
                </div>
                <div>
                  <div className="text-dim">FPY</div>
                  <div className={cx('num font-medium', l && l.fpy < 0.95 ? 'text-warn' : '')}>{pct(l?.fpy)}</div>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-dim">
                {(
                  [
                    ['가동률', l?.oee.availability ?? 0],
                    ['성능', l?.oee.performance ?? 0],
                    ['양품률', l?.oee.quality ?? 0],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k}>
                    <div className="mb-0.5 flex justify-between">
                      <span>{k}</span>
                      <span className="num">{pct(v, 0)}</span>
                    </div>
                    <Bar v={v} color={def.color} />
                  </div>
                ))}
              </div>
              {l && (l.downStations.length > 0 || l.ng > 0) && (
                <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px]">
                  {l.downStations.map((c) => (
                    <button key={c} onClick={() => select(c)} className="rounded bg-down/20 px-1.5 py-0.5 text-down hover:bg-down/30">
                      고장 {STATIONS[c]?.name ?? c}
                    </button>
                  ))}
                  {l.ng > 0 && <span className="text-dim">불량 {l.ng}개</span>}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
