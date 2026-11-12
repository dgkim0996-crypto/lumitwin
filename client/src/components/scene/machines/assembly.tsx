'use client';

// 조립·검사·포장 설비: 조립 셀(램프·미러), 액추에이터 조립 셀, 하우징 체결 셀, 실링기, 리크 검사기, 배광 검사기,
// EOL 검사기(램프·BMS), 미러 기능 검사기, 포장 셀 (세 라인의 뒷단)
// 정지 부품은 재질·모양이 같은 것끼리 InstancedMesh 하나로 모아 그린다(Kit). 움직이는 부분(로봇·프레스·폴딩)만 따로 메시다.
// 제품은 컨베이어 높이(BELT_TOP)의 작업 팰릿 위에 놓이고 -x에서 들어와 +x로 나간다. 작업자 쪽은 +z(앞).
import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import type { EquipmentKind, StationDef } from '@lumitwin/shared';
import { Box, Cyl, MAT, std, Stripe } from '../parts';
import { BELT_TOP, type Callout, FOOTPRINT, type MachineProps, type V3 } from './common';

export const ASSEMBLY_KINDS = [
  'assembly-cell',
  'actuator-cell',
  'screw-cell',
  'sealer',
  'leak-tester',
  'photometry',
  'eol-tester',
  'function-tester',
  'packer',
] as const satisfies readonly EquipmentKind[];

const PI = Math.PI;
const BT = BELT_TOP;
/** 팰릿 지그 윗면 (제품이 앉는 높이) */
const PT = BT + 0.075;
const sm = (x: number) => x * x * (3 - 2 * x);

// ─────────── 재질 (모듈에서 한 번만 만든다) ───────────

const glow = (c: string, e: string, k: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
  std(c, 0, 0.35, { emissive: new THREE.Color(e), emissiveIntensity: k, ...extra });

const M = {
  housing: std('#262a31', 0.1, 0.7), // PP 하우징
  chrome: std('#e4eaf0', 0.55, 0.16), // 증착 리플렉터
  lens: std('#d8eeff', 0.05, 0.05, { transparent: true, opacity: 0.38 }),
  ledOff: std('#cfd5dc', 0.3, 0.35),
  lit: glow('#fffaf0', '#fff3d1', 2.6),
  amberOff: std('#9a5c1c', 0.2, 0.45),
  amber: glow('#ffb43a', '#ff9a10', 2.6),
  pcb: std('#1f6a3d', 0.1, 0.55),
  alu: std('#b9c1ca', 0.7, 0.32),
  cover: std('#a3212c', 0.4, 0.32), // 도장 커버
  mirror: std('#dfe8f1', 0.6, 0.06),
  pa: std('#2d3137', 0.05, 0.75), // PA6-GF 브래킷
  pom: std('#e8e3d6', 0, 0.6), // 지그 블록
  grease: std('#e2a52b', 0.1, 0.35),
  hotmelt: std('#f2dc9a', 0.1, 0.45),
  hose: std('#2a2e35', 0.2, 0.8),
  tube: std('#2d7fd3', 0.1, 0.5), // 공압 튜브
  robot: std('#e5762b', 0.35, 0.45), // 산업용 로봇
  cobot: std('#eef1f4', 0.2, 0.45),
  joint: std('#3b4a5f', 0.4, 0.45),
  foam: std('#4b525c', 0, 1), // 흡음재
  booth: std('#8592a3', 0.2, 0.7),
  black: std('#0b0d11', 0, 0.95), // 암실 안쪽
  screenW: std('#a7a8a4', 0, 0.95), // 배광 스크린 (암실이라 어둡게)
  beam: glow('#fff2c4', '#ffeeb8', 1.5),
  hot: glow('#ffffff', '#fffbe8', 3.4),
  beamVol: std('#fff1c8', 0, 1, { transparent: true, opacity: 0.1, emissive: new THREE.Color('#fff1c8'), emissiveIntensity: 0.6, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  esd: std('#1c1e22', 0.1, 0.8), // ESD 트레이
  label: std('#f4f4ef', 0, 0.7),
  red: std('#c92a2a', 0.1, 0.5),
  redLit: glow('#ff4a4a', '#ff2020', 2.4),
  laser: glow('#ff3030', '#ff1a1a', 2.5),
  green: glow('#3ddc84', '#28c76f', 1.2),
  tint: std('#1b2430', 0.1, 0.1, { transparent: true, opacity: 0.3 }), // 암실 창
  guard: std('#cfe6ff', 0.1, 0.1, { transparent: true, opacity: 0.13 }), // 폴리카보네이트 덮개
  pail: std('#d9b21a', 0.2, 0.5), // 그리스 페일
  mesh: std('#8d98a8', 0.3, 0.6, { transparent: true, opacity: 0.2, depthWrite: false }), // 펜스 철망
  beamDim: glow('#f3e2b0', '#ffe7a6', 0.8),
};

// ─────────── Kit: 정지 부품을 재질별 InstancedMesh로 모은다 ───────────

type Geo = 'box' | 'cyl' | 'sph';
const GEO: Record<Geo, THREE.BufferGeometry> = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 18),
  sph: new THREE.SphereGeometry(0.5, 14, 10),
};
interface Batch {
  geo: Geo;
  mat: THREE.Material;
  cast: boolean;
  list: THREE.Matrix4[];
}
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);

function trs(p: V3, r: V3 | undefined, s: V3) {
  _e.set(r?.[0] ?? 0, r?.[1] ?? 0, r?.[2] ?? 0);
  return new THREE.Matrix4().compose(_p.set(p[0], p[1], p[2]), _q.setFromEuler(_e), _s.set(s[0], s[1], s[2]));
}

class Kit {
  readonly batches = new Map<string, Batch>();
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  private top() {
    return this.stack[this.stack.length - 1];
  }
  /** 로컬 좌표계(위치·회전) 안에서 그린다 */
  at(p: V3, r: V3 | undefined, draw: () => void) {
    this.stack.push(this.top().clone().multiply(trs(p, r, [1, 1, 1])));
    draw();
    this.stack.pop();
  }
  put(geo: Geo, mat: THREE.Material, m: THREE.Matrix4, big: boolean, cast?: boolean) {
    const c = !mat.transparent && (cast ?? big);
    const key = `${geo}:${mat.uuid}:${c ? 1 : 0}`;
    let b = this.batches.get(key);
    if (!b) this.batches.set(key, (b = { geo, mat, cast: c, list: [] }));
    b.list.push(this.top().clone().multiply(m));
  }
  box(mat: THREE.Material, s: V3, p: V3, r?: V3, cast?: boolean) {
    this.put('box', mat, trs(p, r, s), Math.max(s[0], s[1], s[2]) > 0.3, cast);
  }
  cyl(mat: THREE.Material, rad: number, h: number, p: V3, r?: V3, cast?: boolean) {
    this.put('cyl', mat, trs(p, r, [rad * 2, h, rad * 2]), Math.max(rad * 2, h) > 0.3, cast);
  }
  /** 타원 원판·납작 원통 (지름을 축마다 따로) */
  disc(mat: THREE.Material, s: V3, p: V3, r?: V3) {
    this.put('cyl', mat, trs(p, r, s), false, false);
  }
  sph(mat: THREE.Material, rad: number, p: V3, cast?: boolean) {
    this.put('sph', mat, trs(p, undefined, [rad * 2, rad * 2, rad * 2]), rad > 0.15, cast);
  }
  /** 여러 점을 잇는 관 (호스·케이블·배관) */
  pipe(mat: THREE.Material, rad: number, pts: V3[]) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const len = d.length();
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2),
        new THREE.Quaternion().setFromUnitVectors(_up, d.normalize()),
        new THREE.Vector3(rad * 2, len, rad * 2),
      );
      this.put('cyl', mat, m, false, false);
      if (i < pts.length - 1) this.sph(mat, rad, b, false);
    }
  }
}

function kitOf(build: (k: Kit) => void) {
  const k = new Kit();
  build(k);
  return k;
}

function Batched({ b }: { b: Batch }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    b.list.forEach((x, i) => m.setMatrixAt(i, x));
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
    return () => m.dispose();
  }, [b]);
  // 공용 도형·재질은 다른 설비도 쓰므로 R3F가 지우지 않게 한다 (dispose={null})
  return <instancedMesh ref={ref} args={[GEO[b.geo], b.mat, b.list.length]} castShadow={b.cast} receiveShadow dispose={null} />;
}

function KitMesh({ kit }: { kit: Kit }) {
  return (
    <>
      {[...kit.batches].map(([key, b]) => (
        <Batched key={key} b={b} />
      ))}
    </>
  );
}

// ─────────── 움직이는 부분 (가동 중에만) ───────────

type PathFn = (u: number, out: THREE.Vector3) => void;
type Tool = 'grip' | 'screw' | 'nozzle' | 'vacuum';
/** 손목 중심에서 공구 끝까지 (로봇 크기 1 기준) */
const TOOL_LEN: Record<Tool, number> = { grip: 0.27, screw: 0.37, nozzle: 0.3, vacuum: 0.2 };

/**
 * 정지점을 차례로 도는 경로 (집기 → 놓기 …). 로봇 축을 중심으로 각도·반경·높이를 보간해 팔이 몸통을 가로지르지 않는다.
 * 정지점에서는 살짝 내려갔다 올라오고(집기·놓기), 옮길 때는 들어 올린다
 */
function stopsPath(base: V3, stops: V3[], lift = 0.18, dwell = 0.42): PathFn {
  const cyl = stops.map(([x, y, z]) => ({ a: Math.atan2(z - base[2], x - base[0]), r: Math.hypot(x - base[0], z - base[2]), y }));
  const n = stops.length;
  const ha = 0.07;
  return (u, o) => {
    const f = u * n;
    const i = Math.floor(f) % n;
    const g = f - Math.floor(f);
    const A = cyl[i];
    const B = cyl[(i + 1) % n];
    let s = 0;
    let h: number;
    if (g < dwell) h = ha * (1 - Math.sin((g / dwell) * PI));
    else {
      const m = (g - dwell) / (1 - dwell);
      s = sm(m);
      h = ha + lift * Math.sin(m * PI);
    }
    let da = B.a - A.a;
    while (da > PI) da -= 2 * PI;
    while (da < -PI) da += 2 * PI;
    const a = A.a + da * s;
    const r = A.r + (B.r - A.r) * s;
    o.set(base[0] + Math.cos(a) * r, A.y + (B.y - A.y) * s + h, base[2] + Math.sin(a) * r);
  };
}

function ToolHead({ tool }: { tool: Tool }) {
  switch (tool) {
    case 'grip':
      return (
        <group>
          <Box size={[0.11, 0.07, 0.08]} pos={[0, 0.17, 0]} mat={MAT.bodyDark} />
          <Box size={[0.018, 0.07, 0.04]} pos={[-0.035, 0.235, 0]} mat={MAT.steel} cast={false} />
          <Box size={[0.018, 0.07, 0.04]} pos={[0.035, 0.235, 0]} mat={MAT.steel} cast={false} />
        </group>
      );
    case 'screw':
      return (
        <group>
          <Cyl r={0.036} h={0.14} pos={[0, 0.2, 0]} mat={MAT.bodyDark} seg={14} />
          <Cyl r={0.01} h={0.1} pos={[0, 0.32, 0]} mat={MAT.steel} seg={8} />
        </group>
      );
    case 'nozzle':
      return (
        <group>
          <Box size={[0.08, 0.1, 0.08]} pos={[0, 0.18, 0]} mat={MAT.steel} />
          <Cyl r={0.022} rTop={0.01} h={0.07} pos={[0, 0.265, 0]} mat={MAT.bodyDark} seg={10} />
        </group>
      );
    case 'vacuum':
      return (
        <group>
          <Box size={[0.17, 0.025, 0.12]} pos={[0, 0.15, 0]} mat={MAT.bodyDark} />
          <Cyl r={0.024} h={0.035} pos={[-0.05, 0.18, 0]} mat={MAT.rubber} seg={10} />
          <Cyl r={0.024} h={0.035} pos={[0.05, 0.18, 0]} mat={MAT.rubber} seg={10} />
        </group>
      );
  }
}

/**
 * 6축 로봇 팔. path가 주는 공구 끝 목표점을 역기구학(어깨·팔꿈치 2링크 + 선회)으로 따라가고, 공구는 늘 아래를 향한다.
 * base는 받침대 윗면 (설비 좌표). ind면 산업용(주황, 각진 팔), 아니면 협동로봇(흰색, 둥근 팔)
 */
function Robot({ base, path, period, running, phase = 0, sz = 1, tool = 'grip', ind = false }: { base: V3; path: PathFn; period: number; running: boolean; phase?: number; sz?: number; tool?: Tool; ind?: boolean }) {
  const yaw = useRef<THREE.Group>(null);
  const sh = useRef<THREE.Group>(null);
  const el = useRef<THREE.Group>(null);
  const wr = useRef<THREE.Group>(null);
  const run = useRef(running);
  run.current = running;
  const t = useRef(phase * period);
  const posed = useRef(false);
  const tgt = useMemo(() => new THREE.Vector3(), []);
  const l1 = 0.5;
  const l2 = 0.45;
  const hs = ind ? 0.42 : 0.3;
  useFrame((_, dt) => {
    if (!yaw.current || !sh.current || !el.current || !wr.current) return;
    if (!run.current && posed.current) return;
    if (run.current) t.current += dt;
    posed.current = true;
    path((((t.current / period) % 1) + 1) % 1, tgt);
    const L1 = l1 * sz;
    const L2 = l2 * sz;
    const x = tgt.x - base[0];
    const z = tgt.z - base[2];
    const r = Math.max(0.05, Math.hypot(x, z));
    const dy = tgt.y + TOOL_LEN[tool] * sz - base[1] - hs * sz;
    const d = Math.min(L1 + L2 - 0.002, Math.max(Math.abs(L1 - L2) + 0.01, Math.hypot(r, dy)));
    const phi = Math.atan2(dy, r);
    const beta = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))));
    const a1 = phi + beta;
    const a2 = Math.atan2(Math.sin(phi) * d - L1 * Math.sin(a1), Math.cos(phi) * d - L1 * Math.cos(a1));
    yaw.current.rotation.y = Math.atan2(-z, x);
    sh.current.rotation.z = a1 - PI / 2;
    el.current.rotation.z = a2 - a1;
    wr.current.rotation.z = -PI / 2 - a2;
  });
  const body = ind ? M.robot : M.cobot;
  const jm = ind ? MAT.bodyDark : M.joint;
  return (
    <group position={base} scale={sz}>
      {ind ? <Box size={[0.42, 0.12, 0.42]} pos={[0, 0.06, 0]} mat={body} /> : <Cyl r={0.085} h={0.1} pos={[0, 0.05, 0]} mat={jm} seg={16} />}
      <group ref={yaw} position={[0, 0.1, 0]}>
        {ind ? <Box size={[0.32, 0.3, 0.34]} pos={[0, 0.15, 0]} mat={body} /> : <Cyl r={0.075} h={0.2} pos={[0, 0.1, 0]} mat={body} seg={16} />}
        <group ref={sh} position={[0, hs - 0.1, 0]}>
          <Cyl r={ind ? 0.1 : 0.075} h={ind ? 0.36 : 0.17} rot={[PI / 2, 0, 0]} mat={jm} seg={16} />
          {ind ? <Box size={[0.15, l1, 0.17]} pos={[0, l1 / 2, 0.06]} mat={body} /> : <Cyl r={0.05} h={l1} pos={[0, l1 / 2, 0]} mat={body} seg={14} />}
          {ind && <Cyl r={0.024} h={l1} pos={[-0.11, l1 / 2, 0.1]} mat={M.hose} seg={8} />}
          <group ref={el} position={[0, l1, 0]}>
            {ind ? <Box size={[0.2, 0.2, 0.24]} pos={[0, 0, 0.04]} mat={body} /> : <Cyl r={0.062} h={0.14} rot={[PI / 2, 0, 0]} mat={jm} seg={16} />}
            {ind ? <Box size={[0.11, l2, 0.11]} pos={[0, l2 / 2, 0.04]} mat={body} /> : <Cyl r={0.04} h={l2} pos={[0, l2 / 2, 0]} mat={body} seg={14} />}
            <group ref={wr} position={[0, l2, ind ? 0.04 : 0]}>
              <Cyl r={0.048} h={0.12} rot={[PI / 2, 0, 0]} mat={jm} seg={14} />
              <Cyl r={0.042} h={0.1} pos={[0, 0.06, 0]} mat={body} seg={14} />
              <Cyl r={0.04} h={0.025} pos={[0, 0.12, 0]} mat={MAT.bodyDark} seg={14} />
              <ToolHead tool={tool} />
            </group>
          </group>
        </group>
      </group>
    </group>
  );
}

