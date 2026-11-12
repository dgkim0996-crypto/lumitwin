'use client';

import { FACTORY, LINES, type AmrState } from '@lumitwin/shared';
import { STATE_COLOR, STATE_LABEL } from '@/lib/format';
import { useLive } from '@/lib/live';
import { FOOTPRINT } from './machines';
import { labelRef } from './labels';

const AMR_LABEL: Record<AmrState, string> = {
  IDLE: '대기',
  TO_PICK: '적재 위치로 이동',
  LOADING: '적재 중',
  MOVING: '운반 중',
  UNLOADING: '하역 중',
  RETURNING: '복귀 중',
  CHARGING: '충전 중',
};

const base = 'pointer-events-none absolute left-0 top-0 will-change-transform';

/** 캔버스 위 DOM 이름표 층 (위치는 LabelProjector가 옮긴다) */
export function SceneLabels() {
  const stations = useLive((s) => s.stations);
  const selected = useLive((s) => s.selected);
  const hovered = useLive((s) => s.hovered);
  const amrs = useLive((s) => s.amrs);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {LINES.map((l) => (
        <div key={l.code} ref={labelRef(`bay:${l.code}`, l.bay.x0 + 7, 0.1, l.bay.z0 + 1.6)} className={base}>
          <div className="zone-tag" style={{ borderColor: l.color, color: l.color }}>
            {l.short} · {l.name}
          </div>
        </div>
      ))}
      {FACTORY.warehouses.map((w) => (
        <div key={w.code} ref={labelRef(`wh:${w.code}`, w.pos[0], 4.8, w.pos[1] - w.size[1] / 2 + 2)} className={base}>
          <div className="zone-tag">{w.name}</div>
        </div>
      ))}
      {LINES.flatMap((l) =>
        l.stations.map((def) => {
          const st = stations[def.code];
          const state = st?.state ?? (def.cycle <= 0 ? 'RUN' : 'IDLE');
          const isSel = selected === def.code;
          const show = isSel || hovered === def.code || state === 'DOWN';
          const H = FOOTPRINT[def.kind][2];
          return (
            <div key={def.code} ref={labelRef(`st:${def.code}`, def.pos[0], H + 1.1, def.pos[1])} className={base} style={{ display: show ? 'block' : 'none' }}>
              <div className="station-tag" style={{ borderColor: isSel ? l.color : undefined }}>
                <span className="dot" style={{ background: STATE_COLOR[state] }} />
                <b>{def.code}</b>
                <span className="muted">{state === 'DOWN' ? `${STATE_LABEL.DOWN}${st?.reason ? ` · ${st.reason}` : ''}` : def.name}</span>
              </div>
            </div>
          );
        }),
      )}
      {FACTORY.amrs.map((a) => {
        const m = amrs[a.code];
        return (
          <div key={a.code} ref={labelRef(`amr:${a.code}`, a.home[0], 1.5, a.home[1])} className={base} style={{ display: hovered === `amr:${a.code}` && m ? 'block' : 'none' }}>
            {m && (
              <div className="station-tag">
                <b>{a.code}</b>
                <span className="muted">
                  {AMR_LABEL[m.state]} · {m.transfer} · 적재 {m.load} · 배터리 {m.battery.toFixed(0)}%
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
