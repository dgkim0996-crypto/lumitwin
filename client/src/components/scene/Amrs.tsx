'use client';

import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { FACTORY, type AmrDef, type AmrState } from '@lumitwin/shared';
import { useLive } from '@/lib/live';
import { labelEntry } from './labels';
import { Box, MAT, RobotArm, Stripe } from './parts';

const AMR_STATE: Record<AmrState, { label: string; color: string }> = {
  IDLE: { label: '대기', color: '#8b9bb4' },
  TO_PICK: { label: '적재 위치로 이동', color: '#4fb3ff' },
  LOADING: { label: '적재 중', color: '#f5b544' },
  MOVING: { label: '운반 중', color: '#3ddc84' },
  UNLOADING: { label: '하역 중', color: '#f5b544' },
  RETURNING: { label: '복귀 중', color: '#4fb3ff' },
  CHARGING: { label: '충전 중', color: '#b48cff' },
};

const AMR_COLOR = '#ff8a3d';

function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function Amr({ def }: { def: AmrDef }) {
  const g = useRef<THREE.Group>(null);
  const msg = useLive((s) => s.amrs[def.code]);
  const state: AmrState = msg?.state ?? 'IDLE';
  const lightMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#222', emissive: new THREE.Color('#3ddc84'), emissiveIntensity: 1.5 }), []);
  lightMat.emissive.set(AMR_STATE[state].color);

  useFrame((_, dt) => {
    const m = useLive.getState().amrs[def.code];
    const grp = g.current;
    if (!grp) return;
    const tx = m?.x ?? def.home[0];
    const tz = m?.z ?? def.home[1];
    const k = 1 - Math.exp(-dt * 5);
    grp.position.x += (tx - grp.position.x) * k;
    grp.position.z += (tz - grp.position.z) * k;
    // 시뮬레이터 heading은 x축 기준 진행 각(atan2(dz, dx)) → three.js y 회전은 반대 부호
    if (m) grp.rotation.y = lerpAngle(grp.rotation.y, -m.heading, k);
    labelEntry(`amr:${def.code}`).pos.set(grp.position.x, 1.5, grp.position.z);
  });

  const totes = Math.min(3, Math.ceil((msg?.load ?? 0) / 8));
  const working = state === 'LOADING' || state === 'UNLOADING';
  return (
    <group
      ref={g}
      position={[def.home[0], 0, def.home[1]]}
      onPointerOver={(e) => {
        e.stopPropagation();
        useLive.getState().hover(`amr:${def.code}`);
      }}
      onPointerOut={() => useLive.getState().hover(null)}
    >
      <Box size={[1.2, 0.32, 0.8]} pos={[0, 0.22, 0]} mat={MAT.bodyDark} />
      <Stripe size={[1.21, 0.06, 0.81]} pos={[0, 0.3, 0]} color={AMR_COLOR} />
      {[[-0.42, -0.36], [0.42, -0.36], [-0.42, 0.36], [0.42, 0.36]].map(([x, z], i) => (
        <mesh key={i} position={[x, 0.08, z]} rotation={[Math.PI / 2, 0, 0]} material={MAT.rubber}>
          <cylinderGeometry args={[0.08, 0.08, 0.06, 12]} />
        </mesh>
      ))}
      <mesh position={[0.6, 0.3, 0]} material={lightMat}>
        <boxGeometry args={[0.03, 0.06, 0.5]} />
      </mesh>
      <RobotArm pos={[-0.3, 0.38, 0]} running={working} scale={0.45} />
      {Array.from({ length: totes }, (_, i) => (
        <Box key={i} size={[0.5, 0.2, 0.36]} pos={[0.22, 0.48 + i * 0.21, 0]} mat={MAT.tote} />
      ))}
    </group>
  );
}

/** 이동식 협동로봇(AMR)과 이송 경로 */
export function Amrs() {
  return (
    <group>
      {FACTORY.transfers.map((t) => (
        <Line key={t.code} points={t.path.map(([x, z]) => [x, 0.04, z] as [number, number, number])} color={AMR_COLOR} lineWidth={1.2} dashed dashSize={0.6} gapSize={0.4} transparent opacity={0.55} />
      ))}
      {FACTORY.amrs.map((a) => (
        <Amr key={a.code} def={a} />
      ))}
    </group>
  );
}