/** 가동 중에만 왕복하는 부분 (프레스 램·시험 헤드·라벨 패드·폴딩). 움직였다가 hold 동안 머물고 돌아온다. turn이면 axis 둘레로 돈다 */
function Mover({ pos = [0, 0, 0], axis = 1, amp, period, running, phase = 0, hold = 0.3, turn = false, children }: { pos?: V3; axis?: 0 | 1 | 2; amp: number; period: number; running: boolean; phase?: number; hold?: number; turn?: boolean; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  const run = useRef(running);
  run.current = running;
  const t = useRef(phase * period);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    if (run.current) t.current += dt;
    const u = (((t.current / period) % 1) + 1) % 1;
    const go = (1 - hold) / 3;
    const v = u < go ? sm(u / go) : u < go + hold ? 1 : u < 2 * go + hold ? 1 - sm((u - go - hold) / go) : 0;
    if (turn) g.rotation.set(axis === 0 ? amp * v : 0, axis === 1 ? amp * v : 0, axis === 2 ? amp * v : 0);
    else g.position.setComponent(axis, pos[axis] + amp * v);
  });
  return (
    <group ref={ref} position={pos}>
      {children}
    </group>
  );
}

/** 가동 중에 on(t)가 참일 때만 보이는 등 (EOL 점등 순서, 방향지시등 깜박임) */
function Blink({ running, on, children }: { running: boolean; on: (t: number) => boolean; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  const run = useRef(running);
  run.current = running;
  const t = useRef(0);
  useFrame((_, dt) => {
    if (run.current) t.current += dt;
    if (ref.current) ref.current.visible = run.current && on(t.current);
  });
  return <group ref={ref}>{children}</group>;
}

// ─────────── 제품 (로컬 원점 = 바닥 가운데) ───────────

/** 헤드램프 0.6 × 0.4 × 0.29 m (렌즈가 +y). 단계별로 리플렉터·LED·실런트·렌즈를 더한다 */
function lamp(k: Kit, o: { refl?: boolean; led?: boolean; bead?: boolean; lens?: boolean; lit?: boolean }) {
  k.box(M.housing, [0.56, 0.17, 0.36], [0, 0.085, 0]);
  k.box(M.housing, [0.62, 0.03, 0.42], [0, 0.185, 0]); // 렌즈가 붙는 홈 테두리
  k.box(MAT.bodyDark, [0.06, 0.08, 0.08], [-0.3, 0.07, -0.08], undefined, false); // 레벨링 액추에이터
  k.box(MAT.frame, [0.05, 0.05, 0.06], [0.3, 0.08, -0.1], undefined, false); // 커넥터
  if (o.refl) {
    k.box(M.chrome, [0.54, 0.012, 0.34], [0, 0.206, 0], undefined, false);
    for (const x of [-0.13, 0.13]) k.cyl(M.chrome, 0.1, 0.03, [x, 0.215, -0.02], undefined, false);
  }
  if (o.led) {
    const m = o.lit ? M.lit : M.ledOff;
    for (const x of [-0.13, 0.13]) k.cyl(m, 0.035, 0.03, [x, 0.235, -0.02], undefined, false); // LED 모듈 (로우·하이)
    k.box(m, [0.4, 0.014, 0.025], [-0.04, 0.219, 0.15], undefined, false); // DRL 라이트 가이드
    k.box(o.lit ? M.amber : M.amberOff, [0.05, 0.014, 0.1], [0.255, 0.219, 0.06], undefined, false); // 방향지시등
  }
  if (o.bead) {
    for (const z of [-0.19, 0.19]) k.box(M.hotmelt, [0.6, 0.016, 0.022], [0, 0.208, z], undefined, false);
    for (const x of [-0.29, 0.29]) k.box(M.hotmelt, [0.022, 0.016, 0.4], [x, 0.208, 0], undefined, false);
  }
  if (o.lens) k.box(M.lens, [0.6, 0.04, 0.4], [0, 0.27, 0]);
}

/** 램프를 세워서 렌즈가 -x를 보게 한다 (길이는 z, 원점 = 램프 뒷면 가운데) */
function lampFacingMinusX(k: Kit, p: V3, o: Parameters<typeof lamp>[1]) {
  k.at(p, [0, 0, PI / 2], () => k.at([0, 0, 0], [0, -PI / 2, 0], () => lamp(k, o)));
}

/** 미러 헤드: 피벗(원점)에서 +x로 뻗고 거울면이 +z (차 뒤쪽). 커버는 -z */
function mirrorHead(k: Kit, o: { cover?: boolean; glass?: boolean; lit?: boolean }) {
  k.box(M.pa, [0.3, 0.17, 0.09], [0.21, 0.02, -0.005]); // 하우징 프레임 (액추에이터 포함)
  k.box(M.pa, [0.08, 0.07, 0.07], [0.04, -0.02, -0.01]); // 목
  if (o.cover) {
    k.box(M.cover, [0.34, 0.2, 0.05], [0.215, 0.02, -0.07]);
    k.box(o.lit ? M.amber : M.amberOff, [0.15, 0.024, 0.03], [0.29, 0.125, -0.07], undefined, false); // 턴시그널 LED
  }
  if (o.glass) k.box(M.mirror, [0.29, 0.16, 0.012], [0.215, 0.02, 0.047], undefined, false); // 히팅 미러 글래스
}

/** 차 문에 붙는 미러 베이스 */
function mirrorBase(k: Kit) {
  k.box(M.pa, [0.09, 0.15, 0.08], [-0.02, 0, -0.01]);
}

/** 팰릿 위에 거울면이 위로 오게 눕힌 미러 (x = 가운데) */
function mirrorLying(k: Kit, x: number, o: Parameters<typeof mirrorHead>[1], flip = false) {
  k.at([x, PT + 0.09, 0], [-PI / 2, flip ? PI : 0, 0], () =>
    k.at([-0.18, 0, 0], undefined, () => {
      mirrorBase(k);
      mirrorHead(k, o);
    }),
  );
}

/** 폴딩 액추에이터 (브래킷 → 모터·웜기어 → 그리스 → 덮개·나사). step 0~3 */
function actuator(k: Kit, step: number) {
  k.box(M.pa, [0.16, 0.05, 0.12], [0, 0.025, 0]);
  k.cyl(M.pa, 0.034, 0.05, [0.05, 0.075, 0], undefined, false); // 피벗 보스
  if (step >= 1) {
    k.cyl(MAT.steel, 0.026, 0.08, [-0.035, 0.09, 0.02], undefined, false); // 모터
    k.cyl(M.pom, 0.032, 0.022, [0.05, 0.111, 0], undefined, false); // 웜기어
  }
  if (step >= 2) k.cyl(M.grease, 0.02, 0.01, [0.05, 0.126, 0], undefined, false);
  if (step >= 3) {
    k.box(M.pa, [0.17, 0.025, 0.13], [0, 0.145, 0]);
    for (const x of [-0.06, 0.06]) k.cyl(MAT.steel, 0.009, 0.008, [x, 0.161, 0.045], undefined, false);
  }
}

/** BMS 하우징 0.3 × 0.2 m. closed면 덮개와 M3 나사 4개 */
function bms(k: Kit, closed: boolean) {
  k.box(M.alu, [0.3, 0.055, 0.2], [0, 0.0275, 0]);
  k.box(MAT.frame, [0.03, 0.035, 0.09], [0.163, 0.03, 0], undefined, false); // 커넥터
  if (!closed) k.box(M.pcb, [0.27, 0.008, 0.17], [0, 0.059, 0], undefined, false);
  else {
    k.box(MAT.steel, [0.3, 0.012, 0.2], [0, 0.061, 0], undefined, false);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(MAT.bodyDark, 0.009, 0.006, [sx * 0.13, 0.07, sz * 0.085], undefined, false);
    k.box(M.label, [0.1, 0.003, 0.06], [-0.05, 0.0685, 0], undefined, false);
  }
}

// ─────────── 공용 설비 조각 ───────────

/** 작업 팰릿: 강판 + 위치 결정 부시 + 지그 레일. 제품은 PT 높이에 앉는다 */
function pallet(k: Kit, x: number, w = 0.7, d = 0.56) {
  k.box(MAT.steel, [w, 0.035, d], [x, BT + 0.018, 0]);
  for (const s of [-1, 1]) {
    k.box(M.pom, [w * 0.8, 0.04, 0.05], [x, BT + 0.055, s * d * 0.3], undefined, false);
    k.cyl(MAT.bodyDark, 0.02, 0.012, [x + s * (w / 2 - 0.06), BT + 0.041, d / 2 - 0.06], undefined, false);
  }
}

/** 투 스트랜드 팰릿 컨베이어 (셀 안쪽). stops = 스토퍼 위치 */
function palletLine(k: Kit, x0: number, x1: number, stops: number[]) {
  const len = x1 - x0;
  const cx = (x0 + x1) / 2;
  for (const z of [-0.27, 0.27]) {
    k.box(MAT.steel, [len, 0.1, 0.07], [cx, BT - 0.05, z]);
    k.box(MAT.belt, [len, 0.012, 0.05], [cx, BT + 0.006, z], undefined, false);
  }
  const n = Math.max(2, Math.round(len / 1.4) + 1);
  for (let i = 0; i < n; i++) {
    const x = x0 + 0.12 + ((len - 0.24) * i) / (n - 1);
    for (const z of [-0.27, 0.27]) k.box(MAT.frame, [0.06, BT - 0.1, 0.06], [x, (BT - 0.1) / 2, z], undefined, false);
    k.box(MAT.frame, [0.05, 0.05, 0.54], [x, 0.22, 0], undefined, false);
  }
  for (const x of stops) k.box(MAT.bodyDark, [0.05, 0.07, 0.12], [x, BT - 0.02, 0], undefined, false);
  k.cyl(MAT.bodyDark, 0.065, 0.2, [x1 - 0.25, BT - 0.13, 0.42], [PI / 2, 0, 0]); // 구동 모터
  k.box(MAT.bodyDark, [0.14, 0.14, 0.1], [x1 - 0.25, BT - 0.13, 0.3], undefined, false);
}

interface Gap {
  a: number;
  b: number;
  /** 이 높이 위로는 막는다 (컨베이어 통로) */
  top?: number;
}

/** 안전 펜스 한 줄: axis 방향으로 from→to, 다른 축은 fixed. gaps는 문·통로 */
function fenceRun(k: Kit, axis: 'x' | 'z', fixed: number, from: number, to: number, h: number, gaps: Gap[] = []) {
  const P = (t: number, y: number): V3 => (axis === 'x' ? [t, y, fixed] : [fixed, y, t]);
  const S = (len: number, hh: number, th = 0.02): V3 => (axis === 'x' ? [len, hh, th] : [th, hh, len]);
  const posts: number[] = [];
  const seg = (s: number, e: number) => {
    if (e - s < 0.05) return;
    k.box(M.mesh, S(e - s, h - 0.15), P((s + e) / 2, 0.1 + (h - 0.15) / 2), undefined, false);
    k.box(MAT.safety, S(e - s, 0.04, 0.04), P((s + e) / 2, h - 0.04), undefined, false);
    k.box(MAT.frame, S(e - s, 0.03, 0.03), P((s + e) / 2, 0.1), undefined, false);
    const n = Math.max(1, Math.ceil((e - s) / 1.3));
    for (let i = 0; i <= n; i++) posts.push(s + ((e - s) * i) / n);
  };
  let cur = from;
  for (const g of [...gaps].sort((p, q) => p.a - q.a)) {
    seg(cur, g.a);
    cur = g.b;
    if (g.top !== undefined) {
      k.box(M.mesh, S(g.b - g.a, h - g.top - 0.05), P((g.a + g.b) / 2, (g.top + h) / 2), undefined, false);
      k.box(MAT.safety, S(g.b - g.a, 0.05, 0.05), P((g.a + g.b) / 2, g.top), undefined, false);
      posts.push(g.a, g.b);
    }
  }
  seg(cur, to);
  for (const t of posts) k.box(MAT.safety, [0.05, h, 0.05], P(t, h / 2), undefined, false);
}

/** 펜스 문 (z 고정, x0~x1): 망 + 노란 테 + 손잡이 + 인터록 스위치 */
function door(k: Kit, x0: number, x1: number, z: number, h: number) {
  const w = x1 - x0;
  const cx = (x0 + x1) / 2;
  k.box(M.mesh, [w - 0.06, h - 0.25, 0.02], [cx, 0.12 + (h - 0.25) / 2, z + 0.03], undefined, false);
  for (const y of [0.1, h - 0.1]) k.box(MAT.safety, [w, 0.04, 0.04], [cx, y, z + 0.03], undefined, false);
  for (const x of [x0, x1]) k.box(MAT.safety, [0.05, h, 0.05], [x, h / 2, z], undefined, false);
  k.box(MAT.bodyDark, [0.03, 0.2, 0.05], [x1 - 0.12, 1.05, z + 0.06], undefined, false);
  k.box(MAT.safety, [0.07, 0.11, 0.06], [x1 + 0.06, 1.2, z + 0.05], undefined, false);
}

/** 라이트 커튼 한 쌍 (사람이 들어오면 로봇을 세운다) */
function curtain(k: Kit, a: [number, number], b: [number, number], h = 1.5) {
  for (const [x, z] of [a, b]) {
    k.box(MAT.frame, [0.08, 0.25, 0.08], [x, 0.125, z], undefined, false);
    k.box(MAT.safety, [0.045, h, 0.045], [x, 0.25 + h / 2, z], undefined, false);
    k.box(MAT.frame, [0.05, h - 0.1, 0.012], [x, 0.25 + h / 2, z + (a[1] === b[1] ? 0 : 0.025)], undefined, false);
  }
}

/** 조작 단말 (받침대 + 터치 화면 + 비상정지). 화면이 로컬 +z */
function hmi(k: Kit, x: number, z: number, yaw = 0, h = 1.4) {
  k.at([x, 0, z], [0, yaw, 0], () => {
    k.box(MAT.frame, [0.34, 0.03, 0.34], [0, 0.015, 0], undefined, false);
    k.cyl(MAT.frame, 0.035, h - 0.15, [0, (h - 0.15) / 2, 0], undefined, false);
    k.at([0, h, 0], [-0.3, 0, 0], () => {
      k.box(MAT.bodyDark, [0.46, 0.34, 0.07], [0, 0, 0], undefined, true);
      k.box(MAT.screen, [0.36, 0.25, 0.01], [-0.03, 0.01, 0.037], undefined, false);
      k.cyl(M.red, 0.022, 0.03, [0.19, -0.11, 0.045], [PI / 2, 0, 0], false);
    });
  });
}

/** 제어반 (앞면 +z) */
function cabinet(k: Kit, x: number, z: number, w: number, h: number, d: number, yaw = 0) {
  k.at([x, 0, z], [0, yaw, 0], () => {
    k.box(MAT.frame, [w, 0.1, d], [0, 0.05, 0]);
    k.box(MAT.bodyLight, [w, h - 0.1, d], [0, 0.05 + h / 2, 0]);
    if (w > 0.7) k.box(MAT.bodyDark, [0.01, h - 0.3, 0.006], [0, 0.05 + h / 2, d / 2 + 0.003], undefined, false);
    k.box(MAT.frame, [0.03, 0.16, 0.025], [w > 0.7 ? 0.07 : w / 2 - 0.08, 0.95, d / 2 + 0.012], undefined, false);
    k.box(MAT.bodyDark, [w * 0.5, 0.1, 0.006], [0, 0.35, d / 2 + 0.003], undefined, false); // 통풍구
  });
}

type Unit = 'psu' | 'meter' | 'pc' | 'comm' | 'hipot' | 'daq';
/** 19인치 시험 랙. 계측기를 위에서부터 꽂는다 (앞면 +z). lit이면 고전압 램프가 켜진다 */
function rack(k: Kit, x: number, z: number, h: number, units: Unit[], lit = false, yaw = 0) {
  k.at([x, 0, z], [0, yaw, 0], () => {
    const d = 0.6;
    k.box(MAT.frame, [0.6, h, d], [0, h / 2, 0]);
    let y = h - 0.08;
    for (const u of units) {
      const uh = u === 'pc' ? 0.3 : u === 'hipot' ? 0.24 : 0.16;
      y -= uh / 2;
      const f = d / 2 + 0.012;
      k.box(u === 'pc' ? MAT.bodyDark : MAT.bodyLight, [0.52, uh - 0.025, 0.02], [0, y, d / 2 + 0.002], undefined, false);
      k.box(MAT.screen, [u === 'pc' ? 0.3 : 0.13, u === 'pc' ? 0.18 : 0.06, 0.008], [-0.1, y + 0.01, f], undefined, false);
      if (u === 'comm') for (let i = 0; i < 4; i++) k.box(M.green, [0.018, 0.018, 0.008], [0.08 + i * 0.035, y, f], undefined, false);
      else if (u === 'hipot') {
        k.cyl(lit ? M.redLit : M.red, 0.03, 0.03, [0.17, y + 0.05, f], [PI / 2, 0, 0], false);
        k.box(MAT.safety, [0.12, 0.05, 0.006], [0.12, y - 0.06, f], undefined, false);
      } else if (u !== 'pc') for (const dx of [0.1, 0.18]) k.cyl(MAT.frame, 0.018, 0.02, [dx, y, f], [PI / 2, 0, 0], false);
      y -= uh / 2 + 0.015;
    }
  });
}

/** 경사 선반 부품 공급대: 앞(+z)이 낮아 부품이 앞으로 흘러온다. fill(k, 단, 칸)으로 선반 위를 채운다 */
function flowRack(k: Kit, x: number, z: number, w: number, d: number, h: number, levels: number, slots: number, fill: (k: Kit, lv: number, s: number) => void, yaw = 0) {
  k.at([x, 0, z], [0, yaw, 0], () => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(MAT.frame, [0.05, h, 0.05], [(sx * (w - 0.05)) / 2, h / 2, (sz * (d - 0.05)) / 2], undefined, false);
    k.box(MAT.frame, [w, 0.05, d], [0, h, 0]);
    for (let i = 0; i < levels; i++) {
      const y = 0.4 + ((h - 0.55) * i) / Math.max(1, levels - 1);
      k.at([0, y, 0], [0.14, 0, 0], () => {
        k.box(MAT.steel, [w - 0.04, 0.025, d], [0, 0, 0], undefined, false);
        k.box(MAT.safety, [w - 0.04, 0.05, 0.02], [0, 0.03, d / 2], undefined, false);
        for (let s = 0; s < slots; s++) k.at([-w / 2 + ((s + 0.5) * w) / slots, 0.0125, 0], undefined, () => fill(k, i, s));
      });
    }
  });
}

