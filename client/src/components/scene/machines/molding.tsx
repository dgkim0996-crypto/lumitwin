'use client';

// 성형·표면 처리 설비: 제습 건조기, 사출기(렌즈·리플렉터·하우징·미러 커버·브래킷), 하드코팅 라인, 진공 증착기, 도장 라인
// (헤드램프 라인 앞단 + 사이드미러 라인 앞단). 흐름은 +x: 재료·부품이 -x 끝으로 들어와 +x 끝(z = 0, 벨트 높이)으로 나간다.
// 여러 개 반복되는 부품(프레임·히터 밴드·행거·랙)은 InstancedMesh 하나(Many)로 그린다. 움직임은 가동(RUN) 중에만.
import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { EquipmentKind, StationDef } from '@lumitwin/shared';
import { MAT, RobotArm, std, Stripe } from '../parts';
import { BELT_TOP, type Callout, FOOTPRINT, HeatPanel, type MachineProps, type V3 } from './common';

export const MOLDING_KINDS = ['dryer', 'injection', 'tunnel-hardcoat', 'metallizer', 'tunnel-paint'] as const satisfies readonly EquipmentKind[];

// ─────────── 공용 도형 · 재질 (모듈에서 한 번만 만든다) ───────────

/** 단위 도형. 크기는 scale로 준다 */
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 20),
  pipe: new THREE.CylinderGeometry(1, 1, 1, 10),
  cone: new THREE.CylinderGeometry(1, 0.2, 1, 20),
  ball: new THREE.SphereGeometry(1, 14, 10),
  ring: new THREE.TorusGeometry(1, 0.05, 8, 40),
  shell: new THREE.CylinderGeometry(1, 1, 1, 40, 1, true),
  disc: new THREE.CircleGeometry(1, 40),
  annulus: new THREE.RingGeometry(0.58, 1, 40),
};

const M = {
  mold: std('#b7bfc8', 0.4, 0.3),
  platen: std('#5f6b79', 0.5, 0.45),
  /** 스테인리스 (호퍼·탱크·챔버). MAT.steel보다 밝게 보인다 */
  stainless: std('#c5ccd4', 0.5, 0.32),
  band: std('#a86f3c', 0.7, 0.4),
  hose: std('#ffffff', 0.05, 0.75),
  copper: std('#b8733a', 0.8, 0.35),
  inner: std('#2a3038', 0.5, 0.6, { side: THREE.BackSide }),
  coat: std('#ffd27a', 0.1, 0.1, { transparent: true, opacity: 0.3, emissive: new THREE.Color('#ffb340'), emissiveIntensity: 0.25, depthWrite: false }),
  liquid: std('#d9b25a', 0.2, 0.15),
  light: std('#ffffff', 0, 0.5, { emissive: new THREE.Color('#eef5ff'), emissiveIntensity: 1.3 }),
  mist: std('#ffffff', 0, 1, { transparent: true, opacity: 0.22, depthWrite: false }),
};

