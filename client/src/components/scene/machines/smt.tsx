'use client';

// 전장(SMT) 설비: 레이저 마커, 솔더 인쇄기, SPI, 마운터, 리플로우, AOI, 라우터 + 협동로봇, ICT, 컨포멀 코터, FCT
// (전장 모듈 라인: LED 모듈 줄 + BMS 줄)
// 인라인 설비는 같은 꼴을 나눈다: 어두운 받침 + 회색 아래 캐비닛(라인 색 띠) + 흰 덮개(앞·지붕 유리) + 기판 레일(SMEMA) + 조작 화면.
// 덮개 안에 설비마다 다른 속(스텐실·피더·갠트리·프레스…)이 보이고, 기판이 레일을 따라 들어와 작업 위치에서 멈췄다 나간다.
import { useFrame } from '@react-three/fiber';
import { type ReactNode, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { EquipmentKind, StationDef, StationState } from '@lumitwin/shared';
import { Box, Cyl, MAT, RobotArm, Stripe, std } from '../parts';
import { BELT_TOP, type Callout, FOOTPRINT, HeatPanel, type MachineProps, type V3 } from './common';

export const SMT_KINDS = ['laser-marker', 'printer', 'spi', 'mounter', 'reflow', 'aoi', 'router-cobot', 'ict', 'coater', 'fct'] as const satisfies readonly EquipmentKind[];

// ─────────── 재질 (모듈에서 한 번만 만든다) ───────────

const PASTE = '#b9bfc6';
const M = {
  pcb: std('#1f6e3c', 0.15, 0.5), // BMS 기판 (녹색 레지스트)
  mcpcb: std('#dfe3e6', 0.3, 0.4), // LED 기판 (알루미늄 MCPCB)
  part: std('#ffffff', 0.25, 0.5), // 기판 위 부품 (인스턴스 색)
  rail: std('#b4bdc7', 0.35, 0.4), // SMEMA 레일·리니어 가이드
  alu: std('#c9d0d7', 0.35, 0.4), // 알루미늄 프레임·빔
  stainless: std('#c5ccd3', 0.35, 0.35), // 스테인리스 (덕트·탱크·기둥)
  stencil: std('#d9e0e7', 0.45, 0.25),
  aperture: std('#3b4149', 0.5, 0.4),
  paste: std('#8f969d', 0.85, 0.45),
  white: std('#f2f2ee', 0.05, 0.5), // 카트리지·밸브 (흰 플라스틱)
  paper: std('#f3f0e6', 0, 0.95),
  feeder: std('#3a424d', 0.45, 0.45),
  reel: std('#ffffff', 0.1, 0.5), // 테이프 릴 (인스턴스 색)
  lens: std('#0c1116', 0.4, 0.1),
  gold: std('#d8ad4a', 0.5, 0.35),
  fixture: std('#c7b07a', 0.05, 0.7), // G10 픽스처 판
  spindle: std('#e9ecef', 0.35, 0.35),
  okTray: std('#2e7d4f', 0.1, 0.55),
  ngBin: std('#c0392b', 0.1, 0.55),
  n2: std('#3f9a68', 0.5, 0.4), // 질소 배관 (녹색 도장)
  mesh: std('#6e767f', 0.7, 0.5), // 리플로우 메시 벨트
  cool: std('#6f8fae', 0.5, 0.45), // 냉각 구간 그릴
  cap: std('#ffffff', 0.2, 0.55), // 존 덮개 (인스턴스 색)
  tube: std('#e8f4ff', 0.1, 0.1, { transparent: true, opacity: 0.45 }),
  laserGlass: std('#ff9d42', 0.1, 0.15, { transparent: true, opacity: 0.22 }), // 레이저 보호창
  beam: std('#9dffb0', 0, 0.3, { emissive: '#38ff6a', emissiveIntensity: 3, transparent: true, opacity: 0.85 }),
  spray: std('#d8f0ff', 0, 0.2, { emissive: '#bfe6ff', emissiveIntensity: 0.4, transparent: true, opacity: 0.35 }),
  fringe: std('#5fb8ff', 0, 0.3, { emissive: '#3aa0ff', emissiveIntensity: 1.6, transparent: true, opacity: 0.55 }),
  ringR: std('#3a0c0c', 0.1, 0.4, { emissive: '#ff4040', emissiveIntensity: 1.1 }),
  ringG: std('#0c3a16', 0.1, 0.4, { emissive: '#3dff6e', emissiveIntensity: 1.0 }),
  ringB: std('#0c1a3a', 0.1, 0.4, { emissive: '#3f8cff', emissiveIntensity: 1.2 }),
  camLight: std('#f2f7ff', 0, 0.3, { emissive: '#dfe9ff', emissiveIntensity: 1.2 }),
  redLight: std('#4a1010', 0, 0.3, { emissive: '#ff3b3b', emissiveIntensity: 1.4 }),
  okLamp: std('#0f2a19', 0.1, 0.4, { emissive: '#3ddc84', emissiveIntensity: 1.3 }),
  ngLamp: std('#2a0f0f', 0.1, 0.4, { emissive: '#ff4d5e', emissiveIntensity: 1.4 }),
  amber: std('#2a200a', 0.1, 0.4, { emissive: '#f5b544', emissiveIntensity: 1.2 }),
  heatOk: std('#0c2216', 0.1, 0.4, { emissive: '#2fbf71', emissiveIntensity: 0.8 }),
  seg: std('#08140c', 0.2, 0.4, { emissive: '#4dff88', emissiveIntensity: 1.1 }), // 7세그·상태 표시
  profile: std('#2a1608', 0, 0.4, { emissive: '#ff8a3d', emissiveIntensity: 1.6 }),
  cyan: std('#0f2a33', 0.1, 0.4, { emissive: '#3fd0ff', emissiveIntensity: 1.2 }),
  led: std('#ffd23f', 0.1, 0.4, { emissive: '#ffcf33', emissiveIntensity: 0.25 }),
  uvOn: std('#3a1670', 0.1, 0.3, { emissive: '#9b5cff', emissiveIntensity: 1.5, transparent: true, opacity: 0.85 }),
  uvOff: std('#2a1f3a', 0.1, 0.3, { transparent: true, opacity: 0.85 }),
};

// ─────────── 치수 ───────────

/** 아래 캐비닛 윗면. 레일·기판은 이 위를 지난다 */
const DECK = 0.78;
/** 레일 중심 z (안쪽 폭 0.7 m = 공장 컨베이어 폭) */
const RAIL_Z = 0.375;
const RAIL_Y = DECK + 0.05;
/** 기판 중심 높이·두께 */
const BOARD_Y = BELT_TOP + 0.035;
const BT = 0.016;
const BOARD_TOP = BOARD_Y + BT / 2;
const BMS_SIZE: V3 = [0.42, BT, 0.68];
const LED_SIZE: V3 = [0.44, BT, 0.68];

// ─────────── 작은 도우미 ───────────

const frac = (v: number) => v - Math.floor(v);
const ease = (v: number) => v * v * (3 - 2 * v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const powered = (s: StationState) => s === 'RUN' || s === 'IDLE' || s === 'BLOCKED';

const _o = new THREE.Object3D();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const COLORS = new Map<string, THREE.Color>();
const col = (c: string) => {
  let v = COLORS.get(c);
  if (!v) COLORS.set(c, (v = new THREE.Color(c)));
  return v;
};

type Inst = { p: V3; r?: V3; s?: V3; c?: string };

/** 반복 부품(릴·핀·롤러·트레이…)을 인스턴스 메시 하나로 그린다. children은 지오메트리 */
function Many({ items, mat, children, cast = false }: { items: Inst[]; mat: THREE.Material; children: ReactNode; cast?: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((it, i) => {
      _o.position.set(...it.p);
      _o.rotation.set(...(it.r ?? [0, 0, 0]));
      _o.scale.set(...(it.s ?? [1, 1, 1]));
      _o.updateMatrix();
      m.setMatrixAt(i, _o.matrix);
      if (it.c) m.setColorAt(i, col(it.c));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items]);
  return (
    <instancedMesh key={items.length} ref={ref} args={[undefined, undefined, items.length]} material={mat} castShadow={cast} receiveShadow>
      {children}
    </instancedMesh>
  );
}

/** 두 점을 잇는 관 (호스·배관·케이블) */
function Pipe({ a, b, r, mat = MAT.steel }: { a: V3; b: V3; r: number; mat?: THREE.Material }) {
  _a.set(...a);
  _b.set(...b);
  const len = _a.distanceTo(_b);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, _b.sub(_a).normalize());
  return (
    <mesh position={[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]} quaternion={q} material={mat} receiveShadow>
      <cylinderGeometry args={[r, r, len, 12]} />
    </mesh>
  );
}

/** 수평 고리 (AOI 링 조명) */
function Ring({ r, tube, pos, mat }: { r: number; tube: number; pos: V3; mat: THREE.Material }) {
  return (
    <mesh position={pos} rotation={[Math.PI / 2, 0, 0]} material={mat}>
      <torusGeometry args={[r, tube, 8, 32]} />
    </mesh>
  );
}

const ubox = <boxGeometry args={[1, 1, 1]} />;

// ─────────── 기판 흐름 ───────────

/** 기판 한 바퀴(0~1): 들어옴 → 입구 대기 → 작업 위치로 → 작업 → 나감. 기판 두 장이 반 바퀴 차이로 돈다 */
const S = [0.15, 0.5, 0.6, 0.9] as const;
const PERIOD = 8;

/** 설비 박자: 가동 중에만 시간이 흐른다. 처음엔 기판 하나가 작업 위치에 있게 시작한다 */
function useCycle(running: boolean, period = PERIOD, start = 0.7) {
  const st = useRef({ t: start * period, period, run: running });
  st.current.run = running;
  useFrame((_, dt) => {
    if (st.current.run) st.current.t += Math.min(dt, 0.1);
  });
  return st;
}
type Cyc = ReturnType<typeof useCycle>;
const phase = (c: Cyc) => frac(c.current.t / c.current.period);

function boardX(q: number, x0: number, xb: number, xw: number, x1: number) {
  if (q < S[0]) return lerp(x0, xb, ease(q / S[0]));
  if (q < S[1]) return xb;
  if (q < S[2]) return lerp(xb, xw, ease((q - S[1]) / (S[2] - S[1])));
  if (q < S[3]) return xw;
  return lerp(xw, x1, ease((q - S[3]) / (1 - S[3])));
}

/** 작업 위치에 있는 기판의 진행률 w(0~1)과 몇 번째 기판인지(k). 비어 있으면 w = -1 */
function workOf(p: number, n = 2) {
  for (let i = 0; i < n; i++) {
    const q = frac(p + i / n);
    if (q >= S[2] && q < S[3]) return { w: (q - S[2]) / (S[3] - S[2]), k: i };
  }
  return { w: -1, k: 0 };
}

// 기판 위 모양 (기판 중심 기준 x, z). BMS 패널은 3연(가로 줄), LED 패널은 4연(띠 4개)
type Part = { at: V3; s: V3; c: string };
const pt = (x: number, z: number, s: V3, c: string): Part => ({ at: [x, 0, z], s, c });
const SUB_Z = [-0.225, 0, 0.225];
const STRIP_Z = [-0.255, -0.085, 0.085, 0.255];
const rep = (zs: number[], t: Part[]) => zs.flatMap((z0) => t.map((p) => ({ ...p, at: [p.at[0], p.at[1], p.at[2] + z0] as V3 })));

const VSCORE = [-0.1125, 0.1125].map((z) => pt(0, z, [0.42, 0.002, 0.005], '#0f3d20'));
const DMC = rep(SUB_Z, [pt(0.16, 0.06, [0.032, 0.002, 0.032], '#101215')]);
const PAD_IC = [pt(-0.1, 0.04, [0.085, 0.002, 0.06], PASTE), pt(0.05, -0.05, [0.075, 0.002, 0.075], PASTE), pt(-0.17, -0.04, [0.045, 0.002, 0.125], PASTE)];
const CHIP_AT: [number, number, boolean][] = [[-0.05, -0.075, true], [0.02, 0.075, false], [0.12, -0.06, true], [0.15, 0.0, false]];
const PAD_CHIP = CHIP_AT.map(([x, z]) => pt(x, z, [0.036, 0.002, 0.024], PASTE));
const CHIP = CHIP_AT.map(([x, z, r]) => pt(x, z, [0.03, 0.01, 0.016], r ? '#c8b48a' : '#2b2b2b'));
const IC = [pt(-0.1, 0.04, [0.075, 0.012, 0.055], '#1d1f22'), pt(0.05, -0.05, [0.065, 0.012, 0.065], '#1d1f22'), pt(-0.17, -0.04, [0.04, 0.03, 0.12], '#ece6d6')];
const LED_SLOT = [-0.17, 0, 0.17].map((z) => pt(0, z, [0.38, 0.002, 0.012], '#59616b'));
const LED_PAD = [...[-0.12, 0, 0.12].map((x) => pt(x, 0, [0.036, 0.002, 0.036], PASTE)), pt(0.18, 0, [0.04, 0.002, 0.07], PASTE)];
const LED_PART = [...[-0.12, 0, 0.12].map((x) => pt(x, 0, [0.03, 0.012, 0.03], '#ffd23f')), pt(0.18, 0, [0.035, 0.022, 0.06], '#ece6d6')];

const KIT = {
  bare: VSCORE,
  mark: [...VSCORE, ...DMC],
  paste: [...VSCORE, ...DMC, ...rep(SUB_Z, [...PAD_IC, ...PAD_CHIP])],
  chip: [...VSCORE, ...DMC, ...rep(SUB_Z, [...PAD_IC, ...CHIP])],
  full: [...VSCORE, ...DMC, ...rep(SUB_Z, [...CHIP, ...IC])],
  ledPaste: [...LED_SLOT, ...rep(STRIP_Z, LED_PAD)],
  ledFull: [...LED_SLOT, ...rep(STRIP_Z, LED_PART)],
};

/**
 * 레일 위 기판. stream이 아니면 x0(입구) → 대기 → xw(작업 위치)에서 멈춤 → x1(출구).
 * 작업이 절반 지나면 kitOut(인쇄·장착·마킹 결과)으로 바뀐다. stream이면 일정한 속도로 줄지어 흐른다 (리플로우)
 */
function Boards({ cyc, x0, xw, x1, kitIn, kitOut = kitIn, led = false, n = 2, stream = false }: { cyc: Cyc; x0: number; xw: number; x1: number; kitIn: Part[]; kitOut?: Part[]; led?: boolean; n?: number; stream?: boolean }) {
  const bRef = useRef<THREE.InstancedMesh>(null);
  const pRef = useRef<THREE.InstancedMesh>(null);
  const per = Math.max(kitIn.length, kitOut.length);
  const last = useRef(-1);
  const place = () => {
    const p = phase(cyc);
    const b = bRef.current;
    const m = pRef.current;
    if (p === last.current || !b || !m) return;
    last.current = p;
    const xb = (x0 + xw) / 2;
    _o.rotation.set(0, 0, 0);
    for (let i = 0; i < n; i++) {
      const q = frac(p + i / n);
      const x = stream ? lerp(x0, x1, q) : boardX(q, x0, xb, xw, x1);
      _o.position.set(x, BOARD_Y, 0);
      _o.scale.set(1, 1, 1);
      _o.updateMatrix();
      b.setMatrixAt(i, _o.matrix);
      const kit = !stream && q >= (S[2] + S[3]) / 2 ? kitOut : kitIn;
      for (let j = 0; j < per; j++) {
        const it = kit[j];
        if (it) {
          _o.position.set(x + it.at[0], BOARD_TOP + it.s[1] / 2, it.at[2]);
          _o.scale.set(...it.s);
          m.setColorAt(i * per + j, col(it.c));
        } else _o.scale.set(0, 0, 0);
        _o.updateMatrix();
        m.setMatrixAt(i * per + j, _o.matrix);
      }
    }
    b.instanceMatrix.needsUpdate = true;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  };
  useLayoutEffect(() => {
    last.current = -1;
    place();
  });
  useFrame(place);
  return (
    <group>
      <instancedMesh ref={bRef} args={[undefined, undefined, n]} material={led ? M.mcpcb : M.pcb} frustumCulled={false} receiveShadow>
        <boxGeometry args={led ? LED_SIZE : BMS_SIZE} />
      </instancedMesh>
      <instancedMesh ref={pRef} args={[undefined, undefined, n * per]} material={M.part} frustumCulled={false}>
        {ubox}
      </instancedMesh>
    </group>
  );
}

// ─────────── 공용 몸체 ───────────

/** SMEMA 기판 레일 두 줄 (공장 컨베이어 높이·폭에 맞춘다) */
function Rails({ x0, x1 }: { x0: number; x1: number }) {
  return (
    <>
      {[-1, 1].map((s) => (
        <Box key={s} size={[x1 - x0, 0.1, 0.05]} pos={[(x0 + x1) / 2, RAIL_Y, s * RAIL_Z]} mat={M.rail} cast={false} />
      ))}
    </>
  );
}

/** 아래 캐비닛: 어두운 받침 + 회색 캐비닛 + 라인 색 띠 */
function Base({ l, d, x = 0, z = 0, color }: { l: number; d: number; x?: number; z?: number; color: string }) {
  return (
    <group position={[x, 0, z]}>
      <Box size={[l - 0.08, 0.1, d - 0.08]} pos={[0, 0.05, 0]} mat={MAT.frame} cast={false} />
      <Box size={[l, DECK - 0.1, d]} pos={[0, 0.1 + (DECK - 0.1) / 2, 0]} mat={MAT.body} />
      <Stripe size={[l + 0.01, 0.05, d + 0.01]} pos={[0, DECK - 0.08, 0]} color={color} />
    </group>
  );
}

/**
 * 위 덮개: 뒤판 + 양 끝판(기판 출입구) + 지붕(뒤는 막힘, 앞은 유리) + 앞 윗테 + 앞 유리.
 * sill = 앞 아래턱(마운터 피더가 꽂히는 자리), front = false면 앞 유리 대신 도어를 따로 단다, sideGlass = 오른쪽(+x) 끝판을 유리창으로
 */
function Hood({ l, d, h, x = 0, z = 0, glass = MAT.glass, roofGlass = 0.6, front = true, header = 0.12, sill = 0, sideGlass = false }: { l: number; d: number; h: number; x?: number; z?: number; glass?: THREE.Material; roofGlass?: number; front?: boolean; header?: number; sill?: number; sideGlass?: boolean }) {
  const hh = h - DECK;
  const yc = DECK + hh / 2;
  const rd = d * (1 - roofGlass);
  const gh = hh - header - sill;
  return (
    <group position={[x, 0, z]}>
      <Box size={[l, hh, 0.04]} pos={[0, yc, -d / 2 + 0.02]} mat={MAT.bodyLight} />
      <Box size={[0.04, hh, d]} pos={[-l / 2 + 0.02, yc, 0]} mat={MAT.bodyLight} />
      {sideGlass ? (
        <>
          <Box size={[0.04, hh, 0.08]} pos={[l / 2 - 0.02, yc, d / 2 - 0.04]} mat={MAT.bodyLight} />
          <Box size={[0.02, hh, d - 0.12]} pos={[l / 2 - 0.01, yc, -0.02]} mat={glass} cast={false} />
        </>
      ) : (
        <Box size={[0.04, hh, d]} pos={[l / 2 - 0.02, yc, 0]} mat={MAT.bodyLight} />
      )}
      <Box size={[l, 0.04, rd]} pos={[0, h - 0.02, -d / 2 + rd / 2]} mat={MAT.bodyLight} />
      {roofGlass > 0 && <Box size={[l - 0.08, 0.02, d - rd - 0.05]} pos={[0, h - 0.02, -d / 2 + rd + (d - rd - 0.05) / 2]} mat={glass} cast={false} />}
      <Box size={[l, header, 0.05]} pos={[0, h - header / 2, d / 2 - 0.025]} mat={MAT.bodyLight} />
      {sill > 0 && <Box size={[l, sill, 0.05]} pos={[0, DECK + sill / 2, d / 2 - 0.025]} mat={MAT.bodyLight} />}
      {front && <Box size={[l - 0.08, gh, 0.02]} pos={[0, DECK + sill + gh / 2, d / 2 - 0.01]} mat={glass} cast={false} />}
      {/* 기판 출입구 (레일이 지나는 어두운 틈) */}
      {[-1, 1].map((s) => (
        <Box key={s} size={[0.012, 0.13, RAIL_Z * 2 + 0.12]} pos={[s * (l / 2 + 0.006), DECK + 0.07, -z]} mat={MAT.frame} cast={false} />
      ))}
    </group>
  );
}

/**
 * 조작 화면. top이면 (x, y=지붕 높이, z)에 세운 기둥 위 모니터, 아니면 앞면 z에서 나온 팔에 매단 모니터(중심 높이 y).
 * children은 화면 위 표시(모니터 중심 기준, z ≈ 0.03). kb = 키보드 선반, kbZ = 선반이 붙는 앞면 z (기본 z)
 */
function Hmi({ x, y, z, top = false, kb = true, kbY = 1.02, kbZ = z, kbX = x, children }: { x: number; y: number; z: number; top?: boolean; kb?: boolean; kbY?: number; kbZ?: number; kbX?: number; children?: ReactNode }) {
  const my = top ? y + 0.36 : y;
  const mz = top ? z : z + 0.22;
  return (
    <group>
      {top ? <Box size={[0.05, 0.22, 0.05]} pos={[x, y + 0.11, z]} mat={MAT.frame} cast={false} /> : <Box size={[0.05, 0.05, 0.22]} pos={[x, y + 0.18, z + 0.11]} mat={MAT.frame} cast={false} />}
      <group position={[x, my, mz]} rotation={[-0.15, 0, 0]}>
        <Box size={[0.44, 0.3, 0.04]} mat={MAT.frame} cast={false} />
        <Box size={[0.39, 0.25, 0.01]} pos={[0, 0, 0.022]} mat={MAT.screen} cast={false} />
        {children}
      </group>
      {kb && (
        <>
          <Box size={[0.46, 0.025, 0.2]} pos={[kbX, kbY, kbZ + 0.11]} mat={MAT.bodyDark} cast={false} />
          <Box size={[0.38, 0.012, 0.12]} pos={[kbX, kbY + 0.018, kbZ + 0.12]} mat={MAT.frame} cast={false} />
        </>
      )}
    </group>
  );
}

// ─────────── 레이저 마커 (1.6 × 1.7 × 1.7) ───────────

const LM = { xw: 0.08, gx: 0.24, gz: 0.06, lensY: 1.235, rx: 0.58 };

function LaserMarker({ color, running }: MachineProps) {
  const cyc = useCycle(running);
  const beam = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const g = beam.current;
    if (!g) return;
    const { w } = workOf(phase(cyc));
    const on = running && w >= 0.05 && w < 0.85;
    g.visible = on && Math.sin(clock.elapsedTime * 50) > -0.5;
    if (!on) return;
    // 3연 기판의 DMC 자리를 차례로 찍는다 (갈바노 미러가 빔 방향을 바꾼다)
    const dz = SUB_Z[Math.min(2, Math.floor(((w - 0.05) / 0.8) * 3))];
    const dy = LM.lensY - BOARD_TOP;
    g.rotation.x = -Math.atan2(dz, dy);
    g.scale.y = Math.hypot(dz, dy);
  });
  return (
    <group>
      <Base l={1.45} d={1.3} z={-0.2} color={color} />
      <Hood l={1.45} d={1.3} z={-0.2} h={1.6} glass={M.laserGlass} roofGlass={0.45} />
      <Rails x0={-0.85} x1={0.85} />
      {/* 레이저 발진기 → 빔 관 → 갈바노 스캐너 + f-theta 렌즈 */}
      <Box size={[0.46, 0.16, 0.26]} pos={[LM.gx, 1.48, -0.6]} mat={MAT.bodyDark} />
      <Box size={[0.06, 0.06, 0.5]} pos={[LM.gx, 1.42, -0.22]} mat={MAT.bodyDark} cast={false} />
      <Box size={[0.15, 0.15, 0.16]} pos={[LM.gx, 1.36, LM.gz]} mat={MAT.frame} />
      <Cyl r={0.045} h={0.05} pos={[LM.gx, 1.26, LM.gz]} mat={M.lens} />
      <group ref={beam} position={[LM.gx, LM.lensY, LM.gz]} visible={false}>
        <mesh position={[0, -0.5, 0]} material={M.beam}>
          <cylinderGeometry args={[0.004, 0.004, 1, 6]} />
        </mesh>
      </group>
      {/* DMC 리더 (빨간 조명 + 카메라) */}
      <Box size={[0.02, 0.32, 0.02]} pos={[LM.rx, 1.4, LM.gz]} mat={MAT.frame} cast={false} />
      <Box size={[0.08, 0.1, 0.1]} pos={[LM.rx, 1.19, LM.gz]} mat={MAT.frame} cast={false} />
      <Cyl r={0.032} h={0.01} pos={[LM.rx, 1.135, LM.gz]} mat={M.redLight} seg={16} />
      {/* 집진기 + 호스 */}
      <Box size={[0.42, 0.86, 0.38]} pos={[-0.52, 0.43, 0.68]} mat={MAT.body} />
      <Box size={[0.34, 0.46, 0.012]} pos={[-0.52, 0.42, 0.876]} mat={MAT.bodyDark} cast={false} />
      <Box size={[0.1, 0.035, 0.008]} pos={[-0.52, 0.74, 0.874]} mat={M.seg} cast={false} />
      <Pipe a={[-0.52, 0.85, 0.66]} b={[-0.52, 1.74, 0.66]} r={0.045} mat={MAT.rubber} />
      <Pipe a={[-0.52, 1.74, 0.66]} b={[-0.45, 1.6, -0.25]} r={0.045} mat={MAT.rubber} />
      <Hmi x={-0.12} y={1.6} z={0.22} top kbX={0.35} kbZ={0.45} />
      <Boards cyc={cyc} x0={-0.82} xw={LM.xw} x1={0.82} kitIn={KIT.bare} kitOut={KIT.mark} />
    </group>
  );
}

