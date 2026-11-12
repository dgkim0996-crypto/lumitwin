'use client';

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { LINES, STATIONS } from '@lumitwin/shared';
import { useLive } from '@/lib/live';
import { FOOTPRINT } from './machines';
import { MAT } from './parts';

const BELT_Y = 0.78;
const BELT_W = 0.7;
/** 토트(부품 상자) 사이 간격 (m) */
const GAP = 2.4;
/** 설비 안 구간을 미리 표시해 두는 간격 (m) */
const STEP = 0.1;

interface Path {
  pts: THREE.Vector3[];
  cum: number[];
  len: number;
  line: string;
  /** STEP 간격으로 그 지점이 설비 안인지. 설비 안에서는 토트를 숨기고 설비 모델이 기판·부품 흐름을 보여 준다 */
  inside: Uint8Array;
}

/** 월드 좌표 (x, z)가 어느 설비의 바닥 영역 안인지 (설비 회전 반영, 토트 반 길이만큼 여유) */
function insideStation(x: number, z: number): boolean {
  for (const def of Object.values(STATIONS)) {
    const [L, D] = FOOTPRINT[def.kind];
    const a = ((def.rot ?? 0) * Math.PI) / 180;
    const dx = x - def.pos[0];
    const dz = z - def.pos[1];
    const lx = dx * Math.cos(a) - dz * Math.sin(a);
    const lz = dx * Math.sin(a) + dz * Math.cos(a);
    if (Math.abs(lx) <= L / 2 + 0.15 && Math.abs(lz) <= D / 2) return true;
  }
  return false;
}

function makePath(points: [number, number][], line: string): Path {
  const pts = points.map(([x, z]) => new THREE.Vector3(x, BELT_Y + 0.14, z));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const p: Path = { pts, cum, len: cum[cum.length - 1], line, inside: new Uint8Array(0) };
  const v = new THREE.Vector3();
  p.inside = Uint8Array.from({ length: Math.ceil(p.len / STEP) + 1 }, (_, i) => {
    pointAt(p, i * STEP, v);
    return insideStation(v.x, v.z) ? 1 : 0;
  });
  return p;
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
      tmp.scale.setScalar(p.inside[Math.round(d / STEP)] ? 0 : 1);
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