/** 키팅 대차 (바퀴 + 2단 선반). fill로 윗단(로컬 y=0)을 채운다 */
function cart(k: Kit, x: number, z: number, w: number, d: number, fill: (k: Kit) => void, yaw = 0) {
  k.at([x, 0, z], [0, yaw, 0], () => {
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        k.cyl(MAT.rubber, 0.05, 0.04, [sx * (w / 2 - 0.06), 0.05, sz * (d / 2 - 0.06)], [PI / 2, 0, 0], false);
        k.box(MAT.steel, [0.03, 0.75, 0.03], [sx * (w / 2 - 0.02), 0.47, sz * (d / 2 - 0.02)], undefined, false);
      }
    k.box(MAT.bodyDark, [w, 0.03, d], [0, 0.2, 0]);
    k.box(MAT.bodyDark, [w, 0.03, d], [0, 0.8, 0]);
    k.cyl(MAT.steel, 0.015, d, [-w / 2 - 0.04, 0.95, 0], [PI / 2, 0, 0], false);
    k.box(MAT.steel, [0.06, 0.02, 0.02], [-w / 2 - 0.01, 0.95, d / 2 - 0.02], undefined, false);
    k.box(MAT.steel, [0.06, 0.02, 0.02], [-w / 2 - 0.01, 0.95, -d / 2 + 0.02], undefined, false);
    k.at([0, 0.815, 0], undefined, () => fill(k));
  });
}

/** 부품 상자 (p = 바닥 가운데). 안쪽은 어둡게 칠해 열린 상자처럼 보이게 한다 */
function bin(k: Kit, p: V3, w: number, d: number, h: number, mat: THREE.Material = MAT.tote) {
  k.box(mat, [w, h, d], [p[0], p[1] + h / 2, p[2]], undefined, false);
  k.box(MAT.bodyDark, [w - 0.03, 0.004, d - 0.03], [p[0], p[1] + h + 0.002, p[2]], undefined, false);
}

/** 밸런서 팔 + 너트러너: 기둥(cx, cz)에서 공구(tx, tz) 위까지 팔을 뻗고, 공구가 높이 ty에 매달린다 */
function nutrunner(k: Kit, cx: number, cz: number, tx: number, tz: number, ty = 1.3) {
  k.box(MAT.frame, [0.32, 0.02, 0.32], [cx, 0.01, cz], undefined, false);
  k.cyl(MAT.bodyLight, 0.055, 2.05, [cx, 1.025, cz]);
  const dx = tx - cx;
  const dz = tz - cz;
  const len = Math.hypot(dx, dz);
  k.at([cx, 2.0, cz], [0, Math.atan2(-dz, dx), 0], () => {
    k.cyl(MAT.bodyDark, 0.07, 0.1, [0, 0, 0], undefined, false);
    k.box(MAT.steel, [len * 0.55, 0.07, 0.07], [len * 0.275, 0, 0]);
    k.cyl(MAT.bodyDark, 0.05, 0.1, [len * 0.55, -0.03, 0], undefined, false);
    k.box(MAT.steel, [len * 0.47, 0.06, 0.06], [len * 0.775, -0.07, 0]);
  });
  k.box(MAT.safety, [0.09, 0.15, 0.09], [tx, 1.82, tz], undefined, false); // 스프링 밸런서
  k.pipe(MAT.frame, 0.005, [[tx, 1.75, tz], [tx, ty + 0.24, tz]]);
  k.cyl(MAT.bodyDark, 0.036, 0.2, [tx, ty + 0.13, tz], undefined, false); // 모터
  k.cyl(MAT.steel, 0.026, 0.12, [tx, ty - 0.03, tz], undefined, false); // 기어 헤드
  k.cyl(MAT.steel, 0.009, 0.06, [tx, ty - 0.12, tz], undefined, false); // 소켓
  k.box(MAT.bodyDark, [0.24, 0.025, 0.025], [tx, ty + 0.17, tz], undefined, false); // 손잡이
}

/** 로봇 받침대 (윗면 = 로봇 베이스 높이) */
function pedestal(k: Kit, p: V3, w = 0.36) {
  k.box(MAT.bodyDark, [w, p[1], w], [p[0], p[1] / 2, p[2]]);
  k.box(MAT.frame, [w + 0.14, 0.02, w + 0.14], [p[0], 0.01, p[2]], undefined, false);
}

/** 바닥 안전 구역 표시 (노란 선) */
function floorZone(k: Kit, x0: number, x1: number, z0: number, z1: number) {
  k.box(MAT.safety, [x1 - x0, 0.006, 0.06], [(x0 + x1) / 2, 0.004, z0], undefined, false);
  k.box(MAT.safety, [x1 - x0, 0.006, 0.06], [(x0 + x1) / 2, 0.004, z1], undefined, false);
  k.box(MAT.safety, [0.06, 0.006, z1 - z0], [x0, 0.004, (z0 + z1) / 2], undefined, false);
  k.box(MAT.safety, [0.06, 0.006, z1 - z0], [x1, 0.004, (z0 + z1) / 2], undefined, false);
}

/** 작은 탁자 (윗면 높이 h) */
function table(k: Kit, x: number, z: number, w: number, d: number, h: number) {
  k.box(MAT.frame, [w, 0.04, d], [x, h - 0.02, z]);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(MAT.frame, [0.05, h - 0.04, 0.05], [x + sx * (w / 2 - 0.04), (h - 0.04) / 2, z + sz * (d / 2 - 0.04)], undefined, false);
}

interface P {
  color: string;
  running: boolean;
}

// ─────────── 램프 조립 셀 (HL-AS-01) ───────────
// 팰릿: 빈 하우징 → ① 리플렉터 삽입(로봇 A) → ② LED 모듈 장착(로봇 B) → ③ 작업자: 레벨링 액추에이터·배선·나사 체결

const HAS = {
  a: [-0.9, 0.7, -0.8] as V3,
  b: [0.6, 0.7, -0.8] as V3,
  rack: [-1.5, -1.65] as const,
  tray: [1.0, -1.5] as const,
  nut: [1.95, 0.05] as const,
  curtainX: 1.25,
};
const HAS_A = stopsPath(HAS.a, [[-1.225, 0.97, -1.4], [-0.9, PT + 0.24, 0]]);
const HAS_B = stopsPath(HAS.b, [[0.95, 0.93, -1.42], [0.6, PT + 0.26, 0]]);

function lampAssyKit(k: Kit) {
  const [L, D] = FOOTPRINT['assembly-cell'];
  const h = 2.0;
  fenceRun(k, 'x', -D / 2, -L / 2, L / 2, h);
  fenceRun(k, 'z', -L / 2, -D / 2, D / 2, h, [{ a: -1.9, b: -1.1, top: 1.25 }, { a: -0.45, b: 0.45, top: 1.25 }, { a: 1.1, b: 1.9, top: 1.25 }]);
  fenceRun(k, 'z', L / 2, -D / 2, 0.45, h, [{ a: -0.45, b: 0.45, top: 1.25 }]);
  fenceRun(k, 'x', D / 2, -L / 2, HAS.curtainX, h, [{ a: -2.45, b: -1.55 }]);
  door(k, -2.45, -1.55, D / 2, h);
  curtain(k, [HAS.curtainX, 0.55], [HAS.curtainX, 2.45]);

  palletLine(k, -2.9, 2.65, [-1.85, -0.55, 0.95, 2.3]);
  pallet(k, -2.2);
  k.at([-2.2, PT, 0], undefined, () => lamp(k, {}));
  pallet(k, -0.9);
  k.at([-0.9, PT, 0], undefined, () => lamp(k, { refl: true }));
  pallet(k, 0.6);
  k.at([0.6, PT, 0], undefined, () => lamp(k, { refl: true, led: true }));
  pallet(k, 1.95);
  k.at([1.95, PT, 0], undefined, () => lamp(k, { refl: true, led: true }));
  k.pipe(MAT.frame, 0.008, [[1.65, PT + 0.08, -0.1], [1.75, PT + 0.24, -0.05], [2.25, PT + 0.24, -0.05], [2.25, PT + 0.1, -0.1]]); // 배선 하네스

  pedestal(k, HAS.a);
  pedestal(k, HAS.b);

  // 증착 리플렉터 랙 (덤니지 트레이에 한 개씩)
  flowRack(k, HAS.rack[0], HAS.rack[1], 1.1, 0.7, 1.5, 3, 2, (k) => {
    k.box(MAT.bodyDark, [0.48, 0.05, 0.6], [0, 0.025, 0], undefined, false);
    k.at([0, 0.05, 0.04], undefined, () => {
      k.box(M.chrome, [0.42, 0.04, 0.26], [0, 0.02, 0], undefined, false);
      for (const x of [-0.1, 0.1]) k.cyl(M.chrome, 0.085, 0.05, [x, 0.045, 0], undefined, false);
    });
  });

  // LED 모듈 ESD 트레이 더미
  const [tx, tz] = HAS.tray;
  table(k, tx, tz, 0.7, 0.5, 0.74);
  for (let i = 0; i < 5; i++) k.box(M.esd, [0.62, 0.028, 0.44], [tx, 0.754 + i * 0.03, tz], undefined, false);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 3; j++) {
      const p: V3 = [tx - 0.21 + i * 0.14, 0.9, tz - 0.13 + j * 0.13];
      k.box(MAT.steel, [0.08, 0.025, 0.07], p, undefined, false);
      k.box(M.pcb, [0.07, 0.006, 0.06], [p[0], p[1] + 0.015, p[2]], undefined, false);
      k.cyl(M.ledOff, 0.012, 0.008, [p[0], p[1] + 0.022, p[2]], undefined, false);
    }

  // 작업자 구역: 너트러너, 키팅 대차(레벨링 액추에이터·하네스), 조작 단말
  nutrunner(k, 2.55, -0.85, HAS.nut[0], HAS.nut[1], 1.32);
  cart(k, 2.2, 1.85, 0.9, 0.55, (k) => {
    bin(k, [-0.29, 0, 0], 0.27, 0.42, 0.14);
    for (let i = 0; i < 3; i++) k.box(MAT.bodyDark, [0.07, 0.06, 0.08], [-0.29, 0.13, -0.12 + i * 0.12], undefined, false);
    bin(k, [0, 0, 0], 0.27, 0.42, 0.14);
    for (let i = 0; i < 2; i++) k.cyl(MAT.rubber, 0.09, 0.03, [0, 0.15 + i * 0.03, 0], undefined, false);
    bin(k, [0.29, 0, 0], 0.27, 0.42, 0.14, MAT.safety);
    for (let i = 0; i < 4; i++) k.cyl(MAT.steel, 0.015, 0.02, [0.29 - 0.06 + (i % 2) * 0.12, 0.15, -0.08 + Math.floor(i / 2) * 0.16], undefined, false);
  });
  hmi(k, 2.7, 0.95, -PI / 4);
  cabinet(k, 1.95, -2.15, 1.0, 1.75, 0.5);
}

function LampAssyCell({ color, running }: P) {
  const kit = useMemo(() => kitOf(lampAssyKit), []);
  return (
    <group>
      <KitMesh kit={kit} />
      <Robot base={HAS.a} sz={1.1} path={HAS_A} period={9} running={running} tool="grip" />
      <Robot base={HAS.b} sz={1.1} path={HAS_B} period={7} phase={0.45} running={running} tool="vacuum" />
      <Stripe size={[1.01, 0.08, 0.51]} pos={[1.95, 1.55, -2.15]} color={color} />
    </group>
  );
}

