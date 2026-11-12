'use client';

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { EquipmentKind, StationState } from '@lumitwin/shared';
import { Box, Cyl, Fence, MAT, RobotArm, Stripe, Table } from './parts';

/** 설비 겉모양 크기 [길이(x, 흐름 방향), 폭(z), 높이]. 컨베이어 끝점과 맞춘 값이다 */
export const FOOTPRINT: Record<EquipmentKind, [number, number, number]> = {
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

interface MachineProps {
  kind: EquipmentKind;
  color: string;
  state: StationState;
}

/** 열 공정(경화로·리플로우·도장 오븐) 창: 가동 중에 달아오른다 */
function HeatPanel({ size, pos, state }: { size: [number, number, number]; pos: [number, number, number]; state: StationState }) {
  const mat = useMemo(() => MAT.heat.clone(), []);
  const ref = useRef(state);
  ref.current = state;
  useFrame(({ clock }, dt) => {
    const hot = ref.current === 'RUN' || ref.current === 'IDLE' || ref.current === 'BLOCKED';
    const target = hot ? 1.1 + Math.sin(clock.elapsedTime * 2.3) * 0.12 : 0.05;
    mat.emissiveIntensity += (target - mat.emissiveIntensity) * Math.min(1, dt * 0.8);
  });
  return <Box size={size} pos={pos} mat={mat} cast={false} />;
}

/** SMT 계열 공통 몸체: 아래 받침 + 위 덮개 + 창 + 화면 */
function SmtBody({ l, d, h, color, window = true }: { l: number; d: number; h: number; color: string; window?: boolean }) {
  return (
    <group>
      <Box size={[l, 0.8, d]} pos={[0, 0.4, 0]} mat={MAT.bodyLight} />
      <Box size={[l, h - 0.95, d]} pos={[0, 0.8 + (h - 0.95) / 2 + 0.07, 0]} mat={MAT.bodyLight} />
      {window && <Box size={[l * 0.7, (h - 0.95) * 0.55, 0.02]} pos={[0, 0.8 + (h - 0.95) * 0.55, d / 2 + 0.01]} mat={MAT.glass} cast={false} />}
      <Box size={[0.36, 0.26, 0.04]} pos={[l / 2 - 0.25, h - 0.35, d / 2 + 0.05]} mat={MAT.screen} cast={false} />
      <Stripe size={[l + 0.01, 0.06, d + 0.01]} pos={[0, 0.82, 0]} color={color} />
    </group>
  );
}

export function Machine({ kind, color, state }: MachineProps) {
  const running = state === 'RUN';
  const [L, D, H] = FOOTPRINT[kind];

  switch (kind) {
    case 'dryer':
      return (
        <group>
          {[[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].map(([x, z], i) => (
            <Box key={i} size={[0.08, 1.0, 0.08]} pos={[x, 0.5, z]} mat={MAT.frame} cast={false} />
          ))}
          <Cyl r={0.65} h={1.2} pos={[0, 1.6, 0]} mat={MAT.steel} />
          <Cyl r={0.65} rTop={0.12} h={0.5} pos={[0, 0.75, 0]} mat={MAT.steel} rot={[Math.PI, 0, 0]} />
          <Cyl r={0.2} h={0.3} pos={[0, 2.35, 0]} mat={MAT.bodyDark} />
          <Box size={[0.8, 1.4, 0.7]} pos={[0.9, 0.7, 0]} mat={MAT.body} />
          <Stripe size={[0.81, 0.08, 0.71]} pos={[0.9, 1.2, 0]} color={color} />
        </group>
      );

    case 'injection':
      // 왼쪽: 사출 유닛(호퍼·배럴) · 오른쪽: 형체 유닛(금형·타이바) · 안전 커버
      return (
        <group>
          <Box size={[L, 0.9, D * 0.8]} pos={[0, 0.45, 0]} mat={MAT.body} />
          <Box size={[L * 0.4, 0.9, D * 0.55]} pos={[-L * 0.28, 1.35, 0]} mat={MAT.body} />
          <Cyl r={0.18} h={L * 0.32} pos={[-L * 0.12, 1.55, 0]} rot={[0, 0, Math.PI / 2]} mat={MAT.steel} />
          <Cyl r={0.35} rTop={0.45} h={0.8} pos={[-L * 0.3, 2.2, 0]} mat={MAT.steel} />
          <Box size={[L * 0.42, 1.25, D * 0.92]} pos={[L * 0.25, 1.52, 0]} mat={MAT.glass} cast={false} />
          {[-0.45, 0.45].map((z) =>
            [-0.5, 0.5].map((y) => (
              <Cyl key={`${z}${y}`} r={0.07} h={L * 0.38} pos={[L * 0.25, 1.5 + y * 0.8, z * D * 0.7]} rot={[0, 0, Math.PI / 2]} mat={MAT.steel} />
            )),
          )}
          <Box size={[0.25, 1.1, D * 0.75]} pos={[L * 0.06, 1.5, 0]} mat={MAT.bodyDark} />
          <Box size={[0.25, 1.1, D * 0.75]} pos={[L * 0.44, 1.5, 0]} mat={MAT.bodyDark} />
          <Box size={[0.6, 0.45, 0.06]} pos={[-L * 0.05, 1.3, D * 0.45]} mat={MAT.screen} cast={false} />
          <Stripe size={[L + 0.01, 0.08, D * 0.8 + 0.01]} pos={[0, 0.88, 0]} color={color} />
          <RobotArm pos={[L * 0.25, 2.2, -D * 0.25]} running={running} scale={0.7} />
        </group>
      );

    case 'tunnel-hardcoat':
    case 'tunnel-paint': {
      const panels = Math.floor(L / 2.4);
      return (
        <group>
          <Box size={[L, H * 0.85, D]} pos={[0, H * 0.425, 0]} mat={MAT.steel} />
          <Box size={[L * 0.98, 0.25, D * 1.04]} pos={[0, H * 0.9, 0]} mat={MAT.bodyDark} />
          {Array.from({ length: panels }, (_, i) => (
            <HeatPanel key={i} size={[1.4, H * 0.32, 0.03]} pos={[-L / 2 + 1.4 + i * ((L - 2.8) / Math.max(1, panels - 1)), H * 0.5, D / 2 + 0.02]} state={state} />
          ))}
          <Box size={[0.6, 0.9, 0.7]} pos={[-L / 2 + 0.3, 1.2, D / 2 + 0.4]} mat={MAT.body} />
          <Box size={[0.4, 0.3, 0.05]} pos={[-L / 2 + 0.3, 1.45, D / 2 + 0.76]} mat={MAT.screen} cast={false} />
          {kind === 'tunnel-paint' && (
            <>
              <Box size={[3.4, H * 1.02, D * 1.05]} pos={[-L / 2 + 2.2, H * 0.51, 0]} mat={MAT.glass} cast={false} />
              <RobotArm pos={[-L / 2 + 1.6, 0, -D * 0.25]} running={running} scale={0.9} color="#ffd56b" />
              <RobotArm pos={[-L / 2 + 2.9, 0, D * 0.25]} running={running} scale={0.9} color="#ffd56b" phase={1.4} />
            </>
          )}
          <Cyl r={0.25} h={1.2} pos={[L * 0.3, H + 0.4, 0]} mat={MAT.steel} />
          <Stripe size={[L + 0.01, 0.1, D + 0.01]} pos={[0, 0.2, 0]} color={color} />
        </group>
      );
    }

    case 'metallizer':
      // 박스형 진공 챔버 + 원형 도어 + 진공 펌프
      return (
        <group>
          <Box size={[L * 0.55, H * 0.9, D]} pos={[-L * 0.15, H * 0.45, 0]} mat={MAT.steel} />
          <Cyl r={H * 0.36} h={0.2} pos={[-L * 0.15, H * 0.48, D / 2 + 0.1]} rot={[Math.PI / 2, 0, 0]} mat={MAT.bodyLight} seg={32} />
          <Cyl r={H * 0.12} h={0.25} pos={[-L * 0.15, H * 0.48, D / 2 + 0.2]} rot={[Math.PI / 2, 0, 0]} mat={MAT.bodyDark} />
          <Box size={[L * 0.35, H * 0.7, D * 0.8]} pos={[L * 0.3, H * 0.35, 0]} mat={MAT.body} />
          <Cyl r={0.28} h={1.1} pos={[L * 0.25, H * 0.7 + 0.55, -D * 0.2]} mat={MAT.bodyDark} />
          <Cyl r={0.2} h={0.9} pos={[L * 0.4, H * 0.7 + 0.45, D * 0.2]} mat={MAT.bodyDark} />
          <Box size={[0.5, 0.35, 0.05]} pos={[L * 0.3, H * 0.5, D * 0.42]} mat={MAT.screen} cast={false} />
          <Stripe size={[L * 0.55 + 0.01, 0.1, D + 0.01]} pos={[-L * 0.15, 0.25, 0]} color={color} />
        </group>
      );

    case 'assembly-cell':
    case 'actuator-cell':
    case 'screw-cell':
      return (
        <group>
          <Fence w={L} d={D} h={H * 0.85} />
          <Table w={L * 0.45} d={D * 0.35} h={0.85} mat={MAT.body} />
          <RobotArm pos={[-L * 0.2, 0, -D * 0.22]} running={running} />
          {kind !== 'screw-cell' && <RobotArm pos={[L * 0.2, 0, -D * 0.22]} running={running} phase={2} />}
          <Box size={[0.9, 1.6, 0.5]} pos={[L * 0.35, 0.8, D * 0.3]} mat={MAT.body} />
          <Box size={[0.5, 0.35, 0.04]} pos={[L * 0.35, 1.3, D * 0.3 + 0.27]} mat={MAT.screen} cast={false} />
          <Stripe size={[0.91, 0.08, 0.51]} pos={[L * 0.35, 1.0, D * 0.3]} color={color} />
        </group>
      );

    case 'sealer':
      return (
        <group>
          <Fence w={L} d={D} h={H * 0.85} />
          <Table w={L * 0.5} d={D * 0.4} h={0.85} mat={MAT.body} />
          {/* 핫멜트 디스펜서 갠트리 */}
          <Box size={[0.12, 1.4, 0.12]} pos={[-L * 0.22, 1.55, -D * 0.2]} mat={MAT.frame} />
          <Box size={[0.12, 1.4, 0.12]} pos={[L * 0.22, 1.55, -D * 0.2]} mat={MAT.frame} />
          <Box size={[L * 0.48, 0.14, 0.14]} pos={[0, 2.2, -D * 0.2]} mat={MAT.frame} />
          <Gantry running={running} span={L * 0.4} y={1.9} z={-D * 0.2} />
          <Cyl r={0.3} h={0.9} pos={[L * 0.38, 0.45, D * 0.3]} mat={MAT.steel} />
          <Stripe size={[L * 0.5 + 0.01, 0.06, D * 0.4 + 0.01]} pos={[0, 0.9, 0]} color={color} />
        </group>
      );

    case 'leak-tester':
    case 'eol-tester':
    case 'ict':
    case 'fct':
    case 'function-tester':
      return (
        <group>
          <Box size={[L, 0.85, D]} pos={[0, 0.425, 0]} mat={MAT.body} />
          <Box size={[L * 0.8, H - 1.0, 0.1]} pos={[0, 0.85 + (H - 1.0) / 2, -D * 0.4]} mat={MAT.bodyLight} />
          <Box size={[L * 0.6, 0.18, D * 0.5]} pos={[0, H - 0.4, -D * 0.1]} mat={MAT.bodyDark} />
          <Cyl r={0.06} h={0.5} pos={[0, H - 0.75, 0]} mat={MAT.steel} />
          <Box size={[0.55, 0.4, 0.04]} pos={[L * 0.3, H - 0.6, -D * 0.34]} mat={MAT.screen} cast={false} />
          <Box size={[L * 0.6, 0.02, D * 0.4]} pos={[0, 0.87, D * 0.05]} mat={MAT.bodyDark} cast={false} />
          <Stripe size={[L + 0.01, 0.08, D + 0.01]} pos={[0, 0.8, 0]} color={color} />
        </group>
      );

    case 'photometry':
      // 암실 터널: 배광 측정 카메라·스크린
      return (
        <group>
          <Box size={[L, H * 0.9, D]} pos={[0, H * 0.45, 0]} mat={MAT.bodyDark} />
          <Box size={[L * 1.01, 0.12, D * 1.01]} pos={[0, H * 0.9, 0]} mat={MAT.frame} />
          <Box size={[0.6, 0.45, 0.05]} pos={[-L * 0.35, 1.4, D / 2 + 0.03]} mat={MAT.screen} cast={false} />
          <Box size={[1.2, 0.5, 0.05]} pos={[L * 0.15, 1.6, D / 2 + 0.03]} mat={MAT.glass} cast={false} />
          <Stripe size={[L + 0.01, 0.1, D + 0.01]} pos={[0, 0.3, 0]} color={color} />
        </group>
      );

    case 'packer':
      return (
        <group>
          <Table w={L * 0.6} d={D * 0.5} h={0.8} mat={MAT.body} />
          <Box size={[1.1, 0.12, 1.1]} pos={[L * 0.3, 0.06, D * 0.15]} mat={MAT.pallet} />
          {[0, 1, 2].map((r) =>
            [0, 1].map((c) => <Box key={`${r}${c}`} size={[0.5, 0.36, 0.5]} pos={[L * 0.3 - 0.27 + c * 0.54, 0.31 + r * 0.38, D * 0.15]} mat={MAT.carton} />),
          )}
          <RobotArm pos={[-L * 0.15, 0, -D * 0.3]} running={running} />
          <Box size={[0.7, 1.3, 0.5]} pos={[-L * 0.38, 0.65, D * 0.32]} mat={MAT.body} />
          <Stripe size={[0.71, 0.08, 0.51]} pos={[-L * 0.38, 0.9, D * 0.32]} color={color} />
        </group>
      );

    case 'laser-marker':
    case 'printer':
    case 'spi':
    case 'aoi':
      return <SmtBody l={L} d={D} h={H} color={color} />;

    case 'mounter':
      return (
        <group>
          <SmtBody l={L} d={D} h={H} color={color} />
          {/* 피더 뱅크 */}
          <Box size={[L * 0.8, 0.5, 0.35]} pos={[0, 0.85, D / 2 + 0.17]} mat={MAT.bodyDark} />
          <Box size={[L * 0.8, 0.5, 0.35]} pos={[0, 0.85, -D / 2 - 0.17]} mat={MAT.bodyDark} />
          <Gantry running={running} span={L * 0.55} y={H - 0.25} z={0} fast />
        </group>
      );

    case 'reflow': {
      const zones = 6;
      return (
        <group>
          <Box size={[L, 0.75, D]} pos={[0, 0.375, 0]} mat={MAT.body} />
          <Box size={[L * 0.86, H - 0.75, D]} pos={[0, 0.75 + (H - 0.75) / 2, 0]} mat={MAT.bodyLight} />
          {Array.from({ length: zones }, (_, i) => (
            <HeatPanel key={i} size={[(L * 0.8) / zones - 0.1, 0.18, 0.02]} pos={[-L * 0.4 + ((i + 0.5) * L * 0.8) / zones, H - 0.35, D / 2 + 0.01]} state={state} />
          ))}
          <Stripe size={[L + 0.01, 0.06, D + 0.01]} pos={[0, 0.76, 0]} color={color} />
        </group>
      );
    }

    case 'router-cobot':
      return (
        <group>
          <SmtBody l={L * 0.45} d={D * 0.6} h={1.7} color={color} />
          {/* 양팔 이동 협동로봇 (공개 사례: 램프 PCB 라우터 공정) */}
          <group position={[L * 0.3, 0, 0]}>
            <Box size={[0.9, 0.5, 0.7]} pos={[0, 0.25, 0]} mat={MAT.bodyDark} />
            <Box size={[0.4, 0.8, 0.35]} pos={[0, 0.9, 0]} mat={MAT.bodyLight} />
            <RobotArm pos={[0, 1.2, -0.25]} running={running} scale={0.6} />
            <RobotArm pos={[0, 1.2, 0.25]} running={running} scale={0.6} phase={1.7} />
          </group>
        </group>
      );

    case 'coater':
      return (
        <group>
          <SmtBody l={L * 0.6} d={D} h={H} color={color} />
          <Box size={[L * 0.4, 1.0, D * 0.9]} pos={[L * 0.3, 1.25, 0]} mat={MAT.bodyLight} />
          {/* UV 경화 */}
          <HeatPanel size={[L * 0.3, 0.08, 0.02]} pos={[L * 0.3, 1.4, D * 0.46]} state={state} />
        </group>
      );

    default:
      return <Box size={[L, H, D]} pos={[0, H / 2, 0]} mat={MAT.body} />;
  }
}

/** 갠트리 헤드 왕복 (디스펜서·마운터 헤드) */
function Gantry({ running, span, y, z, fast = false }: { running: boolean; span: number; y: number; z: number; fast?: boolean }) {
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
