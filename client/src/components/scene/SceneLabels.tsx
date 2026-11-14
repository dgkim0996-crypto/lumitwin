'use client';

import { FACTORY, LINES, STATIONS, type AmrState, type StationDef } from '@lumitwin/shared';
import { STATE_COLOR, STATE_LABEL } from '@/lib/format';
import { useLive } from '@/lib/live';
import { guideFor } from '@/lib/station-guide';
import { calloutsFor, FOOTPRINT } from './machines';
import { labelRef } from './labels';

/** 설비 원점 기준 좌표 → 월드 좌표 (Station3D와 같은 회전·위치) */
export function stationToWorld(def: StationDef, [x, y, z]: [number, number, number]): [number, number, number] {
  const a = ((def.rot ?? 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [def.pos[0] + x * c + z * s, y, def.pos[1] - x * s + z * c];
}

/** 고른 설비의 부위 이름표: 무엇이 어디서 무슨 일을 하는지 3D 위에 짚어 준다 */
export function PartTags({ def }: { def: StationDef }) {
  return (
    <>
      {calloutsFor(def).map((c, i) => {
        const [x, y, z] = stationToWorld(def, c.at);
        return (
          <div key={`${def.code}:${i}`} ref={labelRef(`part:${def.code}:${i}`, x, y, z)} className={base}>
            <div className="part-tag" title={c.note}>
              {c.text}
            </div>
          </div>
        );
      })}
    </>
  );
}

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
          // 고른 설비는 부위 이름표가 함께 뜨므로, 가장 높은 부위 이름표보다 위로 올려 겹치지 않게 한다
          const top = isSel ? Math.max(H + 0.3, ...calloutsFor(def).map((c) => c.at[1] + 0.6)) : H;
          return (
            <div key={def.code} ref={labelRef(`st:${def.code}`, def.pos[0], top + 1.1, def.pos[1])} className={base} style={{ display: show ? 'block' : 'none' }}>
              <div className="station-tag" style={{ borderColor: isSel ? l.color : undefined, transform: isSel ? 'translateY(-14px)' : undefined }}>
                <span className="dot" style={{ background: STATE_COLOR[state] }} />
                <b>{def.code}</b>
                <span className="muted">{state === 'DOWN' ? `${STATE_LABEL.DOWN}${st?.reason ? ` · ${st.reason}` : ''}` : def.name}</span>
                {state !== 'DOWN' && guideFor(def).tag && <span style={{ color: l.color }}>{guideFor(def).tag}</span>}
              </div>
            </div>
          );
        }),
      )}
      {selected && STATIONS[selected] && <PartTags def={STATIONS[selected]} />}
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