// ─────────── 미러 최종 조립 셀 (OSM-AS-01) ───────────
// 팰릿: 액추에이터+프레임 → ① 도장 커버(로봇) → ② 글래스 올림(로봇) → ③ 글래스 압입 프레스 → ④ 작업자: 턴시그널 LED·하네스·나사

const MAS = {
  bot: [-0.4, 0.7, -0.65] as V3,
  cover: [-1.3, -1.65] as const,
  glass: [0.4, -1.65] as const,
  press: 1.3,
  nut: [2.35, 0.05] as const,
  curtainX: 1.85,
  xs: [-2.3, -1.05, 0.25, 1.3, 2.35],
};
const MAS_PATH = stopsPath(MAS.bot, [
  [-1.05, 0.97, -1.4],
  [-1.05, PT + 0.16, 0],
  [0.15, 1.02, -1.4],
  [0.25, PT + 0.17, 0],
]);

function mirrorAssyKit(k: Kit) {
  const [L, D] = FOOTPRINT['assembly-cell'];
  const h = 2.0;
  fenceRun(k, 'x', -D / 2, -L / 2, L / 2, h);
  fenceRun(k, 'z', -L / 2, -D / 2, D / 2, h, [{ a: -0.45, b: 0.45, top: 1.25 }]);
  fenceRun(k, 'z', L / 2, -D / 2, 0.45, h, [{ a: -0.45, b: 0.45, top: 1.25 }]);
  fenceRun(k, 'x', D / 2, -L / 2, MAS.curtainX, h, [{ a: -1.6, b: -0.7 }]);
  door(k, -1.6, -0.7, D / 2, h);
  curtain(k, [MAS.curtainX, 0.55], [MAS.curtainX, 2.45]);

  palletLine(k, -2.9, 2.65, MAS.xs.map((x) => x + 0.3));
  const st = [{}, { cover: true }, { cover: true, glass: true }, { cover: true }, { cover: true, glass: true }];
  MAS.xs.forEach((x, i) => {
    pallet(k, x, 0.56, 0.6);
    if (i !== 3) mirrorLying(k, x, st[i]);
  });
  mirrorLying(k, MAS.press, { cover: true }); // 압입 전 (글래스는 프레스 헤드에)
  k.pipe(MAT.frame, 0.008, [[2.1, PT + 0.1, -0.05], [2.2, PT + 0.2, 0.1], [2.55, PT + 0.2, 0.1]]); // 하네스

  pedestal(k, MAS.bot);

  // 도장 커버 랙 (덤니지에 3개씩)
  flowRack(k, MAS.cover[0], MAS.cover[1], 1.0, 0.7, 1.4, 3, 2, (k) => {
    k.box(MAT.bodyDark, [0.42, 0.04, 0.62], [0, 0.02, 0], undefined, false);
    for (let i = 0; i < 3; i++) k.box(M.cover, [0.34, 0.06, 0.18], [0, 0.07, -0.2 + i * 0.2], undefined, false);
  });
  // 미러 글래스 랙 (칸마다 세워 꽂는다)
  flowRack(k, MAS.glass[0], MAS.glass[1], 1.0, 0.7, 1.4, 3, 2, (k) => {
    k.box(MAT.bodyDark, [0.38, 0.03, 0.62], [0, 0.015, 0], undefined, false);
    for (let i = 0; i < 6; i++) k.box(M.mirror, [0.3, 0.17, 0.008], [0, 0.115, -0.24 + i * 0.09], [-0.15, 0, 0], false);
  });

  // 글래스 압입 프레스 (포털 + 공압 실린더 2개)
  const px = MAS.press;
  for (const z of [-0.52, 0.52]) {
    k.box(MAT.frame, [0.1, 1.95, 0.1], [px, 0.975, z]);
    k.box(MAT.frame, [0.24, 0.02, 0.24], [px, 0.01, z], undefined, false);
  }
  k.box(MAT.bodyLight, [0.24, 0.16, 1.16], [px, 1.95, 0]);
  for (const z of [-0.18, 0.18]) {
    k.cyl(MAT.steel, 0.055, 0.32, [px, 2.19, z]);
    k.cyl(MAT.bodyDark, 0.06, 0.03, [px, 2.36, z], undefined, false);
  }
  k.pipe(M.tube, 0.008, [[px, 2.3, 0.24], [px, 2.3, 0.5], [px - 0.06, 1.2, 0.5]]);

  // 작업자 구역
  nutrunner(k, 2.75, -0.85, MAS.nut[0], MAS.nut[1], 1.26);
  cart(k, 2.4, 1.85, 0.8, 0.55, (k) => {
    bin(k, [-0.2, 0, 0], 0.32, 0.42, 0.14, MAT.safety);
    for (let i = 0; i < 3; i++) k.box(M.amberOff, [0.15, 0.025, 0.04], [-0.2, 0.15, -0.12 + i * 0.12], undefined, false);
    bin(k, [0.2, 0, 0], 0.32, 0.42, 0.14);
    for (let i = 0; i < 3; i++) k.cyl(MAT.rubber, 0.1, 0.025, [0.2, 0.15 + i * 0.026, 0], undefined, false);
  });
  hmi(k, 2.75, 1.0, -PI / 4);
  cabinet(k, 2.0, -2.15, 0.9, 1.75, 0.5);
}

function MirrorAssyCell({ color, running }: P) {
  const kit = useMemo(() => kitOf(mirrorAssyKit), []);
  const head = useMemo(
    () =>
      kitOf((k) => {
        const px = MAS.press;
        for (const z of [-0.18, 0.18]) k.cyl(MAT.steel, 0.016, 0.85, [px, 1.547, z], undefined, false);
        k.box(MAT.bodyDark, [0.44, 0.05, 0.34], [px, 1.097, 0]);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(MAT.rubber, 0.022, 0.03, [px + 0.035 + sx * 0.1, 1.057, -0.02 + sz * 0.05], undefined, false);
        k.box(M.mirror, [0.29, 0.012, 0.16], [px + 0.035, 1.036, -0.02], undefined, false); // 흡착한 글래스
      }),
    [],
  );
  return (
    <group>
      <KitMesh kit={kit} />
      <Mover pos={[0, 0.21, 0]} amp={-0.21} period={5} running={running} hold={0.35}>
        <KitMesh kit={head} />
      </Mover>
      <Robot base={MAS.bot} sz={1.25} path={MAS_PATH} period={12} running={running} tool="vacuum" />
      <Stripe size={[0.91, 0.08, 0.51]} pos={[2.0, 1.55, -2.15]} color={color} />
    </group>
  );
}

// ─────────── 폴딩 액추에이터 조립 셀 (OSM-AC-01) ───────────
// 팰릿: 브래킷 → ① 모터·웜기어·클러치 삽입(로봇) → ② 기어 압입 프레스 → ③ 그리스 정량 도포 → ④ 커버 나사 체결(로봇)

const ACT = {
  ins: [-1.7, 0.7, -0.75] as V3,
  scr: [1.7, 0.7, -0.75] as V3,
  rack: [-1.75, -1.55] as const,
  press: -0.55,
  grease: 0.6,
  feeder: [2.2, -1.05] as const,
  xs: [-1.7, -0.55, 0.6, 1.7],
};
const ACT_INS = stopsPath(ACT.ins, [[-1.35, 0.95, -1.32], [-1.7, PT + 0.09, 0]]);
const ACT_SCR = stopsPath(ACT.scr, [[2.06, 1.12, -0.9], [1.64, PT + 0.16, 0.045], [2.06, 1.12, -0.9], [1.76, PT + 0.16, 0.045]], 0.1);

function actuatorKit(k: Kit) {
  const [L, D] = FOOTPRINT['actuator-cell'];
  const h = 2.0;
  fenceRun(k, 'x', -D / 2, -L / 2, L / 2, h);
  fenceRun(k, 'z', -L / 2, -D / 2, D / 2, h, [{ a: -0.45, b: 0.45, top: 1.25 }]);
  fenceRun(k, 'z', L / 2, -D / 2, D / 2, h, [{ a: -0.45, b: 0.45, top: 1.25 }]);
  fenceRun(k, 'x', D / 2, -L / 2, L / 2, h, [{ a: -0.5, b: 0.4 }]);
  door(k, -0.5, 0.4, D / 2, h);

  palletLine(k, -2.6, 2.6, ACT.xs.map((x) => x + 0.23));
  ACT.xs.forEach((x, i) => {
    pallet(k, x, 0.45, 0.6);
    k.box(M.pom, [0.2, 0.03, 0.16], [x, PT - 0.005, 0], undefined, false); // 브래킷 지그
    k.at([x, PT + 0.01, 0], undefined, () => actuator(k, i));
  });

  pedestal(k, ACT.ins);
  pedestal(k, ACT.scr);
  // 부품 공급 랙: 단마다 모터·웜기어·클러치 상자
  flowRack(k, ACT.rack[0], ACT.rack[1], 1.2, 0.6, 1.3, 3, 3, (k, lv) => {
    bin(k, [0, 0, 0], 0.34, 0.5, 0.12);
    for (let i = 0; i < 4; i++) {
      const p: V3 = [-0.08 + (i % 2) * 0.16, 0.12, -0.11 + Math.floor(i / 2) * 0.22];
      if (lv === 0) k.cyl(MAT.steel, 0.03, 0.07, p, [PI / 2, 0, 0], false);
      else if (lv === 1) k.cyl(M.pom, 0.04, 0.03, p, undefined, false);
      else k.cyl(MAT.bodyDark, 0.035, 0.03, p, undefined, false);
    }
  });

  // 기어 압입 서보 프레스 (C형 프레임)
  const px = ACT.press;
  k.box(MAT.frame, [0.5, 0.04, 0.5], [px, 0.02, -0.9], undefined, false);
  k.box(MAT.bodyLight, [0.3, 1.75, 0.3], [px, 0.9, -0.9]);
  k.box(MAT.bodyLight, [0.26, 0.3, 1.05], [px, 1.62, -0.43]);
  k.cyl(MAT.bodyDark, 0.07, 0.3, [px + 0.05, 1.92, 0]);
  k.box(MAT.screen, [0.16, 0.1, 0.01], [px, 1.3, -0.745], undefined, false);

  // 그리스 도포 스테이션
  const gx = ACT.grease;
  k.box(MAT.frame, [0.3, 0.02, 0.3], [gx, 0.01, -0.75], undefined, false);
  k.box(MAT.frame, [0.1, 1.65, 0.1], [gx, 0.825, -0.75]);
  k.box(MAT.frame, [0.08, 0.08, 0.8], [gx, 1.62, -0.37]);
  k.box(MAT.bodyDark, [0.1, 0.32, 0.08], [gx + 0.05, 1.42, -0.07]); // Z축 슬라이드
  k.cyl(M.grease, 0.045, 0.26, [gx, 1.15, -0.68]); // 그리스 카트리지
  k.cyl(MAT.steel, 0.05, 0.03, [gx, 1.295, -0.68], undefined, false);
  k.cyl(M.pail, 0.16, 0.38, [0.3, 0.19, -1.45]); // 그리스 페일 + 펌프
  k.cyl(MAT.bodyDark, 0.04, 0.5, [0.3, 0.63, -1.45], undefined, false);
  k.pipe(M.hose, 0.012, [[0.3, 0.88, -1.45], [0.45, 1.3, -1.1], [gx, 1.6, -0.78]]);
  k.pipe(M.hose, 0.009, [[gx, 1.66, -0.4], [gx + 0.12, 1.66, -0.05], [gx + 0.09, 1.36, 0.0]]);

  // 나사 공급기 (스텝 피더)
  const [fx, fz] = ACT.feeder;
  k.box(MAT.bodyDark, [0.2, 0.9, 0.2], [fx, 0.45, fz]);
  k.box(MAT.bodyLight, [0.32, 0.18, 0.26], [fx, 0.99, fz]);
  k.box(MAT.steel, [0.2, 0.08, 0.18], [fx + 0.03, 1.12, fz - 0.03], [0, 0, -0.3], false);
  k.box(MAT.steel, [0.06, 0.03, 0.18], [fx - 0.13, 1.095, fz + 0.12], undefined, false);

  hmi(k, 1.3, 2.25);
  cabinet(k, 1.4, -1.72, 0.9, 1.6, 0.45);
}

function ActuatorCell({ color, running }: P) {
  const kit = useMemo(() => kitOf(actuatorKit), []);
  const ram = useMemo(
    () =>
      kitOf((k) => {
        k.cyl(MAT.steel, 0.035, 0.42, [ACT.press + 0.05, 1.43, 0], undefined, false);
        k.cyl(MAT.bodyDark, 0.03, 0.06, [ACT.press + 0.05, 1.19, 0], undefined, false);
      }),
    [],
  );
  const valve = useMemo(
    () =>
      kitOf((k) => {
        k.cyl(MAT.steel, 0.03, 0.14, [ACT.grease + 0.05, 1.27, 0.0], undefined, false);
        k.cyl(MAT.steel, 0.004, 0.07, [ACT.grease + 0.05, 1.17, 0.0], undefined, false);
      }),
    [],
  );
  return (
    <group>
      <KitMesh kit={kit} />
      <Mover pos={[0, 0, 0]} amp={-0.12} period={4} running={running}>
        <KitMesh kit={ram} />
      </Mover>
      <Mover pos={[0, 0, 0]} amp={-0.1} period={3.4} running={running} phase={0.5} hold={0.4}>
        <KitMesh kit={valve} />
      </Mover>
      <Robot base={ACT.ins} sz={1.0} path={ACT_INS} period={6} running={running} tool="grip" />
      <Robot base={ACT.scr} sz={1.0} path={ACT_SCR} period={8} running={running} phase={0.3} tool="screw" />
      <Stripe size={[0.91, 0.08, 0.46]} pos={[1.4, 1.4, -1.72]} color={color} />
    </group>
  );
}

// ─────────── BMS 하우징 체결 셀 (EM-HA-B) ───────────
// 기판 투입(소형 협동로봇) → XYZ 자동 드라이버가 나사 공급기에서 나사를 받아 M3 4개를 조인다

const SCR = {
  bot: [-0.6, 0.82, -0.8] as V3,
  mag: [-1.0, -0.85] as const,
  load: -0.6,
  drive: 0.5,
  feed: [0.95, -0.55, 1.08] as V3, // 나사 받는 점 (x, z, y)
};
const SCR_BOT = stopsPath(SCR.bot, [[-1.0, 1.0, -0.85], [-0.6, PT + 0.07, 0]], 0.12);