// ─────────── 솔더 인쇄기 (1.9 × 1.9 × 1.7) ───────────

const STENCIL_Y = 0.955;
const FRAME: Inst[] = [
  { p: [0, STENCIL_Y, 0.43], s: [0.92, 0.03, 0.06] },
  { p: [0, STENCIL_Y, -0.43], s: [0.92, 0.03, 0.06] },
  { p: [0.43, STENCIL_Y, 0], s: [0.06, 0.03, 0.8] },
  { p: [-0.43, STENCIL_Y, 0], s: [0.06, 0.03, 0.8] },
];
const APERTURE: Inst[] = rep(SUB_Z, [...PAD_IC, ...PAD_CHIP]).map((p) => ({ p: [p.at[0], STENCIL_Y + 0.0025, p.at[2]], s: [p.s[0], 0.001, p.s[2]] }));
const STENCIL_CLAMP: Inst[] = [-1, 1].map((s) => ({ p: [0, 0.92, s * 0.5], s: [1.5, 0.04, 0.05] }));
const PR_RAILS: Inst[] = [-1, 1].map((s) => ({ p: [s * 0.6, 1.43, 0], s: [0.05, 0.05, 1.2] }));
const BLADES: Inst[] = [-1, 1].map((s) => ({ p: [0, 1.02, s * 0.04], r: [s * 0.5, 0, 0], s: [0.68, 0.12, 0.008] }));
const CLEAN_ROLLS: Inst[] = [-0.56, -0.66].map((z) => ({ p: [0, 0.885, z], r: [0, 0, Math.PI / 2] }));

