'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { TraceNode } from '@lumitwin/shared';
import { api } from '@/lib/api';
import { cx, kst, num } from '@/lib/format';
import { useLive } from '@/lib/live';
import { defectName, ITEM_NAMES, stationName, valueMeta } from '@/lib/names';

export const UNIT_STATUS: Record<string, string> = { WIP: '공정 중', NG: '불량', DONE: '완성', CONSUMED: '조립됨' };

/** 제품 상태 배지 (색 + 글자) */
export function StatusBadge({ status, defect }: { status: string | null; defect?: string | null }) {
  if (!status) return <span className="rounded bg-white/10 px-1.5 text-[11px] text-dim">기록 없음</span>;
  return (
    <span className={cx('whitespace-nowrap rounded px-1.5 text-[11px]', status === 'NG' ? 'bg-down/20 text-down' : status === 'DONE' ? 'bg-run/20 text-run' : 'bg-white/10 text-sub')}>
      {UNIT_STATUS[status] ?? status}
      {defect ? ` · ${defectName(defect)}` : ''}
    </span>
  );
}

/** 시리얼 계보 트리. onPick이 없으면 시리얼을 누를 때 이력 창을 연다. full이면 공정 값을 모두 이름과 함께 보인다 */
export function TraceTree({ n, depth = 0, onPick, full = false }: { n: TraceNode; depth?: number; onPick?: (serial: string) => void; full?: boolean }) {
  const openTrace = useLive((s) => s.openTrace);
  const pick = onPick ?? openTrace;
  return (
    <div className={cx(depth > 0 && 'ml-4 border-l border-line pl-3')}>
      <div className="mt-2 flex flex-wrap items-baseline gap-2">
        <button className="num text-sm font-semibold hover:underline" onClick={() => pick(n.serial)}>
          {n.serial}
        </button>
        <span className="text-xs text-sub">{(n.item && ITEM_NAMES[n.item]) ?? n.item ?? '이력 없음 (시작 재공)'}</span>
        {n.status && <StatusBadge status={n.status} defect={n.defect} />}
      </div>
      {n.records.length > 0 && (
        <table className="mt-1 w-full text-[11px]">
          <tbody>
            {n.records.map((r, i) => (
              <tr key={i} className="border-b border-line/50 align-top">
                <td className="num w-16 py-0.5 text-dim">{kst(r.endedAt)}</td>
                <td className="w-40 py-0.5">{stationName(r.station)}</td>
                <td className={cx('w-24 py-0.5', r.result === 'NG' ? 'text-down' : 'text-run')}>
                  {r.result}
                  {r.defect ? ` ${defectName(r.defect)}` : ''}
                  {r.escaped.length > 0 && <span className="ml-1 text-warn">유출 {r.escaped.map(defectName).join(',')}</span>}
                </td>
                <td className="num py-0.5 text-sub">
                  {Object.entries(full ? { ...r.values, ...(r.attrs ?? {}) } : r.values)
                    .slice(0, full ? undefined : 4)
                    .map(([k, v]) => {
                      if (!full) return `${k} ${num(v)}`;
                      const m = valueMeta(r.station, k);
                      return `${m.name} ${num(v)}${m.unit ? ` ${m.unit}` : ''}`;
                    })
                    .join(' · ')}
                  {r.lots && <div className="text-dim">LOT {Object.values(r.lots).join(', ')}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {n.children.map((c) => (
        <TraceTree key={c.serial} n={c} depth={depth + 1} onPick={onPick} full={full} />
      ))}
    </div>
  );
}

/** 시리얼 이력(정추적): 거친 공정의 조건·판정 + 들어간 부품을 아래로 따라간다 */
export function TraceDialog() {
  const serial = useLive((s) => s.traceSerial);
  const openTrace = useLive((s) => s.openTrace);
  const q = useQuery({ queryKey: ['trace', serial], queryFn: () => api.get<TraceNode>(`/production/trace/${encodeURIComponent(serial!)}`), enabled: !!serial });
  const up = useQuery({ queryKey: ['ancestors', serial], queryFn: () => api.get<string[]>(`/production/ancestors/${encodeURIComponent(serial!)}`), enabled: !!serial });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && openTrace(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openTrace]);
  if (!serial) return null;
  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => openTrace(null)}>
      <div className="panel scroll-thin max-h-[82vh] w-[760px] overflow-y-auto p-4" style={{ background: 'var(--color-panel-solid)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-base font-semibold">제품 이력 추적</div>
            <div className="text-xs text-sub">MES에 저장된 공정 기록으로 부품 계보를 따라갑니다 (LOT·공정 조건·판정)</div>
          </div>
          <button onClick={() => openTrace(null)} className="rounded px-2 py-1 text-sm text-sub hover:bg-white/10">
            닫기
          </button>
        </div>
        {up.data && up.data.length > 0 && (
          <div className="mt-2 text-xs text-sub">
            역추적: 이 부품은{' '}
            {up.data.map((s, i) => (
              <span key={s}>
                {i > 0 && ' → '}
                <button className="num text-info hover:underline" onClick={() => openTrace(s)}>
                  {s}
                </button>
              </span>
            ))}
            에 조립되었습니다
          </div>
        )}
        {q.isLoading && <div className="mt-4 text-sm text-dim">불러오는 중…</div>}
        {q.error && <div className="mt-4 text-sm text-down">{(q.error as Error).message}</div>}
        {q.data && <TraceTree n={q.data} />}
      </div>
    </div>
  );
}
