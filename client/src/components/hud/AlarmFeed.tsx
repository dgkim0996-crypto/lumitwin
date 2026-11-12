'use client';

import { useState } from 'react';
import { STATIONS, type AlarmLive } from '@lumitwin/shared';
import { useAccess } from '@/lib/access';
import { api } from '@/lib/api';
import { cx, kst } from '@/lib/format';
import { useLive } from '@/lib/live';

const SEV: Record<AlarmLive['severity'], { color: string; label: string }> = {
  critical: { color: '#ff4d5e', label: '긴급' },
  warn: { color: '#f5b544', label: '경고' },
  info: { color: '#4fb3ff', label: '참고' },
};

const KIND: Record<AlarmLive['kind'], string> = {
  DOWN: '고장',
  LIMIT: '규격',
  SPC: 'SPC',
  QUALITY: '품질',
  SCENARIO: '시나리오',
  CHECK: '점검',
};

type Filter = 'all' | 'open' | 'quality';

/** 알람 목록: 고장(긴급) · 규격 이탈·불량률(경고) · SPC 판정(참고). 누르면 그 설비로 간다 */
export function AlarmFeed() {
  const alarms = useLive((s) => s.alarms);
  const events = useLive((s) => s.events);
  const select = useLive((s) => s.select);
  const ackLocal = useLive((s) => s.ackLocal);
  const { readOnly } = useAccess();
  const [filter, setFilter] = useState<Filter>('open');
  const list = alarms.filter((a) => (filter === 'open' ? !a.acked : filter === 'quality' ? a.kind !== 'DOWN' : true));
  const open = alarms.filter((a) => !a.acked).length;

  const ack = async (id: number) => {
    ackLocal(id);
    await api.post(`/live/alarms/${id}/ack`).catch(() => {});
  };

  return (
    <div className="panel pointer-events-auto flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <div className="text-sm font-semibold">
          알람 <span className="num text-xs text-sub">{open}건 미확인</span>
        </div>
        <div className="flex gap-1 text-[11px]">
          {(
            [
              ['open', '미확인'],
              ['quality', '품질·SPC'],
              ['all', '전체'],
            ] as const
          ).map(([k, t]) => (
            <button key={k} onClick={() => setFilter(k)} className={cx('rounded px-1.5 py-0.5', filter === k ? 'bg-white/15' : 'text-sub hover:bg-white/10')}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 && <div className="p-4 text-center text-xs text-dim">알람이 없습니다</div>}
        {list.slice(0, 120).map((a) => (
          <div key={a.id} className={cx('group flex gap-2 border-b border-line/60 px-3 py-2 hover:bg-white/[0.04]', a.acked && 'opacity-50')}>
            <span className="mt-1 h-full w-1 shrink-0 self-stretch rounded" style={{ background: SEV[a.severity].color }} />
            <button className="min-w-0 flex-1 text-left" onClick={() => select(a.station)}>
              <div className="flex items-center gap-1.5 text-[11px] text-dim">
                <span className="num">{kst(a.t)}</span>
                <span style={{ color: SEV[a.severity].color }}>{KIND[a.kind]}</span>
                <span className="truncate">{STATIONS[a.station]?.line}</span>
              </div>
              <div className="text-[13px] leading-snug">{a.title}</div>
              {a.detail && <div className="text-[11px] leading-snug text-sub">{a.detail}</div>}
            </button>
            {!a.acked && !readOnly && (
              // 터치 화면에는 마우스 올림이 없으므로 확인 버튼을 늘 보인다
              <button onClick={() => ack(a.id)} className="h-6 shrink-0 self-center rounded bg-white/10 px-1.5 text-[11px] opacity-0 group-hover:opacity-100 hover:bg-white/20 focus-visible:opacity-100 pointer-coarse:opacity-100">
                확인
              </button>
            )}
          </div>
        ))}
      </div>
      {events[0] && (
        <div className="border-t border-line px-3 py-1.5 text-[11px] text-sub">
          <span className="num text-dim">{kst(events[0].t)}</span> {events[0].message}
        </div>
      )}
    </div>
  );
}