function Printer({ def, color, running }: MachineProps) {
  const led = def.step.startsWith('LED');
  const cyc = useCycle(running);
  const carriage = useRef<THREE.Group>(null);
  const bead = useRef<THREE.Mesh>(null);
  const cam = useRef<THREE.Group>(null);
  useFrame(() => {
    const p = phase(cyc);
    const { w, k } = workOf(p);
    // 스퀴지: 기판마다 앞→뒤, 뒤→앞으로 번갈아 민다
    const dir = k === 0 ? 1 : -1;
    if (w >= 0 && carriage.current) {
      carriage.current.position.z = dir * lerp(0.3, -0.3, ease(clamp01((w - 0.1) / 0.75)));
      if (bead.current) bead.current.position.z = -dir * 0.085;
    }
    // 비전 카메라: 기판이 바뀌는 사이에 기준 마크를 찾아 오가고, 인쇄 중엔 비켜 선다
    if (cam.current) cam.current.position.x = w >= 0 ? 0.55 : Math.sin(p * Math.PI * 8) * 0.3;
  });
  return (
    <group>
      <Base l={1.7} d={1.7} z={-0.05} color={color} />
      <Hood l={1.7} d={1.7} z={-0.05} h={1.6} />
      <Rails x0={-0.97} x1={0.97} />
      {/* 스텐실: 프레임 + 박판 + 개구부 + 고정 레일 */}
      <Many items={FRAME} mat={M.alu} cast>
        {ubox}
      </Many>
      <Box size={[0.8, 0.004, 0.8]} pos={[0, STENCIL_Y, 0]} mat={M.stencil} cast={false} />
      <Many items={APERTURE} mat={M.aperture}>
        {ubox}
      </Many>
      <Many items={STENCIL_CLAMP} mat={MAT.frame}>
        {ubox}
      </Many>
      {/* 스퀴지 캐리지 (앞뒤로 움직인다) */}
      <Many items={PR_RAILS} mat={M.rail}>
        {ubox}
      </Many>
      <group ref={carriage} position={[0, 0, 0.3]}>
        <Box size={[1.28, 0.09, 0.14]} pos={[0, 1.36, 0]} mat={MAT.bodyDark} />
        <Box size={[0.56, 0.16, 0.18]} pos={[0, 1.24, 0]} mat={MAT.bodyLight} />
        <Box size={[0.7, 0.05, 0.1]} pos={[0, 1.135, 0]} mat={MAT.steel} cast={false} />
        <Many items={BLADES} mat={MAT.steel}>
          {ubox}
        </Many>
        <Cyl r={0.035} h={0.2} pos={[0.2, 1.21, 0.13]} mat={M.white} seg={16} />
        <mesh ref={bead} position={[0, STENCIL_Y + 0.013, -0.085]} rotation={[0, 0, Math.PI / 2]} material={M.paste}>
          <cylinderGeometry args={[0.011, 0.011, 0.62, 8]} />
        </mesh>
      </group>
      {/* 비전 카메라 (스텐실과 기판 사이) */}
      <Box size={[1.3, 0.025, 0.04]} pos={[0, 0.925, -0.32]} mat={MAT.frame} cast={false} />
      <group ref={cam} position={[0.55, 0, 0]}>
        <Box size={[0.12, 0.045, 0.1]} pos={[0, 0.91, -0.25]} mat={MAT.bodyDark} cast={false} />
        <Cyl r={0.02} h={0.015} pos={[0, 0.88, -0.25]} mat={M.lens} seg={12} />
      </group>
      {/* 스텐실 밑면 클리닝 롤 */}
      <Box size={[0.82, 0.03, 0.24]} pos={[0, 0.85, -0.61]} mat={MAT.bodyDark} cast={false} />
      <Many items={CLEAN_ROLLS} mat={M.paper}>
        <cylinderGeometry args={[0.03, 0.03, 0.76, 16]} />
      </Many>
      <Hmi x={-0.45} y={1.6} z={0.62} top kbZ={0.8} />
      <Boards cyc={cyc} x0={-0.97} xw={0} x1={0.97} led={led} kitIn={led ? LED_SLOT : KIT.mark} kitOut={led ? KIT.ledPaste : KIT.paste} />
    </group>
  );
}

// ─────────── 검사 갠트리 공용 (SPI·AOI: 1.5 × 1.7 × 1.7) ───────────

const INSP_XW = 0.13;
const INSP_RAILS: Inst[] = [-1, 1].map((s) => ({ p: [s * 0.66, 1.45, -0.05], s: [0.05, 0.05, 1.3] }));

/** 검사 헤드 움직임: 작업 중엔 기판 위를 지그재그로 훑고, 아니면 뒤쪽에 선다 */
function useScan(cyc: Cyc, beam: React.RefObject<THREE.Group | null>, head: React.RefObject<THREE.Group | null>, show?: React.RefObject<THREE.Mesh | null>) {
  useFrame(() => {
    const { w } = workOf(phase(cyc));
    const on = w >= 0;
    if (beam.current) beam.current.position.z = on ? lerp(0.26, -0.26, w) : -0.05;
    if (head.current) head.current.position.x = on ? INSP_XW + Math.sin(w * Math.PI * 6) * 0.14 : INSP_XW;
    if (show?.current) show.current.visible = on && cyc.current.run;
  });
}

