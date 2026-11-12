'use client';

import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { LINES, STATIONS } from '@lumitwin/shared';
import { useLive } from '@/lib/live';
import { Amrs } from './Amrs';
import { Conveyors } from './Conveyors';
import { LabelProjector } from './labels';
import { Plant } from './Plant';
import { Station3D } from './Station3D';

// 왼쪽 패널(라인·알람)이 화면 왼쪽을 가리므로 공장 중심을 조금 오른쪽에 보이게 한다
const HOME = { pos: new THREE.Vector3(-12, 96, 84), target: new THREE.Vector3(-12, 0, 4) };

/** 설비를 고르면 카메라가 그 설비로 날아간다. 사용자가 끌면 바로 멈춘다 */
function CameraRig() {
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const camera = useThree((s) => s.camera);
  const selected = useLive((s) => s.selected);
  const fly = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const homeSeq = useLive((s) => s.homeSeq);

  useEffect(() => {
    if (!selected) return;
    const st = STATIONS[selected];
    if (!st) return;
    const target = new THREE.Vector3(st.pos[0], 0.8, st.pos[1]);
    fly.current = { target, pos: target.clone().add(new THREE.Vector3(6, 13, 15)) };
  }, [selected]);

  useEffect(() => {
    if (homeSeq > 0) fly.current = { pos: HOME.pos.clone(), target: HOME.target.clone() };
  }, [homeSeq]);

  useEffect(() => {
    if (!controls) return;
    const stop = () => (fly.current = null);
    controls.addEventListener('start', stop);
    return () => controls.removeEventListener('start', stop);
  }, [controls]);

  useFrame((_, dt) => {
    const f = fly.current;
    if (!f || !controls) return;
    const k = 1 - Math.exp(-dt * 3.2);
    camera.position.lerp(f.pos, k);
    controls.target.lerp(f.target, k);
    controls.update();
    if (camera.position.distanceTo(f.pos) < 0.05 && controls.target.distanceTo(f.target) < 0.05) fly.current = null;
  });
  return null;
}

export default function FactoryScene() {
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: HOME.pos.toArray(), fov: 38, near: 0.5, far: 600 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      // 끌지 않고 빈 곳을 클릭하면 선택을 푼다 (R3F는 끌기 거리가 짧은 클릭에만 이 이벤트를 준다)
      onPointerMissed={() => useLive.getState().select(null)}
    >
      <color attach="background" args={['#0a0f16']} />
      <fog attach="fog" args={['#0a0f16', 150, 320]} />
      <hemisphereLight args={['#cfe3ff', '#1a1f28', 0.55]} />
      <ambientLight intensity={0.25} />
      <directionalLight
        position={[45, 90, 35]}
        intensity={1.7}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-80}
        shadow-camera-right={80}
        shadow-camera-top={50}
        shadow-camera-bottom={-50}
        shadow-camera-near={10}
        shadow-camera-far={220}
        shadow-bias={-0.0004}
      />
      <directionalLight position={[-60, 40, -50]} intensity={0.35} color="#9fc4ff" />
      <Suspense fallback={null}>
        <Plant />
        <Conveyors />
        {LINES.flatMap((l) => l.stations.map((s) => <Station3D key={s.code} def={s} color={l.color} />))}
        <Amrs />
      </Suspense>
      <OrbitControls makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={1.38} minDistance={6} maxDistance={190} target={HOME.target.toArray()} />
      <CameraRig />
      <LabelProjector />
    </Canvas>
  );
}