function screwKit(k: Kit) {
  const W = 2.5;
  const Dz = 2.4;
  // 기계 받침 (컨베이어 양옆)
  for (const s of [-1, 1]) {
    k.box(MAT.bodyLight, [W, 0.78, 0.75], [0, 0.39, s * 0.825]);
    k.box(MAT.steel, [W, 0.02, 0.75], [0, 0.79, s * 0.825]);
  }
  k.box(MAT.bodyDark, [0.01, 0.6, 0.006], [-0.42, 0.4, 1.203], undefined, false);
  k.box(MAT.bodyDark, [0.01, 0.6, 0.006], [0.42, 0.4, 1.203], undefined, false);
  // 알루미늄 프로파일 틀 + 투명 덮개
  for (const x of [-W / 2 + 0.025, 0, W / 2 - 0.025]) for (const z of [-Dz / 2 + 0.025, Dz / 2 - 0.025]) k.box(MAT.steel, [0.045, 1.2, 0.045], [x, 1.4, z], undefined, false);
  for (const z of [-Dz / 2 + 0.025, Dz / 2 - 0.025]) k.box(MAT.steel, [W, 0.045, 0.045], [0, 2.0, z], undefined, false);
  for (const x of [-W / 2 + 0.025, W / 2 - 0.025]) k.box(MAT.steel, [0.045, 0.045, Dz], [x, 2.0, 0], undefined, false);
  k.box(M.guard, [W - 0.05, 1.17, 0.01], [0, 1.4, -Dz / 2 + 0.02]);
  k.box(M.guard, [W - 0.05, 1.17, 0.01], [0, 1.4, Dz / 2 - 0.02]);
  for (const x of [-W / 2 + 0.02, W / 2 - 0.02]) {
    for (const s of [-1, 1]) k.box(M.guard, [0.01, 1.17, 0.76], [x, 1.4, s * 0.81]);
    k.box(M.guard, [0.01, 0.78, 0.86], [x, 1.6, 0]);
  }
  for (const x of [-0.3, 0.3]) k.box(MAT.steel, [0.03, 0.03, 0.12], [x, 1.35, Dz / 2 + 0.01], undefined, false); // 문 손잡이

  // 기판 투입
  k.box(MAT.frame, [0.3, 0.02, 0.3], [SCR.bot[0], 0.81, SCR.bot[2]], undefined, false);
  const [mx, mz] = SCR.mag;
  for (let i = 0; i < 4; i++) {
    k.box(M.esd, [0.36, 0.035, 0.26], [mx, 0.82 + i * 0.04, mz], undefined, false);
    k.box(M.pcb, [0.27, 0.008, 0.17], [mx, 0.842 + i * 0.04, mz], undefined, false);
  }
  pallet(k, SCR.load, 0.42, 0.4);
  k.at([SCR.load, PT, 0], undefined, () => bms(k, false));

  // 하우징 지그 + 클램프
  const dx = SCR.drive;
  pallet(k, dx, 0.42, 0.4);
  k.at([dx, PT, 0], undefined, () => bms(k, true));
  for (const s of [-1, 1]) {
    k.cyl(MAT.steel, 0.025, 0.14, [dx, PT + 0.03, s * 0.25], [PI / 2, 0, 0], false);
    k.box(MAT.bodyDark, [0.08, 0.1, 0.06], [dx, PT + 0.03, s * 0.36], undefined, false);
  }

  // XYZ 레일 (x축 2줄)
  for (const z of [-0.62, 0.62]) {
    k.box(MAT.steel, [1.3, 0.06, 0.07], [0.55, 1.75, z]);
    k.box(MAT.steel, [0.05, 0.95, 0.05], [1.18, 1.28, z], undefined, false);
    k.box(MAT.steel, [0.05, 0.95, 0.05], [-0.08, 1.28, z], undefined, false);
  }
  // 나사 공급기 (스텝 피더 + 호퍼 + 배출 레일)
  const [fx, fz] = [SCR.feed[0], -0.85];
  k.box(MAT.bodyLight, [0.32, 0.24, 0.3], [fx, 0.92, fz]);
  k.box(MAT.steel, [0.24, 0.1, 0.22], [fx, 1.09, fz - 0.02], [0.25, 0, 0], false);
  k.box(MAT.steel, [0.05, 0.04, 0.32], [fx, 1.05, -0.62], undefined, false);
  k.box(MAT.screen, [0.1, 0.06, 0.008], [fx - 0.08, 0.92, fz + 0.155], undefined, false);
  k.box(MAT.bodyDark, [1.2, 0.04, 0.08], [0.55, 1.8, -0.74], undefined, false); // 케이블 덕트

  hmi(k, 1.15, 1.38);
}

/** XYZ 자동 드라이버: 공급기에서 나사를 받아 네 구멍을 차례로 조인다 */
function XyzDriver({ running }: { running: boolean }) {
  const bx = useRef<THREE.Group>(null);
  const cz = useRef<THREE.Group>(null);
  const zy = useRef<THREE.Group>(null);
  const run = useRef(running);
  run.current = running;
  const t = useRef(0);
  const pts = useMemo(() => {
    const f: V3 = [SCR.feed[0], SCR.feed[1], SCR.feed[2]];
    const s = (sx: number, sz: number): V3 => [SCR.drive + sx * 0.13, sz * 0.085, PT + 0.08];
    return [f, s(-1, -1), f, s(1, -1), f, s(1, 1), f, s(-1, 1)];
  }, []);
  useFrame((_, dt) => {
    if (!bx.current || !cz.current || !zy.current) return;
    if (run.current) t.current += dt;
    const step = 1.1;
    const f = t.current / step;
    const i = Math.floor(f) % pts.length;
    const g = f - Math.floor(f);
    const A = pts[(i + pts.length - 1) % pts.length];
    const B = pts[i];
    const up = 1.25;
    const m = sm(Math.min(1, g / 0.4));
    bx.current.position.x = A[0] + (B[0] - A[0]) * m;
    cz.current.position.z = A[1] + (B[1] - A[1]) * m;
    const dip = g < 0.4 ? 0 : Math.sin(((g - 0.4) / 0.6) * PI);
    zy.current.position.y = up + (B[2] - up) * dip;
  });
  return (
    <group ref={bx} position={[0.5, 0, 0]}>
      <Box size={[0.09, 0.1, 1.34]} pos={[0, 1.83, 0]} mat={MAT.bodyDark} />
      <group ref={cz}>
        <Box size={[0.16, 0.2, 0.14]} pos={[0, 1.78, 0]} mat={MAT.bodyLight} />
        <Box size={[0.04, 0.5, 0.04]} pos={[0.06, 1.5, 0]} mat={MAT.steel} cast={false} />
        <group ref={zy} position={[0, 1.25, 0]}>
          <Cyl r={0.038} h={0.2} pos={[0, 0.25, 0]} mat={MAT.bodyDark} seg={14} />
          <Cyl r={0.016} h={0.06} pos={[0, 0.12, 0]} mat={MAT.steel} seg={10} />
          <Cyl r={0.006} h={0.1} pos={[0, 0.05, 0]} mat={MAT.steel} seg={6} />
        </group>
      </group>
    </group>
  );
}

function ScrewCell({ color, running }: P) {
  const kit = useMemo(() => kitOf(screwKit), []);
  return (
    <group>
      <KitMesh kit={kit} />
      <XyzDriver running={running} />
      <Robot base={SCR.bot} sz={0.9} path={SCR_BOT} period={5.5} running={running} tool="vacuum" />
      <Stripe size={[2.51, 0.07, 0.76]} pos={[0, 0.7, 0.825]} color={color} />
    </group>
  );
}

// ─────────── 렌즈 핫멜트 실링·압착기 (HL-SL-01) ───────────
// 6축 로봇이 하우징 홈을 따라 핫멜트를 짜고 → 렌즈 프레스가 코팅 렌즈를 눌러 붙인다

const SEAL = {
  bot: [-1.4, 0.6, -0.75] as V3,
  lamp: -1.4,
  press: 1.2,
  melter: [-2.0, -1.3] as const,
};
/** 홈 둘레를 한 바퀴: 내려와서 → 네 변 → 들어 올려 처음 자리로 */
const SEAL_PATH: PathFn = (u, o) => {
  const cx = SEAL.lamp;
  const y = PT + 0.225;
  const hx = 0.29;
  const hz = 0.19;
  if (u < 0.1) return void o.set(cx - hx, y + 0.15 * (1 - sm(u / 0.1)), -hz);
  if (u > 0.85) return void o.set(cx - hx, y + 0.15 * sm((u - 0.85) / 0.15), -hz);
  const per = 4 * (hx + hz);
  let s = ((u - 0.1) / 0.75) * per;
  const edges: [number, number, number, number][] = [
    [-hx, -hz, 1, 0],
    [hx, -hz, 0, 1],
    [hx, hz, -1, 0],
    [-hx, hz, 0, -1],
  ];
  for (const [x0, z0, ex, ez] of edges) {
    const len = ex !== 0 ? 2 * hx : 2 * hz;
    if (s <= len) return void o.set(cx + x0 + ex * s, y, z0 + ez * s);
    s -= len;
  }
  o.set(cx - hx, y, -hz);
};

function sealerKit(k: Kit) {
  const [L, D] = FOOTPRINT.sealer;
  const h = 2.0;
  fenceRun(k, 'x', -D / 2, -L / 2, L / 2, h);
  fenceRun(k, 'z', -L / 2, -D / 2, D / 2, h, [{ a: -0.45, b: 0.45, top: 1.25 }]);
  fenceRun(k, 'z', L / 2, -D / 2, D / 2, h, [{ a: -0.45, b: 0.45, top: 1.25 }]);
  fenceRun(k, 'x', D / 2, -L / 2, L / 2, h, [{ a: -0.45, b: 0.45 }]);
  door(k, -0.45, 0.45, D / 2, h);

  // 도포 위치: 리플렉터·LED가 들어간 하우징 + 홈을 따라 짠 실런트
  pallet(k, SEAL.lamp);
  k.at([SEAL.lamp, PT, 0], undefined, () => lamp(k, { refl: true, led: true, bead: true }));
  k.box(MAT.bodyDark, [0.55, SEAL.bot[1], 0.55], [SEAL.bot[0], SEAL.bot[1] / 2, SEAL.bot[2]]);

  // 핫멜트 용융기 (탱크 + 펌프 + 조작부) + 가열 호스
  const [mx, mz] = SEAL.melter;
  k.box(MAT.frame, [0.52, 0.22, 0.44], [mx, 0.11, mz]);
  k.box(MAT.bodyLight, [0.5, 0.72, 0.42], [mx, 0.58, mz]);
  k.box(MAT.steel, [0.3, 0.06, 0.26], [mx - 0.05, 0.97, mz]);
  k.box(MAT.bodyDark, [0.08, 0.04, 0.08], [mx - 0.05, 1.02, mz], undefined, false);
  k.box(MAT.screen, [0.16, 0.1, 0.01], [mx - 0.1, 0.78, mz + 0.215], undefined, false);
  k.box(MAT.safety, [0.12, 0.08, 0.005], [mx + 0.12, 0.78, mz + 0.212], undefined, false); // 고온 경고
  k.cyl(MAT.steel, 0.03, 0.06, [mx + 0.27, 0.62, mz + 0.05], [0, 0, PI / 2], false);
  k.pipe(M.hose, 0.028, [[mx + 0.3, 0.62, mz + 0.05], [mx + 0.45, 0.3, mz + 0.2], [-1.4, 0.3, -1.12], [-1.4, 0.82, -0.98]]);

  // 렌즈 압착 프레스 (포털 + 공압 실린더 2개)
  const px = SEAL.press;
  pallet(k, px);
  k.at([px, PT, 0], undefined, () => lamp(k, { refl: true, led: true, bead: true }));
  for (const z of [-0.62, 0.62]) {
    k.box(MAT.frame, [0.12, 1.95, 0.12], [px, 0.975, z]);
    k.box(MAT.frame, [0.3, 0.02, 0.3], [px, 0.01, z], undefined, false);
  }
  k.box(MAT.bodyLight, [0.3, 0.18, 1.36], [px, 2.0, 0]);
  for (const z of [-0.25, 0.25]) {
    k.cyl(MAT.steel, 0.065, 0.34, [px, 2.26, z]);
    k.cyl(MAT.bodyDark, 0.07, 0.03, [px, 2.44, z], undefined, false);
  }
  k.pipe(M.tube, 0.008, [[px + 0.07, 2.35, 0.25], [px + 0.07, 2.35, 0.62], [px + 0.07, 1.4, 0.68]]);

  // 렌즈 매거진 (하드코팅 렌즈 + 간지)
  table(k, px, -1.32, 0.8, 0.6, 0.72);
  for (let i = 0; i < 4; i++) {
    k.box(M.lens, [0.6, 0.04, 0.4], [px, 0.745 + i * 0.05, -1.32]);
    k.box(MAT.bodyLight, [0.62, 0.006, 0.42], [px, 0.77 + i * 0.05, -1.32], undefined, false);
  }

  hmi(k, 1.9, 2.0);
  cabinet(k, 2.05, -1.5, 0.7, 1.7, 0.45);
}

function Sealer({ color, running }: P) {
  const kit = useMemo(() => kitOf(sealerKit), []);
  const platen = useMemo(
    () =>
      kitOf((k) => {
        const px = SEAL.press;
        for (const z of [-0.25, 0.25]) k.cyl(MAT.steel, 0.018, 0.75, [px, 1.62, z], undefined, false);
        k.box(MAT.bodyDark, [0.68, 0.06, 0.48], [px, 1.247, 0]);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(MAT.rubber, 0.03, 0.03, [px + sx * 0.22, 1.202, sz * 0.13], undefined, false);
        k.box(M.lens, [0.6, 0.04, 0.4], [px, 1.167, 0]);
      }),
    [],
  );
  return (
    <group>
      <KitMesh kit={kit} />
      <Mover pos={[0, 0.24, 0]} amp={-0.24} period={6} running={running} hold={0.4}>
        <KitMesh kit={platen} />
      </Mover>
      <Robot base={SEAL.bot} sz={1.25} path={SEAL_PATH} period={9} running={running} tool="nozzle" ind />
      <Stripe size={[0.71, 0.08, 0.46]} pos={[2.05, 1.5, -1.5]} color={color} />
    </group>
  );
}

// ─────────── 기밀(리크) 검사기 (HL-LT-01) ───────────
// 시험 헤드가 내려와 렌즈를 누르고 벤트 구멍을 막은 뒤 30 mbar로 가압 → 30 s 압력 강하를 잰다

const LEAK = { x: -0.1, fx: -0.9 };

