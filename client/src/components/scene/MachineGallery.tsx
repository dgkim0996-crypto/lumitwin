'use client';

// 설비 모델 미리보기 (/dev/machines). 공장 배치와 상관없이 설비를 한자리에 모아 보고, 모델 수정 결과를 캡처로 확인할 때 쓴다.
//   ?group=molding|smt|assembly   공정군 (기본: 전부)
//   ?code=HL-IM-L1                설비 하나를 가까이
//   ?view=iso|front|back|top|side 카메라 방향 (기본 iso)
//   ?state=RUN|IDLE|DOWN|SETUP|STOP|BLOCKED   상태 (기본 RUN, 움직이는 부분이 돈다)
//   ?tags=0                       부위 이름표 숨기기
// 이름표 옆 숫자는 메시 수(인스턴스는 한 개로 셈)다. 공장 전체에 38대가 있으므로 가볍게 유지한다.
import { OrbitControls } from '@react-three/drei';
import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { LINES, STATIONS, type StationDef, type StationState } from '@lumitwin/shared';
import { KIND_LABEL } from '@/lib/format';
import { LabelProjector, labelRef } from './labels';
import { BELT_TOP } from './machines/common';
import { calloutsFor, FOOTPRINT, groupOf, Machine, MACHINE_GROUPS, type MachineGroup } from './machines';
import { MAT, StackLight } from './parts';
import { stationToWorld } from './SceneLabels';

const STATES: StationState[] = ['RUN', 'IDLE', 'BLOCKED', 'DOWN', 'SETUP', 'STOP'];
const GAP = 2.2;
const ROW_W = 34;

type Def = (typeof STATIONS)[string];

interface Placed {
  def: Def;
  color: string;
  /** 갤러리 안 위치 (공장 좌표 대신) */
  at: StationDef;
}

function params() {
  const q = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const group = q.get('group') as MachineGroup | null;
  const state = (q.get('state') ?? 'RUN').toUpperCase() as StationState;
  return {
    group: group && group in MACHINE_GROUPS ? group : null,
    code: q.get('code'),
    view: q.get('view') ?? 'iso',
    state: STATES.includes(state) ? state : 'RUN',
    tags: q.get('tags') !== '0',
  };
}

/** 설비를 줄지어 놓는다. 공장 좌표 대신 갤러리 좌표를 쓰고 회전은 0으로 둔다 */
function layout(defs: Def[]): Placed[] {
  const out: Placed[] = [];
  let x = 0;
  let z = 0;
  let rowDepth = 0;
  for (const def of defs) {
    const [L, D] = FOOTPRINT[def.kind];
    if (x > 0 && x + L > ROW_W) {
      x = 0;
      z += rowDepth + GAP + 1.5;
      rowDepth = 0;
    }
    const color = LINES.find((l) => l.code === def.line)?.color ?? '#ffffff';
    out.push({ def, color, at: { ...def, pos: [x + L / 2, z + D / 2], rot: 0 } });
    x += L + GAP;
    rowDepth = Math.max(rowDepth, D);
  }
  return out;
}

function countMeshes(o: THREE.Object3D) {
  let n = 0;
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh && c.visible) n++;
  });
  return n;
}

function Item({ p, state, onCount }: { p: Placed; state: StationState; onCount: (code: string, n: number) => void }) {
  const ref = useRef<THREE.Group>(null);
  const [L, D, H] = FOOTPRINT[p.def.kind];
  useEffect(() => {
    const id = requestAnimationFrame(() => ref.current && onCount(p.def.code, countMeshes(ref.current)));
    return () => cancelAnimationFrame(id);
  }, [p.def.code, onCount]);
  return (
    <group position={[p.at.pos[0], 0, p.at.pos[1]]}>
      {/* 컨베이어가 지나는 높이·폭을 보여 주는 바닥 표시와 벨트 토막 (모델 맞춤용) */}
      <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={MAT.belt}>
        <planeGeometry args={[L + 0.7, D + 0.7]} />
      </mesh>
      <mesh position={[0, BELT_TOP - 0.04, 0]} material={MAT.belt}>
        <boxGeometry args={[L + 1.6, 0.08, 0.7]} />
      </mesh>
      <group ref={ref}>
        <Machine def={p.def} color={p.color} state={state} running={state === 'RUN'} />
      </group>
      <StackLight state={state} pos={[L / 2 - 0.15, Math.max(H - 0.2, 1.2), -D / 2 + 0.15]} />
    </group>
  );
}

