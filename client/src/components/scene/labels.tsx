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
  /** 겹침 피하기용 이름표 크기 (요소마다 처음 보일 때 한 번 잰다) */
  w?: number;
  h?: number;
  measured?: HTMLElement;
}

/** 이 접두어의 이름표(설비 부위 이름표)는 화면에서 서로 겹치면 위로 비켜 쌓는다 */
const DECLUTTER = ['part:', 'galpart:'];

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

const place = (el: HTMLElement, x: number, y: number) => {
  el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
};

interface Pending {
  e: Entry;
  x: number;
  y: number;
}

/** 화면 아래쪽 이름표부터 자리를 잡고, 겹치는 이름표는 겹친 이름표 바로 위로 올린다 */
function declutter(items: Pending[]) {
  items.sort((a, b) => b.y - a.y);
  const taken: { l: number; r: number; t: number; b: number }[] = [];
  for (const it of items) {
    const el = it.e.el!;
    if (!it.e.w || it.e.measured !== el) {
      it.e.w = el.offsetWidth;
      it.e.h = el.offsetHeight;
      it.e.measured = el;
    }
    const half = (it.e.w || 80) / 2 + 3;
    const h = (it.e.h || 20) + 3;
    const l = it.x - half;
    const r = it.x + half;
    let y = it.y;
    for (let guard = 0; guard < 10; guard++) {
      const hit = taken.find((p) => l < p.r && r > p.l && y - h < p.b && y > p.t);
      if (!hit) break;
      y = hit.t;
    }
    taken.push({ l, r, t: y - h, b: y });
    place(el, it.x, y);
  }
}

export function LabelProjector() {
  const v = useMemo(() => new THREE.Vector3(), []);
  const pending = useMemo<Pending[]>(() => [], []);
  useFrame(({ camera, size }) => {
    pending.length = 0;
    for (const [id, e] of labelRegistry) {
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
      if (DECLUTTER.some((p) => id.startsWith(p))) pending.push({ e, x, y });
      else place(el, x, y);
    }
    if (pending.length) declutter(pending);
  });
  return null;
}