function Spi({ color, running }: MachineProps) {
  const cyc = useCycle(running);
  const beam = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const fringe = useRef<THREE.Mesh>(null);
  useScan(cyc, beam, head, fringe);
  return (
    <group>
      <Base l={1.5} d={1.6} z={-0.05} color={color} />
      <Hood l={1.5} d={1.6} z={-0.05} h={1.6} roofGlass={0.85} />
      <Rails x0={-0.77} x1={0.77} />
      <Many items={INSP_RAILS} mat={M.rail}>
        {ubox}
      </Many>
      <group ref={beam} position={[0, 0, -0.05]}>
        <Box size={[1.3, 0.08, 0.12]} pos={[0, 1.385, 0]} mat={MAT.bodyDark} />
        {/* 3D 측정 헤드: 가운데 카메라 + 양옆 모아레 프로젝터 */}
        <group ref={head} position={[INSP_XW, 0, 0]}>
          <Box size={[0.24, 0.26, 0.2]} pos={[0, 1.215, 0]} mat={MAT.bodyDark} />
          <Cyl r={0.04} h={0.09} pos={[0, 1.05, 0]} mat={M.lens} seg={16} />
          <Many items={[-1, 1].map((s) => ({ p: [s * 0.14, 1.08, 0], r: [0, 0, s * 0.5] }))} mat={M.alu}>
            <cylinderGeometry args={[0.028, 0.028, 0.13, 12]} />
          </Many>
          <mesh ref={fringe} position={[0, BOARD_TOP + 0.03, 0]} material={M.fringe} visible={false}>
            <boxGeometry args={[0.16, 0.002, 0.16]} />
          </mesh>
        </group>
      </group>
      {/* 결과 화면: 패드별 체적 히트맵 */}
      <Hmi x={-0.4} y={1.32} z={0.75}>
        <Box size={[0.33, 0.19, 0.003]} pos={[0, -0.01, 0.028]} mat={M.heatOk} cast={false} />
        <Many items={[[-0.08, 0.03], [0.06, -0.05], [0.11, 0.05]].map(([x, y]) => ({ p: [x, y, 0.031] as V3, s: [0.05, 0.04, 0.003] as V3 }))} mat={M.amber}>
          {ubox}
        </Many>
        <Box size={[0.035, 0.03, 0.003]} pos={[0.02, 0.02, 0.032]} mat={M.ngLamp} cast={false} />
      </Hmi>
      <Boards cyc={cyc} x0={-0.77} xw={INSP_XW} x1={0.77} kitIn={KIT.paste} />
    </group>
  );
}

const SIDE_CAMS: Inst[] = [
  { p: [0.11, 1.03, 0], r: [0, 0, -0.45] },
  { p: [-0.11, 1.03, 0], r: [0, 0, 0.45] },
  { p: [0, 1.03, 0.11], r: [0.45, 0, 0] },
  { p: [0, 1.03, -0.11], r: [-0.45, 0, 0] },
];

function Aoi({ def, color, running }: MachineProps) {
  const led = def.step.startsWith('LED');
  const cyc = useCycle(running);
  const beam = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const judge = useRef<THREE.Mesh>(null);
  useScan(cyc, beam, head);
  useFrame(() => {
    // 판정 표시: 대부분 양품(초록), 가끔 불량(빨강)
    const m = judge.current;
    if (!m) return;
    const want = Math.floor(cyc.current.t / (cyc.current.period / 2)) % 6 === 4 ? M.ngLamp : M.okLamp;
    if (m.material !== want) m.material = want;
  });
  return (
    <group>
      <Base l={1.5} d={1.6} z={-0.05} color={color} />
      <Hood l={1.5} d={1.6} z={-0.05} h={1.6} roofGlass={0.85} />
      <Rails x0={-0.77} x1={0.77} />
      <Many items={INSP_RAILS} mat={M.rail}>
        {ubox}
      </Many>
      <group ref={beam} position={[0, 0, -0.05]}>
        <Box size={[1.3, 0.08, 0.12]} pos={[0, 1.385, 0]} mat={MAT.bodyLight} />
        {/* 카메라 헤드: 위 카메라 + 옆 카메라 4 + 3색 링 조명 */}
        <group ref={head} position={[INSP_XW, 0, 0]}>
          <Box size={[0.16, 0.26, 0.16]} pos={[0, 1.22, 0]} mat={MAT.frame} />
          <Cyl r={0.045} h={0.08} pos={[0, 1.05, 0]} mat={M.lens} seg={16} />
          <Many items={SIDE_CAMS} mat={MAT.bodyDark}>
            <cylinderGeometry args={[0.02, 0.02, 0.08, 10]} />
          </Many>
          <Ring r={0.06} tube={0.01} pos={[0, 1.0, 0]} mat={M.ringR} />
          <Ring r={0.078} tube={0.011} pos={[0, 0.975, 0]} mat={M.ringG} />
          <Ring r={0.096} tube={0.012} pos={[0, 0.95, 0]} mat={M.ringB} />
        </group>
      </group>
      {/* 판정 화면 (지붕 위) */}
      <Hmi x={0.25} y={1.6} z={0.58} top kbZ={0.75}>
        <mesh ref={judge} position={[0.1, 0.075, 0.03]} material={M.okLamp}>
          <boxGeometry args={[0.13, 0.05, 0.004]} />
        </mesh>
      </Hmi>
      <Boards cyc={cyc} x0={-0.77} xw={INSP_XW} x1={0.77} led={led} kitIn={led ? KIT.ledFull : KIT.full} />
    </group>
  );
}

// ─────────── 마운터 (2.8 × 2.3 × 1.7) ───────────
// L = LED 마운터, B1 = 칩 마운터(고속, 로터리 헤드 2개), B2 = IC 마운터(트레이 피더)

type MountVariant = 'led' | 'chip' | 'ic';
const REEL_C = ['#f1f3f5', '#1f2328', '#2f6fb3', '#f1f3f5', '#1f2328', '#d9dde2', '#f1f3f5'];
const MT_RAILS: Inst[] = [-1, 1].map((s) => ({ p: [s * 1.05, 1.47, 0], s: [0.06, 0.06, 1.3] }));
const NOZZLE_ROW: Inst[] = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5].map((i) => ({ p: [i * 0.044, 1.045, 0] }));
const NOZZLE_RING: Inst[] = Array.from({ length: 12 }, (_, i) => ({ p: [Math.cos((i / 12) * Math.PI * 2) * 0.06, -0.085, Math.sin((i / 12) * Math.PI * 2) * 0.06] }));
const TRAY = { x: -0.575, z: -0.93, w: 0.85, d: 0.42 };

function mounterParts(v: MountVariant) {
  const feeders: Inst[] = [];
  const reels: Inst[] = [];
  const carts: Inst[] = [];
  const bank = (xa: number, xb: number, side: number) => {
    let i = 0;
    for (let x = xa; x <= xb + 1e-6; x += 0.044, i++) {
      feeders.push({ p: [x, 0.915, side * 0.73], s: [0.03, 0.09, 0.5] });
      reels.push({ p: [x, 0.68, side * 1.0], r: [0, 0, Math.PI / 2], c: REEL_C[(i * 5 + (side > 0 ? 0 : 3)) % REEL_C.length] });
    }
    const cx = (xa + xb) / 2;
    const w = xb - xa + 0.08;
    carts.push({ p: [cx, 0.3, side * 0.97], s: [w, 0.5, 0.34] }, { p: [cx, 0.855, side * 0.86], s: [w, 0.03, 0.34] });
  };
  bank(-0.95, 0.95, 1);
  if (v === 'ic') bank(0.05, 0.93, -1);
  else bank(-0.95, 0.93, -1);
  return { feeders, reels, carts };
}

function Mounter({ def, color, running }: MachineProps) {
  const v: MountVariant = def.code.endsWith('B2') ? 'ic' : def.code.endsWith('B1') ? 'chip' : 'led';
  const parts = useMemo(() => mounterParts(v), [v]);
  const cyc = useCycle(running);
  const t = useRef(0);
  const beamA = useRef<THREE.Group>(null);
  const headA = useRef<THREE.Group>(null);
  const beamB = useRef<THREE.Group>(null);
  const headB = useRef<THREE.Group>(null);
  const drumA = useRef<THREE.Group>(null);
  const drumB = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (running) t.current += Math.min(dt, 0.1);
    const k = t.current;
    if (v === 'chip') {
      // 앞뒤 빔이 각자 피더 ↔ 기판을 빠르게 오가고, 로터리 헤드가 돈다
      if (beamA.current) beamA.current.position.z = 0.27 + 0.22 * Math.sin(k * 3.2);
      if (beamB.current) beamB.current.position.z = -0.27 - 0.22 * Math.sin(k * 3.2 + 1.3);
      if (headA.current) headA.current.position.x = Math.sin(k * 2.3) * 0.6;
      if (headB.current) headB.current.position.x = Math.sin(k * 2.3 + 2) * 0.6;
      if (drumA.current) drumA.current.rotation.y = k * 9;
      if (drumB.current) drumB.current.rotation.y = -k * 9;
    } else {
      if (beamA.current) beamA.current.position.z = 0.48 * Math.sin(k * 2.6);
      if (headA.current) headA.current.position.x = Math.sin(k * 1.9) * 0.55;
    }
  });
  const rotaryHead = (head: React.RefObject<THREE.Group | null>, drum: React.RefObject<THREE.Group | null>) => (
    <group ref={head}>
      <Box size={[0.22, 0.2, 0.16]} pos={[0, 1.24, 0]} mat={MAT.bodyDark} />
      <group ref={drum} position={[0, 1.09, 0]}>
        <Cyl r={0.075} h={0.1} mat={M.alu} seg={20} />
        <Many items={NOZZLE_RING} mat={MAT.steel}>
          <cylinderGeometry args={[0.006, 0.006, 0.07, 6]} />
        </Many>
      </group>
    </group>
  );
  return (
    <group>
      <Base l={2.3} d={1.4} color={color} />
      <Hood l={2.3} d={1.4} h={1.65} sill={0.24} roofGlass={0.8} />
      <Rails x0={-1.42} x1={1.42} />
      {/* 경광등 받침 겸 뒤 오른쪽 덮개 */}
      <Box size={[0.4, 1.6, 0.42]} pos={[1.2, 0.8, -0.93]} mat={MAT.bodyLight} />
      {/* 피더 카트: 테이프 피더가 기계 안으로 꽂히고 아래에 부품 릴이 걸린다 */}
      <Many items={parts.carts} mat={MAT.bodyDark}>
        {ubox}
      </Many>
      <Many items={parts.feeders} mat={M.feeder}>
        {ubox}
      </Many>
      <Many items={parts.reels} mat={M.reel}>
        <cylinderGeometry args={[0.085, 0.085, 0.022, 20]} />
      </Many>
      {/* XY 갠트리 */}
      <Many items={MT_RAILS} mat={M.rail}>
        {ubox}
      </Many>
      <group ref={beamA}>
        <Box size={[2.04, 0.1, 0.13]} pos={[0, 1.39, 0]} mat={M.alu} />
        {v === 'chip' ? (
          rotaryHead(headA, drumA)
        ) : (
          <group ref={headA}>
            <Box size={[0.3, 0.24, 0.17]} pos={[0, 1.22, 0]} mat={MAT.bodyDark} />
            <Many items={NOZZLE_ROW} mat={MAT.steel}>
              <cylinderGeometry args={[0.009, 0.009, 0.11, 8]} />
            </Many>
          </group>
        )}
      </group>
      {v === 'chip' && (
        <group ref={beamB}>
          <Box size={[2.04, 0.1, 0.13]} pos={[0, 1.39, 0]} mat={M.alu} />
          {rotaryHead(headB, drumB)}
        </group>
      )}
      {/* 부품 인식 카메라 (위를 본다) */}
      {(v === 'chip' ? [1, -1] : [1]).map((s) => (
        <group key={s} position={[s * 0.35, 0, s * 0.45]}>
          <Box size={[0.1, 0.04, 0.1]} pos={[0, 0.8, 0]} mat={MAT.frame} cast={false} />
          <Cyl r={0.035} h={0.008} pos={[0, 0.824, 0]} mat={M.camLight} seg={16} />
        </group>
      ))}
      {/* IC 마운터: 뒤쪽 트레이 피더 (트레이 층층이 + 기계 안으로 들어온 셔틀 트레이) */}
      {v === 'ic' && (
        <group>
          <Box size={[TRAY.w, 0.5, TRAY.d]} pos={[TRAY.x, 0.25, TRAY.z]} mat={MAT.body} />
          <Many items={[-1, 1].flatMap((sx) => [-1, 1].map((sz) => ({ p: [TRAY.x + sx * 0.4, 1.1, TRAY.z + sz * 0.19] as V3 })))} mat={MAT.frame}>
            <boxGeometry args={[0.04, 1.2, 0.04]} />
          </Many>
          <Box size={[TRAY.w, 0.08, TRAY.d]} pos={[TRAY.x, 1.74, TRAY.z]} mat={MAT.bodyLight} />
          <Box size={[TRAY.w - 0.04, 1.2, TRAY.d - 0.04]} pos={[TRAY.x, 1.1, TRAY.z]} mat={MAT.glass} cast={false} />
          <Many items={Array.from({ length: 10 }, (_, i) => ({ p: [TRAY.x, 0.56 + i * 0.11, TRAY.z] as V3, s: [0.7, 0.03, 0.34] as V3, c: i % 2 ? '#2c3440' : '#1d2127' }))} mat={M.part}>
            {ubox}
          </Many>
          <Box size={[0.36, 0.02, 0.3]} pos={[-0.5, 0.9, -0.55]} mat={MAT.frame} cast={false} />
          <Many items={Array.from({ length: 12 }, (_, i) => ({ p: [-0.62 + (i % 4) * 0.08, 0.916, -0.62 + Math.floor(i / 4) * 0.07] as V3 }))} mat={MAT.rubber}>
            <boxGeometry args={[0.045, 0.012, 0.045]} />
          </Many>
        </group>
      )}
      <Hmi x={-0.8} y={1.65} z={0.5} top kb={false} />
      <Boards
        cyc={cyc}
        x0={-1.42}
        xw={0}
        x1={1.42}
        led={v === 'led'}
        kitIn={v === 'led' ? KIT.ledPaste : v === 'chip' ? KIT.paste : KIT.chip}
        kitOut={v === 'led' ? KIT.ledFull : v === 'chip' ? KIT.chip : KIT.full}
      />
    </group>
  );
}

