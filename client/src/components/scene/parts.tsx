'use client';

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import type { StationState } from '@lumitwin/shared';
import { STATE_COLOR } from '@/lib/format';

// ─────────── 공용 재질 (모든 설비가 나눠 쓴다) ───────────

const std = (color: string, metalness = 0.3, roughness = 0.6, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });

export const MAT = {
  body: std('#c9ced6', 0.25, 0.55),
  bodyLight: std('#e3e7ec', 0.15, 0.6),
  bodyDark: std('#454d5a', 0.4, 0.5),
  steel: std('#9aa3ad', 0.75, 0.35),
  frame: std('#2b313b', 0.5, 0.5),
  safety: std('#f5c400', 0.2, 0.55),
  glass: std('#9fd3ff', 0.1, 0.1, { transparent: true, opacity: 0.18 }),
  fence: std('#3a414d', 0.3, 0.6, { transparent: true, opacity: 0.35 }),
  screen: std('#0d1b2a', 0.2, 0.3, { emissive: new THREE.Color('#1c6fb8'), emissiveIntensity: 0.6 }),
  belt: std('#1d2229', 0.1, 0.9),
  rubber: std('#14171c', 0.0, 0.95),
  carton: std('#b88a57', 0.0, 0.85),
  pallet: std('#7a5a3a', 0.0, 0.9),
  tote: std('#2f6fb3', 0.1, 0.6),
  heat: std('#40140c', 0.1, 0.6, { emissive: new THREE.Color('#ff5a1f'), emissiveIntensity: 0.0 }),
};

// ─────────── 기본 도형 ───────────

type V3 = [number, number, number];

export function Box({ size, pos = [0, 0, 0], mat = MAT.body, rot, cast = true }: { size: V3; pos?: V3; mat?: THREE.Material; rot?: V3; cast?: boolean }) {
  return (
    <mesh position={pos} rotation={rot} material={mat} castShadow={cast} receiveShadow>
      <boxGeometry args={size} />
    </mesh>
  );
}

export function Cyl({ r, h, pos = [0, 0, 0], mat = MAT.steel, rot, seg = 24, rTop }: { r: number; h: number; pos?: V3; mat?: THREE.Material; rot?: V3; seg?: number; rTop?: number }) {
  return (
    <mesh position={pos} rotation={rot} material={mat} castShadow receiveShadow>
      <cylinderGeometry args={[rTop ?? r, r, h, seg]} />
    </mesh>
  );
}

/** 라인 색 띠 (설비가 어느 라인 소속인지 멀리서도 보이게) */
export function Stripe({ size, pos, color }: { size: V3; pos: V3; color: string }) {
  const mat = useMemo(() => std(color, 0.2, 0.5, { emissive: new THREE.Color(color), emissiveIntensity: 0.25 }), [color]);
  return <Box size={size} pos={pos} mat={mat} cast={false} />;
}

// ─────────── 경광등 ───────────