function leakKit(k: Kit) {
  const x = LEAK.x;
  // 시험 프레임
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      k.box(MAT.steel, [0.07, 1.95, 0.07], [x + sx * 0.55, 0.975, sz * 0.62]);
      k.box(MAT.frame, [0.16, 0.02, 0.16], [x + sx * 0.55, 0.01, sz * 0.62], undefined, false);
    }
  for (const z of [-0.62, 0.62]) k.box(MAT.bodyLight, [1.2, 0.09, 0.09], [x, 1.98, z]);
  for (const sx of [-1, 1]) k.box(MAT.bodyLight, [0.09, 0.09, 1.33], [x + sx * 0.55, 1.98, 0]);
  k.box(MAT.bodyLight, [0.26, 0.1, 1.33], [x, 1.98, 0]);
  k.cyl(MAT.steel, 0.075, 0.42, [x, 2.23, 0]); // 클램프 실린더
  k.cyl(MAT.bodyDark, 0.085, 0.04, [x, 2.45, 0], undefined, false);
  for (const z of [-0.22, 0.22]) k.cyl(MAT.bodyDark, 0.035, 0.06, [x, 2.05, z], undefined, false); // 가이드 부시
  k.box(M.guard, [1.04, 1.0, 0.012], [x, 1.42, -0.62]);
  curtain(k, [x - 0.62, 0.7], [x + 0.62, 0.7], 1.3);
  // 검사 지그 위 램프 + 앞뒤 대기 팰릿
  pallet(k, x);
  k.box(M.pom, [0.66, 0.05, 0.08], [x, PT - 0.02, 0.24], undefined, false);
  k.at([x, PT, 0], undefined, () => lamp(k, { refl: true, led: true, lens: true }));
  pallet(k, -1.35);
  k.at([-1.35, PT, 0], undefined, () => lamp(k, { refl: true, led: true, lens: true }));
  pallet(k, 1.25);
  k.at([1.25, PT, 0], undefined, () => lamp(k, { refl: true, led: true, lens: true }));

  // 압력 감쇠 측정기 (보조 함 위)
  cabinet(k, 1.15, -0.95, 0.85, 1.0, 0.55);
  const ix = 1.15;
  k.box(MAT.bodyLight, [0.44, 0.22, 0.34], [ix, 1.16, -0.9]);
  k.box(MAT.screen, [0.2, 0.1, 0.01], [ix - 0.08, 1.18, -0.725], undefined, false);
  k.box(M.green, [0.04, 0.03, 0.01], [ix + 0.1, 1.2, -0.725], undefined, false);
  k.box(M.red, [0.04, 0.03, 0.01], [ix + 0.16, 1.2, -0.725], undefined, false);
  for (const dx of [0.08, 0.15]) k.cyl(MAT.steel, 0.012, 0.04, [ix + dx, 1.11, -0.72], [PI / 2, 0, 0], false);
  k.pipe(M.tube, 0.008, [[ix + 0.08, 1.11, -0.7], [ix - 0.3, 1.1, -0.66], [x + 0.55, 1.9, -0.66], [x + 0.2, 2.03, -0.3]]);

  // 제어반 + 레귤레이터·필터 (FRL, 앞 왼쪽 기둥)
  cabinet(k, -1.25, -0.95, 0.8, 1.7, 0.5);
  const fx = LEAK.fx;
  const fz = 0.66;
  k.box(MAT.steel, [0.44, 0.34, 0.015], [fx, 1.25, fz]); // 기둥에 붙인 판
  k.box(MAT.bodyDark, [0.07, 0.06, 0.07], [fx - 0.1, 1.3, fz + 0.04], undefined, false);
  k.cyl(M.lens, 0.03, 0.1, [fx - 0.1, 1.2, fz + 0.04]); // 필터 보울
  k.box(MAT.bodyDark, [0.07, 0.08, 0.07], [fx + 0.02, 1.29, fz + 0.04], undefined, false); // 레귤레이터
  k.cyl(MAT.bodyLight, 0.03, 0.015, [fx + 0.02, 1.36, fz + 0.08], [PI / 2, 0, 0], false); // 압력계
  k.cyl(MAT.bodyDark, 0.018, 0.04, [fx + 0.02, 1.35, fz + 0.04], undefined, false);
  k.pipe(M.tube, 0.008, [[fx + 0.06, 1.29, fz + 0.04], [x - 0.5, 1.29, fz + 0.04], [x - 0.5, 1.93, 0.62], [x - 0.12, 2.04, 0.3]]);
  hmi(k, -1.25, 0.95);
}

function LeakTester({ color, running }: P) {
  const kit = useMemo(() => kitOf(leakKit), []);
  const head = useMemo(
    () =>
      kitOf((k) => {
        const x = LEAK.x;
        k.cyl(MAT.steel, 0.03, 0.78, [x, 1.65, 0], undefined, false);
        for (const z of [-0.22, 0.22]) k.cyl(MAT.steel, 0.02, 0.78, [x, 1.65, z], undefined, false);
        k.box(MAT.bodyDark, [0.72, 0.07, 0.52], [x, 1.252, 0]);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(MAT.rubber, 0.035, 0.03, [x + sx * 0.27, 1.202, sz * 0.17], undefined, false);
        k.cyl(MAT.steel, 0.014, 0.1, [x + 0.15, 1.18, -0.16], undefined, false); // 시험 노즐
        k.pipe(M.tube, 0.008, [[x + 0.15, 1.29, -0.16], [x + 0.15, 1.3, -0.3], [x + 0.2, 1.9, -0.3]]);
      }),
    [],
  );
  return (
    <group>
      <KitMesh kit={kit} />
      <Mover pos={[0, 0.2, 0]} amp={-0.2} period={7} running={running} hold={0.5}>
        <KitMesh kit={head} />
      </Mover>
      <Stripe size={[1.21, 0.05, 0.1]} pos={[LEAK.x, 1.91, 0.62]} color={color} />
    </group>
  );
}

// ─────────── 배광·에이밍 검사기 (HL-PH-01) ───────────
// 암실 터널 +x 끝의 고니오미터가 램프를 들어 -x 끝 스크린에 비추고, 카메라가 컷오프·광도를 잰다. 앞쪽 지붕을 터 안이 보인다

const PH = { WH: 2.45, scrX: -2.75, lampX: 2.45, lampY: 1.78, cut: 1.74, gonX: 2.35 };

function photometryKit(k: Kit, running: boolean) {
  const [L, D] = FOOTPRINT.photometry;
  const { WH } = PH;
  const zb = -D / 2 + 0.03;
  const zf = D / 2 - 0.03;
  // 뒷벽 (안쪽 검정)
  k.box(MAT.bodyDark, [L, WH, 0.06], [0, WH / 2, zb]);
  k.box(M.black, [L - 0.12, WH - 0.05, 0.01], [0, WH / 2, zb + 0.035], undefined, false);
  k.box(M.black, [L - 0.12, 0.01, D - 0.12], [0, 0.006, 0], undefined, false);
  // 앞벽: 아래는 막고 위는 짙은 창
  k.box(MAT.bodyDark, [L, 0.95, 0.06], [0, 0.475, zf]);
  for (const x of [-L / 2 + 0.04, -1.5, 0, 1.5, L / 2 - 0.04]) k.box(MAT.frame, [0.08, WH - 0.95, 0.08], [x, 0.95 + (WH - 0.95) / 2, zf]);
  for (const x of [-2.25, -0.75, 0.75, 2.25]) k.box(M.tint, [1.42, WH - 1.05, 0.015], [x, 0.95 + (WH - 1.0) / 2, zf]);
  k.box(MAT.frame, [L, 0.1, 0.1], [0, WH - 0.05, zf]);
  // 지붕: 뒤쪽 절반만 덮고 앞쪽은 보만 남긴다
  k.box(MAT.bodyDark, [L, 0.05, D / 2], [0, WH, -D / 4]);
  for (const x of [-2.25, -0.75, 0.75, 2.25]) k.box(MAT.frame, [0.08, 0.08, D / 2], [x, WH - 0.04, D / 4]);
  // 양 끝벽 (컨베이어 통로 + 차광 커튼)
  for (const s of [-1, 1]) {
    const x = s * (L / 2 - 0.03);
    for (const z of [-1, 1]) k.box(MAT.bodyDark, [0.06, WH, D / 2 - 0.45], [x, WH / 2, z * (0.45 + (D / 2 - 0.45) / 2)]);
    k.box(MAT.bodyDark, [0.06, WH - 1.22, 0.9], [x, 1.22 + (WH - 1.22) / 2, 0]);
    for (let i = 0; i < 6; i++) k.box(M.black, [0.012, 0.14, 0.14], [x, 1.15, -0.375 + i * 0.15], undefined, false);
  }

  // 측정 스크린 (흰 막 + 테 + 기준선)
  const sx = PH.scrX;
  k.box(M.screenW, [0.03, 1.15, 2.7], [sx, 1.825, 0]);
  k.box(MAT.frame, [0.05, 0.05, 2.8], [sx, 2.425, 0], undefined, false);
  k.box(MAT.frame, [0.05, 0.05, 2.8], [sx, 1.225, 0], undefined, false);
  for (const z of [-1.38, 1.38]) k.box(MAT.frame, [0.05, 1.25, 0.05], [sx, 1.825, z], undefined, false);
  k.box(MAT.frame, [0.006, 1.15, 0.01], [sx + 0.017, 1.825, 0], undefined, false);
  k.box(MAT.frame, [0.006, 0.01, 2.7], [sx + 0.017, PH.lampY, 0], undefined, false);
  // 배광 패턴 (가동 중): 컷오프 아래 넓은 빛 + 오른쪽(-z) 15° 꺾임 + 밝은 점
  if (running) {
    const fx = sx + 0.02;
    const c = PH.cut;
    k.disc(M.beamDim, [0.5, 0.004, 2.3], [fx, c - 0.3, 0.05], [0, 0, PI / 2]);
    k.box(M.beamDim, [0.004, 0.3, 2.0], [fx + 0.001, c - 0.15, 0.15]);
    k.box(M.beam, [0.004, 0.16, 1.2], [fx + 0.002, c - 0.08, 0.5]);
    k.box(M.beam, [0.004, 0.12, 0.62], [fx + 0.002, c - 0.02, -0.38], [0.26, 0, 0]);
    k.box(M.beam, [0.004, 0.16, 0.2], [fx + 0.002, c - 0.08, 0.0]);
    k.disc(M.hot, [0.13, 0.004, 0.34], [fx + 0.003, c - 0.08, -0.1], [0, 0, PI / 2]);
  }

  // 고니오미터 (기둥 + 팔 + 회전 헤드). 램프·요크는 따로 돈다
  const gx = PH.gonX;
  k.box(MAT.frame, [0.4, 0.04, 0.4], [gx, 0.02, -0.95], undefined, false);
  k.box(MAT.bodyLight, [0.22, 2.2, 0.22], [gx, 1.1, -0.95]);
  k.box(MAT.bodyLight, [0.2, 0.15, 1.05], [gx, 2.2, -0.45]);
  k.cyl(MAT.bodyDark, 0.11, 0.1, [gx, 2.08, 0]);
  pallet(k, gx);

  // 측정 카메라
  k.cyl(MAT.frame, 0.03, 1.75, [1.75, 0.875, -0.8], undefined, false);
  k.box(MAT.frame, [0.3, 0.02, 0.3], [1.75, 0.01, -0.8], undefined, false);
  k.box(MAT.bodyDark, [0.24, 0.15, 0.15], [1.75, 1.84, -0.8]);
  k.cyl(MAT.frame, 0.05, 0.14, [1.57, 1.84, -0.8], [0, 0, PI / 2], false);
  k.cyl(MAT.screen, 0.035, 0.01, [1.495, 1.84, -0.8], [0, 0, PI / 2], false);

  hmi(k, 2.45, 1.82);
}

function Photometry({ color, running }: P) {
  const kit = useMemo(() => kitOf((k) => photometryKit(k, running)), [running]);
  const yoke = useMemo(
    () =>
      kitOf((k) => {
        k.box(MAT.steel, [0.1, 0.04, 0.78], [0, 2.01, 0]);
        for (const z of [-0.36, 0.36]) k.box(MAT.steel, [0.06, 0.26, 0.04], [0, 1.88, z], undefined, false);
        lampFacingMinusX(k, [PH.lampX - PH.gonX, PH.lampY, 0], { refl: true, led: true, lens: true, lit: running });
      }),
    [running],
  );
  const beamLen = PH.lampX - 0.29 - PH.scrX;
  return (
    <group>
      <KitMesh kit={kit} />
      <Mover pos={[PH.gonX, 0, 0]} axis={1} amp={0.06} period={6} running={running} turn hold={0.2}>
        <KitMesh kit={yoke} />
      </Mover>
      {running && (
        <mesh position={[PH.scrX + beamLen / 2, (PH.lampY + PH.cut - 0.2) / 2, 0]} rotation={[0, 0, PI / 2 + (PH.lampY - PH.cut + 0.2) / beamLen]} scale={[0.42, 1, 1]} material={M.beamVol}>
          <cylinderGeometry args={[0.95, 0.12, beamLen, 24, 1, true]} />
        </mesh>
      )}
      <Stripe size={[6.01, 0.08, 0.065]} pos={[0, 0.9, 1.57]} color={color} />
    </group>
  );
}

// ─────────── EOL 점등·통신 검사기 (HL-EOL-01) ───────────
// 커넥터를 자동으로 꽂고 → 로우·하이빔, DRL, 방향지시등을 차례로 켜며 전류와 LIN 응답을 본다. 위 카메라가 점등을 확인

const EOL = { x: -0.2 };

function lampEolKit(k: Kit) {
  const x = EOL.x;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      k.box(MAT.steel, [0.06, 1.95, 0.06], [x + sx * 0.5, 0.975, sz * 0.58]);
      k.box(MAT.frame, [0.15, 0.02, 0.15], [x + sx * 0.5, 0.01, sz * 0.58], undefined, false);
    }
  for (const z of [-0.58, 0.58]) k.box(MAT.bodyLight, [1.08, 0.08, 0.08], [x, 1.98, z]);
  for (const sx of [-1, 1]) k.box(MAT.bodyLight, [0.08, 0.08, 1.24], [x + sx * 0.5, 1.98, 0]);
  k.box(MAT.bodyLight, [0.12, 0.08, 1.24], [x, 1.98, 0]);
  // 점등 확인 카메라 + 조명 링
  k.box(MAT.body, [0.3, 0.16, 0.3], [x, 1.86, 0]);
  k.cyl(MAT.frame, 0.06, 0.1, [x, 1.73, 0], undefined, false);
  k.cyl(MAT.screen, 0.045, 0.01, [x, 1.675, 0], undefined, false);
  k.box(M.guard, [0.94, 1.0, 0.012], [x, 1.42, -0.58]);
  curtain(k, [x - 0.58, 0.66], [x + 0.58, 0.66], 1.3);

  // 검사 지그: 팰릿 + 램프 + 커넥터 자동 체결 유닛
  pallet(k, x);
  k.at([x, PT, 0], undefined, () => lamp(k, { refl: true, led: true, lens: true }));
  k.box(MAT.steel, [0.05, 0.05, 0.5], [x + 0.5, 0.98, -0.33], undefined, false);
  k.box(MAT.steel, [0.2, 0.06, 0.09], [x + 0.46, PT + 0.08, -0.1]);
  k.cyl(MAT.steel, 0.018, 0.12, [x + 0.6, PT + 0.08, -0.1], [0, 0, PI / 2], false);
  k.box(MAT.frame, [0.05, 0.05, 0.06], [x + 0.34, PT + 0.08, -0.1], undefined, false);
  k.pipe(M.hose, 0.014, [[x + 0.56, PT + 0.1, -0.1], [x + 0.56, 1.9, -0.45], [-1.2, 1.95, -0.7], [-1.25, 1.82, -0.85]]);
  pallet(k, -1.35);
  k.at([-1.35, PT, 0], undefined, () => lamp(k, { refl: true, led: true, lens: true }));
  pallet(k, 1.25);
  k.at([1.25, PT, 0], undefined, () => lamp(k, { refl: true, led: true, lens: true }));

  rack(k, -1.25, -0.85, 1.8, ['pc', 'psu', 'psu', 'meter', 'comm']);
  hmi(k, 1.0, 0.95);
}

/** EOL 점등 순서: 로우 → 하이 → DRL → 방향지시등 깜박임 (4 s 주기) */
const EOL_STEP = (t: number) => Math.floor(t % 4);

function LampEol({ color, running }: P) {
  const kit = useMemo(() => kitOf(lampEolKit), []);
  const x = EOL.x;
  const y = PT;
  return (
    <group>
      <KitMesh kit={kit} />
      <Blink running={running} on={(t) => EOL_STEP(t) <= 1}>
        <Cyl r={0.095} h={0.008} pos={[x - 0.13, y + 0.235, -0.02]} mat={M.lit} seg={18} />
      </Blink>
      <Blink running={running} on={(t) => EOL_STEP(t) === 1}>
        <Cyl r={0.095} h={0.008} pos={[x + 0.13, y + 0.235, -0.02]} mat={M.lit} seg={18} />
      </Blink>
      <Blink running={running} on={(t) => EOL_STEP(t) === 2}>
        <Box size={[0.41, 0.018, 0.03]} pos={[x - 0.04, y + 0.22, 0.15]} mat={M.lit} cast={false} />
      </Blink>
      <Blink running={running} on={(t) => EOL_STEP(t) === 3 && t % 0.5 < 0.25}>
        <Box size={[0.055, 0.018, 0.105]} pos={[x + 0.255, y + 0.22, 0.06]} mat={M.amber} cast={false} />
      </Blink>
      <Stripe size={[1.09, 0.05, 0.09]} pos={[x, 1.915, 0.58]} color={color} />
    </group>
  );
}