// ─────────── 리플로우 오븐 (5.4 × 1.7 × 1.5) ───────────
// 입구 컨베이어 | 가열 8존 (예열 3 · 소크 3 · 피크 2) | 냉각 2존 | 출구 컨베이어

const RF = { x0: -2.35, x1: 2.65, hx0: -2.1, zw: 0.425, cx0: 1.3, cw: 0.55 };
const RF_L = RF.x1 - RF.x0;
const RF_CX = (RF.x0 + RF.x1) / 2;
const heatX = (i: number) => RF.hx0 + (i + 0.5) * RF.zw;
const coolX = (j: number) => RF.cx0 + (j + 0.5) * RF.cw;
/** 존별 히터 창 높이: 뒤로 갈수록 뜨겁다 (예열 → 소크 → 피크) */
const HEAT_H = [0.09, 0.09, 0.09, 0.13, 0.13, 0.13, 0.19, 0.19];
const ZONE_CAPS: Inst[] = [
  ...HEAT_H.map((_, i) => ({ p: [heatX(i), 1.33, 0] as V3, s: [RF.zw - 0.035, 0.06, 1.28] as V3, c: '#eef1f4' })),
  ...[0, 1].map((j) => ({ p: [coolX(j), 1.325, 0] as V3, s: [RF.cw - 0.04, 0.05, 1.28] as V3, c: '#b7cde2' })),
];
const RF_STACKS: Inst[] = [-1.75, 0.9].map((x) => ({ p: [x, 1.57, -0.35] }));
const RF_STACK_CAPS: Inst[] = [-1.75, 0.9].map((x) => ({ p: [x, 1.795, -0.35] }));
const RF_BELTS: Inst[] = [
  { p: [-2.55, 0.835, 0], s: [0.42, 0.01, 0.7] },
  { p: [2.775, 0.835, 0], s: [0.27, 0.01, 0.7] },
];
const RF_STANDS: Inst[] = [
  { p: [-2.55, 0.39, 0], s: [0.3, 0.78, 0.5] },
  { p: [2.78, 0.39, 0], s: [0.18, 0.78, 0.5] },
];
const RF_GRILLES: Inst[] = [0, 1].map((j) => ({ p: [coolX(j), 1.06, 0.76], s: [RF.cw - 0.09, 0.2, 0.02] }));
const RF_FANS: Inst[] = [0, 1].map((j) => ({ p: [coolX(j), 1.375, 0.12] }));
const N2_DROPS: Inst[] = HEAT_H.map((_, i) => ({ p: [heatX(i), 1.39, -0.62] }));
const N2_TUBES: Inst[] = [0, 1, 2, 3].map((i) => ({ p: [-1.9 + i * 0.1, 0.45, 0.79] }));
/** 온도 프로파일 곡선 (화면 위, 예열 → 소크 → 피크 → 냉각) */
const PROFILE: Inst[] = (() => {
  const pts: [number, number][] = [[-0.17, -0.09], [-0.1, -0.01], [0.0, 0.02], [0.05, 0.09], [0.09, 0.09], [0.16, -0.07]];
  return pts.slice(1).map((b, i) => {
    const a = pts[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    return { p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0.03] as V3, r: [0, 0, Math.atan2(dy, dx)] as V3, s: [Math.hypot(dx, dy) + 0.008, 0.009, 0.004] as V3 };
  });
})();

function Reflow({ def, color, state, running }: MachineProps) {
  const n2 = def.code.endsWith('-B');
  const led = def.step.startsWith('LED');
  const cyc = useCycle(running, 40, 0);
  const fans = useRef<(THREE.Group | null)[]>([]);
  useFrame((_, dt) => {
    if (!running) return;
    for (const f of fans.current) if (f) f.rotation.y += Math.min(dt, 0.1) * 12;
  });
  return (
    <group>
      {/* 몸체: 받침 + 아래 캐비닛 + 터널 분할선(어두운 띠) + 위 후드 */}
      <Box size={[RF_L - 0.06, 0.08, 1.44]} pos={[RF_CX, 0.04, 0]} mat={MAT.frame} cast={false} />
      <Box size={[RF_L, 0.72, 1.5]} pos={[RF_CX, 0.44, 0]} mat={MAT.body} />
      <Stripe size={[RF_L + 0.01, 0.05, 1.51]} pos={[RF_CX, 0.74, 0]} color={color} />
      <Box size={[RF_L - 0.02, 0.07, 1.48]} pos={[RF_CX, 0.835, 0]} mat={MAT.frame} cast={false} />
      <Box size={[RF_L, 0.43, 1.5]} pos={[RF_CX, 1.085, 0]} mat={MAT.bodyLight} />
      {/* 존 덮개 (가열 흰색 · 냉각 하늘색) + 존별 히터 창 */}
      <Many items={ZONE_CAPS} mat={M.cap} cast>
        {ubox}
      </Many>
      {HEAT_H.map((hgt, i) => (
        <HeatPanel key={i} size={[RF.zw - 0.09, hgt, 0.02]} pos={[heatX(i), 0.95 + hgt / 2, 0.76]} state={state} />
      ))}
      <Many items={RF_GRILLES} mat={M.cool}>
        {ubox}
      </Many>
      {/* 냉각 팬 */}
      <Many items={RF_FANS} mat={MAT.bodyDark}>
        <cylinderGeometry args={[0.17, 0.17, 0.05, 24]} />
      </Many>
      {[0, 1].map((j) => (
        <group
          key={j}
          ref={(g) => {
            fans.current[j] = g;
          }}
          position={[coolX(j), 1.405, 0.12]}
        >
          <Box size={[0.3, 0.012, 0.05]} mat={MAT.frame} cast={false} />
          <Box size={[0.05, 0.012, 0.3]} mat={MAT.frame} cast={false} />
        </group>
      ))}
      {/* 배기 덕트 */}
      <Many items={RF_STACKS} mat={M.stainless} cast>
        <cylinderGeometry args={[0.08, 0.08, 0.42, 16]} />
      </Many>
      <Many items={RF_STACK_CAPS} mat={MAT.bodyDark}>
        <cylinderGeometry args={[0.11, 0.11, 0.03, 16]} />
      </Many>
      {/* 입구·출구 메시 벨트 컨베이어 */}
      <Many items={RF_BELTS} mat={M.mesh}>
        {ubox}
      </Many>
      <Many items={RF_STANDS} mat={MAT.frame}>
        {ubox}
      </Many>
      <Rails x0={-2.75} x1={2.9} />
      {/* 질소 공급 (B: 질소 리플로우) — 입상관 + 존마다 내려가는 매니폴드 + 유량계 + O₂ 표시 */}
      {n2 && (
        <group>
          <Pipe a={[-2.42, 0.05, -0.62]} b={[-2.42, 1.42, -0.62]} r={0.025} mat={M.n2} />
          <Pipe a={[-2.42, 1.42, -0.62]} b={[1.15, 1.42, -0.62]} r={0.025} mat={M.n2} />
          <Many items={N2_DROPS} mat={M.n2}>
            <cylinderGeometry args={[0.012, 0.012, 0.06, 8]} />
          </Many>
          <Box size={[0.42, 0.32, 0.03]} pos={[-1.75, 0.48, 0.765]} mat={MAT.bodyDark} cast={false} />
          <Many items={N2_TUBES} mat={M.tube}>
            <cylinderGeometry args={[0.014, 0.014, 0.22, 10]} />
          </Many>
          <Box size={[0.14, 0.04, 0.01]} pos={[-1.75, 0.6, 0.785]} mat={M.seg} cast={false} />
        </group>
      )}
      {/* 조작 화면: 온도 프로파일 */}
      <Hmi x={-2.05} y={1.3} z={0.6} top kbY={1.0} kbZ={0.75}>
        <Many items={PROFILE} mat={M.profile}>
          {ubox}
        </Many>
      </Hmi>
      <Boards cyc={cyc} x0={-2.75} xw={0} x1={2.9} n={10} stream led={led} kitIn={led ? KIT.ledFull : KIT.full} />
    </group>
  );
}

// ─────────── PCB 라우터 + 양팔 이동 협동로봇 (3.6 × 3.0 × 2.1) ───────────
// 왼쪽: 라우터(스핀들 갠트리 + 집진기) · 가운데: 양팔 이동 협동로봇 · 오른쪽: 양품 트레이/불량함 + 셀 제어반