/** 위에서부터 빨강(고장) · 노랑(대기) · 초록(가동) · 파랑(셋업). 고장·배출 대기는 깜박인다 */
export function StackLight({ state, pos }: { state: StationState; pos: V3 }) {
  const mats = useMemo(
    () => (['#ff4d5e', '#f5b544', '#3ddc84', '#4fb3ff'] as const).map((c) => std(c, 0.1, 0.4, { emissive: new THREE.Color(c), emissiveIntensity: 0, transparent: true, opacity: 0.9 })),
    [],
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  useFrame(({ clock }) => {
    const s = stateRef.current;
    const blink = Math.sin(clock.elapsedTime * 7) > 0 ? 1 : 0.15;
    const on = [s === 'DOWN' ? blink : 0, s === 'BLOCKED' ? blink : s === 'IDLE' ? 0.9 : 0, s === 'RUN' ? 1 : 0, s === 'SETUP' ? 1 : 0];
    mats.forEach((m, i) => {
      m.emissiveIntensity = on[i] * 2.2;
      m.opacity = on[i] > 0.2 ? 1 : 0.35;
    });
  });
  return (
    <group position={pos}>
      <Cyl r={0.035} h={0.5} pos={[0, 0.25, 0]} mat={MAT.frame} />
      {mats.map((m, i) => (
        <Cyl key={i} r={0.09} h={0.14} pos={[0, 0.98 - i * 0.15, 0]} mat={m} seg={16} />
      ))}
      <Cyl r={0.1} h={0.04} pos={[0, 1.07, 0]} mat={MAT.frame} seg={16} />
    </group>
  );
}

// ─────────── 로봇 팔 (가동 중에만 움직인다) ───────────

export function RobotArm({ pos, running, scale = 1, color = '#f2f4f7', phase = 0 }: { pos: V3; running: boolean; scale?: number; color?: string; phase?: number }) {
  const base = useRef<THREE.Group>(null);
  const lower = useRef<THREE.Group>(null);
  const upper = useRef<THREE.Group>(null);
  const runRef = useRef(running);
  runRef.current = running;
  const mat = useMemo(() => std(color, 0.3, 0.45), [color]);
  const t = useRef(phase);
  useFrame((_, dt) => {
    if (runRef.current) t.current += dt;
    const k = t.current;
    if (base.current) base.current.rotation.y = Math.sin(k * 1.3) * 1.1;
    if (lower.current) lower.current.rotation.z = -0.5 + Math.sin(k * 2.1) * 0.35;
    if (upper.current) upper.current.rotation.z = 1.1 + Math.sin(k * 2.6 + 1) * 0.4;
  });
  return (
    <group position={pos} scale={scale}>
      <Cyl r={0.22} h={0.25} pos={[0, 0.12, 0]} mat={MAT.bodyDark} />
      <group ref={base} position={[0, 0.25, 0]}>
        <Cyl r={0.17} h={0.25} pos={[0, 0.12, 0]} mat={mat} />
        <group ref={lower} position={[0, 0.25, 0]}>
          <Box size={[0.14, 0.8, 0.16]} pos={[0, 0.4, 0]} mat={mat} />
          <group ref={upper} position={[0, 0.8, 0]}>
            <Box size={[0.12, 0.65, 0.13]} pos={[0, 0.32, 0]} mat={mat} />
            <Box size={[0.16, 0.12, 0.16]} pos={[0, 0.68, 0]} mat={MAT.bodyDark} />
          </group>
        </group>
      </group>
    </group>
  );
}

/** 안전 펜스 (사각 둘레의 기둥 + 반투명 망) */
export function Fence({ w, d, h = 1.9 }: { w: number; d: number; h?: number }) {
  const posts: V3[] = [];
  const nx = Math.max(1, Math.round(w / 1.5));
  const nz = Math.max(1, Math.round(d / 1.5));
  for (let i = 0; i <= nx; i++) {
    const x = -w / 2 + (w * i) / nx;
    posts.push([x, h / 2, -d / 2], [x, h / 2, d / 2]);
  }
  for (let j = 1; j < nz; j++) {
    const z = -d / 2 + (d * j) / nz;
    posts.push([-w / 2, h / 2, z], [w / 2, h / 2, z]);
  }
  return (
    <group>
      {posts.map((p, i) => (
        <Box key={i} size={[0.06, h, 0.06]} pos={p} mat={MAT.safety} cast={false} />
      ))}
      <Box size={[w, h * 0.85, 0.02]} pos={[0, h * 0.5, -d / 2]} mat={MAT.fence} cast={false} />
      <Box size={[0.02, h * 0.85, d]} pos={[-w / 2, h * 0.5, 0]} mat={MAT.fence} cast={false} />
      <Box size={[0.02, h * 0.85, d]} pos={[w / 2, h * 0.5, 0]} mat={MAT.fence} cast={false} />
    </group>
  );
}

/** 컨베이어 위를 지나는 설비의 공용 받침: 다리 4개 + 상판 */
export function Table({ w, d, h = 0.85, mat = MAT.frame, children }: { w: number; d: number; h?: number; mat?: THREE.Material; children?: ReactNode }) {
  return (
    <group>
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => (
        <Box key={i} size={[0.08, h, 0.08]} pos={[(sx * (w - 0.1)) / 2, h / 2, (sz * (d - 0.1)) / 2]} mat={mat} cast={false} />
      ))}
      <Box size={[w, 0.06, d]} pos={[0, h, 0]} mat={mat} />
      {children}
    </group>
  );
}

export const STATE_LIGHT = STATE_COLOR;
