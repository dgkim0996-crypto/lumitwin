'use client';

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { LINES } from '@lumitwin/shared';
import { useLive } from '@/lib/live';
import { MAT } from './parts';

const BELT_Y = 0.78;
const BELT_W = 0.7;
/** 토트(부품 상자) 사이 간격 (m) */
const GAP = 2.4;

interface Path {
  pts: THREE.Vector3[];
  cum: number[];
  len: number;
  line: string;
}

function makePath(points: [number, number][], line: string): Path {
  const pts = points.map(([x, z]) => new THREE.Vector3(x, BELT_Y + 0.14, z));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  return { pts, cum, len: cum[cum.length - 1], line };
}

function pointAt(p: Path, d: number, out: THREE.Vector3): THREE.Vector3 {
  let i = 1;
  while (i < p.cum.length - 1 && p.cum[i] < d) i++;
  const seg = p.cum[i] - p.cum[i - 1] || 1;
  return out.copy(p.pts[i - 1]).lerp(p.pts[i], (d - p.cum[i - 1]) / seg);
}

/** 컨베이어 벨트 + 그 위로 흐르는 토트. 라인에 가동 중인 설비가 있으면 배속에 맞춰 흐른다 */
export function Conveyors() {
  const { paths, segments } = useMemo(() => {
    const paths: Path[] = [];
    const segments: { pos: [number, number, number]; len: number; angle: number }[] = [];
    for (const line of LINES) {
      for (const poly of line.conveyors) {
        paths.push(makePath(poly, line.code));
        for (let i = 1; i < poly.length; i++) {
          const [x0, z0] = poly[i - 1];
          const [x1, z1] = poly[i];
          const len = Math.hypot(x1 - x0, z1 - z0);
          segments.push({ pos: [(x0 + x1) / 2, BELT_Y, (z0 + z1) / 2], len: len + BELT_W, angle: -Math.atan2(z1 - z0, x1 - x0) });
        }
      }
    }
    return { paths, segments };
  }, []);

  const tokens = useMemo(() => paths.flatMap((p, pi) => Array.from({ length: Math.max(1, Math.floor(p.len / GAP)) }, (_, k) => ({ pi, base: k * GAP }))), [paths]);
  const colors = useMemo(() => Object.fromEntries(LINES.map((l) => [l.code, new THREE.Color(l.color).lerp(new THREE.Color('#ffffff'), 0.25)])), []);
  const mesh = useRef<THREE.InstancedMesh>(null);
  const offset = useRef(0);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const v = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, dt) => {
    const { sim, simConnected, lines } = useLive.getState();
    const moving = Boolean(sim?.running && simConnected);
    if (moving) offset.current += dt * Math.min(2.5, 0.3 * (sim?.speed ?? 1));
    const m = mesh.current;
    if (!m) return;
    tokens.forEach((t, i) => {
      const p = paths[t.pi];
      const down = (lines[p.line]?.downStations.length ?? 0) > 0;
      const d = ((t.base + (down ? offset.current * 0.3 : offset.current)) % p.len + p.len) % p.len;
      pointAt(p, d, v);
      tmp.position.copy(v);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      m.setColorAt(i, colors[p.line]);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      {segments.map((s, i) => (
        <group key={i} position={s.pos} rotation={[0, s.angle, 0]}>
          <mesh material={MAT.belt} receiveShadow>
            <boxGeometry args={[s.len, 0.08, BELT_W]} />
          </mesh>
          <mesh material={MAT.steel} position={[0, 0.03, BELT_W / 2 + 0.03]}>
            <boxGeometry args={[s.len, 0.12, 0.05]} />
          </mesh>
          <mesh material={MAT.steel} position={[0, 0.03, -BELT_W / 2 - 0.03]}>
            <boxGeometry args={[s.len, 0.12, 0.05]} />
          </mesh>
          {Array.from({ length: Math.max(2, Math.floor(s.len / 2)) }, (_, k) => (
            <mesh key={k} material={MAT.frame} position={[-s.len / 2 + 0.3 + (k * (s.len - 0.6)) / Math.max(1, Math.max(2, Math.floor(s.len / 2)) - 1), -BELT_Y / 2, 0]}>
              <boxGeometry args={[0.06, BELT_Y, BELT_W * 0.9]} />
            </mesh>
          ))}
        </group>
      ))}
      <instancedMesh ref={mesh} args={[undefined, undefined, tokens.length]} castShadow>
        <boxGeometry args={[0.42, 0.2, 0.32]} />
        <meshStandardMaterial roughness={0.55} metalness={0.1} />
      </instancedMesh>
    </group>
  );
}