const RT = { x: -1.05, xw: -0.9, cobot: [0.35, 0, 0.45] as V3, table: [1.3, -0.05] as const };
const RT_RAILS: Inst[] = [-1, 1].map((s) => ({ p: [RT.x + s * 0.62, 1.62, 0], s: [0.05, 0.05, 1.2] }));
const ROUTE_Z = [-0.17, 0, 0.17];
const WHEELS: Inst[] = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => ({ p: [sx * 0.26, 0.07, sz * 0.28] as V3, r: [Math.PI / 2, 0, 0] as V3 })));
const TABLE_LEGS: Inst[] = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => ({ p: [RT.table[0] + sx * 0.33, 0.37, RT.table[1] + sz * 0.45] as V3 })));
const OK_TRAYS: Inst[] = [0, 1, 2].map((i) => ({ p: [RT.table[0], 0.8 + i * 0.036, -0.27] }));
const MODULES: Inst[] = Array.from({ length: 8 }, (_, i) => ({ p: [RT.table[0] + (i % 2 ? 0.11 : -0.11), 0.896, -0.27 + (Math.floor(i / 2) - 1.5) * 0.08] as V3 }));
const MODULE_LEDS: Inst[] = MODULES.flatMap((m) => [-0.05, 0.05].map((dx) => ({ p: [m.p[0] + dx, 0.906, m.p[2]] as V3 })));
const FLOOR_LINES: Inst[] = [
  { p: [0.36, 0.012, -0.3], s: [1.12, 0.004, 0.05] },
  { p: [0.36, 0.012, 1.3], s: [1.12, 0.004, 0.05] },
  { p: [-0.2, 0.012, 0.5], s: [0.05, 0.004, 1.6] },
  { p: [0.92, 0.012, 0.5], s: [0.05, 0.004, 1.6] },
];

function RouterCobot({ color, running }: MachineProps) {
  const cyc = useCycle(running);
  const beam = useRef<THREE.Group>(null);
  const spindle = useRef<THREE.Group>(null);
  const bot = useRef<THREE.Group>(null);
  const t = useRef(0);
  useFrame((_, dt) => {
    if (running) t.current += Math.min(dt, 0.1);
    const { w } = workOf(phase(cyc));
    const on = w >= 0;
    // 스핀들: 모듈 사이 탭 3줄을 차례로 깎는다
    if (beam.current) beam.current.position.z = on ? ROUTE_Z[Math.min(2, Math.floor(w * 3))] : -0.4;
    if (spindle.current) {
      spindle.current.position.x = on ? RT.xw + Math.sin(frac(w * 3) * Math.PI * 2) * 0.17 : RT.x;
      spindle.current.position.y = on ? -0.03 : 0;
    }
    // 이동 로봇: 라우터 출구와 트레이 사이를 조금씩 오간다
    if (bot.current) bot.current.position.x = RT.cobot[0] + Math.sin(t.current * 0.5) * 0.08;
  });
  return (
    <group>
      {/* 라우터 */}
      <Base l={1.5} d={1.4} x={RT.x} color={color} />
      <Hood l={1.5} d={1.4} x={RT.x} h={1.85} sideGlass />
      <Rails x0={-1.85} x1={-0.3} />
      <Box size={[0.56, 0.02, 0.66]} pos={[RT.xw, 0.832, 0]} mat={MAT.frame} cast={false} />
      <Many items={RT_RAILS} mat={M.rail}>
        {ubox}
      </Many>
      <group ref={beam} position={[0, 0, -0.4]}>
        <Box size={[1.3, 0.09, 0.11]} pos={[RT.x, 1.555, 0]} mat={MAT.bodyDark} />
        <group ref={spindle} position={[RT.x, 0, 0]}>
          <Box size={[0.14, 0.24, 0.05]} pos={[0, 1.4, 0.08]} mat={M.alu} cast={false} />
          <Cyl r={0.055} h={0.26} pos={[0, 1.3, 0]} mat={M.spindle} seg={20} />
          <Cyl r={0.025} h={0.16} pos={[0, 1.09, 0]} mat={M.spindle} seg={12} />
          <Cyl r={0.06} h={0.06} pos={[0, 0.98, 0]} mat={MAT.rubber} seg={16} />
          <Cyl r={0.004} h={0.08} pos={[0, 0.93, 0]} mat={MAT.steel} seg={6} />
        </group>
      </group>
      {/* 집진기 (사이클론 + 호스) */}
      <Box size={[0.6, 1.1, 0.5]} pos={[-1.45, 0.55, -1.15]} mat={MAT.body} />
      <Cyl r={0.2} h={0.55} pos={[-1.45, 1.375, -1.15]} mat={M.stainless} seg={24} />
      <Cyl r={0.045} h={0.02} pos={[-1.3, 0.85, -0.895]} rot={[Math.PI / 2, 0, 0]} mat={M.white} seg={16} />
      <Pipe a={[-1.45, 1.64, -1.15]} b={[-1.2, 1.86, -0.45]} r={0.05} mat={MAT.rubber} />
      <Hmi x={-1.55} y={1.5} z={0.7} />
      <Boards cyc={cyc} x0={-1.85} xw={RT.xw} x1={-0.35} led kitIn={KIT.ledFull} />

      {/* 양팔 이동 협동로봇: 바퀴 달린 베이스 + 몸통 + 머리(카메라) + 팔 둘 */}
      <group ref={bot} position={RT.cobot}>
        <Box size={[0.78, 0.08, 0.58]} pos={[0, 0.07, 0]} mat={MAT.bodyDark} cast={false} />
        <Box size={[0.74, 0.28, 0.54]} pos={[0, 0.25, 0]} mat={MAT.bodyLight} />
        <Stripe size={[0.745, 0.04, 0.545]} pos={[0, 0.33, 0]} color={color} />
        <Box size={[0.75, 0.015, 0.55]} pos={[0, 0.15, 0]} mat={M.cyan} cast={false} />
        <Many items={WHEELS} mat={MAT.rubber}>
          <cylinderGeometry args={[0.07, 0.07, 0.05, 16]} />
        </Many>
        <Cyl r={0.04} h={0.05} pos={[-0.3, 0.415, 0.18]} mat={MAT.frame} seg={16} />
        <Box size={[0.24, 0.72, 0.26]} pos={[0, 0.75, 0]} mat={MAT.bodyLight} />
        <Box size={[0.18, 0.12, 0.56]} pos={[0, 1.18, 0]} mat={MAT.bodyLight} />
        <Box size={[0.16, 0.14, 0.16]} pos={[0, 1.34, 0]} mat={MAT.bodyLight} />
        <Box size={[0.012, 0.05, 0.12]} pos={[-0.085, 1.35, 0]} mat={M.lens} cast={false} />
        {[-1, 1].map((s) => (
          <group key={s} position={[0, 1.24, s * 0.32]} rotation={[s * 0.4, 0, 0]}>
            <RobotArm pos={[0, 0, 0]} running={running} scale={0.42} phase={s > 0 ? 0 : 1.7} />
          </group>
        ))}
      </group>
      <Many items={FLOOR_LINES} mat={MAT.safety}>
        {ubox}
      </Many>

      {/* 양품 트레이 · 불량함 */}
      <Many items={TABLE_LEGS} mat={MAT.frame}>
        <boxGeometry args={[0.05, 0.74, 0.05]} />
      </Many>
      <Box size={[0.75, 0.04, 1.0]} pos={[RT.table[0], 0.76, RT.table[1]]} mat={MAT.steel} />
      <Many items={OK_TRAYS} mat={M.okTray} cast>
        <boxGeometry args={[0.5, 0.035, 0.36]} />
      </Many>
      <Many items={MODULES} mat={M.mcpcb}>
        <boxGeometry args={[0.2, 0.012, 0.065]} />
      </Many>
      <Many items={MODULE_LEDS} mat={M.led}>
        <boxGeometry args={[0.022, 0.008, 0.022]} />
      </Many>
      <Box size={[0.3, 0.16, 0.26]} pos={[1.35, 0.86, 0.27]} mat={M.ngBin} />

      {/* 셀 제어반 (경광등 받침) */}
      <Box size={[0.5, 1.95, 0.4]} pos={[1.5, 0.975, -1.25]} mat={MAT.bodyLight} />
      <Box size={[0.02, 0.3, 0.02]} pos={[1.3, 1.0, -1.045]} mat={MAT.bodyDark} cast={false} />
    </group>
  );
}

// ─────────── ICT 인서킷 테스터 (1.7 × 1.9 × 1.9) ───────────

const ICT_XW = 0.05;
const ICT_PINS: Inst[] = Array.from({ length: 48 }, (_, i) => ({ p: [ICT_XW - 0.21 + (i % 8) * 0.06, 0.842, -0.27 + Math.floor(i / 8) * 0.108] as V3 }));
const ICT_COLS: Inst[] = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => ({ p: [ICT_XW + sx * 0.36, 1.135, sz * 0.46] as V3 })));
const ICT_CYLS: Inst[] = [-1, 1].map((s) => ({ p: [ICT_XW + s * 0.18, 1.63, 0] }));
const ICT_FINGERS: Inst[] = Array.from({ length: 20 }, (_, i) => ({ p: [-0.2 + (i % 5) * 0.1, -0.042, -0.27 + Math.floor(i / 5) * 0.18] as V3 }));
const ICT_RODS: Inst[] = [-1, 1].map((s) => ({ p: [s * 0.18, 0.325, 0] }));
const ICT_CARDS: Inst[] = Array.from({ length: 14 }, (_, i) => ({ p: [-0.55 + i * 0.077, 0.42, 0.842] as V3 }));
const ICT_LEDS: Inst[] = ICT_CARDS.map((c) => ({ p: [c.p[0], 0.6, 0.85] as V3 }));

function Ict({ color, running }: MachineProps) {
  const cyc = useCycle(running);
  const press = useRef<THREE.Group>(null);
  useFrame(() => {
    const { w } = workOf(phase(cyc));
    // 누름판: 기판이 자리에 오면 내려가 핀에 누르고, 시험이 끝나면 올라간다
    const down = w < 0 ? 0 : clamp01(Math.min(w / 0.12, (1 - w) / 0.12));
    if (press.current) press.current.position.y = lerp(1.06, 0.93, ease(down));
  });
  return (
    <group>
      <Base l={1.6} d={1.75} z={-0.05} color={color} />
      <Hood l={1.6} d={1.75} z={-0.05} h={1.75} />
      <Rails x0={-0.87} x1={0.87} />
      {/* 핀 픽스처 (베드 오브 네일) */}
      <Box size={[0.56, 0.012, 0.66]} pos={[ICT_XW, 0.829, 0]} mat={M.fixture} cast={false} />
      <Many items={ICT_PINS} mat={M.gold}>
        <cylinderGeometry args={[0.005, 0.005, 0.016, 6]} />
      </Many>
      {/* 공압 프레스: 기둥 4 + 상판 + 실린더 2 + 움직이는 누름판 */}
      <Many items={ICT_COLS} mat={M.stainless} cast>
        <cylinderGeometry args={[0.025, 0.025, 0.71, 12]} />
      </Many>
      <Box size={[0.86, 0.06, 1.0]} pos={[ICT_XW, 1.52, 0]} mat={MAT.bodyDark} />
      <Many items={ICT_CYLS} mat={M.alu} cast>
        <cylinderGeometry args={[0.05, 0.05, 0.16, 16]} />
      </Many>
      <group ref={press} position={[ICT_XW, 1.06, 0]}>
        <Box size={[0.62, 0.035, 0.74]} mat={MAT.frame} />
        <Many items={ICT_FINGERS} mat={M.white}>
          <cylinderGeometry args={[0.006, 0.006, 0.05, 6]} />
        </Many>
        <Many items={ICT_RODS} mat={MAT.steel}>
          <cylinderGeometry args={[0.016, 0.016, 0.615, 10]} />
        </Many>
      </group>
      {/* 계측 랙 (아래 캐비닛 앞): 핀 카드 + 상태 LED */}
      <Box size={[1.12, 0.48, 0.012]} pos={[-0.05, 0.42, 0.831]} mat={MAT.frame} cast={false} />
      <Many items={ICT_CARDS} mat={MAT.steel}>
        <boxGeometry args={[0.045, 0.4, 0.01]} />
      </Many>
      <Many items={ICT_LEDS} mat={M.okLamp}>
        <boxGeometry args={[0.016, 0.016, 0.006]} />
      </Many>
      <Hmi x={-0.55} y={1.42} z={0.825} />
      <Boards cyc={cyc} x0={-0.87} xw={ICT_XW} x1={0.87} kitIn={KIT.full} />
    </group>
  );
}

