'use client';

import { useFrame } from '@react-three/fiber';
import { useMemo } from 'react';
import * as THREE from 'three';

/**
 * 3D 위 이름표. drei <Html>은 이름표마다 React 루트를 따로 만들어 React 19 개발 모드에서 해제 경고가 나고,
 * 수가 많으면 무겁다. 그래서 이름표는 캔버스 위의 보통 DOM 층(SceneLabels)에 그리고,
 * 캔버스 안의 LabelProjector가 매 프레임 월드 좌표를 화면 좌표로 바꿔 transform만 옮긴다.
 */
interface Entry {
  pos: THREE.Vector3;
  el: HTMLElement | null;
}

export const labelRegistry = new Map<string, Entry>();

export function labelEntry(id: string, x = 0, y = 0, z = 0): Entry {
  let e = labelRegistry.get(id);
  if (!e) {
    e = { pos: new THREE.Vector3(x, y, z), el: null };
    labelRegistry.set(id, e);
  }
  return e;
}

/** DOM 이름표를 등록하는 ref 콜백 */
export const labelRef = (id: string, x: number, y: number, z: number) => (el: HTMLElement | null) => {
  const e = labelEntry(id, x, y, z);
  e.pos.set(x, y, z);
  e.el = el;
};

export function LabelProjector() {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    for (const e of labelRegistry.values()) {
      const el = e.el;
      if (!el) continue;
      v.copy(e.pos).project(camera);
      const behind = v.z > 1 || v.z < -1;
      if (behind) {
        el.style.visibility = 'hidden';
        continue;
      }
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((1 - v.y) / 2) * size.height;
      el.style.visibility = '';
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  });
  return null;
}
