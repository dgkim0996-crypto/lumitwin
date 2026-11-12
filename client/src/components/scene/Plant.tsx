'use client';

import { Grid, Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { FACTORY, LINES, type WarehouseDef } from '@lumitwin/shared';
import { useLive } from '@/lib/live';
import { MAT } from './parts';

const [W, D] = FACTORY.size;

function Rect({ x0, x1, z0, z1, y = 0.01, color, opacity }: { x0: number; x1: number; z0: number; z1: number; y?: number; color: string; opacity: number }) {
  return (
    <mesh position={[(x0 + x1) / 2, y, (z0 + z1) / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[x1 - x0, z1 - z0]} />
      <meshStandardMaterial color={color} transparent opacity={opacity} roughness={0.9} depthWrite={false} />
    </mesh>
  );
}

const outline = (x0: number, x1: number, z0: number, z1: number, y = 0.02): [number, number, number][] => [
  [x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [x0, y, z0],
];

/** 창고 랙: 기둥 + 선반 + 적재 상자. FG(완제품)는 입고 누계만큼 채운다 */
function Warehouse({ wh }: { wh: WarehouseDef }) {
  const [cx, cz] = wh.pos;
  const [w, d] = wh.size;
  const rows = w >= 10 ? 2 : 1;
  const bays = Math.floor(d / 4);
  const levels = 3;
  const slots = rows * bays * levels * 2;
  const mesh = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const positions = useMemo(() => {
    const out: [number, number, number][] = [];
    for (let r = 0; r < rows; r++) {
      const x = cx - w / 2 + (w / (rows + 1)) * (r + 1);
      for (let b = 0; b < bays; b++) {
        for (let l = 0; l < levels; l++) {
          for (let k = 0; k < 2; k++) out.push([x, 0.35 + l * 1.3, cz - d / 2 + 2 + b * 4 + (k - 0.5) * 1.6]);
        }
      }
    }
    return out;
  }, [cx, cz, w, d, rows, bays]);
  const isFg = wh.code === 'FG';

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const total = isFg ? Object.values(useLive.getState().sim?.warehouse ?? {}).reduce((a, b) => a + b, 0) : 0;
    // 완제품: 상자 하나 = 12개로 보고 채운다 (라인을 돌리면 랙이 차오르는 모습). 자재 창고는 70%를 채운다
    const filled = isFg ? Math.min(slots, Math.floor(total / 12)) : Math.floor(slots * 0.7);
    positions.forEach((p, i) => {
      tmp.position.set(p[0], p[1], p[2]);
      tmp.scale.setScalar(i < filled ? 1 : 0.0001);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <Rect x0={cx - w / 2} x1={cx + w / 2} z0={cz - d / 2} z1={cz + d / 2} color="#1b2331" opacity={0.9} />
      <Line points={outline(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2)} color="#46566f" lineWidth={1} />
      {Array.from({ length: rows }, (_, r) => {
        const x = cx - w / 2 + (w / (rows + 1)) * (r + 1);
        return (
          <group key={r}>
            {Array.from({ length: bays + 1 }, (_, b) => (
              <mesh key={b} position={[x, 2, cz - d / 2 + b * 4]} material={MAT.safety}>
                <boxGeometry args={[1.2, 4, 0.08]} />
              </mesh>
            ))}
            {Array.from({ length: levels }, (_, l) => (
              <mesh key={l} position={[x, 0.1 + l * 1.3, cz - d / 2 + (bays * 4) / 2]} material={MAT.frame}>
                <boxGeometry args={[1.25, 0.06, bays * 4]} />
              </mesh>
            ))}
          </group>
        );
      })}
      <instancedMesh ref={mesh} args={[undefined, undefined, positions.length]} castShadow material={isFg ? MAT.carton : MAT.tote}>
        <boxGeometry args={[1.0, 0.5, 1.2]} />
      </instancedMesh>
    </group>
  );
}

/** 공장 바닥: 건물 외곽 · 라인 베이 · 통로 · 창고 */
export function Plant() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, 0, 0]}>
        <planeGeometry args={[W + 30, D + 30]} />
        <meshStandardMaterial color="#10151d" roughness={0.95} />
      </mesh>
      <Grid
        position={[0, 0.004, 0]}
        args={[W, D]}
        cellSize={1}
        cellThickness={0.4}
        cellColor="#18202b"
        sectionSize={10}
        sectionThickness={0.8}
        sectionColor="#223044"
        fadeDistance={260}
        fadeStrength={1}
      />
      {/* 건물 외곽 (낮은 벽 + 기둥 토막: 위에서 들여다보는 단면 표현) */}
      <Line points={outline(-W / 2, W / 2, -D / 2, D / 2, 0.03)} color="#3a4a60" lineWidth={1.5} />
      {[-1, 1].map((s) => (
        <mesh key={`wx${s}`} position={[0, 0.3, (s * D) / 2]} material={MAT.bodyDark}>
          <boxGeometry args={[W, 0.6, 0.3]} />
        </mesh>
      ))}
      {[-1, 1].map((s) => (
        <mesh key={`wz${s}`} position={[(s * W) / 2, 0.3, 0]} material={MAT.bodyDark}>
          <boxGeometry args={[0.3, 0.6, D]} />
        </mesh>
      ))}
      {Array.from({ length: 8 }, (_, i) => -W / 2 + (W / 7) * i).flatMap((x) =>
        [-D / 2, D / 2].map((z) => (
          <mesh key={`p${x}${z}`} position={[x, 0.9, z]} material={MAT.steel}>
            <boxGeometry args={[0.6, 1.8, 0.6]} />
          </mesh>
        )),
      )}

      {LINES.map((l) => (
        <group key={l.code}>
          <Rect x0={l.bay.x0} x1={l.bay.x1} z0={l.bay.z0} z1={l.bay.z1} color={l.color} opacity={0.045} />
          <Line points={outline(l.bay.x0, l.bay.x1, l.bay.z0, l.bay.z1)} color={l.color} lineWidth={1} transparent opacity={0.45} />
        </group>
      ))}

      {FACTORY.aisles.map((a, i) => (
        <group key={i}>
          <Rect x0={a.x0} x1={a.x1} z0={a.z0} z1={a.z1} color="#1a2230" opacity={1} y={0.006} />
          {[a.z0 + 0.15, a.z1 - 0.15].map((z) => (
            <Line key={z} points={[[a.x0, 0.02, z], [a.x1, 0.02, z]]} color="#f5c400" lineWidth={1} dashed dashSize={1.2} gapSize={0.8} transparent opacity={0.6} />
          ))}
        </group>
      ))}

      {FACTORY.warehouses.map((w) => (
        <Warehouse key={w.code} wh={w} />
      ))}
    </group>
  );
}