// ─────────── 선택 컨포멀 코터 + 경화 + UV 검사 (2.6 × 1.9 × 1.9) ───────────
// 왼쪽: 코팅 셀(XYZ 갠트리 + 스프레이 밸브 + 코팅액 탱크) · 가운데: 경화 터널 · 오른쪽: UV 검사 후드

const CC = { xw: -0.4, cell: -0.65 };
const CC_RAILS: Inst[] = [-1.2, -0.1].map((x) => ({ p: [x, 1.62, -0.025], s: [0.05, 0.05, 1.3] }));
/** 경화 터널 지붕의 방열 핀 */
const CURE_FINS: Inst[] = Array.from({ length: 9 }, (_, i) => ({ p: [0.1 + i * 0.08, 1.37, 0.15] as V3, s: [0.025, 0.06, 0.7] as V3 }));

function Coater({ color, state, running }: MachineProps) {
  const cyc = useCycle(running);
  const beam = useRef<THREE.Group>(null);
  const valve = useRef<THREE.Group>(null);
  const spray = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const { w } = workOf(phase(cyc));
    const on = w >= 0;
    // 밸브가 기판 위를 지그재그로 지나며 정해진 영역에만 뿌린다
    if (beam.current) beam.current.position.z = on ? lerp(-0.26, 0.26, w) : -0.2;
    if (valve.current) valve.current.position.x = on ? CC.xw + Math.sin(w * Math.PI * 5) * 0.17 : CC.xw;
    if (spray.current) spray.current.visible = on && running && Math.sin(w * Math.PI * 30) > -0.3;
  });
  const uv = powered(state) ? M.uvOn : M.uvOff;
  return (
    <group>
      <Base l={2.6} d={1.65} z={-0.025} color={color} />
      <Hood l={1.3} d={1.65} x={CC.cell} z={-0.025} h={1.8} sideGlass />
      <Rails x0={-1.32} x1={1.32} />
      {/* XYZ 갠트리 + 스프레이 밸브 */}
      <Many items={CC_RAILS} mat={M.rail}>
        {ubox}
      </Many>
      <group ref={beam} position={[0, 0, -0.2]}>
        <Box size={[1.15, 0.08, 0.11]} pos={[CC.cell, 1.555, 0]} mat={MAT.bodyDark} />
        <group ref={valve} position={[CC.xw, 0, 0]}>
          <Box size={[0.1, 0.26, 0.07]} pos={[0, 1.39, 0]} mat={M.alu} cast={false} />
          <Cyl r={0.032} h={0.16} pos={[0, 1.2, 0]} mat={M.white} seg={16} />
          <Cyl r={0.008} h={0.05} pos={[0, 1.095, 0]} mat={M.gold} seg={8} />
          <mesh ref={spray} position={[0, 0.98, 0]} material={M.spray} visible={false}>
            <cylinderGeometry args={[0.006, 0.045, 0.18, 16, 1, true]} />
          </mesh>
        </group>
      </group>
      {/* 코팅액 압력 탱크 + 배기 덕트 */}
      <Cyl r={0.12} h={0.34} pos={[-1.08, 0.95, -0.6]} mat={M.stainless} seg={24} />
      <Cyl r={0.13} h={0.03} pos={[-1.08, 1.135, -0.6]} mat={MAT.bodyDark} seg={24} />
      <Cyl r={0.035} h={0.015} pos={[-1.0, 1.158, -0.6]} mat={M.white} seg={16} />
      <Cyl r={0.08} h={0.36} pos={[-0.95, 1.98, -0.5]} mat={M.stainless} seg={16} />
      {/* 경화 터널 */}
      <Box size={[0.84, 0.56, 1.3]} pos={[0.42, 1.06, -0.05]} mat={MAT.bodyLight} />
      <HeatPanel size={[0.6, 0.12, 0.02]} pos={[0.42, 1.12, 0.61]} state={state} />
      <Cyl r={0.05} h={0.25} pos={[0.42, 1.465, -0.4]} mat={M.stainless} seg={12} />
      <Many items={CURE_FINS} mat={MAT.bodyDark}>
        {ubox}
      </Many>
      {/* UV 검사 후드 + 카메라 */}
      <Box size={[0.44, 1.0, 1.6]} pos={[1.08, 1.28, -0.025]} mat={MAT.bodyDark} />
      <Box size={[0.34, 0.36, 0.02]} pos={[1.08, 1.12, 0.785]} mat={uv} cast={false} />
      <Box size={[0.12, 0.1, 0.12]} pos={[1.08, 1.83, 0.25]} mat={MAT.frame} />
      <Hmi x={-1.05} y={1.5} z={0.8} />
      <Boards cyc={cyc} x0={-1.32} xw={CC.xw} x1={1.32} kitIn={KIT.full} />
    </group>
  );
}

// ─────────── FCT 기능 시험기 (2.4 × 1.6 × 1.8) ───────────
// 왼쪽: 시험 챔버(위로 열리는 도어 + 픽스처) · 오른쪽 뒤: 계측 랙(전원·DMM·CAN·부하) · 오른쪽 앞: 배출 레일

const FCT = { xw: -0.3, cx: -0.425 };
const FCT_POGO: Inst[] = Array.from({ length: 24 }, (_, i) => ({ p: [FCT.xw - 0.18 + (i % 6) * 0.072, 0.843, -0.24 + Math.floor(i / 6) * 0.16] as V3 }));
const DOOR_BARS: Inst[] = [0.82, 1.4].map((y) => ({ p: [0, y, 0], s: [1.46, 0.04, 0.03] }));
/** 계측 랙 앞판 [y, 높이, 색] — #1과 #2는 구성이 조금 다르다 */
const RACK_1: [number, number, string][] = [[1.6, 0.14, '#d5d9de'], [1.44, 0.12, '#3a4048'], [1.3, 0.08, '#b8323a'], [1.15, 0.14, '#cfd4da'], [0.93, 0.24, '#2b313b']];
const RACK_2: [number, number, string][] = [[1.6, 0.12, '#3a4048'], [1.45, 0.14, '#d5d9de'], [1.3, 0.08, '#b8323a'], [1.17, 0.1, '#e1e4e8'], [0.95, 0.26, '#2b313b']];

function Fct({ def, color, running }: MachineProps) {
  const two = def.code.endsWith('2');
  const cyc = useCycle(running, PERIOD, two ? 0.2 : 0.7);
  const door = useRef<THREE.Group>(null);
  const clampB = useRef<THREE.Group>(null);
  const hold = useRef<THREE.Group>(null);
  const rack = two ? RACK_2 : RACK_1;
  const faces = useMemo<Inst[]>(() => rack.map(([y, h, c], i) => ({ p: [i === 2 ? 0.69 : 0.84, y, -0.415], s: [i === 2 ? 0.3 : 0.6, h, 0.012], c })), [rack]);
  const disp = useMemo<Inst[]>(
    () => [
      { p: [0.66, rack[0][0], -0.405], s: [0.12, 0.04, 0.01] },
      { p: [0.82, rack[0][0], -0.405], s: [0.12, 0.04, 0.01] },
      { p: [0.72, rack[1][0], -0.405], s: [0.2, 0.04, 0.01] },
      ...[0, 1, 2].map((i) => ({ p: [0.6 + i * 0.04, rack[2][0], -0.405] as V3, s: [0.015, 0.015, 0.01] as V3 })),
      { p: [0.7, rack[3][0], -0.405], s: [0.14, 0.035, 0.01] },
    ],
    [rack],
  );
  useFrame((_, dt) => {
    const { w } = workOf(phase(cyc));
    // 도어: 시험 중 닫힘, 기판을 바꿀 때 열림 / 클램프·누름판: 시험 중에만 물린다
    const closed = w >= 0;
    if (door.current && running) door.current.position.y += ((closed ? 0 : 0.3) - door.current.position.y) * Math.min(1, dt * 4);
    const engage = w < 0 ? 0 : clamp01(Math.min((w - 0.05) / 0.1, (0.95 - w) / 0.1));
    if (clampB.current) clampB.current.position.x = lerp(0, 0.08, ease(engage));
    if (hold.current) hold.current.position.y = lerp(1.05, 0.89, ease(engage));
  });
  return (
    <group>
      <Base l={2.4} d={1.5} color={color} />
      <Hood l={1.55} d={1.5} x={FCT.cx} h={1.7} front={false} header={0.3} roofGlass={0.5} />
      <Rails x0={-1.22} x1={1.22} />
      {/* 시험 도어 (위로 열린다) */}
      <group ref={door} position={[FCT.cx, two ? 0.3 : 0, 0.765]}>
        <Box size={[1.44, 0.6, 0.02]} pos={[0, 1.11, 0]} mat={MAT.glass} cast={false} />
        <Many items={DOOR_BARS} mat={MAT.bodyLight}>
          {ubox}
        </Many>
        <Box size={[0.3, 0.03, 0.04]} pos={[0, 0.88, 0.03]} mat={MAT.bodyDark} cast={false} />
      </group>
      {/* 픽스처: 포고 핀 판 + 커넥터 클램프 + 위 누름판 */}
      <Box size={[0.56, 0.015, 0.66]} pos={[FCT.xw, 0.83, 0]} mat={M.fixture} cast={false} />
      <Many items={FCT_POGO} mat={M.gold}>
        <cylinderGeometry args={[0.006, 0.006, 0.016, 6]} />
      </Many>
      <Cyl r={0.025} h={0.14} pos={[FCT.xw - 0.42, 0.9, 0]} rot={[0, 0, Math.PI / 2]} mat={M.alu} seg={12} />
      <group ref={clampB}>
        <Box size={[0.06, 0.05, 0.6]} pos={[FCT.xw - 0.33, 0.9, 0]} mat={MAT.frame} />
      </group>
      <Cyl r={0.045} h={0.2} pos={[FCT.xw + 0.05, 1.55, 0]} mat={M.alu} seg={16} />
      <group ref={hold} position={[FCT.xw + 0.05, 1.05, 0]}>
        <Box size={[0.3, 0.02, 0.5]} mat={MAT.frame} cast={false} />
        <Cyl r={0.012} h={0.57} pos={[0, 0.295, 0]} mat={MAT.steel} seg={8} />
      </group>
      {/* 계측 랙 + 장비 앞판 + 표시창, 픽스처로 가는 케이블 */}
      <Box size={[0.68, 0.94, 0.32]} pos={[0.84, 1.25, -0.58]} mat={MAT.frame} />
      <Many items={faces} mat={M.part}>
        {ubox}
      </Many>
      <Many items={disp} mat={M.seg}>
        {ubox}
      </Many>
      <Pipe a={[FCT.xw + 0.2, 0.84, -0.33]} b={[0.55, 1.0, -0.5]} r={0.018} mat={MAT.rubber} />
      {two ? <Hmi x={-0.85} y={1.7} z={0.45} top kbZ={0.75} kbY={1.0} /> : <Hmi x={-0.95} y={1.45} z={0.75} kbY={1.0} />}
      <Boards cyc={cyc} x0={-1.22} xw={FCT.xw} x1={1.22} kitIn={KIT.full} />
    </group>
  );
}

