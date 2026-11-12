'use client';

import { Line } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { memo, useCallback } from 'react';
import type { StationDef } from '@lumitwin/shared';
import { useLive } from '@/lib/live';
import { STATE_COLOR } from '@/lib/format';
import { FOOTPRINT, Machine } from './machines';
import { StackLight } from './parts';

interface Props {
  def: StationDef;
  color: string;
}

/** 설비 하나: 모델 + 경광등 + 선택 테두리. 이름표는 SceneLabels(DOM)가 그린다. 클릭하면 오른쪽에 상세가 열린다 */
export const Station3D = memo(function Station3D({ def, color }: Props) {
  const state = useLive((s) => s.stations[def.code]?.state ?? (def.cycle <= 0 ? 'RUN' : 'IDLE'));
  const selected = useLive((s) => s.selected === def.code);
  const hovered = useLive((s) => s.hovered === def.code);
  const [L, D, H] = FOOTPRINT[def.kind];

  const onClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      useLive.getState().select(def.code);
    },
    [def.code],
  );
  const onOver = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      useLive.getState().hover(def.code);
      document.body.style.cursor = 'pointer';
    },
    [def.code],
  );
  const onOut = useCallback(() => {
    if (useLive.getState().hovered === def.code) useLive.getState().hover(null);
    document.body.style.cursor = '';
  }, [def.code]);

  const pad = 0.35;
  const ring: [number, number, number][] = [
    [-L / 2 - pad, 0.03, -D / 2 - pad],
    [L / 2 + pad, 0.03, -D / 2 - pad],
    [L / 2 + pad, 0.03, D / 2 + pad],
    [-L / 2 - pad, 0.03, D / 2 + pad],
    [-L / 2 - pad, 0.03, -D / 2 - pad],
  ];

  return (
    <group position={[def.pos[0], 0, def.pos[1]]} rotation={[0, ((def.rot ?? 0) * Math.PI) / 180, 0]} onClick={onClick} onPointerOver={onOver} onPointerOut={onOut}>
      <Machine kind={def.kind} color={color} state={state} />
      <StackLight state={state} pos={[L / 2 - 0.15, Math.max(H - 0.2, 1.2), -D / 2 + 0.15]} />
      {/* 클릭 판정을 넉넉하게: 보이지 않는 상자 */}
      <mesh position={[0, H / 2, 0]} visible={false}>
        <boxGeometry args={[L, H, D]} />
      </mesh>
      {(selected || hovered) && <Line points={ring} color={selected ? color : '#ffffff'} lineWidth={selected ? 2.5 : 1.2} transparent opacity={selected ? 1 : 0.6} />}
      {state === 'DOWN' && <Line points={ring} color={STATE_COLOR.DOWN} lineWidth={2} />}
    </group>
  );
});