// ─────────── BMS EOL 시험기 (EM-EOL-B) ───────────
// 안전 후드가 내려와 접촉 핀을 커넥터에 대고 → 절연저항(500 V), CAN 진단, 펌웨어·DTC를 확인한다

function bmsEolKit(k: Kit, running: boolean) {
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      k.box(MAT.steel, [0.05, 1.7, 0.05], [sx * 0.4, 0.85, sz * 0.5]);
      k.box(MAT.frame, [0.14, 0.02, 0.14], [sx * 0.4, 0.01, sz * 0.5], undefined, false);
    }
  k.box(MAT.bodyLight, [0.86, 0.06, 1.06], [0, 1.72, 0]);
  k.cyl(MAT.steel, 0.06, 0.3, [0, 1.9, 0]);
  k.cyl(running ? M.redLit : M.red, 0.05, 0.1, [0.3, 1.8, -0.38]); // 고전압 경고등
  k.box(MAT.safety, [0.14, 0.09, 0.006], [0.25, 1.62, 0.533], undefined, false);
  k.box(M.guard, [0.76, 0.8, 0.012], [0, 1.2, -0.5]);
  pallet(k, 0, 0.42, 0.4);
  k.at([0, PT, 0], undefined, () => bms(k, true));
  for (const x of [-1.0, 1.0]) {
    pallet(k, x, 0.42, 0.4);
    k.at([x, PT, 0], undefined, () => bms(k, true));
  }
  rack(k, -1.15, -0.85, 1.3, ['hipot', 'comm', 'psu', 'pc'], running);
  k.pipe(M.hose, 0.012, [[0.1, 1.72, -0.53], [-0.4, 1.5, -0.72], [-0.88, 1.31, -0.85]]);
  hmi(k, 1.0, 0.95);
}

function BmsEol({ color, running }: P) {
  const kit = useMemo(() => kitOf((k) => bmsEolKit(k, running)), [running]);
  const hood = useMemo(
    () =>
      kitOf((k) => {
        k.cyl(MAT.steel, 0.025, 0.6, [0, 1.5, 0], undefined, false);
        k.box(MAT.bodyDark, [0.56, 0.03, 0.46], [0, 1.2, 0]);
        k.box(M.guard, [0.56, 0.32, 0.46], [0, 1.027, 0]);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(MAT.steel, [0.02, 0.32, 0.02], [sx * 0.27, 1.027, sz * 0.22], undefined, false);
        k.box(MAT.bodyDark, [0.08, 0.14, 0.12], [0.165, 1.11, 0], undefined, false); // 접촉 핀 헤드
        for (let i = 0; i < 6; i++) k.cyl(MAT.steel, 0.004, 0.1, [0.165, 0.995, -0.05 + i * 0.02], undefined, false);
      }),
    [],
  );
  return (
    <group>
      <KitMesh kit={kit} />
      <Mover pos={[0, 0.25, 0]} amp={-0.25} period={7} running={running} hold={0.5}>
        <KitMesh kit={hood} />
      </Mover>
      <Stripe size={[0.87, 0.05, 1.07]} pos={[0, 1.665, 0]} color={color} />
    </group>
  );
}

// ─────────── 미러 기능 검사기 (OSM-FT-01) ───────────
// 방음 부스 안 폴딩 지그가 미러를 접었다 폈다 하며 시간·모터 전류·소음(마이크)을 재고, 히터 전류와 턴시그널을 확인한다

const FT = { pivot: [-0.15, PT + 0.36, 0] as V3, bx: 1.25, bz: 1.1, bh: 2.05 };

/** 차 문 모양 지그에 세운 미러 (x = 팰릿 가운데). head가 거짓이면 베이스만 */
function mirrorFixture(k: Kit, x: number, head: boolean) {
  pallet(k, x, 0.56, 0.6);
  k.box(MAT.bodyLight, [0.04, 0.55, 0.42], [x - 0.2, BT + 0.035 + 0.275, -0.05]);
  k.box(MAT.steel, [0.2, 0.04, 0.3], [x - 0.12, BT + 0.055, -0.05], undefined, false);
  k.at([x + FT.pivot[0], FT.pivot[1], 0], undefined, () => {
    mirrorBase(k);
    if (head) mirrorHead(k, { cover: true, glass: true });
  });
}

function functionKit(k: Kit) {
  const { bx, bz, bh } = FT;
  const t = 0.1;
  // 방음 부스
  k.box(M.booth, [2 * bx, bh, t], [0, bh / 2, -bz + t / 2]);
  k.box(M.booth, [1.85, 0.95, t], [-0.325, 0.475, bz - t / 2]);
  k.box(M.booth, [0.15, 1.1, t], [-bx + 0.075, 1.5, bz - t / 2]);
  k.box(M.booth, [0.1, 1.1, t], [0.55, 1.5, bz - t / 2]);
  k.box(M.booth, [1.6, 0.2, t], [-0.3, bh - 0.1, bz - t / 2]);
  k.box(MAT.glass, [1.6, 0.9, 0.02], [-0.3, 1.4, bz - t / 2]);
  for (const y of [0.97, 1.86]) k.box(MAT.frame, [1.62, 0.03, 0.04], [-0.3, y, bz - 0.02], undefined, false);
  k.box(MAT.bodyLight, [0.64, bh - 0.05, 0.12], [0.92, bh / 2, bz - 0.04]); // 문
  k.cyl(MAT.steel, 0.015, 0.3, [0.67, 1.1, bz + 0.05], undefined, false);
  for (const y of [0.4, 1.6]) k.box(MAT.steel, [0.04, 0.12, 0.04], [1.23, y, bz + 0.03], undefined, false);
  for (const z of [-bz + 0.05, bz - 0.05]) k.box(M.booth, [2 * bx, t, 0.1], [0, bh + t / 2, z]);
  for (const x of [-bx + 0.05, 0, bx - 0.05]) k.box(M.booth, [0.1, t, 2 * bz], [x, bh + t / 2, 0]);
  k.box(MAT.glass, [2 * bx - 0.1, 0.02, 2 * bz - 0.1], [0, bh + t / 2, 0]); // 관찰 창 지붕
  for (const s of [-1, 1]) {
    const x = s * (bx - t / 2);
    for (const z of [-1, 1]) k.box(M.booth, [t, bh, bz - 0.42], [x, bh / 2, z * (0.42 + (bz - 0.42) / 2)]);
    k.box(M.booth, [t, bh - 1.2, 0.84], [x, 1.2 + (bh - 1.2) / 2, 0]);
    k.box(MAT.bodyLight, [0.04, 0.45, 0.9], [x + s * 0.08, 1.45, 0]); // 들어 올린 방음 도어
    for (const z of [-0.47, 0.47]) k.box(MAT.steel, [0.03, 1.1, 0.03], [x + s * 0.08, 0.75, z], undefined, false);
  }
  // 흡음재 (뒷벽 안쪽)
  for (let i = 0; i < 9; i++) for (let j = 0; j < 6; j++) k.box(M.foam, [0.17, 0.17, 0.06], [-1.04 + i * 0.26, 0.3 + j * 0.3, -bz + t + 0.03], [0, 0, PI / 4], false);

  // 폴딩 지그 + 측정 마이크
  mirrorFixture(k, 0, false);
  k.pipe(M.hose, 0.01, [[-0.22, FT.pivot[1] - 0.05, -0.08], [-0.3, 1.0, -0.55], [-0.3, 1.0, -bz + 0.15]]);
  k.cyl(MAT.frame, 0.018, 1.5, [0.3, 0.75, -0.7], undefined, false);
  k.box(MAT.frame, [0.3, 0.02, 0.3], [0.3, 0.01, -0.7], undefined, false);
  k.pipe(MAT.frame, 0.01, [[0.3, 1.5, -0.7], [-0.04, 1.5, -0.22]]);
  k.cyl(MAT.bodyDark, 0.016, 0.12, [-0.04, 1.43, -0.22], undefined, false);
  k.sph(MAT.steel, 0.02, [-0.04, 1.36, -0.22], false);

  // 앞뒤 대기 팰릿 (세운 미러)
  mirrorFixture(k, -1.65, true);
  mirrorFixture(k, 1.65, true);

  rack(k, -1.65, -1.0, 1.6, ['pc', 'daq', 'meter', 'psu']);
  k.pipe(M.hose, 0.014, [[-1.4, 1.5, -0.95], [-bx, 1.5, -0.95]]);
  hmi(k, 1.7, 1.15);
}

function FunctionTester({ color, running }: P) {
  const kit = useMemo(() => kitOf(functionKit), []);
  const head = useMemo(() => kitOf((k) => mirrorHead(k, { cover: true, glass: true })), []);
  return (
    <group>
      <KitMesh kit={kit} />
      <Mover pos={[FT.pivot[0], FT.pivot[1], 0]} axis={1} amp={-1.35} period={10} running={running} turn hold={0.3}>
        <KitMesh kit={head} />
        <Blink running={running} on={(t) => t % 0.8 < 0.4}>
          <Box size={[0.152, 0.026, 0.032]} pos={[0.29, 0.125, -0.07]} mat={M.amber} cast={false} />
        </Blink>
      </Mover>
      <Stripe size={[2 * FT.bx + 0.02, 0.08, 0.04]} pos={[0, FT.bh - 0.06, FT.bz + 0.005]} color={color} />
    </group>
  );
}

// ─────────── 포장 셀 (HL·EM·OSM PK) ───────────
// 라벨 인쇄·부착 → 바코드 판독 → 협동로봇이 출하 용기(램프: 회수용 용기, BMS: ESD 트레이, 미러: L/R 박스)에 담는다

type Line = 'HL' | 'EM' | 'OSM';
const PK = {
  bot: [0.2, 0.7, -0.75] as V3,
  label: -1.2,
  scan: -0.85,
  pick: 0.2,
  box: [1.2, -1.0] as const,
};
/** 제품 윗면 높이 (라벨 패드가 닿는 곳) */
const PK_TOP: Record<Line, number> = { HL: PT + 0.29, EM: PT + 0.07, OSM: PT + 0.142 };
const PK_PATH: Record<Line, PathFn> = {
  HL: stopsPath(PK.bot, [[PK.pick, PK_TOP.HL, 0], [0.84, 0.98, -1.0]], 0.22),
  EM: stopsPath(PK.bot, [[PK.pick, PK_TOP.EM, 0], [1.04, 1.12, -1.01]], 0.22),
  OSM: stopsPath(PK.bot, [[PK.pick, PK_TOP.OSM, 0], [1.2, 1.0, -0.87]], 0.22),
};

function product(k: Kit, line: Line, x: number) {
  if (line === 'HL') {
    pallet(k, x);
    k.at([x, PT, 0], undefined, () => lamp(k, { refl: true, led: true, lens: true }));
  } else if (line === 'EM') {
    pallet(k, x, 0.42, 0.4);
    k.at([x, PT, 0], undefined, () => bms(k, true));
  } else {
    pallet(k, x, 0.56, 0.6);
    mirrorLying(k, x, { cover: true, glass: true });
  }
}

function packerKit(k: Kit, line: Line, running: boolean) {
  // 컨베이어 위 팰릿: 라벨 위치, 집는 위치, 빈 팰릿
  product(k, line, PK.label);
  product(k, line, PK.pick);
  pallet(k, 1.4, line === 'EM' ? 0.42 : line === 'OSM' ? 0.56 : 0.7, line === 'EM' ? 0.4 : 0.56);

  // 라벨 프린터·부착기
  const lx = PK.label;
  k.box(MAT.frame, [0.3, 0.02, 0.3], [lx, 0.01, -0.7], undefined, false);
  k.box(MAT.frame, [0.08, 1.6, 0.08], [lx, 0.8, -0.7]);
  k.box(MAT.bodyLight, [0.38, 0.36, 0.42], [lx, 1.58, -0.42]);
  k.box(MAT.screen, [0.12, 0.07, 0.01], [lx - 0.08, 1.64, -0.205], undefined, false);
  k.cyl(M.label, 0.11, 0.07, [lx + 0.24, 1.62, -0.45], [0, 0, PI / 2], false);
  k.cyl(MAT.bodyDark, 0.04, 0.08, [lx + 0.24, 1.62, -0.45], [0, 0, PI / 2], false);
  k.cyl(MAT.steel, 0.03, 0.22, [lx, 1.5, -0.12], undefined, false); // 탬프 실린더

  // 바코드 스캐너
  const sx = PK.scan;
  k.cyl(MAT.frame, 0.02, 1.25, [sx, 0.625, 0.62], undefined, false);
  k.box(MAT.frame, [0.2, 0.02, 0.2], [sx, 0.01, 0.62], undefined, false);
  k.at([sx, 1.32, 0.52], [0.6, -0.6, 0], () => {
    k.box(MAT.bodyDark, [0.1, 0.08, 0.15], [0, 0, 0], undefined, false);
    k.box(running ? M.laser : MAT.screen, [0.06, 0.02, 0.006], [0, 0, -0.078], undefined, false);
  });
  if (running) k.pipe(M.laser, 0.002, [[sx - 0.04, 1.27, 0.46], [PK.label + 0.05, PK_TOP[line] + 0.01, -0.12]]);

  // 협동로봇 받침 + 안전 구역
  pedestal(k, PK.bot);
  k.box(MAT.safety, [0.1, 0.07, 0.1], [PK.bot[0], 0.3, PK.bot[2] + 0.2], undefined, false); // 에어리어 스캐너
  floorZone(k, -0.4, 1.9, -1.45, -0.45);

  const [bx, bz] = PK.box;
  if (line === 'HL') {
    // 회수용 전용 용기 (덤니지 칸에 램프를 세워 넣는다)
    k.box(MAT.pallet, [1.2, 0.14, 0.9], [bx, 0.07, bz]);
    k.box(MAT.tote, [1.16, 0.04, 0.86], [bx, 0.16, bz]);
    for (const z of [-0.41, 0.41]) k.box(MAT.tote, [1.16, 0.55, 0.04], [bx, 0.455, bz + z]);
    for (const x of [-0.56, 0.56]) k.box(MAT.tote, [0.04, 0.55, 0.86], [bx + x, 0.455, bz]);
    for (const x of [-0.18, 0.18]) k.box(MAT.bodyDark, [0.03, 0.4, 0.78], [bx + x, 0.38, bz], undefined, false);
    for (const x of [0, 0.36]) lampFacingMinusX(k, [bx + x + 0.15, 0.395, bz], { refl: true, led: true, lens: true });
    // 접어 둔 빈 용기 (앞쪽)
    k.box(MAT.pallet, [1.2, 0.14, 0.9], [bx, 0.07, 0.95]);
    for (let i = 0; i < 2; i++) bin(k, [bx, 0.14 + i * 0.17, 0.95], 1.16, 0.86, 0.16);
  } else if (line === 'EM') {
    // ESD 트레이 대차 (맨 위 트레이에 BMS 2×2)
    cart(k, bx, bz + 0.1, 0.8, 0.6, (k) => {
      for (let i = 0; i < 6; i++) k.box(M.esd, [0.66, 0.035, 0.46], [0, 0.018 + i * 0.037, 0], undefined, false);
      for (let i = 1; i < 4; i++) k.at([-0.16 + (i % 2) * 0.32, 0.22, -0.11 + Math.floor(i / 2) * 0.22], undefined, () => bms(k, true));
    });
    // 빈 트레이 더미
    k.box(MAT.bodyDark, [0.7, 0.08, 0.5], [bx, 0.06, 0.95]);
    for (let i = 0; i < 10; i++) k.box(M.esd, [0.66, 0.035, 0.46], [bx, 0.12 + i * 0.037, 0.95], undefined, false);
  } else {
    // L/R 한 쌍 박스 (포장대 위) + 출하 박스 팔레트
    table(k, bx, bz, 0.9, 0.7, 0.75);
    k.box(MAT.carton, [0.7, 0.012, 0.52], [bx, 0.756, bz]);
    for (const z of [-0.26, 0.26]) k.box(MAT.carton, [0.7, 0.25, 0.01], [bx, 0.875, bz + z]);
    for (const x of [-0.35, 0.35]) k.box(MAT.carton, [0.01, 0.25, 0.52], [bx + x, 0.875, bz]);
    for (const z of [-0.33, 0.33]) k.box(MAT.carton, [0.68, 0.01, 0.15], [bx, 1.02, bz + z * 1.0], [z > 0 ? -0.6 : 0.6, 0, 0], false);
    k.box(MAT.carton, [0.68, 0.2, 0.01], [bx, 0.86, bz], undefined, false);
    k.at([0, -PT + 0.78, bz - 0.13], undefined, () => mirrorLying(k, bx, { cover: true, glass: true })); // L (R 칸은 로봇이 채운다)
    k.box(MAT.pallet, [1.2, 0.14, 1.0], [bx, 0.07, 0.95]);
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++)
        for (let l = 0; l < 2; l++) {
          const p: V3 = [bx - 0.3 + i * 0.6, 0.29 + l * 0.3, 0.72 + j * 0.47];
          k.box(MAT.carton, [0.58, 0.29, 0.45], p);
          if (j === 1) k.box(M.label, [0.14, 0.09, 0.004], [p[0] + 0.12, p[1], p[2] + 0.227], undefined, false);
        }
  }
  cabinet(k, -1.45, 1.1, 0.7, 1.15, 0.45);
  hmi(k, -0.75, 1.15);
}