/** 제품 재질 */
const PM = {
  lens: std('#e6f4ff', 0.05, 0.05, { transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
  bmc: std('#2b2d31', 0.15, 0.45, { side: THREE.DoubleSide }),
  alu: std('#eef2f6', 0.7, 0.18, { side: THREE.DoubleSide }),
  housing: std('#69707a', 0.05, 0.75, { side: THREE.DoubleSide }),
  asa: std('#1f2328', 0.25, 0.2, { side: THREE.DoubleSide }),
  pa: std('#2a2d32', 0.05, 0.8),
  /** 도장 커버: 인스턴스 색으로 칠 전(검정 ASA)·후(차체색)를 나눈다 */
  paint: std('#ffffff', 0.35, 0.3, { side: THREE.DoubleSide }),
};

// ─────────── 제품 모양 (오목한 면이 +y, 가운데 정렬) ───────────

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const bowl = (r: number) => new THREE.SphereGeometry(r, 20, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
const merged = (list: THREE.BufferGeometry[]) => {
  const g = mergeGeometries(list) as THREE.BufferGeometry;
  g.center();
  return g;
};

const PART = {
  /** 헤드램프 외부 렌즈 (투명 PC, 0.7 × 0.45 m 곡면) */
  lens: merged([new THREE.SphereGeometry(0.6, 28, 8, 0, Math.PI * 2, Math.PI - 0.62, 0.62).scale(1, 1, 0.65)]),
  /** 리플렉터: 로우·하이빔 반사경 두 개가 붙은 BMC 성형품 */
  refl: merged([
    bowl(0.16).scale(1, 0.8, 1).translate(-0.17, 0, 0),
    bowl(0.16).scale(1, 0.8, 1).translate(0.17, 0, 0),
    box(0.68, 0.02, 0.04, 0, 0, 0.17),
    box(0.68, 0.02, 0.04, 0, 0, -0.17),
    box(0.04, 0.02, 0.3, 0.32, 0, 0),
    box(0.04, 0.02, 0.3, -0.32, 0, 0),
  ]),
  /** 램프 하우징: 위가 열린 통 + 렌즈와 붙는 플랜지 */
  housing: merged([
    new THREE.CylinderGeometry(0.42, 0.34, 0.28, 4, 1, true).rotateY(Math.PI / 4).scale(1.35, 1, 1),
    box(0.65, 0.025, 0.48, 0, -0.14, 0),
    box(0.88, 0.02, 0.05, 0, 0.14, 0.32),
    box(0.88, 0.02, 0.05, 0, 0.14, -0.32),
    box(0.05, 0.02, 0.6, 0.425, 0.14, 0),
    box(0.05, 0.02, 0.6, -0.425, 0.14, 0),
  ]),
  /** 미러 커버 한 개 */
  cover: merged([bowl(0.14).scale(1.5, 0.75, 1)]),
  /** 좌·우 2캐비티 한 숏: 커버 두 개 + 런너 */
  covers: merged([
    bowl(0.14).scale(1.5, 0.75, 1).translate(0, 0, 0.17),
    bowl(0.14).scale(1.5, 0.75, 1).translate(0, 0, -0.17),
    box(0.03, 0.03, 0.2, 0, -0.02, 0),
    new THREE.CylinderGeometry(0.02, 0.02, 0.08, 8).translate(0, -0.06, 0),
  ]),
  /** 브래킷 4캐비티 한 숏 (ㄱ자 브래킷 4개 + 런너) */
  brackets: merged([
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].flatMap((sz) => [
        box(0.13, 0.025, 0.08, sx * 0.1, -0.025, sz * 0.075),
        box(0.025, 0.07, 0.08, sx * 0.1525, 0, sz * 0.075),
        new THREE.CylinderGeometry(0.022, 0.022, 0.05, 10).translate(sx * 0.06, 0, sz * 0.075),
      ]),
    ),
    box(0.02, 0.02, 0.15, 0, -0.03, 0),
    box(0.1, 0.02, 0.02, 0, -0.03, 0),
  ]),
};

function dims(g: THREE.BufferGeometry) {
  if (!g.boundingBox) g.computeBoundingBox();
  const v = (g.boundingBox as THREE.Box3).getSize(new THREE.Vector3());
  return { len: v.x, t: v.y, w: v.z };
}

// ─────────── 배치 도우미 ───────────

/** [위치, 크기(단위 도형 배율), 회전(XYZ)] */
type Item = [V3, V3, V3?];
const ZERO: V3 = [0, 0, 0];
const ONE: V3 = [1, 1, 1];
const TINY: V3 = [1e-4, 1e-4, 1e-4];
const PI = Math.PI;
const b = (p: V3, s: V3, r?: V3): Item => [p, s, r];
/** 원기둥 (반지름 r, 길이 h). axis 방향으로 눕힌다 */
const c = (p: V3, r: number, h: number, axis: 'x' | 'y' | 'z' = 'y'): Item => [p, [r, h, r], axis === 'x' ? [0, 0, PI / 2] : axis === 'z' ? [PI / 2, 0, 0] : undefined];
/** 고리 (GEO.ring, 반지름 R). axis가 고리 축 */
const rg = (p: V3, R: number, axis: 'x' | 'y' | 'z' = 'z'): Item => [p, [R, R, R], axis === 'x' ? [0, PI / 2, 0] : axis === 'y' ? [PI / 2, 0, 0] : undefined];

const _o = new THREE.Object3D();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _e = new THREE.Euler();
const _col = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/** a에서 b까지 잇는 관 (GEO.pipe) */
function tube(a: V3, bb: V3, r: number): Item {
  _va.set(...a);
  _vb.set(...bb).sub(_va);
  const len = _vb.length();
  _o.quaternion.setFromUnitVectors(UP, _vb.normalize());
  _e.setFromQuaternion(_o.quaternion);
  return [[(a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2, (a[2] + bb[2]) / 2], [r, len, r], [_e.x, _e.y, _e.z]];
}
/** 꺾인 관: 점들을 차례로 잇는다 */
const pipeline = (pts: V3[], r: number) => pts.slice(1).map((p, i) => tube(pts[i], p, r));
/** 꺾인 곳 이음매 (GEO.ball) */
const elbows = (pts: V3[], r: number) => pts.slice(1, -1).map((p) => b(p, [r, r, r]));

/** 인스턴스 i의 행렬 */
function put(m: THREE.InstancedMesh, i: number, p: V3, s: V3, r: V3 = ZERO) {
  _o.position.set(...p);
  _o.rotation.set(...r);
  _o.scale.set(...s);
  _o.updateMatrix();
  m.setMatrixAt(i, _o.matrix);
}
/** 인스턴스 i를 a→b 관으로 */
function putTube(m: THREE.InstancedMesh, i: number, a: V3, bb: V3, r: number) {
  _va.set(...a);
  _vb.set(...bb).sub(_va);
  const len = _vb.length();
  _o.position.set(...a).addScaledVector(_vb, 0.5);
  _o.quaternion.setFromUnitVectors(UP, _vb.normalize());
  _o.scale.set(r, len, r);
  _o.updateMatrix();
  m.setMatrixAt(i, _o.matrix);
}

/** 같은 모양 여러 개를 메시 하나로 (정적) */
function Many({ geo, mat, items, colors, cast = false }: { geo: THREE.BufferGeometry; mat: THREE.Material; items: Item[]; colors?: string[]; cast?: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach(([p, s, r], i) => {
      put(m, i, p, s, r);
      if (colors) m.setColorAt(i, _col.set(colors[i % colors.length]));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  });
  return <instancedMesh key={items.length} ref={ref} args={[geo, mat, items.length]} castShadow={cast} receiveShadow />;
}

interface SetDef {
  g: THREE.BufferGeometry;
  m: THREE.Material;
  items: Item[];
  cast?: boolean;
  colors?: string[];
}
function Sets({ list }: { list: SetDef[] }) {
  return (
    <>
      {list
        .filter((d) => d.items.length > 0)
        .map((d, i) => (
          <Many key={i} geo={d.g} mat={d.m} items={d.items} cast={d.cast} colors={d.colors} />
        ))}
    </>
  );
}

/** 메시 하나 (단위 도형을 늘려 쓴다) */
function M1({ g = GEO.box, m, p, s = ONE, r, cast = true }: { g?: THREE.BufferGeometry; m: THREE.Material; p: V3; s?: V3; r?: V3; cast?: boolean }) {
  return <mesh geometry={g} material={m} position={p} scale={s} rotation={r} castShadow={cast} receiveShadow />;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** p가 a→b 구간을 지나는 동안 0→1 (부드럽게) */
const seg = (p: number, a: number, bb: number) => {
  const u = clamp01((p - a) / (bb - a));
  return u * u * (3 - 2 * u);
};
const frac = (v: number) => ((v % 1) + 1) % 1;
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 997, 7) / 997;

// ─────────── 제습 건조기 ───────────
// 단열 건조 호퍼(스탠드 위) + 제습 유닛(로터·히터·송풍기) + 건조 공기 호스 + 사출기로 가는 레진 이송관

const DX = -0.33; // 호퍼 중심
const DZ = 0.05;
const DRY_RESIN: V3[] = [
  [DX, 0.38, DZ],
  [DX, 0.38, 0.68],
  [0.7, 0.38, 0.68],
  [0.7, 2.35, 0.68],
  [1.05, 2.35, 0.68],
];
const DRY_SUPPLY: V3[] = [
  [0.22, 1.15, -0.5],
  [DX, 1.15, -0.5],
  [DX, 1.15, -0.36],
];
const DRY_RETURN: V3[] = [
  [DX + 0.22, 2.36, DZ - 0.22],
  [DX + 0.22, 2.56, DZ - 0.22],
  [0.42, 2.56, -0.42],
  [0.42, 1.8, -0.42],
];
const DRYER_SETS: SetDef[] = [
  {
    g: GEO.box,
    m: MAT.frame,
    items: [
      ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => b([DX + sx * 0.3, 0.5, DZ + sz * 0.3], [0.07, 1.0, 0.07]))),
      b([DX, 0.98, DZ + 0.3], [0.67, 0.06, 0.06]),
      b([DX, 0.98, DZ - 0.3], [0.67, 0.06, 0.06]),
      b([DX + 0.3, 0.98, DZ], [0.06, 0.06, 0.67]),
      b([DX - 0.3, 0.98, DZ], [0.06, 0.06, 0.67]),
      b([0.65, 1.975, -0.65], [0.05, 0.85, 0.05]), // 경광등 기둥
    ],
    cast: true,
  },
  { g: GEO.cyl, m: M.stainless, items: [c([DX, 1.675, DZ], 0.42, 1.25), c([DX, 2.5, DZ], 0.16, 0.28)], cast: true },
  {
    g: GEO.cyl,
    m: MAT.bodyDark,
    items: [
      c([DX, 1.25, DZ], 0.43, 0.05),
      c([DX, 2.1, DZ], 0.43, 0.05),
      c([DX, 2.33, DZ], 0.44, 0.06),
      c([DX, 2.66, DZ], 0.1, 0.05),
      c([0.795, 0.85, -0.2], 0.25, 0.03, 'x'), // 제습 로터 점검 덮개
      c([0.5, 0.3, -0.72], 0.15, 0.06, 'z'), // 재생 송풍기
    ],
  },
  {
    g: GEO.box,
    m: MAT.bodyDark,
    items: [
      b([DX, 0.53, DZ], [0.16, 0.17, 0.16]), // 배출 게이트
      b([0.5, 1.68, -0.25], [0.4, 0.26, 0.5]), // 공정 히터
      b([0.785, 0.32, -0.2], [0.02, 0.28, 0.7]), // 흡기 루버
    ],
  },
  { g: GEO.pipe, m: MAT.steel, items: pipeline(DRY_RESIN, 0.04), cast: true },
  { g: GEO.ball, m: MAT.steel, items: elbows(DRY_RESIN, 0.04) },
  { g: GEO.pipe, m: MAT.rubber, items: [...pipeline(DRY_SUPPLY, 0.05), ...pipeline(DRY_RETURN, 0.05)], cast: true },
  { g: GEO.ball, m: MAT.rubber, items: [...elbows(DRY_SUPPLY, 0.05), ...elbows(DRY_RETURN, 0.05)] },
];

function Dryer({ color }: MachineProps) {
  return (
    <group>
      <Sets list={DRYER_SETS} />
      <M1 g={GEO.cone} m={M.stainless} p={[DX, 0.835, DZ]} s={[0.42, 0.43, 0.42]} />
      <M1 m={MAT.body} p={[0.5, 0.775, -0.1]} s={[0.56, 1.55, 1.2]} />
      <M1 m={MAT.screen} p={[0.5, 1.2, 0.505]} s={[0.3, 0.2, 0.01]} cast={false} />
      <Stripe size={[0.57, 0.08, 1.21]} pos={[0.5, 1.42, -0.1]} color={color} />
    </group>
  );
}

// ─────────── 사출기 ───────────
// 로컬 좌표는 850 t 기준이고 설비마다 배율 s로 줄인다 (+x 끝을 맞춘다). 사출 유닛은 -x, 형체 유닛은 +x, 조작 쪽은 +z.
// 한 사이클: 형체 → 형개 → 취출 로봇 하강·흡착 → 상승·반전 → 형체 → 출구 컨베이어로 이동·하강·놓기 → 복귀

const YC = 1.39; // 금형 중심 높이
const XM = 0.18; // 파팅 라인 (닫힘)
const STROKE = 0.55; // 형개 거리
const LINK = 0.4; // 토글 링크 길이
const XA0 = 0.82; // 가동판 뒷면 (닫힘)
const XB = 1.62; // 후판 앞면
const Y_UP = 2.38; // 취출 로봇 손목 대기 높이
const BEAM_Y = 2.6;
const BEAM_Z = -0.42;
const HOP_X = -2.15; // 호퍼·피드 스로트
const CONV_X = 3.4; // 제품을 내려놓는 출구 컨베이어 위치 (월드 x)

type Feed = 'loader' | 'stuffer' | 'dryer';
interface ImCfg {
  /** 크기 배율 (850 t = 1) */
  s: number;
  part: THREE.BufferGeometry;
  pm: THREE.Material;
  /** 금형 높이·깊이 (로컬 m) */
  mh: number;
  md: number;
  /** 원료 공급: 진공 로더 호퍼 · BMC 스터퍼 · 호퍼 드라이어 */
  feed: Feed;
  /** 열경화 BMC: 배럴은 냉각 재킷, 금형은 전기 히터 */
  bmc?: boolean;
  /** 따로 선 제습 건조기에서 오는 레진 수송관 */
  pipe?: boolean;
}
const IM_DEFAULT: ImCfg = { s: 1, part: PART.housing, pm: PM.housing, mh: 0.95, md: 0.85, feed: 'loader' };
const IM: Record<string, ImCfg> = {
  'HL-IM-L1': { s: 0.92, part: PART.lens, pm: PM.lens, mh: 0.9, md: 0.72, feed: 'loader', pipe: true },
  'HL-IM-R1': { s: 0.84, part: PART.refl, pm: PM.bmc, mh: 0.82, md: 0.62, feed: 'stuffer', bmc: true },
  'HL-IM-H1': IM_DEFAULT,
  'OSM-IM-C1': { s: 0.86, part: PART.covers, pm: PM.asa, mh: 0.72, md: 0.85, feed: 'dryer' },
  'OSM-IM-B1': { s: 0.74, part: PART.brackets, pm: PM.pa, mh: 0.56, md: 0.5, feed: 'dryer' },
};

function imLayout(def: StationDef) {
  const cfg = IM[def.code] ?? IM_DEFAULT;
  const { s } = cfg;
  const { t, w } = dims(cfg.part);
  const off = 2.7 - 2.6 * s;
  /** 로컬 → 월드 */
  const W = (x: number, y: number, z: number): V3 => [off + s * x, s * y, s * z];
  const a = 0.035 + t / 2; // 흡착판에서 제품 중심까지
  const xDrop = (CONV_X - off) / s + 0.18;
  return {
    cfg,
    s,
    off,
    W,
    t,
    w,
    a,
    xPick: XM + STROKE - a,
    xDrop,
    dPick: Y_UP - (YC + 0.18),
    dDrop: Math.min(1.35, Y_UP - ((BELT_TOP + 0.03) / s + a + t / 2)),
    beamEnd: Math.min(xDrop + 0.3, (3.95 - off) / s),
    zPost: -0.55 / s,
    xT: off + s * 2.15, // 금형 온조기 (월드 x, 형체 실린더 옆)
  };
}
type ImLayout = ReturnType<typeof imLayout>;

/** 금형 호스 경로 (월드): 온조기 위 → 안전문 위로 올라가 → 금형 윗면으로 내려간다. 앞 2개는 고정측, 뒤 2개는 가동측 */
function hosePaths(L: ImLayout, open: number): V3[][] {
  const { cfg, W, xT, s } = L;
  const z = cfg.md / 2 - 0.08;
  const yTop = YC + cfg.mh / 2;
  const xs = [XM - 0.2, XM - 0.08, XM + 0.1 + STROKE * open, XM + 0.24 + STROKE * open];
  return xs.map((x, i) => {
    const nx = xT - 0.2 + i * 0.13;
    return [[nx, 0.94, 0.95], [nx, s * 2.3, 0.95], W(x, 2.3, z), W(x, yTop, z)];
  });
}

function injectionSets(L: ImLayout): { local: SetDef[]; world: SetDef[] } {
  const { cfg, beamEnd, zPost, off, s, W } = L;
  const frame: Item[] = [
    b([-0.675, 0.04, 0], [6.5, 0.08, 1.44]),
    ...[-2.6, -1.25, 0.1, 1.45].map((x) => b([x, 0.4, 0.752], [0.02, 0.5, 0.01])), // 베드 점검문 이음매
    b([-1.05, 1.08, 0.82], [0.06, 0.66, 0.06]), // 조작반 기둥
    b([-0.27, 2.285, BEAM_Z], [0.22, 0.47, 0.22]), // 로봇 빔 받침 (고정판 위)
    b([beamEnd - 0.08, BEAM_Y / 2, zPost], [0.12, BEAM_Y, 0.12]), // 로봇 빔 끝 기둥
    b([beamEnd - 0.08, BEAM_Y, (BEAM_Z + zPost) / 2], [0.1, 0.1, Math.abs(zPost - BEAM_Z) + 0.1]),
  ];
  const body: Item[] = [b([-0.675, 0.375, 0], [6.55, 0.75, 1.5])];
  const light: Item[] = [
    b([-2.925, 1.3, 0], [1.25, 1.1, 0.96]), // 사출 유닛 커버
    ...[-0.42, 0.77, 1.95].flatMap((x) => [0.8, -0.8].map((z) => b([x, 1.44, z], [0.06, 1.38, 0.06]))), // 안전문 틀
    b([0.765, 2.13, 0.8], [2.42, 0.07, 0.06]),
    b([0.765, 2.13, -0.8], [2.42, 0.07, 0.06]),
  ];
  const lightCyl: Item[] = [];
  const platens: Item[] = [
    b([-0.275, 1.385, 0], [0.35, 1.33, 1.42]), // 고정판
    b([1.78, 1.385, 0], [0.32, 1.26, 1.38]), // 후판
  ];
  const dark: Item[] = [b([HOP_X, 1.45, 0], [0.3, 0.32, 0.34])]; // 피드 스로트
  const darkCyl: Item[] = [
    c([-3.75, 1.3, 0], 0.24, 0.4, 'x'), // 스크루 구동 모터
    c([2.22, YC, 0], 0.2, 0.56, 'x'), // 형체 실린더
  ];
  const steel: Item[] = [
    ...[1, -1].flatMap((sy) => [1, -1].map((sz) => c([0.74, YC + sy * 0.55, sz * 0.55], 0.065, 2.64, 'x'))), // 타이바
    ...[-0.51, 2.0].flatMap((x) => [1, -1].flatMap((sy) => [1, -1].map((sz) => c([x, YC + sy * 0.55, sz * 0.55], 0.11, 0.12, 'x')))), // 타이바 너트
    c([-1.375, 1.0, 0.42], 0.04, 1.85, 'x'), // 노즐 터치 실린더
    c([-1.375, 1.0, -0.42], 0.04, 1.85, 'x'),
    c([-1.31, YC, 0], 0.085, 1.38, 'x'), // 배럴
    c([-0.535, YC, 0], 0.05, 0.17, 'x'), // 노즐
  ];
  const stainless: Item[] = [];
  const hoses: Item[] = [];
  if (cfg.feed === 'stuffer') {
    light.push(b([HOP_X, 1.86, 0], [0.44, 0.5, 0.44])); // BMC 스터퍼 통
    darkCyl.push(c([HOP_X, 2.385, 0], 0.11, 0.55)); // 누름 유압 실린더
    steel.push(c([HOP_X, 2.72, 0], 0.035, 0.12));
  } else {
    (cfg.feed === 'dryer' ? lightCyl : stainless).push(c([HOP_X, 2.225, 0], cfg.feed === 'dryer' ? 0.33 : 0.3, 0.55));
    darkCyl.push(c([HOP_X, 2.52, 0], 0.32, 0.04), c([HOP_X, 2.8, 0], 0.11, 0.04));
    stainless.push(c([HOP_X, 2.66, 0], 0.16, 0.24)); // 진공 로더
    if (cfg.feed === 'dryer') {
      body.push(b([-2.95, 2.06, 0], [0.36, 0.42, 0.34])); // 호퍼 드라이어 (히터·송풍기)
      hoses.push(
        ...pipeline([[-2.95, 2.27, 0.08], [-2.95, 2.42, 0.08], [-2.48, 2.42, 0.08]], 0.035),
        ...pipeline([[-2.95, 2.27, -0.08], [-2.95, 2.34, -0.08], [-2.48, 2.34, -0.08]], 0.035),
      );
    }
  }
  const bands: Item[] = cfg.bmc ? [c([-1.31, YC, 0], 0.13, 1.3, 'x')] : [-1.85, -1.58, -1.31, -1.04, -0.77].map((x) => c([x, YC, 0], 0.125, 0.14, 'x'));

  const local: SetDef[] = [
    { g: GEO.box, m: MAT.frame, items: frame, cast: true },
    { g: GEO.box, m: MAT.body, items: body, cast: true },
    { g: GEO.box, m: MAT.bodyLight, items: light, cast: true },
    { g: GEO.cyl, m: MAT.bodyLight, items: lightCyl, cast: true },
    { g: GEO.box, m: M.platen, items: platens, cast: true },
    { g: GEO.box, m: MAT.bodyDark, items: dark, cast: true },
    { g: GEO.cyl, m: M.stainless, items: stainless, cast: true },
    { g: GEO.cyl, m: MAT.bodyDark, items: darkCyl, cast: true },
    { g: GEO.cyl, m: MAT.steel, items: steel, cast: true },
    { g: GEO.cyl, m: cfg.bmc ? MAT.bodyDark : M.band, items: bands },
    { g: GEO.pipe, m: MAT.rubber, items: hoses },
    { g: GEO.box, m: MAT.glass, items: [b([0.765, 1.44, 0.8], [2.37, 1.36, 0.02]), b([0.765, 1.44, -0.8], [2.37, 1.36, 0.02])] },
  ];

  // 월드 좌표: 출구 컨베이어, 경광등 기둥, 레진 수송관
  const legs: Item[] = [2.85, 3.92].flatMap((x) => [0.28, -0.28].map((z) => b([x, (BELT_TOP - 0.06) / 2, z], [0.05, BELT_TOP - 0.06, 0.05])));
  legs.push(b([3.85, 1.1, -1.05], [0.05, 2.2, 0.05]));
  const world: SetDef[] = [
    { g: GEO.box, m: MAT.frame, items: legs },
    { g: GEO.box, m: MAT.safety, items: [b([3.375, BELT_TOP + 0.01, 0.33], [1.25, 0.07, 0.04]), b([3.375, BELT_TOP + 0.01, -0.33], [1.25, 0.07, 0.04])] },
  ];
  if (cfg.pipe) {
    const hx = off + s * HOP_X;
    const y = s * 2.79;
    const pts: V3[] = [W(HOP_X, 2.79, 0), [hx, y, -0.95], [-4.15, y, -0.95]];
    world.push({ g: GEO.pipe, m: MAT.steel, items: pipeline(pts, 0.035), cast: true }, { g: GEO.ball, m: MAT.steel, items: elbows(pts, 0.035) });
  }
  return { local, world };
}

function Injection({ def, color, running }: MachineProps) {
  const L = useMemo(() => imLayout(def), [def]);
  const sets = useMemo(() => injectionSets(L), [L]);
  const { cfg, s, off, a, xPick, xDrop, dPick, dDrop, beamEnd, xT, t, w } = L;
  const { part, pm, mh, md } = cfg;
  const wE = Math.min(0.5, w * 0.8);
  // 공급(빨강)·회수(파랑) 호스, 관마다 3토막. BMC는 히터 전선(검정)
  const hoseColors = (cfg.bmc ? ['#202328', '#202328'] : ['#c0392b', '#2e6bd1']).flatMap((h) => [h, h, h]);
  const staticHoses = useMemo(() => hosePaths(L, 0).slice(0, 2).flatMap((pts) => pipeline(pts, 0.025)), [L]);
  const cups = useMemo(() => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => c([0.03, -0.18 + sy * 0.08, sz * wE * 0.3], 0.022, 0.04, 'x'))), [wE]);

  const mov = useRef<THREE.Group>(null);
  const moldPart = useRef<THREE.Mesh>(null);
  const links = useRef<THREE.InstancedMesh>(null);
  const cross = useRef<THREE.Mesh>(null);
  const rod = useRef<THREE.Mesh>(null);
  const car = useRef<THREE.Group>(null);
  const stages = useRef<(THREE.Mesh | null)[]>([]);
  const wrist = useRef<THREE.Group>(null);
  const gripPart = useRef<THREE.Mesh>(null);
  const convPart = useRef<THREE.Group>(null);
  const hoses = useRef<THREE.InstancedMesh>(null);

  const run = useRef(running);
  run.current = running;
  // 멈춰 있을 때 보이는 장면: 금형이 열리고 로봇이 내려가 제품을 잡은 순간
  const tm = useRef(0.53 + 0.035 * hash(def.code));
  const drawn = useRef(false);
  const T = Math.max(6, def.cycle / 7);

  useLayoutEffect(() => {
    const m = hoses.current;
    if (!m) return;
    hoseColors.forEach((h, i) => m.setColorAt(i, _col.set(h)));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  useFrame((_, dt) => {
    if (run.current) tm.current += dt / T;
    else if (drawn.current) return;
    drawn.current = true;
    const p = frac(tm.current);
    const open = seg(p, 0.38, 0.46) - seg(p, 0.66, 0.74);
    const d = dPick * (seg(p, 0.46, 0.53) - seg(p, 0.57, 0.64)) + dDrop * (seg(p, 0.8, 0.85) - seg(p, 0.85, 0.89));
    const flip = seg(p, 0.64, 0.7) - seg(p, 0.95, 1);
    const xr = xPick + (xDrop - xPick) * (seg(p, 0.7, 0.8) - seg(p, 0.89, 0.96));

    if (mov.current) mov.current.position.x = STROKE * open;
    if (moldPart.current) moldPart.current.visible = p < 0.55 || p >= 0.74;
    // 토글: 가동판이 후판 쪽으로 오면 링크가 안쪽으로 접힌다
    const xa = XA0 + STROKE * open;
    const half = (XB - xa) / 2;
    const k = Math.sqrt(Math.max(0, LINK * LINK - half * half));
    const xk = xa + half;
    const lm = links.current;
    if (lm) {
      let i = 0;
      for (const sy of [1, -1]) {
        const y0 = YC + sy * 0.45;
        const yk = y0 - sy * k;
        for (const z of [0.3, -0.3]) {
          for (const [x0, y1, x1, y2] of [
            [xa, y0, xk, yk],
            [xk, yk, XB, y0],
          ]) {
            const dx = x1 - x0;
            const dy = y2 - y1;
            put(lm, i++, [(x0 + x1) / 2, (y1 + y2) / 2, z], [Math.hypot(dx, dy) + 0.06, 0.09, 0.12], [0, 0, Math.atan2(dy, dx)]);
          }
        }
      }
      lm.instanceMatrix.needsUpdate = true;
    }
    const xc = xk + 0.06;
    if (cross.current) cross.current.position.set(xc, YC, 0);
    if (rod.current) {
      const l = Math.max(0.01, XB - xc - 0.05);
      rod.current.position.set(xc + 0.05 + l / 2, YC, 0);
      rod.current.scale.set(0.05, l, 0.05);
    }
    // 취출 로봇
    if (car.current) car.current.position.x = xr;
    stages.current.forEach((m, i) => m && m.position.set(0, Y_UP + 0.3 - (d * (i + 1)) / 3, 0));
    if (wrist.current) {
      wrist.current.position.set(0, Y_UP - d, 0);
      wrist.current.rotation.z = (-flip * PI) / 2;
    }
    if (gripPart.current) gripPart.current.visible = p >= 0.55 && p < 0.85;
    // 출구 컨베이어 위 제품 (놓인 뒤 +x로 흘러 라인 컨베이어로 넘어간다)
    const u = frac(p - 0.85) / 0.5;
    if (convPart.current) {
      convPart.current.visible = u < 1;
      convPart.current.position.set(CONV_X + 0.5 * u, BELT_TOP + (s * t) / 2, 0);
    }
    // 가동측 금형 호스는 형개를 따라간다
    const hm = hoses.current;
    if (hm) {
      const paths = hosePaths(L, open).slice(2);
      paths.forEach((pts, i) => pts.slice(1).forEach((q, j) => putTube(hm, i * 3 + j, pts[j], q, 0.025)));
      hm.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group>
      <group position={[off, 0, 0]} scale={s}>
        <Sets list={sets.local} />
        <Stripe size={[6.56, 0.07, 1.51]} pos={[-0.675, 0.62, 0]} color={color} />
        {cfg.feed !== 'stuffer' && <M1 g={GEO.cone} m={cfg.feed === 'dryer' ? MAT.bodyLight : M.stainless} p={[HOP_X, 1.78, 0]} s={[0.3, 0.34, 0.3]} />}
        {/* 고정측 금형 (캐비티) */}
        <M1 m={M.mold} p={[XM - 0.14, YC, 0]} s={[0.28, mh, md]} />
        {/* 가동측: 코어 + 가동판 + 제품 (형개 때 함께 움직인다) */}
        <group ref={mov}>
          <M1 m={M.mold} p={[XM + 0.16, YC, 0]} s={[0.32, mh, md]} />
          <M1 m={M.platen} p={[0.66, 1.385, 0]} s={[0.32, 1.26, 1.38]} />
          <M1 m={MAT.frame} p={[0.66, 0.79, 0]} s={[0.42, 0.08, 1.1]} cast={false} />
          <mesh ref={moldPart} geometry={part} material={pm} position={[XM, YC, 0]} rotation={[0, 0, -PI / 2]} castShadow />
        </group>
        {/* 토글 링크 8개 · 크로스헤드 · 형체 실린더 로드 */}
        <instancedMesh ref={links} args={[GEO.box, MAT.steel, 8]} castShadow frustumCulled={false} />
        <mesh ref={cross} geometry={GEO.box} material={MAT.bodyDark} scale={[0.1, 0.3, 0.75]} castShadow />
        <mesh ref={rod} geometry={GEO.cyl} material={MAT.steel} rotation={[0, 0, PI / 2]} />
        {/* 조작반 (HMI) · 안전문 손잡이 */}
        <M1 m={MAT.bodyLight} p={[-1.05, 1.62, 0.84]} s={[0.6, 0.48, 0.1]} r={[-0.15, 0, 0]} />
        <M1 m={MAT.screen} p={[-1.05, 1.63, 0.895]} s={[0.48, 0.34, 0.02]} r={[-0.15, 0, 0]} cast={false} />
        <M1 m={MAT.safety} p={[0.95, 1.45, 0.83]} s={[0.04, 0.3, 0.04]} cast={false} />
        {/* 취출 로봇 (트래버스형): 빔 + 캐리지 + 3단 수직 암 + 반전 손목 + 흡착판 */}
        <M1 m={MAT.bodyLight} p={[(beamEnd - 0.4) / 2, BEAM_Y, BEAM_Z]} s={[beamEnd + 0.4, 0.16, 0.2]} />
        <group ref={car}>
          <M1 m={MAT.safety} p={[0, BEAM_Y, -0.235]} s={[0.3, 0.3, 0.63]} />
          {[0.15, 0.11, 0.08].map((sz, i) => (
            <mesh
              key={i}
              ref={(m) => {
                stages.current[i] = m;
              }}
              geometry={GEO.box}
              material={i ? MAT.steel : MAT.bodyLight}
              scale={[sz, 0.6, sz]}
              castShadow
            />
          ))}
          <group ref={wrist}>
            <M1 m={MAT.bodyDark} p={[0, -0.03, 0]} s={[0.12, 0.08, 0.14]} />
            <M1 m={MAT.frame} p={[0, -0.18, 0]} s={[0.03, 0.3, wE]} />
            <Many geo={GEO.cyl} mat={MAT.rubber} items={cups} />
            <mesh ref={gripPart} geometry={part} material={pm} position={[a, -0.18, 0]} rotation={[0, 0, -PI / 2]} castShadow />
          </group>
        </group>
      </group>
      {/* 금형 온조기 (BMC는 금형 히터 제어반) + 금형 호스 */}
      <M1 m={MAT.body} p={[xT, 0.47, 1.0]} s={[0.55, 0.94, 0.4]} />
      <M1 m={MAT.screen} p={[xT - 0.1, 0.74, 1.205]} s={[0.22, 0.13, 0.01]} cast={false} />
      <Many geo={GEO.pipe} mat={M.hose} items={staticHoses} colors={hoseColors} />
      <instancedMesh ref={hoses} args={[GEO.pipe, M.hose, 6]} frustumCulled={false} />
      {/* 출구 컨베이어 (라인 컨베이어와 같은 높이) */}
      <Sets list={sets.world} />
      <M1 m={MAT.belt} p={[3.375, BELT_TOP - 0.03, 0]} s={[1.25, 0.06, 0.6]} cast={false} />
      <group ref={convPart} scale={s}>
        <mesh geometry={part} material={pm} rotation={[0, 0, PI]} castShadow />
      </group>
    </group>
  );
}

// ─────────── 하드코팅 라인 (클린룸) ───────────
// 적재 → [클린룸: 이온 블로우 → 프라이머·하드코트 플로우 코팅 → 플래시오프] → 130 °C 열경화로 → 출구 외관 검사 → 하역
// 렌즈는 머리 위 행거 컨베이어에 매달려 지나간다

const HC_N = 18;
const HC_X0 = -7.8;
const HC_SPAN = 15.6;
const HC_RAIL = 2.42;
const LENS_HANG: V3 = [-PI / 2, 0, 0]; // 볼록면이 앞(+z)을 본다
const FFU_X = [-6.0, -3.85, -1.7];
const HC_ZONES = [0.75, 2.8, 4.85];
const COATERS = [-4.4, -3.1]; // 프라이머, 하드코트

const HC_SETS: SetDef[] = [
  {
    g: GEO.box,
    m: MAT.bodyLight,
    items: [
      b([-3.85, 1.325, -1.45], [6.2, 2.65, 0.05]), // 클린룸 뒷벽
      b([-1.55, 1.25, 0.55], [1.3, 1.2, 0.04]), // 플래시오프 송풍판
      b([-1.55, 1.25, -0.55], [1.3, 1.2, 0.04]),
    ],
    cast: true,
  },
  {
    // 천장·FFU: 그림자를 드리우지 않아 클린룸 안이 밝게 보인다 (실제로도 조명이 켜져 있다)
    g: GEO.box,
    m: MAT.bodyLight,
    items: [b([-3.85, 2.7, 0], [6.2, 0.1, 2.95]), ...FFU_X.flatMap((x) => [-0.62, 0.62].map((z) => b([x, 2.89, z], [1.1, 0.28, 0.9])))],
  },
  { g: GEO.box, m: M.light, items: FFU_X.flatMap((x) => [-0.62, 0.62].map((z) => b([x, 2.64, z], [0.95, 0.015, 0.75]))) },
  {
    g: GEO.box,
    m: MAT.glass,
    items: [
      b([-3.85, 1.33, 1.45], [6.2, 2.6, 0.02]),
      b([-6.95, 1.33, 0.9], [0.02, 2.6, 1.1]),
      b([-6.95, 1.33, -0.9], [0.02, 2.6, 1.1]),
      b([-6.95, 0.45, 0], [0.02, 0.9, 0.7]),
    ],
  },
  {
    g: GEO.box,
    m: MAT.frame,
    items: [
      ...[-6.95, -4.9, -2.85, -0.8].flatMap((x) => [1.45, -1.45].map((z) => b([x, 1.33, z], [0.07, 2.66, 0.07]))),
      b([-3.85, 2.63, 1.45], [6.2, 0.07, 0.07]),
      b([-3.85, 0.04, 1.45], [6.2, 0.08, 0.07]),
      b([-0.77, 1.67, 0], [0.03, 1.6, 0.66]), // 경화로 입구
      b([6.37, 1.67, 0], [0.03, 1.6, 0.66]), // 경화로 출구
      b([1.75, 1.3, 1.31], [0.08, 2.6, 0.04]), // 존 구분
      b([3.85, 1.3, 1.31], [0.08, 2.6, 0.04]),
      ...[-7.5, 7.55].flatMap((x) => [-1, 1].flatMap((sx) => [0.3, -0.3].map((z) => b([x + sx * 0.4, (BELT_TOP - 0.06) / 2, z], [0.05, BELT_TOP - 0.06, 0.05])))),
      ...[-6.0].flatMap((x) => [0.42, -0.42].map((z) => b([x, 0.375, z], [0.06, 0.75, 0.06]))), // 에어 나이프 받침
      b([-7.85, 1.25, -0.75], [0.1, 2.5, 0.1]), // 레일 끝 기둥
      b([7.85, 1.25, -0.75], [0.1, 2.5, 0.1]),
      b([-7.85, 2.47, -0.375], [0.08, 0.08, 0.8]),
      b([7.85, 2.47, -0.375], [0.08, 0.08, 0.8]),
      b([7.1, 1.3, -0.6], [1.4, 1.3, 0.05]), // 검사 라이트 박스 틀
      b([6.43, 1.3, -0.4], [0.05, 1.3, 0.45]),
      b([7.77, 1.3, -0.4], [0.05, 1.3, 0.45]),
      b([7.85, 1.3, -1.45], [0.05, 2.6, 0.05]), // 경광등 기둥
    ],
    cast: true,
  },
  {
    g: GEO.box,
    m: MAT.steel,
    items: [
      b([0, HC_RAIL, 0], [15.7, 0.08, 0.1]), // 행거 레일
      b([-6.0, 1.25, 0.42], [0.08, 1.0, 0.08]), // 이온 에어 나이프
      b([-6.0, 1.25, -0.42], [0.08, 1.0, 0.08]),
      ...COATERS.flatMap((x) => [0.18, -0.18].map((z) => b([x, 1.6, z], [0.9, 0.05, 0.05]))), // 노즐 매니폴드
      b([-3.75, 0.225, 0], [2.6, 0.45, 1.3]), // 코팅액 회수 통
      b([-3.75, 1.25, -0.7], [2.6, 1.6, 0.04]), // 비산 방지판
    ],
    cast: true,
  },
  {
    g: GEO.cyl,
    m: MAT.steel,
    items: [
      ...COATERS.flatMap((x) => [0.18, -0.18].flatMap((z) => [0, 1, 2, 3].map((k) => c([x - 0.33 + k * 0.22, 1.545, z], 0.015, 0.07)))), // 노즐
      c([5.8, 2.975, 0.5], 0.18, 0.75), // 배기 스택
    ],
    cast: true,
  },
  { g: GEO.cyl, m: M.stainless, items: COATERS.map((x) => c([x, 0.4, -1.1], 0.25, 0.8)), cast: true }, // 코팅액 탱크
  {
    g: GEO.box,
    m: MAT.bodyDark,
    items: [
      ...HC_ZONES.map((x) => b([x, 2.85, -0.35], [1.2, 0.5, 1.0])), // 존 히터·순환팬 박스
    ],
  },
  {
    g: GEO.cyl,
    m: MAT.bodyDark,
    items: [
      ...HC_ZONES.map((x) => c([x, 3.25, -0.35], 0.16, 0.3)),
      ...FFU_X.flatMap((x) => [-0.62, 0.62].map((z) => c([x, 3.08, z], 0.16, 0.1))),
      ...COATERS.map((x) => c([x, 0.9, -1.1], 0.07, 0.2)),
    ],
  },
  {
    g: GEO.box,
    m: MAT.body,
    items: [
      b([2.8, 1.3, 0], [7.1, 2.6, 2.6]), // 열경화로
      b([6.05, 0.85, 1.43], [0.5, 1.7, 0.25]), // 제어반
      b([-6.0, 0.3, -1.1], [0.7, 0.6, 0.5]), // 이온 블로어
    ],
    cast: true,
  },
  {
    g: GEO.pipe,
    m: MAT.steel,
    items: [
      ...COATERS.flatMap((x) =>
        pipeline(
          [
            [x, 0.8, -1.1],
            [x, 1.75, -1.1],
            [x, 1.75, -0.18],
            [x, 1.62, -0.18],
          ],
          0.025,
        ),
      ),
      ...pipeline(
        [
          [-6.0, 0.5, -0.85],
          [-6.0, 0.5, 0.42],
        ],
        0.05,
      ),
      tube([-6.0, 0.5, 0.42], [-6.0, 0.75, 0.42], 0.05),
      tube([-6.0, 0.5, -0.42], [-6.0, 0.75, -0.42], 0.05),
    ],
  },
  {
    g: GEO.box,
    m: MAT.belt,
    items: [b([-7.5, BELT_TOP - 0.03, 0], [0.95, 0.06, 0.7]), b([7.55, BELT_TOP - 0.03, 0], [0.85, 0.06, 0.7])],
  },
  { g: PART.lens, m: PM.lens, items: [b([-7.45, BELT_TOP + 0.06, 0], ONE, [PI, 0, 0]), b([7.6, BELT_TOP + 0.06, 0], ONE, [PI, 0, 0])] },
  { g: GEO.box, m: MAT.screen, items: [b([6.05, 1.35, 1.56], [0.32, 0.22, 0.01])] },
];
const HC_FLOW: Item[] = COATERS.flatMap((x) => [0.08, -0.08].map((z) => b([x, 1.01, z], [0.75, 1.1, 0.004])));

/** 행거 컨베이어 (렌즈를 매달고 +x로 돈다) */
function HcHangers({ running }: { running: boolean }) {
  const rods = useRef<THREE.InstancedMesh>(null);
  const lenses = useRef<THREE.InstancedMesh>(null);
  const run = useRef(running);
  run.current = running;
  const tm = useRef(0);
  const drawn = useRef(false);
  useFrame((_, dt) => {
    if (run.current) tm.current += dt;
    else if (drawn.current) return;
    drawn.current = true;
    const r = rods.current;
    const l = lenses.current;
    if (!r || !l) return;
    for (let i = 0; i < HC_N; i++) {
      const x = HC_X0 + frac((i / HC_N) + (tm.current * 0.12) / HC_SPAN) * HC_SPAN;
      put(r, 2 * i, [x, 1.95, 0], [0.025, 0.86, 0.025]);
      put(r, 2 * i + 1, [x, 1.52, 0], [0.4, 0.03, 0.03]);
      // 적재 위치에서 걸고 하역 위치에서 뗀다
      put(l, i, [x, 1.26, 0], x > -7.45 && x < 7.35 ? ONE : TINY, LENS_HANG);
    }
    r.instanceMatrix.needsUpdate = true;
    l.instanceMatrix.needsUpdate = true;
  });
  return (
    <>
      <instancedMesh ref={rods} args={[GEO.box, MAT.steel, HC_N * 2]} frustumCulled={false} />
      <instancedMesh ref={lenses} args={[PART.lens, PM.lens, HC_N]} frustumCulled={false} />
    </>
  );
}

function Hardcoat({ color, state, running }: MachineProps) {
  return (
    <group>
      <Sets list={HC_SETS} />
      <M1 m={M.liquid} p={[-3.75, 0.455, 0]} s={[2.5, 0.01, 1.2]} cast={false} />
      {running && <Many geo={GEO.box} mat={M.coat} items={HC_FLOW} />}
      <M1 m={M.light} p={[7.1, 1.3, -0.565]} s={[1.2, 1.1, 0.02]} cast={false} />
      {HC_ZONES.map((x) => (
        <HeatPanel key={x} size={[1.7, 0.85, 0.03]} pos={[x, 1.45, 1.315]} state={state} />
      ))}
      <Stripe size={[7.12, 0.12, 2.62]} pos={[2.8, 0.3, 0]} color={color} />
      <HcHangers running={running} />
    </group>
  );
}

// ─────────── 도장 라인 ───────────
// 적재 → 전처리 터널(세척·건조) → 유리 부스(베이스·클리어 정전 도장 로봇) → 플래시오프 → 125 °C 건조로 → 하역
// 커버는 머리 위 컨베이어의 스핀들 지그에 매달려 지나가고, 부스 안에서는 지그가 돌아 모든 면이 칠해진다

const PT_N = 20;
const PT_X0 = -8.85;
const PT_SPAN = 17.7;
const PT_RAIL = 2.85;
const ROBOTS = [-3.6, -1.4]; // 베이스, 클리어
const PT_ZONES = [2.95, 4.9, 6.85];
const RAW = new THREE.Color('#262a30');
const BASE = new THREE.Color('#2f63b8');
const CLEAR = new THREE.Color('#4a80d4');
const openings = (xs: number[]) => xs.map((x) => b([x, 1.85, 0], [0.03, 1.3, 0.7]));

const PT_SETS: SetDef[] = [
  {
    g: GEO.box,
    m: M.stainless,
    items: [b([-6.45, 1.3, 0], [2.9, 2.6, 2.0])], // 전처리 터널 (스테인리스)
    cast: true,
  },
  { g: GEO.box, m: MAT.steel, items: [b([0, PT_RAIL, 0], [17.7, 0.08, 0.1])] }, // 컨베이어 레일
  {
    g: GEO.box,
    m: MAT.body,
    items: [
      b([4.9, 1.35, 0], [5.8, 2.7, 2.5]), // 건조로
      b([-6.45, 0.35, -1.4], [2.2, 0.7, 0.55]), // 세척수 탱크
      b([1.9, 0.8, 1.5], [0.6, 1.6, 0.3]), // 제어반
    ],
    cast: true,
  },
  {
    g: GEO.box,
    m: MAT.bodyLight,
    items: [
      b([-2.5, 1.5, -1.6], [4.6, 3.0, 0.06]), // 부스 뒷벽 (배기 필터 벽)
      b([0.9, 1.3, 0], [1.8, 2.6, 2.0]), // 플래시오프 터널
    ],
    cast: true,
  },
  {
    // 급기 플레넘·덕트: 그림자 없이 (부스 안이 밝게 보이게)
    g: GEO.box,
    m: MAT.bodyLight,
    items: [b([-2.5, 3.175, 0], [4.6, 0.35, 3.26]), b([-2.5, 3.5, -0.9], [3.6, 0.3, 0.6])],
  },
  {
    g: GEO.box,
    m: MAT.bodyDark,
    items: [
      b([-2.5, 1.0, -1.565], [4.2, 1.4, 0.02]), // 배기 필터면
      ...PT_ZONES.map((x) => b([x, 2.95, -0.45], [1.1, 0.5, 0.9])), // 존 히터·순환팬
    ],
  },
  {
    g: GEO.cyl,
    m: MAT.bodyDark,
    items: [...PT_ZONES.map((x) => c([x, 3.35, -0.45], 0.16, 0.3)), c([-5.4, 0.55, -1.4], 0.12, 0.3, 'x')],
  },
  {
    g: GEO.cyl,
    m: MAT.steel,
    items: [
      c([-5.6, 3.15, -0.6], 0.2, 1.1), // 전처리 배기
      c([-0.8, 3.65, -1.25], 0.28, 0.6), // 부스 배기
      c([7.2, 3.3, 0.55], 0.2, 1.2), // 건조로 배기
    ],
    cast: true,
  },
  {
    g: GEO.box,
    m: MAT.frame,
    items: [
      ...openings([-7.915, -4.985, -0.015, 1.815, 1.985, 7.815]),
      b([-6.45, 2.605, 0], [2.9, 0.02, 0.08]), // 지붕 슬롯
      b([0.9, 2.605, 0], [1.8, 0.02, 0.08]),
      b([4.9, 2.705, 0], [5.8, 0.02, 0.08]),
      ...[-4.8, -2.5, -0.2].flatMap((x) => [1.6, -1.6].map((z) => b([x, 1.5, z], [0.07, 3.0, 0.07]))), // 부스 기둥
      b([-2.5, 0.04, 0], [4.5, 0.08, 3.1]), // 부스 그레이팅
      ...ROBOTS.map((x) => b([x, 0.175, -1.05], [0.55, 0.35, 0.55])), // 로봇 받침
      ...[-8.5, 8.45].flatMap((x) => [-1, 1].flatMap((sx) => [0.3, -0.3].map((z) => b([x + sx * 0.38, (BELT_TOP - 0.06) / 2, z], [0.05, BELT_TOP - 0.06, 0.05])))),
      b([-8.85, 1.45, -0.8], [0.1, 2.9, 0.1]), // 레일 끝 기둥
      b([8.85, 1.45, -0.8], [0.1, 2.9, 0.1]),
      b([-8.85, 2.9, -0.4], [0.08, 0.08, 0.85]),
      b([8.85, 2.9, -0.4], [0.08, 0.08, 0.85]),
      ...[-6.45, 0.9].flatMap((x) => [0.09, -0.09].map((z) => b([x, 2.725, z], [0.05, 0.25, 0.03]))), // 레일 받침
      ...[3.9, 5.85].flatMap((x) => [0.09, -0.09].map((z) => b([x, 2.775, z], [0.05, 0.15, 0.03]))),
      ...[3.9, 5.85].map((x) => b([x, 1.35, 1.27], [0.08, 2.7, 0.04])), // 존 구분
      b([8.85, 1.6, -1.65], [0.05, 3.2, 0.05]), // 경광등 기둥
    ],
    cast: true,
  },
  {
    g: GEO.box,
    m: MAT.glass,
    items: [b([-2.5, 1.5, 1.6], [4.6, 3.0, 0.02]), ...[-4.8, -0.2].flatMap((x) => [b([x, 1.5, 1.0], [0.02, 3.0, 1.2]), b([x, 1.5, -1.0], [0.02, 3.0, 1.2]), b([x, 0.6, 0], [0.02, 1.2, 0.8])])],
  },
  { g: GEO.box, m: M.light, items: [b([-2.5, 2.985, 1.1], [4.2, 0.02, 0.25]), b([-2.5, 2.985, -1.1], [4.2, 0.02, 0.25])] },
  { g: GEO.box, m: MAT.belt, items: [b([-8.5, BELT_TOP - 0.03, 0], [0.9, 0.06, 0.7]), b([8.45, BELT_TOP - 0.03, 0], [0.9, 0.06, 0.7])] },
  {
    g: PART.cover,
    m: PM.paint,
    items: [-8.68, -8.32, 8.27, 8.63].map((x) => b([x, BELT_TOP + 0.055, 0], ONE, [PI, PI / 2, 0])),
    colors: ['#262a30', '#262a30', '#4a80d4', '#4a80d4'],
  },
  { g: GEO.box, m: MAT.screen, items: [b([1.9, 1.25, 1.655], [0.4, 0.26, 0.01])] },
];
const PT_MIST: Item[] = ROBOTS.map((x) => b([x, 1.7, -0.2], [0.55, 0.7, 0.4]));

const _qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -PI / 2);
const _qy = new THREE.Quaternion();

/** 컨베이어 지그 (커버 좌·우 2개씩) */
function PtJigs({ running }: { running: boolean }) {
  const rods = useRef<THREE.InstancedMesh>(null);
  const covers = useRef<THREE.InstancedMesh>(null);
  const run = useRef(running);
  run.current = running;
  const tm = useRef(0);
  const drawn = useRef(false);
  useFrame((_, dt) => {
    if (run.current) tm.current += dt;
    else if (drawn.current) return;
    drawn.current = true;
    const r = rods.current;
    const cv = covers.current;
    if (!r || !cv) return;
    for (let i = 0; i < PT_N; i++) {
      const x = PT_X0 + frac(i / PT_N + (tm.current * 0.14) / PT_SPAN) * PT_SPAN;
      put(r, 2 * i, [x, 2.505, 0], [0.025, 0.61, 0.025]);
      put(r, 2 * i + 1, [x, 1.75, 0], [0.03, 0.9, 0.03]);
      // 부스 안에서 지그가 두 바퀴 돈다
      const psi = 4 * PI * seg(x, -4.6, -0.4);
      _qy.setFromAxisAngle(UP, psi);
      _col.copy(RAW).lerp(BASE, seg(x, -3.9, -3.1)).lerp(CLEAR, seg(x, -1.8, -1.0));
      const show = x > -8.75 && x < 8.2;
      for (let k = 0; k < 2; k++) {
        _o.position.set(x + Math.sin(psi) * 0.07, k ? 1.52 : 1.95, Math.cos(psi) * 0.07);
        _o.quaternion.copy(_qy).multiply(_qx);
        _o.scale.set(...(show ? ONE : TINY));
        _o.updateMatrix();
        cv.setMatrixAt(2 * i + k, _o.matrix);
        cv.setColorAt(2 * i + k, _col);
      }
    }
    r.instanceMatrix.needsUpdate = true;
    cv.instanceMatrix.needsUpdate = true;
    if (cv.instanceColor) cv.instanceColor.needsUpdate = true;
  });
  return (
    <>
      <instancedMesh ref={rods} args={[GEO.box, MAT.steel, PT_N * 2]} frustumCulled={false} />
      <instancedMesh ref={covers} args={[PART.cover, PM.paint, PT_N * 2]} castShadow frustumCulled={false} />
    </>
  );
}

function PaintLine({ color, state, running }: MachineProps) {
  return (
    <group>
      <Sets list={PT_SETS} />
      {ROBOTS.map((x, i) => (
        <group key={x} position={[x, 0.35, -1.05]} rotation={[0, -PI / 2, 0]}>
          <RobotArm pos={[0, 0, 0]} running={running} scale={0.95} color="#ffd56b" phase={i * 1.4} />
        </group>
      ))}
      {running && <Many geo={GEO.ball} mat={M.mist} items={PT_MIST} colors={['#6d9be6', '#f2f6ff']} />}
      {PT_ZONES.map((x) => (
        <HeatPanel key={x} size={[1.6, 0.9, 0.03]} pos={[x, 1.5, 1.265]} state={state} />
      ))}
      <Stripe size={[5.82, 0.12, 2.52]} pos={[4.9, 0.3, 0]} color={color} />
      <PtJigs running={running} />
    </group>
  );
}

// ─────────── 진공 증착기 ───────────
// 가로 원통 챔버(앞쪽 둥근 문 + 큰 관찰창) 안에서 리플렉터 24개를 건 랙이 돈다.
// 오른쪽: 고진공 밸브·확산 펌프, 루츠·로터리 펌프, 러핑 배관 · 앞: HMDSO 공급, 조작 데스크 · 왼쪽: RF 전원, 다음 배치 랙 대차

const VX = -0.25; // 챔버 축
const VY = 1.5;
const VZ = -0.4;
const VR = 1.05;
const FORE: V3[] = [
  [1.8, 0.86, -1.38],
  [1.8, 2.78, -1.38],
  [VX, 2.78, -1.38],
  [VX, 2.5, -1.38],
];
const HMDSO: V3[] = [
  [1.15, 1.34, 0.5],
  [1.15, 1.95, 0.5],
  [0.72, 1.95, 0.5],
];
const RF_CABLE: V3[] = [
  [-1.75, 1.9, -1.3],
  [-1.75, 2.35, -1.3],
  [-0.95, 2.35, -1.0],
];
/** 랙 위 리플렉터 (반지름 R, 축 방향 z 위치들, 크기 sc). 오목면이 가운데 필라멘트를 본다 */
function rackParts(R: number, zs: number[], sc: number, cx = 0, cy = 0, cz = 0): Item[] {
  const out: Item[] = [];
  const qy = new THREE.Quaternion().setFromAxisAngle(UP, PI / 2);
  const qz = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  for (let k = 0; k < 8; k++) {
    const phi = (k / 8) * PI * 2;
    qz.setFromAxisAngle(zAxis, phi + PI / 2).multiply(qy);
    _e.setFromQuaternion(qz);
    for (const z of zs) out.push([[cx + R * Math.cos(phi), cy + R * Math.sin(phi), cz + z], [sc, sc, sc], [_e.x, _e.y, _e.z]]);
  }
  return out;
}
const spindles = (R: number, len: number, cx = 0, cy = 0, cz = 0) =>
  Array.from({ length: 8 }, (_, k) => c([cx + R * Math.cos((k / 8) * PI * 2), cy + R * Math.sin((k / 8) * PI * 2), cz], 0.016, len, 'z'));
const CART: V3 = [-1.95, 1.12, 1.05]; // 대차 위 예비 랙 중심

const VM_SETS: SetDef[] = [
  {
    g: GEO.box,
    m: MAT.frame,
    items: [
      b([VX, 0.04, VZ], [2.4, 0.08, 2.5]), // 받침 스키드
      b([VX, 0.3, -1.1], [1.7, 0.6, 0.28]), // 새들
      b([VX, 0.3, 0.3], [1.7, 0.6, 0.28]),
      b([VX - 1.1, VY, 0.85], [0.12, 0.6, 0.18]), // 문 힌지
      b([CART[0], 0.2, CART[2]], [0.9, 0.06, 1.2]), // 대차
      b([CART[0], 0.72, 0.5], [0.08, 1.0, 0.08]),
      b([CART[0], 0.72, 1.6], [0.08, 1.0, 0.08]),
      b([2.35, 1.5, -1.65], [0.05, 3.0, 0.05]), // 경광등 기둥
    ],
    cast: true,
  },
  {
    g: GEO.cyl,
    m: MAT.steel,
    items: [
      c([1.05, 1.5, -0.75], 0.26, 0.55, 'x'), // 고진공 덕트
      c([CART[0], CART[1], CART[2]], 0.03, 1.15, 'z'), // 예비 랙 축
      ...spindles(0.42, 1.05, ...CART),
    ],
    cast: true,
  },
  {
    g: GEO.cyl,
    m: MAT.bodyDark,
    items: [
      c([1.55, 0.12, -0.75], 0.31, 0.24), // 확산 펌프 히터
      c([2.33, 0.22, -1.38], 0.15, 0.24, 'x'), // 로터리 펌프 모터
      c([2.17, 0.65, -1.38], 0.12, 0.24, 'x'), // 루츠 펌프 모터
    ],
  },
  {
    g: GEO.cyl,
    m: M.stainless,
    items: [
      c([VX, VY, VZ - 1.19], 1.06, 0.08, 'z'), // 뒤 덮개
      c([1.55, 0.72, -0.75], 0.27, 0.95), // 확산 펌프
      c([1.15, 1.12, 0.5], 0.13, 0.44), // HMDSO 탱크
    ],
    cast: true,
  },
  { g: GEO.cyl, m: M.copper, items: [0.35, 0.5, 0.65, 0.8, 0.95].map((y) => c([1.55, y, -0.75], 0.285, 0.035)) },
  {
    g: GEO.ring,
    m: MAT.bodyDark,
    items: [
      rg([VX, VY, 0.76], 1.08), // 앞 플랜지
      rg([VX, VY, -1.2], 1.06),
      rg([VX, VY, -0.4], 1.06),
      rg([VX, VY, 0.95], 0.62), // 관찰창 테
      rg([CART[0], CART[1], CART[2] + 0.52], 0.42),
      rg([CART[0], CART[1], CART[2] - 0.52], 0.42),
    ],
  },
  {
    g: GEO.box,
    m: MAT.bodyDark,
    items: [
      b([1.55, 1.5, -0.75], [0.46, 0.6, 0.6]), // 고진공 밸브
      b([0.8, 2.78, -1.38], [0.24, 0.24, 0.24]), // 러핑 밸브
      b([-1.95, 0.6, -1.14], [0.6, 0.5, 0.02]), // RF 캐비닛 통풍구
      b([1.95, 1.2, 1.08], [0.6, 0.42, 0.05]), // 모니터
      ...Array.from({ length: 8 }, (_, k) => {
        const a = (k / 8) * PI * 2 + PI / 8;
        return b([VX + Math.cos(a) * 0.95, VY + Math.sin(a) * 0.95, 0.95], [0.12, 0.06, 0.06], [0, 0, a]); // 문 클램프
      }),
    ],
  },
  {
    g: GEO.box,
    m: MAT.body,
    items: [
      b([1.85, 0.22, -1.38], [0.72, 0.44, 0.42]), // 로터리 펌프
      b([1.8, 0.65, -1.38], [0.5, 0.42, 0.38]), // 루츠 펌프
      b([-1.95, 0.95, -1.45], [0.9, 1.9, 0.6]), // RF 전원
      b([1.15, 0.45, 0.5], [0.45, 0.9, 0.4]), // 가스 캐비닛
      b([1.95, 0.45, 1.25], [0.9, 0.9, 0.55]), // 조작 데스크
    ],
    cast: true,
  },
  { g: GEO.box, m: MAT.screen, items: [b([1.95, 1.2, 1.11], [0.52, 0.34, 0.01]), b([-1.95, 1.45, -1.14], [0.35, 0.22, 0.01])] },
  {
    g: GEO.pipe,
    m: MAT.steel,
    items: [...pipeline(FORE, 0.09), tube([1.6, 0.65, -1.02], [1.6, 0.65, -1.2], 0.06), ...pipeline(HMDSO, 0.022)],
    cast: true,
  },
  { g: GEO.ball, m: MAT.steel, items: [...elbows(FORE, 0.09), ...elbows(HMDSO, 0.022)] },
  { g: GEO.pipe, m: MAT.rubber, items: pipeline(RF_CABLE, 0.04) },
  { g: GEO.cyl, m: MAT.rubber, items: [-1, 1].flatMap((sx) => [0.55, 1.55].map((z) => c([CART[0] + sx * 0.35, 0.09, z], 0.09, 0.06, 'x'))) },
  { g: PART.refl, m: PM.bmc, items: rackParts(0.36, [-0.34, 0, 0.34], 0.5, ...CART) }, // 다음 배치 (증착 전)
];
const RACK_SPINDLES: Item[] = [...spindles(0.62, 1.9), c([0, 0, 0.95], 0.02, 1.24, 'x'), c([0, 0, 0.95], 0.02, 1.24), c([0, 0, -0.95], 0.02, 1.24, 'x'), c([0, 0, -0.95], 0.02, 1.24)];
const RACK_RINGS: Item[] = [rg([0, 0, 0.95], 0.62), rg([0, 0, -0.95], 0.62)];
const RACK_PARTS = rackParts(0.54, [-0.6, 0, 0.6], 0.75);
const FILAMENT: Item[] = [c([VX, VY, VZ], 0.025, 1.9, 'z'), ...[-0.72, -0.36, 0, 0.36, 0.72].map((z) => c([VX, VY, VZ + z], 0.055, 0.08, 'z'))];

function Metallizer({ color, running }: MachineProps) {
  const rack = useRef<THREE.Group>(null);
  const plasmaMesh = useRef<THREE.Mesh>(null);
  const run = useRef(running);
  run.current = running;
  const tm = useRef(0);
  // 증발(필라멘트 발광)·플라즈마는 이 설비만의 상태라 재질을 따로 둔다
  const fil = useMemo(() => std('#ffe2b8', 0.2, 0.4, { emissive: new THREE.Color('#ffb060'), emissiveIntensity: 0 }), []);
  const plasma = useMemo(() => std('#b48cff', 0, 1, { transparent: true, opacity: 0, emissive: new THREE.Color('#9d6bff'), emissiveIntensity: 1.6, depthWrite: false }), []);
  useFrame((_, dt) => {
    const on = run.current;
    if (on) {
      tm.current += dt;
      if (rack.current) rack.current.rotation.z += dt * 0.5;
    }
    // 한 배치(약 24분)를 16초로: 펌프다운 → Al 증발 → HMDSO 플라즈마 탑코트 → 벤트
    const p = frac(tm.current / 16);
    const evap = on ? seg(p, 0.3, 0.33) - seg(p, 0.42, 0.45) : 0;
    const pl = on ? seg(p, 0.5, 0.53) - seg(p, 0.72, 0.75) : 0;
    fil.emissiveIntensity = evap * (3.5 + Math.sin(tm.current * 23) * 0.4);
    plasma.opacity = pl * (0.2 + 0.05 * Math.sin(tm.current * 9));
    if (plasmaMesh.current) plasmaMesh.current.visible = pl > 0.01;
  });
  return (
    <group>
      <Sets list={VM_SETS} />
      {/* 챔버: 바깥 원통 + 안쪽 라이너(안에서 보이는 면) */}
      <M1 g={GEO.shell} m={M.stainless} p={[VX, VY, VZ]} s={[VR, 2.3, VR]} r={[PI / 2, 0, 0]} />
      <M1 g={GEO.cyl} m={M.inner} p={[VX, VY, VZ]} s={[VR - 0.05, 2.26, VR - 0.05]} r={[PI / 2, 0, 0]} cast={false} />
      {/* 문: 테 + 앞판(가운데 뚫림) + 관찰창 + 손잡이 */}
      <M1 g={GEO.shell} m={MAT.bodyLight} p={[VX, VY, 0.84]} s={[1.07, 0.16, 1.07]} r={[PI / 2, 0, 0]} />
      <M1 g={GEO.annulus} m={MAT.bodyLight} p={[VX, VY, 0.92]} s={[1.07, 1.07, 1]} cast={false} />
      <M1 g={GEO.disc} m={MAT.glass} p={[VX, VY, 0.9]} s={[0.62, 0.62, 1]} cast={false} />
      <M1 m={MAT.safety} p={[VX + 0.85, VY, 0.97]} s={[0.06, 0.3, 0.08]} cast={false} />
      <M1 g={GEO.cyl} m={MAT.safety} p={[1.55, 1.98, -0.75]} s={[0.09, 0.36, 0.09]} />
      {/* 회전 랙 (리플렉터 24개) */}
      <group ref={rack} position={[VX, VY, VZ]}>
        <Many geo={GEO.cyl} mat={MAT.steel} items={RACK_SPINDLES} />
        <Many geo={GEO.ring} mat={MAT.steel} items={RACK_RINGS} />
        <Many geo={PART.refl} mat={PM.alu} items={RACK_PARTS} />
      </group>
      {/* 증발원 필라멘트 · 플라즈마 */}
      <Many geo={GEO.cyl} mat={fil} items={FILAMENT} />
      <mesh ref={plasmaMesh} geometry={GEO.cyl} material={plasma} position={[VX, VY, VZ]} scale={[0.85, 2.0, 0.85]} rotation={[PI / 2, 0, 0]} visible={false} />
      <Stripe size={[0.91, 0.07, 0.56]} pos={[1.95, 0.8, 1.25]} color={color} />
    </group>
  );
}

// ─────────── 설비 고르기 ───────────

export function MoldingMachine(props: MachineProps) {
  const { def } = props;
  const [L, D, H] = FOOTPRINT[def.kind];
  switch (def.kind) {
    case 'dryer':
      return <Dryer {...props} />;
    case 'injection':
      return <Injection {...props} />;
    case 'tunnel-hardcoat':
      return <Hardcoat {...props} />;
    case 'tunnel-paint':
      return <PaintLine {...props} />;
    case 'metallizer':
      return <Metallizer {...props} />;
    default:
      return <M1 m={MAT.body} p={[0, H / 2, 0]} s={[L, H, D]} />;
  }
}

// ─────────── 부위 이름표 ───────────

const IM_NOTES: Record<string, { feed: [string, string]; barrel: [string, string]; mold: [string, string]; clamp: string; robot: string; tcu: [string, string] }> = {
  'HL-IM-L1': {
    feed: ['호퍼·로더', '옆 제습 건조기에서 진공으로 보낸 마른 PC 레진이 여기로 들어온다'],
    barrel: ['배럴·히터 밴드', '히터 밴드가 배럴을 약 300 °C로 데우고, 스크루가 레진을 녹여 금형으로 밀어 넣는다'],
    mold: ['금형 (렌즈)', '녹은 PC를 채우고 보압으로 눌러 투명 렌즈로 굳힌다. 금형이 차면 잔류응력이 남는다'],
    clamp: '토글 링크가 펴지며 650 t로 금형을 닫고, 타이바 4개가 그 힘을 버틴다',
    robot: '금형이 열리면 내려가 렌즈를 흡착해 꺼내고, 눕혀서 출구 컨베이어에 놓는다',
    tcu: ['금형 온조기', '100 °C 안팎의 물을 금형에 돌려 온도를 지킨다. 낮으면 렌즈에 잔류응력이 남아 코팅 크랙이 난다'],
  },
  'HL-IM-R1': {
    feed: ['BMC 스터퍼', '반죽 같은 BMC를 유압 피스톤이 눌러 스크루로 밀어 넣는다 (알갱이가 아니라 호퍼 대신 쓴다)'],
    barrel: ['배럴 (냉각 재킷)', '열경화 재료라 배럴은 미지근하게 식혀 두고, 굳는 것은 뜨거운 금형 안에서다'],
    mold: ['금형 (리플렉터)', '약 150 °C 금형 안에서 30~40초 동안 BMC가 굳어 리플렉터가 된다. 표면이 매끄러워야 증착이 잘 된다'],
    clamp: '토글이 금형을 닫아 성형 압력을 버틴다',
    robot: '굳은 리플렉터를 꺼내 진공 증착으로 가는 컨베이어에 놓는다',
    tcu: ['금형 히터 제어반', '금형 속 전기 히터를 켜고 꺼 150 °C를 지킨다'],
  },
  'HL-IM-H1': {
    feed: ['호퍼·로더', 'PP-TD 레진 알갱이를 진공 로더가 빨아올려 호퍼에 채운다'],
    barrel: ['배럴·히터 밴드', '히터 밴드가 배럴을 약 220 °C로 데우고, 스크루가 레진을 녹여 밀어 넣는다'],
    mold: ['금형 (하우징)', '큰 하우징 금형. 식는 속도가 고르지 않으면 렌즈와 붙는 플랜지가 휜다'],
    clamp: '850 t 형체력으로 큰 금형을 닫는다. 타이바 4개가 그 힘을 버틴다',
    robot: '하우징을 꺼내 뒤집어 출구 컨베이어에 놓는다',
    tcu: ['금형 온조기', '45 °C 안팎의 물로 금형을 식힌다. 냉각 시간이 휨을 좌우한다'],
  },
  'OSM-IM-C1': {
    feed: ['호퍼 드라이어', '사출기 위에서 ASA 레진을 바로 말린다. 이슬점이 높으면 은줄이 생긴다'],
    barrel: ['배럴·히터 밴드', '히터 밴드가 배럴을 약 250 °C로 데우고, 스크루가 레진을 녹여 밀어 넣는다'],
    mold: ['2캐비티 금형', '한 번에 좌·우 커버 두 개를 뽑는다. 고광택이라 금형을 70 °C로 데워 쓴다'],
    clamp: '토글이 금형을 닫고 타이바 4개가 형체력을 버틴다',
    robot: '좌·우 커버를 한 번에 흡착해 꺼낸다',
    tcu: ['금형 온조기', '70 °C 안팎의 물을 돌린다. 낮으면 웰드라인이 보이고 광택이 떨어진다'],
  },
  'OSM-IM-B1': {
    feed: ['호퍼 드라이어', 'PA6-GF30을 80 °C로 말린다. 젖은 나일론은 은줄이 생기고 약해진다'],
    barrel: ['배럴·히터 밴드', '히터 밴드가 배럴을 약 270 °C로 데우고, 스크루가 레진을 녹여 밀어 넣는다'],
    mold: ['금형 (브래킷)', '작은 브래킷 4개를 한 번에 뽑는다. 금형 85 °C가 결정화를 도와 휨을 막는다'],
    clamp: '작은 형체 유닛. 토글이 금형을 닫는다',
    robot: '브래킷 묶음(런너 포함)을 꺼내 컨베이어에 놓는다',
    tcu: ['금형 온조기', '80~90 °C 물을 돌려 금형 온도를 지킨다. 낮으면 브래킷이 휜다'],
  },
};

/** 고른 설비의 부위 이름표 (설비 원점 기준 좌표) */
export function moldingCallouts(def: StationDef): Callout[] {
  switch (def.kind) {
    case 'dryer':
      return [
        { text: '건조 호퍼', at: [DX, 2.85, DZ], note: '레진을 120 °C 마른 공기 속에 2~3시간 머물게 해 수분을 0.02 % 이하로 뺀다' },
        { text: '제습 유닛', at: [0.5, 1.95, -0.1], note: '제습 로터가 공기의 수분을 빨아들여 이슬점 -40 °C의 마른 공기를 만들고 데운다' },
        { text: '건조 공기 호스', at: [0.05, 2.75, -0.3], note: '마른 열풍을 호퍼 아래로 넣고, 레진을 지나며 젖은 공기를 위에서 되돌려 받는다' },
        { text: '레진 이송관', at: [0.75, 2.55, 0.68], note: '다 마른 레진을 진공으로 렌즈 사출기 호퍼까지 보낸다' },
      ];
    case 'injection': {
      const Lo = imLayout(def);
      const { W, cfg } = Lo;
      const n = IM_NOTES[def.code] ?? IM_NOTES['HL-IM-H1'];
      return [
        { text: n.feed[0], at: W(HOP_X, cfg.feed === 'stuffer' ? 2.8 : 2.95, 0), note: n.feed[1] },
        { text: n.barrel[0], at: W(-1.31, YC + 0.3, 0), note: n.barrel[1] },
        { text: n.mold[0], at: W(XM, YC + cfg.mh / 2 + 0.12, 0.2), note: n.mold[1] },
        { text: '타이바·토글', at: W(1.25, YC + 0.75, 0.55), note: n.clamp },
        { text: '취출 로봇', at: W(Lo.xPick, Y_UP + 0.65, -0.2), note: n.robot },
        { text: n.tcu[0], at: [Lo.xT, 1.1, 1.0], note: n.tcu[1] },
      ];
    }
    case 'tunnel-hardcoat':
      return [
        { text: '행거 컨베이어', at: [-7.45, 2.6, 0], note: '렌즈를 걸어 클린룸·경화로·검사대를 차례로 지나게 한다. 한 바퀴에 약 45분' },
        { text: '클린룸·FFU', at: [-5.0, 3.2, 0.62], note: '천장 FFU가 거른 공기를 내려보내 먼지가 코팅에 붙지 않게 한다 (ISO 7급 가정)' },
        { text: '플로우 코팅', at: [-3.75, 1.8, 0.3], note: '이온 바람으로 먼지를 턴 렌즈 위로 노즐이 프라이머와 실록산 하드코트를 흘려 덮는다. 남은 액은 아래 통으로 돌아간다' },
        { text: '플래시오프', at: [-1.55, 1.95, 0.55], note: '오븐에 들어가기 전에 용제를 천천히 날려 기포·흐름 자국을 막는다' },
        { text: '열경화로', at: [2.8, 3.5, -0.35], note: '130 °C에서 45분 동안 하드코트를 굳힌다. 렌즈에 잔류응력이 있으면 여기서 크랙이 난다' },
        { text: '출구 외관 검사', at: [7.1, 2.05, -0.55], note: '뒤에서 밝은 빛을 비춰 이물·크랙·흐름을 눈으로 본다' },
      ];
    case 'tunnel-paint':
      return [
        { text: '행거·스핀들 지그', at: [-8.5, 2.5, 0], note: '지그에 커버를 걸면 위 컨베이어가 끌고 가고, 부스 안에서는 지그가 돌아 구석까지 칠한다' },
        { text: '전처리 터널', at: [-6.45, 2.85, 0.6], note: '세척·건조로 이형제와 먼지를 지워 도료가 잘 붙게 한다' },
        { text: '도장 로봇 (베이스)', at: [ROBOTS[0], 2.75, -1.05], note: '정전 회전 벨로 베이스 색을 15~20 µm 칠한다' },
        { text: '도장 로봇 (클리어)', at: [ROBOTS[1], 2.75, -1.05], note: '베이스가 마르기 전에 클리어를 35~45 µm 덮는다 (웨트온웨트)' },
        { text: '플래시오프', at: [0.9, 2.85, 0.6], note: '용제를 날려 핀홀·흐름을 막는다. 부스 습도가 높으면 핀홀이 는다' },
        { text: '건조로', at: [4.9, 3.0, 0.6], note: '125 °C 열풍으로 베이스와 클리어를 한꺼번에 굳힌다' },
      ];
    case 'metallizer':
      return [
        { text: '진공 챔버', at: [VX, 2.8, VZ], note: '리플렉터 24개를 넣고 0.2 Pa까지 공기를 뺀 뒤 알루미늄을 증착한다. 한 배치 약 24분' },
        { text: '회전 랙', at: [VX, VY + 0.75, 1.0], note: '랙이 도는 동안 가운데 필라멘트에서 증발한 알루미늄이 리플렉터에 약 60 nm 쌓인다' },
        { text: '진공 펌프', at: [1.65, 2.25, -0.95], note: '로터리·루츠 펌프가 먼저 빼고 확산 펌프가 고진공을 만든다. 펌프다운 약 9분' },
        { text: 'HMDSO 공급', at: [1.15, 1.6, 0.5], note: 'Al 위에 HMDSO 플라즈마 보호막을 30~40초 입힌다. 1분을 넘기면 백화가 생긴다' },
        { text: 'RF 전원', at: [-1.95, 2.1, -1.45], note: '고주파로 챔버 안에 플라즈마를 켜 HMDSO를 막으로 바꾼다' },
        { text: '랙 대차', at: [CART[0], 1.75, CART[2]], note: '다음 배치 리플렉터 24개를 미리 걸어 두었다가 챔버의 랙과 바꿔 넣는다' },
      ];
    default:
      return [];
  }
}
