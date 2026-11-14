'use client';

import Link from 'next/link';
import { LINES, STATIONS, type LineCode, type LineDef, type LineExecution, type SimLineStatus } from '@lumitwin/shared';
import { WoProgress } from '@/components/execution/bits';
import { useExecSummary } from '@/lib/execution';
import { cx, pct } from '@/lib/format';
import { useLive } from '@/lib/live';
import { useUi } from '@/lib/ui';

function Bar({ v, color }: { v: number; color: string }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded bg-white/10">
      <div className="h-full rounded" style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%`, background: color }} />
    </div>
  );
}

const vName = (def: LineDef, code: string | null | undefined) => (code ? (def.variants.find((v) => v.code === code)?.name ?? code) : '-');

/**
 * 라인 실행 상태 (P9): 투입 중인 작업지시·기종·진척, 다음 작업지시, 불량 대기·수리대·격리 구역 개수.
 * 작업지시 진척은 MES 요약(/execution/summary), 개수는 시뮬레이터 상태(SimStatusMsg.lines)에서 온다
 */
function LineExec({ def, ex, sim }: { def: LineDef; ex: LineExecution | undefined; sim: SimLineStatus | undefined }) {
  const setLine = useUi((s) => s.setLine);
  const cur = ex?.current ?? null;
  const code = cur?.code ?? sim?.wo?.code ?? null;
  const variant = cur?.variant ?? sim?.wo?.variant ?? sim?.variant ?? null;
  const next = ex?.next ?? null;
  const pick = () => setLine(def.code as LineCode);
  if (!ex && !sim) return null;
  const chips = [
    { k: '불량 대기', v: sim?.ngPen ?? 0, warn: (ex?.waitMrb ?? 0) > 0, title: `불량 판정 뒤 처리를 기다리는 개체${ex?.waitMrb ? ` (MRB 판정 대기 ${ex.waitMrb}건)` : ''}` },
    { k: '수리대', v: sim?.repair ?? ex?.repairing ?? 0, warn: false, title: '수리·재작업 중이거나 줄 선 개체' },
    { k: '격리', v: sim?.quarantine ?? ex?.quarantine ?? 0, warn: true, title: '인터록에 걸려 격리 구역에 있는 개체' },
  ];
  return (
    <div className="mt-2 border-t border-line/60 pt-2 text-[11px]">
      <Link href="/orders" onClick={pick} className="group block rounded px-1 py-0.5 -mx-1 hover:bg-white/[0.06]" title="작업지시·생산 계획 열기">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-dim">작업지시</span>
          {code ? (
            <span className="num truncate text-ink">
              {code} <span className="text-sub">· {vName(def, variant)}</span>
            </span>
          ) : (
            <span className={sim?.waitingWo ? 'text-warn' : 'text-dim'}>{sim?.waitingWo ? '작업지시 기다리는 중' : '없음'}</span>
          )}
        </div>
        {cur ? (
          <div className="mt-1">
            <WoProgress qty={cur.qty} released={cur.released} doneQty={cur.doneQty} scrapQty={cur.scrapQty} height={5} />
            <div className="num mt-0.5 flex justify-between text-dim">
              <span>
                투입 {cur.released}/{cur.qty} · 양품 {cur.doneQty}
                {cur.scrapQty ? <span className="text-down"> · 폐기 {cur.scrapQty}</span> : null}
              </span>
              {next && (
                <span className={cx('truncate', next.variant !== cur.variant && 'text-warn')} title={next.variant !== cur.variant ? '다음 작업지시에서 기종이 바뀝니다 (셋업)' : undefined}>
                  다음 {vName(def, next.variant)}
                  {next.variant !== cur.variant ? ' ⇄' : ''}
                </span>
              )}
            </div>
          </div>
        ) : sim?.wo ? (
          <div className="num mt-0.5 text-dim">
            투입 {sim.wo.released}/{sim.wo.qty}
          </div>
        ) : null}
      </Link>
      <Link href="/ncr" onClick={pick} className="mt-1 -mx-1 flex flex-wrap gap-x-3 gap-y-0.5 rounded px-1 py-0.5 hover:bg-white/[0.06]" title="불량 처리(NCR) 열기">
        {chips.map((c) => (
          <span key={c.k} title={c.title} className="num">
            <span className="text-dim">{c.k}</span> <b className={cx('font-medium', c.v > 0 && c.warn ? 'text-warn' : 'text-ink')}>{c.v}</b>
          </span>
        ))}
        {(ex?.waitMrb ?? 0) > 0 && <span className="text-warn">MRB {ex!.waitMrb}</span>}
      </Link>
    </div>
  );
}

/** 라인별 생산 현황: 완성 수 · 최근 1시간 vs 목표 · OEE(가동률×성능×양품률) · FPY · 실행 상태(작업지시·불량 처리·격리) */
export function LinePanel() {
  const lines = useLive((s) => s.lines);
  const select = useLive((s) => s.select);
  const simLines = useLive((s) => s.sim?.lines);
  const exec = useExecSummary();
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
              <LineExec def={def} ex={exec.data?.lines.find((x) => x.line === def.code)} sim={simLines?.[def.code as LineCode]} />
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