// ─────────── 설비 고르기 ───────────

export function SmtMachine(props: MachineProps) {
  switch (props.def.kind) {
    case 'laser-marker':
      return <LaserMarker {...props} />;
    case 'printer':
      return <Printer {...props} />;
    case 'spi':
      return <Spi {...props} />;
    case 'mounter':
      return <Mounter {...props} />;
    case 'reflow':
      return <Reflow {...props} />;
    case 'aoi':
      return <Aoi {...props} />;
    case 'router-cobot':
      return <RouterCobot {...props} />;
    case 'ict':
      return <Ict {...props} />;
    case 'coater':
      return <Coater {...props} />;
    case 'fct':
      return <Fct {...props} />;
    default: {
      const [L, D, H] = FOOTPRINT[props.def.kind];
      return <Box size={[L, H, D]} pos={[0, H / 2, 0]} mat={MAT.body} />;
    }
  }
}

/** 고른 설비의 부위 이름표 (설비 원점 기준 좌표). at은 그 부위 바로 위 */
export function smtCallouts(def: StationDef): Callout[] {
  switch (def.kind) {
    case 'laser-marker':
      return [
        { text: '레이저 헤드', at: [LM.gx, 1.5, LM.gz], note: '갈바노 미러가 레이저를 움직여 기판마다 2D 데이터매트릭스(DMC) 시리얼을 새긴다' },
        { text: 'DMC 리더', at: [LM.rx, 1.28, LM.gz], note: '새긴 코드를 바로 읽어 판독 등급을 확인한다. 이 코드로 이후 공정 이력이 이어진다' },
        { text: '레이저 보호창', at: [-0.1, 1.2, 0.46], note: '주황색 창이 레이저 반사광을 걸러 작업자 눈을 보호한다' },
        { text: '집진기', at: [-0.52, 0.95, 0.68], note: '마킹 때 생기는 연기와 분진을 빨아들여 필터로 거른다' },
      ];
    case 'printer':
      return [
        { text: '스텐실', at: [0.32, 1.0, 0.3], note: '패드 자리에 구멍(개구부)이 뚫린 얇은 금속판. 이 구멍으로 페이스트가 찍힌다' },
        { text: '스퀴지', at: [-0.3, 1.47, 0], note: '블레이드가 스텐실 위 페이스트를 밀어 개구부를 채운다. 속도·압력이 인쇄량을 정한다' },
        { text: '페이스트 카트리지', at: [0.2, 1.36, 0.13], note: '솔더 페이스트(SAC305)를 스텐실 위에 보충한다' },
        { text: '비전 카메라', at: [0.55, 0.98, -0.25], note: '기판과 스텐실의 기준 마크를 찍어 둘의 위치를 맞춘다' },
        { text: '클리닝 롤', at: [0.3, 0.94, -0.61], note: '스텐실 밑면을 종이로 닦아 개구부 막힘(미납·냉납 원인)을 막는다' },
      ];
    case 'spi':
      return [
        { text: '3D 측정 헤드', at: [INSP_XW, 1.48, -0.3], note: '줄무늬 빛(모아레)을 비추고 카메라로 찍어 페이스트 높이·체적을 잰다' },
        { text: '인쇄된 기판', at: [INSP_XW + 0.15, 0.95, 0.2], note: '인쇄 직후 기판. 체적 70~130 %를 벗어나면 불량으로 걸러 인쇄기로 되먹임한다' },
        { text: '측정 결과 화면', at: [-0.4, 1.55, 0.97], note: '패드별 체적을 색으로 보여 준다. 초록은 정상, 노랑·빨강은 부족·과다' },
      ];
    case 'mounter': {
      const v: MountVariant = def.code.endsWith('B2') ? 'ic' : def.code.endsWith('B1') ? 'chip' : 'led';
      const out: Callout[] = [
        v === 'chip'
          ? { text: '로터리 헤드', at: [0, 1.5, 0.27], note: '노즐 여러 개가 돌며 칩을 연달아 집어 고속으로 장착한다. 빔이 앞뒤 두 개다' }
          : { text: '장착 헤드', at: [0, 1.5, 0], note: v === 'led' ? '노즐로 LED를 집어 ±35 µm 정밀도로 놓는다. 노즐이 닳으면 광축이 틀어진다' : '노즐로 MCU·AFE·CAN IC를 집어 기판 위 자리에 놓는다' },
        { text: '테이프 피더', at: [-0.35, 1.02, 0.85], note: '테이프에 담긴 부품을 한 칸씩 내보내 노즐이 집게 한다' },
        { text: '부품 릴', at: [-1.05, 0.82, 1.0], note: '부품이 감긴 릴. 피더 카트째 바꿔 끼워 기종을 바꾼다' },
        { text: '부품 인식 카메라', at: [0.45, 1.2, 0.45], note: '노즐에 붙은 부품을 아래에서 찍어 틀어짐을 보정한다' },
      ];
      if (v === 'ic') out.push({ text: '트레이 피더', at: [TRAY.x, 1.85, TRAY.z], note: '큰 IC는 릴 대신 트레이에 담겨 층층이 공급된다' });
      return out;
    }
    case 'reflow': {
      const led = def.step.startsWith('LED');
      const out: Callout[] = [
        { text: '예열 구간', at: [heatX(1), 1.42, 0], note: '기판을 천천히(초당 3 °C 이하) 데워 부품이 열충격을 받지 않게 한다' },
        { text: '소크 구간', at: [heatX(4), 1.42, 0], note: '150→180 °C에서 기판 전체 온도를 고르게 맞추고 플럭스를 활성화한다' },
        { text: '피크 구간', at: [(heatX(6) + heatX(7)) / 2, 1.42, 0], note: led ? '피크 235~245 °C. MCPCB는 열이 잘 빠져 보이드 관리가 중요하다' : '솔더가 녹는 피크 245 °C를 TAL 40~80초 동안 유지한다. 낮으면 냉납' },
        { text: '냉각 구간', at: [(coolX(0) + coolX(1)) / 2, 1.48, 0.12], note: '팬 바람으로 빨리 식혀 접합부를 곱게 굳힌다' },
        { text: '배기 덕트', at: [-1.75, 1.88, -0.35], note: '플럭스가 타며 나는 연기를 밖으로 뺀다' },
      ];
      if (def.code.endsWith('-B')) out.push({ text: '질소 공급 라인', at: [-0.4, 1.5, -0.62], note: '존마다 질소를 넣어 산소를 1,000 ppm 아래로 낮춰 산화·툼스톤을 줄인다' });
      return out;
    }
    case 'aoi':
      return [
        { text: '카메라 헤드', at: [INSP_XW, 1.42, -0.3], note: '위·옆 카메라로 부품 유무·극성·위치·납땜 모양을 찍는다' },
        { text: '3색 링 조명', at: [INSP_XW + 0.12, 1.02, -0.3], note: '빨강·초록·파랑 빛을 다른 각도로 비춰 납땜 경사를 색으로 구분한다' },
        { text: '판정 화면', at: [0.25, 2.15, 0.58], note: '양품/불량을 판정하고 불량 위치를 보여 준다. 냉납은 외관으로 일부만 보인다' },
      ];
    case 'router-cobot':
      return [
        { text: '라우터 스핀들', at: [RT.x, 1.66, -0.2], note: '약 4만 rpm 비트가 탭을 깎아 4연 LED 기판을 모듈로 나눈다' },
        { text: '집진기', at: [-1.45, 1.75, -1.15], note: '절삭 분진을 빨아들인다. 차압이 오르면 필터를 바꿀 때다' },
        { text: '양팔 협동로봇', at: [RT.cobot[0], 2.0, RT.cobot[2]], note: '두 팔로 기판을 넣고 잘린 모듈을 꺼내 양품·불량으로 나눠 담는다 (공개 사례)' },
        { text: '이동 베이스', at: [RT.cobot[0] + 0.3, 0.5, RT.cobot[2] + 0.2], note: '바퀴 달린 베이스라 다른 셀로 옮겨 쓸 수 있다' },
        { text: '양품 트레이', at: [RT.table[0], 1.0, -0.27], note: '잘린 LED 모듈을 담아 AMR로 헤드램프 조립 라인에 보낸다' },
        { text: '불량함', at: [1.35, 1.0, 0.27], note: '가장자리 균열 같은 불량 모듈을 따로 모은다' },
      ];
    case 'ict':
      return [
        { text: '공압 프레스', at: [ICT_XW, 1.78, 0], note: '실린더가 누름판을 내려 기판을 핀 위에 눌러 붙인다' },
        { text: '핀 픽스처', at: [ICT_XW + 0.25, 0.92, 0.25], note: '스프링 핀 수백 개가 테스트 패드를 짚는다 (베드 오브 네일)' },
        { text: '계측 랙', at: [-0.05, 0.72, 0.84], note: '핀 카드가 단락·개방과 저항·커패시터 값을 잰다' },
      ];
    case 'coater':
      return [
        { text: '스프레이 밸브', at: [CC.xw, 1.45, -0.2], note: '정해 둔 영역에만 아크릴 코팅을 뿌린다. 커넥터 같은 곳은 피한다' },
        { text: '코팅액 탱크', at: [-1.08, 1.22, -0.6], note: '압력을 걸어 밸브로 코팅액을 보낸다' },
        { text: '경화 터널', at: [0.42, 1.42, -0.05], note: '약 80 °C로 코팅을 굳힌다' },
        { text: 'UV 검사', at: [1.08, 1.92, 0.2], note: '형광 코팅에 UV를 비춰 빠진 곳을 찾는다. 두께는 재지 못한다' },
      ];
    case 'fct':
      return [
        { text: '시험 픽스처', at: [FCT.xw, 0.95, 0.2], note: '포고 핀이 기판 패드에 닿아 전원과 신호를 연결한다' },
        { text: '커넥터 클램프', at: [FCT.xw - 0.33, 1.0, 0.25], note: '공압으로 커넥터를 물려 CAN·셀 전압 배선을 잇는다' },
        { text: '계측 랙', at: [0.84, 1.8, -0.58], note: '전원 공급기·DMM·CAN 인터페이스로 셀 전압 정확도·암전류·통신을 잰다' },
        { text: '시험 도어', at: [FCT.cx, 1.5, 0.78], note: '시험 중에는 닫혀 손이 들어가지 않게 막는다' },
      ];
    default:
      return [];
  }
}
