'use client';

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { EquipmentKind, StationDef, StationState } from '@lumitwin/shared';
import { Box, Cyl, MAT } from '../parts';

export type V3 = [number, number, number];

/**
 * 설비 겉모양 크기 [길이(x, 흐름 방향), 폭(z), 높이] (m).
 * 선택 테두리·이름표 높이·클릭 판정이 이 값을 쓰고, 공장 배치(shared/src/factory)의 설비 간격과 컨베이어가 이 크기에 맞춰져 있다.
 * 바꾸지 않는다. 모델은 이 상자 안(조금 넘치는 정도까지)에 그린다.
 */
export const FOOTPRINT: Record<EquipmentKind, V3> = {
  dryer: [1.6, 1.6, 2.6],
  injection: [8, 2.4, 2.4],
  'tunnel-hardcoat': [16, 3.2, 2.8],
  metallizer: [5, 3.6, 3.2],
  'assembly-cell': [6, 5, 2.2],
  sealer: [5, 3.6, 2.3],
  'leak-tester': [3.6, 2.6, 2.1],
  photometry: [6, 3.2, 2.7],
  'eol-tester': [3.6, 2.6, 2.1],
  packer: [4, 3, 1.9],
  'laser-marker': [1.6, 1.7, 1.7],
  printer: [1.9, 1.9, 1.7],
  spi: [1.5, 1.7, 1.7],
  mounter: [2.8, 2.3, 1.7],
  reflow: [5.4, 1.7, 1.5],
  aoi: [1.5, 1.7, 1.7],
  'router-cobot': [3.6, 3, 2.1],
  ict: [1.7, 1.9, 1.9],
  coater: [2.6, 1.9, 1.9],
  fct: [2.4, 1.6, 1.8],
  'screw-cell': [3, 3, 2.2],
  'tunnel-paint': [18, 3.6, 3.4],
  'actuator-cell': [5, 4, 2.2],
  'function-tester': [4, 3, 2.2],
};

/** 컨베이어 벨트 윗면 높이 (m). 부품·팰릿은 이 높이로 설비를 지난다 (Conveyors.tsx의 BELT_Y + 반 두께) */
export const BELT_TOP = 0.82;

export interface MachineProps {
  /** 이 설비의 공장 정의 (코드·이름·태그 등). 같은 종류라도 설비마다 모양을 다르게 할 때 쓴다 */
  def: StationDef;
  /** 라인 색 */
  color: string;
  state: StationState;
  /** state === 'RUN'. 움직이는 부분은 이때만 움직인다 */
  running: boolean;
}

/**
 * 설비를 고르면 3D 위에 띄우는 부위 이름표. at은 설비 원점 기준 좌표(m, x = 흐름 방향, y = 위, z = 폭)이고
 * 설비의 회전·위치는 이름표 층(SceneLabels)이 적용한다. note는 상세 패널의 "3D에서 보이는 부분"에 같이 나온다.
 */
export interface Callout {
  text: string;
  at: V3;
  note?: string;
}

/** 열 공정(경화로·리플로우·도장 오븐) 창: 가동 중에 달아오른다 */
export function HeatPanel({ size, pos, state, rot }: { size: V3; pos: V3; state: StationState; rot?: V3 }) {
  const mat = useMemo(() => MAT.heat.clone(), []);
  const ref = useRef(state);
  ref.current = state;
  useFrame(({ clock }, dt) => {
    const hot = ref.current === 'RUN' || ref.current === 'IDLE' || ref.current === 'BLOCKED';
    const target = hot ? 1.1 + Math.sin(clock.elapsedTime * 2.3) * 0.12 : 0.05;
    mat.emissiveIntensity += (target - mat.emissiveIntensity) * Math.min(1, dt * 0.8);
  });
  return <Box size={size} pos={pos} mat={mat} cast={false} rot={rot} />;
}

/** 갠트리 헤드 왕복 (디스펜서·마운터 헤드) */
export function Gantry({ running, span, y, z, fast = false }: { running: boolean; span: number; y: number; z: number; fast?: boolean }) {
  const ref = useRef<THREE.Group>(null);
  const run = useRef(running);
  run.current = running;
  const t = useRef(0);
  useFrame((_, dt) => {
    if (run.current) t.current += dt * (fast ? 4 : 1.2);
    if (ref.current) ref.current.position.x = Math.sin(t.current) * span * 0.5;
  });
  return (
    <group ref={ref} position={[0, y, z]}>
      <Box size={[0.25, 0.3, 0.3]} mat={MAT.bodyDark} />
      <Cyl r={0.04} h={0.3} pos={[0, -0.25, 0]} mat={MAT.steel} />
    </group>
  );
}