function Fit({ placed, view, single }: { placed: Placed[]; view: string; single: boolean }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null;
  useLayoutEffect(() => {
    const box = new THREE.Box3();
    for (const p of placed) {
      const [L, D, H] = FOOTPRINT[p.def.kind];
      box.expandByPoint(new THREE.Vector3(p.at.pos[0] - L / 2, 0, p.at.pos[1] - D / 2));
      box.expandByPoint(new THREE.Vector3(p.at.pos[0] + L / 2, H, p.at.pos[1] + D / 2));
    }
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.z * 1.3, size.y * 1.6) * (single ? 0.95 : 1.05) + 1.5;
    const dir: Record<string, [number, number, number]> = {
      iso: [0.55, 0.62, 0.95],
      front: [0, 0.32, 1],
      back: [0, 0.32, -1],
      side: [1, 0.3, 0.05],
      top: [0, 1, 0.02],
    };
    const d = new THREE.Vector3(...(dir[view] ?? dir.iso)).normalize().multiplyScalar(r);
    camera.position.copy(c).add(d);
    camera.lookAt(c);
    if (controls) {
      controls.target.copy(c);
      controls.update();
    }
  }, [placed, view, single, camera, controls]);
  return null;
}

export default function MachineGallery() {
  const q = useMemo(params, []);
  const defs = useMemo(() => {
    const all = Object.values(STATIONS);
    if (q.code) return all.filter((d) => d.code === q.code);
    return all.filter((d) => !q.group || groupOf(d.kind) === q.group);
  }, [q]);
  const placed = useMemo(() => layout(defs), [defs]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const onCount = useMemo(() => (code: string, n: number) => setCounts((c) => (c[code] === n ? c : { ...c, [code]: n })), []);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const single = placed.length === 1;

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#0a0f16]">
      <Canvas shadows dpr={[1, 2]} camera={{ fov: 38, near: 0.1, far: 400, position: [10, 10, 10] }} gl={{ antialias: true, preserveDrawingBuffer: true }}>
        <color attach="background" args={['#0e1520']} />
        <hemisphereLight args={['#cfe3ff', '#1a1f28', 0.55]} />
        <ambientLight intensity={0.25} />
        <directionalLight position={[45, 90, 35]} intensity={1.7} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-40} shadow-camera-right={40} shadow-camera-top={40} shadow-camera-bottom={-40} shadow-bias={-0.0004} />
        <directionalLight position={[-60, 40, -50]} intensity={0.35} color="#9fc4ff" />
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[ROW_W / 2, 0, 20]}>
          <planeGeometry args={[200, 200]} />
          <meshStandardMaterial color="#1b2330" roughness={0.9} />
        </mesh>
        {placed.map((p) => (
          <Item key={p.def.code} p={p} state={q.state} onCount={onCount} />
        ))}
        <OrbitControls makeDefault enableDamping dampingFactor={0.1} />
        <Fit placed={placed} view={q.view} single={single} />
        <LabelProjector />
      </Canvas>
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {placed.map((p) => {
          const [, D] = FOOTPRINT[p.def.kind];
          return (
            <div key={p.def.code} ref={labelRef(`gal:${p.def.code}`, p.at.pos[0], 0.02, p.at.pos[1] + D / 2 + 0.9)} className="pointer-events-none absolute left-0 top-0" style={{ transform: 'translate(-9999px,0)' }}>
              <div className="station-tag" style={{ transform: 'translateY(100%)' }}>
                <b>{p.def.code}</b>
                <span className="muted">
                  {p.def.name} · {KIND_LABEL[p.def.kind]} · 메시 {counts[p.def.code] ?? '…'}
                </span>
              </div>
            </div>
          );
        })}
        {q.tags &&
          placed.flatMap((p) =>
            calloutsFor(p.def).map((c, i) => {
              const [x, y, z] = stationToWorld(p.at, c.at);
              return (
                <div key={`${p.def.code}:${i}`} ref={labelRef(`galpart:${p.def.code}:${i}`, x, y, z)} className="pointer-events-none absolute left-0 top-0" style={{ transform: 'translate(-9999px,0)' }}>
                  <div className="part-tag">{c.text}</div>
                </div>
              );
            }),
          )}
      </div>
      <div className="panel absolute left-3 top-3 px-3 py-2 text-xs text-sub">
        <div className="font-semibold text-ink">설비 모델 미리보기</div>
        <div>
          {q.code ?? (q.group ? MACHINE_GROUPS[q.group].name : '전체')} · {placed.length}대 · 상태 {q.state} · 메시 합계 {total}
        </div>
      </div>
    </main>
  );
}