function Packer({ line, color, running }: P & { line: Line }) {
  const kit = useMemo(() => kitOf((k) => packerKit(k, line, running)), [line, running]);
  const pad = useMemo(
    () =>
      kitOf((k) => {
        const top = PK_TOP[line];
        k.cyl(MAT.steel, 0.012, 1.42 - top, [PK.label, top + 0.05 + (1.42 - top) / 2, -0.12], undefined, false);
        k.box(MAT.bodyDark, [0.13, 0.03, 0.11], [PK.label, top + 0.035, -0.12], undefined, false);
        k.box(M.label, [0.1, 0.004, 0.08], [PK.label, top + 0.018, -0.12], undefined, false);
      }),
    [line],
  );
  const lift = 1.3 - PK_TOP[line] - 0.016;
  return (
    <group>
      <KitMesh kit={kit} />
      <Mover pos={[0, lift, 0]} amp={-lift} period={4} running={running} hold={0.2}>
        <KitMesh kit={pad} />
      </Mover>
      <Robot base={PK.bot} sz={1.25} path={PK_PATH[line]} period={line === 'EM' ? 5 : 7} running={running} tool={line === 'HL' ? 'grip' : 'vacuum'} />
      <Stripe size={[0.71, 0.08, 0.46]} pos={[-1.45, 1.0, 1.1]} color={color} />
    </group>
  );
}

// ─────────── 진입점 ───────────

export function AssemblyMachine({ def, color, running }: MachineProps) {
  const osm = def.code.startsWith('OSM');
  const em = def.code.startsWith('EM');
  switch (def.kind) {
    case 'assembly-cell':
      return osm ? <MirrorAssyCell color={color} running={running} /> : <LampAssyCell color={color} running={running} />;
    case 'actuator-cell':
      return <ActuatorCell color={color} running={running} />;
    case 'screw-cell':
      return <ScrewCell color={color} running={running} />;
    case 'sealer':
      return <Sealer color={color} running={running} />;
    case 'leak-tester':
      return <LeakTester color={color} running={running} />;
    case 'photometry':
      return <Photometry color={color} running={running} />;
    case 'eol-tester':
      return em ? <BmsEol color={color} running={running} /> : <LampEol color={color} running={running} />;
    case 'function-tester':
      return <FunctionTester color={color} running={running} />;
    case 'packer':
      return <Packer line={osm ? 'OSM' : em ? 'EM' : 'HL'} color={color} running={running} />;
    default: {
      const [L, D, H] = FOOTPRINT[def.kind];
      return <Box size={[L, H, D]} pos={[0, H / 2, 0]} mat={MAT.body} />;
    }
  }
}

/** 고른 설비의 부위 이름표 (설비 원점 기준 좌표) */
export function assemblyCallouts(def: StationDef): Callout[] {
  const osm = def.code.startsWith('OSM');
  const em = def.code.startsWith('EM');
  switch (def.kind) {
    case 'assembly-cell':
      if (osm)
        return [
          { text: '협동로봇', at: [MAS.bot[0] + 0.3, 1.75, MAS.bot[2] + 0.4], note: '도장 커버와 미러 글래스를 집어 팰릿 위 미러에 얹는다' },
          { text: '커버 공급 랙', at: [MAS.cover[0] - 0.3, 1.55, MAS.cover[1]], note: '도장을 마친 커버를 경사 선반으로 로봇 앞까지 내려 보낸다' },
          { text: '글래스 랙', at: [MAS.glass[0], 1.6, MAS.glass[1]], note: '히팅 미러 글래스를 칸마다 세워 보관한다' },
          { text: '글래스 압입 프레스', at: [MAS.press, 2.55, 0], note: '공압 실린더 두 개로 글래스를 눌러 끼운다 (압입력 100~145 N 관리)' },
          { text: '너트러너', at: [MAS.nut[0], 1.65, MAS.nut[1]], note: '밸런서 팔에 매단 공구로 체결 토크를 재며 나사를 조인다' },
          { text: '하네스·LED 부품함', at: [2.4, 1.25, 1.85], note: '작업자가 턴시그널 LED와 하네스를 꺼내 꽂는다' },
        ];
      return [
        { text: '협동로봇', at: [HAS.a[0] + 0.35, 1.75, HAS.a[2] + 0.45], note: '증착 리플렉터를 집어 하우징에 넣는다. 옆 로봇은 LED 모듈을 얹는다' },
        { text: '리플렉터 랙', at: [HAS.rack[0] - 0.35, 1.65, HAS.rack[1]], note: '증착을 마친 리플렉터를 경사 선반으로 로봇 앞까지 내려 보낸다' },
        { text: 'LED 모듈 트레이', at: [HAS.tray[0], 1.15, HAS.tray[1]], note: '로우·하이빔 LED 모듈을 정전기 방지(ESD) 트레이로 공급한다' },
        { text: '너트러너', at: [HAS.nut[0], 1.65, HAS.nut[1]], note: '밸런서 팔에 매단 공구로 체결 토크(약 1.2 N·m)를 재며 나사를 조인다' },
        { text: '팰릿 컨베이어', at: [-2.2, 1.3, 0], note: '하우징을 실은 지그 팰릿이 작업 위치마다 스토퍼에 멈춘다' },
        { text: '라이트 커튼', at: [HAS.curtainX, 1.95, 1.5], note: '작업자 손이 로봇 구역에 들어오면 로봇을 멈춘다' },
      ];
    case 'actuator-cell':
      return [
        { text: '삽입 로봇', at: [ACT.ins[0], 1.95, ACT.ins[2]], note: '모터·웜기어·클러치를 집어 브래킷에 넣는다' },
        { text: '부품 공급 랙', at: [ACT.rack[0], 1.5, ACT.rack[1]], note: '모터·웜기어·클러치를 상자째 경사 선반으로 공급한다' },
        { text: '기어 압입 프레스', at: [ACT.press, 2.2, -0.3], note: '서보 프레스가 웜기어를 모터 축에 눌러 끼운다' },
        { text: '그리스 도포기', at: [ACT.grease, 1.85, 0], note: '웜기어에 그리스를 정량(약 120 mg) 짠다. 모자라면 소음·전류가 오른다' },
        { text: '체결 로봇', at: [ACT.scr[0], 1.95, ACT.scr[2]], note: '나사 공급기에서 나사를 받아 커버를 0.8 N·m로 조인다' },
      ];
    case 'screw-cell':
      return [
        { text: '자동 드라이버', at: [SCR.drive, 2.2, 0], note: 'XYZ 축이 나사 네 구멍으로 옮겨 다니며 M3 나사를 약 1.05 N·m로 조인다' },
        { text: '나사 공급기', at: [SCR.feed[0], 1.4, -0.85], note: '스텝 피더가 나사를 한 개씩 세워 드라이버가 받는 자리로 내보낸다' },
        { text: '기판 투입 로봇', at: [SCR.bot[0], 1.75, SCR.bot[2]], note: '기능 시험을 마친 기판을 집어 하우징에 넣는다' },
        { text: '하우징 지그', at: [SCR.drive, 1.15, 0.38], note: '팰릿 위 하우징을 클램프로 밀어 나사 구멍 위치를 맞춘다' },
      ];
    case 'sealer':
      return [
        { text: '도포 로봇', at: [SEAL.bot[0], 2.25, SEAL.bot[2]], note: '6축 로봇이 하우징 홈을 따라 노즐을 한 바퀴 돌리며 실런트를 짠다' },
        { text: '핫멜트 용융기', at: [SEAL.melter[0], 1.3, SEAL.melter[1]], note: '실런트를 약 190 °C로 녹여 펌프로 밀어 보낸다' },
        { text: '가열 호스', at: [-1.7, 0.55, -1.15], note: '실런트가 굳지 않게 데우면서 로봇 노즐까지 보낸다' },
        { text: '렌즈 압착 프레스', at: [SEAL.press, 2.65, 0], note: '공압 실린더가 코팅 렌즈를 실런트 위에 약 20 s 눌러 붙인다' },
        { text: '렌즈 매거진', at: [SEAL.press, 1.15, -1.32], note: '하드코팅을 마친 렌즈를 간지와 함께 쌓아 두고 하나씩 쓴다' },
      ];
    case 'leak-tester':
      return [
        { text: '시험 헤드', at: [LEAK.x - 0.2, 1.75, 0.3], note: '내려와 렌즈를 누르고 벤트 구멍에 노즐을 물려 램프 안을 밀폐한다' },
        { text: '압력 감쇠 측정기', at: [1.15, 1.45, -0.9], note: '30 mbar로 가압한 뒤 30 s 동안 압력이 얼마나 빠지는지 잰다 (10 mbar 넘게 빠지면 누설)' },
        { text: '레귤레이터·필터', at: [LEAK.fx, 1.55, 0.7], note: '공장 압축 공기를 걸러 시험 압력으로 낮춘다' },
        { text: '검사 지그', at: [LEAK.x + 0.3, 1.25, 0.25], note: '팰릿 위 램프를 정위치에 잡아 헤드와 맞춘다' },
      ];
    case 'photometry':
      return [
        { text: '암실 터널', at: [0, PH.WH + 0.2, -0.8], note: '바깥 빛을 막아 램프 빛만 찍히게 한다 (암실 조도 0.5 lux 안팎)' },
        { text: '측정 스크린', at: [PH.scrX, 2.6, 0.4], note: '램프 빛이 맺히는 흰 막. 컷오프 선과 가장 밝은 점이 여기 생긴다' },
        { text: '측정 카메라', at: [1.75, 2.1, -0.8], note: '스크린의 빔을 찍어 컷오프 위치·각도와 최대 광도를 계산한다' },
        { text: '고니오미터', at: [PH.gonX, 2.55, -0.2], note: '램프를 들어 잡고 각도를 미세하게 돌려 광축을 맞춘다' },
        { text: '조작 단말', at: [2.45, 1.85, 1.82], note: '광축 편차와 합격·불합격을 보여 준다' },
      ];
    case 'eol-tester':
      if (em)
        return [
          { text: '안전 후드', at: [0, 1.6, 0.35], note: '절연 시험 동안 내려와 고전압에 손이 닿지 않게 덮는다' },
          { text: '접촉 핀 헤드', at: [0.2, 1.45, 0], note: '스프링 핀을 커넥터에 대 전원과 CAN 선을 잇는다' },
          { text: '절연저항 시험기', at: [-1.15, 1.5, -0.85], note: '500 V를 걸어 절연저항을 잰다 (100 MΩ 이상이면 합격)' },
          { text: '고전압 경고등', at: [0.3, 2.05, -0.38], note: '시험 전압이 걸려 있는 동안 켜진다' },
          { text: 'CAN 진단기', at: [-1.15, 0.95, -0.5], note: '진단 요청을 보내 응답·펌웨어 버전·DTC를 읽는다' },
        ];
      return [
        { text: '커넥터 체결 유닛', at: [EOL.x + 0.5, 1.3, -0.1], note: '커넥터를 자동으로 꽂아 13.5 V 전원과 LIN 신호를 넣는다' },
        { text: '점등 확인 카메라', at: [EOL.x, 2.25, 0], note: '로우·하이빔, DRL, 방향지시등이 순서대로 켜지는지 본다' },
        { text: '시험 랙', at: [-1.25, 2.05, -0.85], note: '전원 공급기·전류계·LIN 인터페이스가 들어 있다 (소비 전류 1.65~1.95 A)' },
        { text: '작업자 화면', at: [1.0, 1.85, 0.95], note: '검사 단계와 합격·불합격을 보여 준다' },
      ];
    case 'function-tester':
      return [
        { text: '방음 부스', at: [-0.6, FT.bh + 0.25, -0.5], note: '바깥 소음을 막아 접힘 소음(47 dB(A) 이하)을 정확히 잰다' },
        { text: '폴딩 지그', at: [0.05, 1.55, 0.1], note: '미러를 차 문처럼 세워 잡고 접기·펴기를 반복시킨다 (폴딩 시간 측정)' },
        { text: '측정 마이크', at: [-0.04, 1.65, -0.35], note: '액추에이터 가까이(약 20 cm)에서 작동 소음을 잰다' },
        { text: '시험 랙', at: [-1.65, 1.85, -1.0], note: '모터 전류·히터 전류를 재고 턴시그널 점등을 확인한다' },
        { text: '작업자 화면', at: [1.7, 1.85, 1.15], note: '측정값과 합격·불합격을 보여 준다' },
      ];
    case 'packer': {
      const box =
        def.code.startsWith('HL')
          ? { text: '회수용 용기', note: '램프를 칸막이에 세워 담는다. 가득 차면 AMR이 완제품 창고로 옮긴다' }
          : em
            ? { text: 'ESD 트레이', note: '정전기를 흘려보내는 트레이 칸에 BMS를 담아 쌓는다' }
            : { text: 'L/R 박스', note: '좌·우 미러를 한 쌍씩 칸막이 박스에 넣는다' };
      return [
        { text: '라벨 프린터', at: [PK.label, 1.95, -0.42], note: '출하 라벨을 인쇄해 패드로 제품에 찍어 붙인다' },
        { text: '바코드 스캐너', at: [PK.scan, 1.6, 0.55], note: '붙인 라벨을 읽어 판독이 되는지 확인한다' },
        { text: '적재 협동로봇', at: [PK.bot[0], 2.15, PK.bot[2]], note: '완제품을 집어 출하 용기에 담는다' },
        { text: box.text, at: [PK.box[0], 1.35, PK.box[1]], note: box.note },
      ];
    }
    default:
      return [];
  }
}
