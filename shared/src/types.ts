/** 근거 등급. confirmed = 공개 출처 확인 · weak = 2차 자료·출처 간 불일치 · assumed = 공개 근거 없는 가정값 */
export type SourceGrade = 'confirmed' | 'weak' | 'assumed';

export type LineCode = 'HL' | 'EM' | 'OSM';

/** 설비 상태 (PackML 단순화). 경광등 색은 client에서 정한다 */
export type StationState = 'RUN' | 'IDLE' | 'BLOCKED' | 'DOWN' | 'SETUP' | 'STOP';

/** 3D 모델 종류. client/src/three/equipment 의 컴포넌트와 1:1 */
export type EquipmentKind =
  | 'dryer'
  | 'injection'
  | 'tunnel-hardcoat'
  | 'metallizer'
  | 'assembly-cell'
  | 'sealer'
  | 'leak-tester'
  | 'photometry'
  | 'eol-tester'
  | 'packer'
  | 'laser-marker'
  | 'printer'
  | 'spi'
  | 'mounter'
  | 'reflow'
  | 'aoi'
  | 'router-cobot'
  | 'ict'
  | 'coater'
  | 'fct'
  | 'screw-cell'
  | 'tunnel-paint'
  | 'actuator-cell'
  | 'function-tester';

/**
 * 값 참조
 * - `tag:key`          이 설비의 태그
 * - `tag:STATION.key`  다른 설비의 태그 (예: 건조기 이슬점)
 * - `attr:key`         부품에 실려 온 속성 (앞 공정에서 계산)
 */
export type SignalRef = string;

export interface Term {
  ref: SignalRef;
  /** 참조 값의 z점수(표준편차 단위) 1당 더해지는 양 (대상의 단위) */
  coef: number;
}

export interface TagDef {
  key: string;
  name: string;
  unit: string;
  /** continuous = 계속 변하는 값(온도·압력) · cycle = 한 개 가공할 때마다 나오는 값 */
  mode: 'continuous' | 'cycle';
  nominal: number;
  sd: number;
  /** 관리 규격 하한·상한 (화면 표시·임계 알람) */
  lsl?: number;
  usl?: number;
  /** 연속 태그: 설비가 멈추면 수렴하는 값 */
  idle?: number;
  /** 연속 태그: 시정수 (초) */
  tau?: number;
  /** 연속 태그: 다른 태그에 끌려가는 관계 (예: 레진 수분 ← 이슬점) */
  terms?: Term[];
  digits?: number;
  grade: SourceGrade;
  note?: string;
}

/** 부품 속성: 이 설비에서 계산돼 부품에 실리고, 뒤 공정의 불량·측정에 쓰인다 */
export interface AttrDef {
  key: string;
  name: string;
  unit: string;
  base: number;
  sd: number;
  terms: Term[];
  digits?: number;
  grade: SourceGrade;
  note?: string;
}

/** 검사 측정값: 규격을 벗어나면 defect 코드로 NG */
export interface MeasureDef {
  key: string;
  name: string;
  unit: string;
  base: number;
  /** 계측 잡음 */
  sd: number;
  terms: Term[];
  lsl?: number;
  usl?: number;
  defect: string;
  /** 이 측정으로 불량 판정이 났을 때의 처리 (P9, DefectDef.disposition과 같은 뜻) */
  disposition?: DefectDef['disposition'];
  repairMin?: number;
  repairProb?: number;
  digits?: number;
  grade: SourceGrade;
  note?: string;
}

export interface Driver {
  ref: SignalRef;
  /** 1 = 값이 높을수록 · -1 = 낮을수록 · 0 = 양쪽 */
  dir: 1 | -1 | 0;
  /** z가 문턱(th)을 넘는 1당 logit 증가량 */
  k: number;
  th?: number;
}

export interface DefectDef {
  code: string;
  name: string;
  /** 정상 조건의 기본 불량률 (개당) */
  base: number;
  drivers: Driver[];
  /** true면 이 공정에서 판정하지 않고 부품에 잠재 불량으로 실려 뒤 검사 공정에서 검출된다 */
  latent?: boolean;
  /**
   * 불량 판정 뒤 MES가 자동으로 내리는 처리 (P9). 없으면 검출 공정이 재검사 가능한 검사 공정이면 REPAIR, 아니면 SCRAP.
   * MRB = 자동으로 정하지 않고 품질 담당자 판정을 기다린다 (불량 처리 화면)
   */
  disposition?: 'REPAIR' | 'REWORK' | 'SCRAP' | 'MRB';
  /** 수리·재작업에 걸리는 시간 (분, 가상)과 성공 확률 */
  repairMin?: number;
  repairProb?: number;
  grade: SourceGrade;
  note?: string;
}

/** 검사 공정이 잠재 불량을 찾아내는 확률 */
export interface DetectDef {
  defect: string;
  prob: number;
}

/**
 * 재가동 초품: 오래 멈췄다 다시 돌리면 처음 몇 사이클은 금형·실린더 온도와 재료가 안정되지 않아 불량이 잘 난다
 * (사출의 퍼지·시사출). 6대 로스의 초기 수율 로스가 여기서 나온다
 */
export interface WarmupDef {
  /** 이만큼(분, 가상 시계) 넘게 멈췄다 다시 돌 때만 */
  minHalt: number;
  /** 불안정한 사이클 수 */
  shots: number;
  /** 그 사이클에서 부품 하나가 불량일 확률 */
  prob: number;
  /** 불량 코드 (이 설비 defects 중 하나) */
  defect: string;
  grade: SourceGrade;
  note?: string;
}

export interface StationDef {
  code: string;
  name: string;
  kind: EquipmentKind;
  step: string;
  /** 3D 배치 (m). [x, z] */
  pos: [number, number];
  /** Y축 회전 (도) */
  rot?: number;
  /** 사이클 시간 (초). 배치·슬롯 설비는 한 사이클(한 배치·한 개가 안에 머무는 시간) */
  cycle: number;
  cycleCv?: number;
  /** 한 사이클에 나오는 개수 (캐비티·챔버 배치) */
  batch?: number;
  /** 동시에 안에 들어가는 개수 (경화로·리플로우 같은 터널형) */
  slots?: number;
  /** 평균 고장 간격·평균 수리 시간 (분, 가상 시계) */
  mtbf: number;
  mttr: number;
  tags: TagDef[];
  attrs?: AttrDef[];
  measures?: MeasureDef[];
  defects?: DefectDef[];
  detects?: DetectDef[];
  warmup?: WarmupDef;
  /** 인터록 게이트 (P9): 투입 전에 MES에 확인을 받는다 (공정 순서·불량·Hold·작업지시·초물) */
  gate?: boolean;
  /**
   * 보조 설비 (P9): 자기 공정 단계 없이 다른 설비에 붙어 공정 조건만 내는 설비 (예: 사출기 호퍼의 제습 건조기).
   * 부품을 가공하지 않으므로 생산 수·OEE·6대 로스에서 뺀다. step은 붙어 있는 공정을 가리킨다
   */
  aux?: boolean;
  /** 상태 감시 (P9 예지 보전): 이 값이 있는 설비만 진동·전류·온도를 보낸다 */
  health?: HealthDef;
  /** 소비 전력 (kW). run = 가공 중 · idle = 대기·막힘·셋업 · off = 정지·고장 (P9 에너지) */
  power?: { run: number; idle: number; off: number; grade: SourceGrade; note?: string };
  grade: SourceGrade;
  desc: string;
  note?: string;
}

export interface StepInput {
  /** 같은 라인의 앞 공정 코드 */
  step?: string;
  /** 다른 라인 공정 (AMR 이송으로 들어온다) */
  transfer?: string;
  /** 구매 자재 */
  material?: string;
  qty: number;
}

export interface StepDef {
  code: string;
  name: string;
  inputs: StepInput[];
  /** 출력 버퍼 용량 (개) */
  buffer: number;
  /** 이 공정이 만들어 내는 품목 코드 */
  item: string;
  itemName: string;
  /** new = 새 시리얼 발번 · keep = 첫 번째 공정 입력의 시리얼을 이어 쓴다 */
  serial: 'new' | 'keep';
  /** 새 시리얼 앞글자 (serial: 'new'일 때) */
  prefix?: string;
  /**
   * 연배 분할 (P9): 투입 1개에서 나오는 개수. 시리얼은 입력 시리얼 뒤에 -1, -2 … 를 붙인다 (serial: 'keep'일 때).
   * 예: LED 4연배 PCB → 라우팅 → 모듈 4개. 없으면 1
   */
  split?: number;
}

export interface LineDef {
  code: LineCode;
  name: string;
  short: string;
  color: string;
  desc: string;
  product: { code: string; name: string };
  /**
   * 기종 (P9). 작업지시는 이 중 하나를 고른다. 제품 시리얼을 새로 매기는 공정(release)부터 기종이 붙는다.
   * 앞 공정(사출·SMT 등)은 기종과 무관한 공용 부품으로 보고 계속 흐른다
   */
  variants: VariantDef[];
  /** 작업지시가 투입되는 공정 (제품 시리얼을 새로 매기는 공정) */
  release: string;
  /** 기종이 바뀔 때 설비별 셋업 (기종 변경 셋업 = 6대 로스의 셋업, 4M 변경점의 Method) */
  changeover: ChangeoverDef[];
  taktSec: number;
  /** 베이 범위 (m) */
  bay: { x0: number; x1: number; z0: number; z1: number };
  steps: StepDef[];
  stations: StationDef[];
  finalStep: string;
  /** 3D 컨베이어 경로 (화면용) */
  conveyors: [number, number][][];
}

/**
 * 상태 감시 기준 (P9 예지 보전). 정상일 때 값과 마모가 끝까지 진행되는 데 걸리는 가동 시간.
 * 마모(0~1)가 쌓일수록 진동이 먼저 크게 오르고, 전류·온도가 뒤따른다. 마모가 1에 가까우면 고장 확률이 커진다
 */
export interface HealthDef {
  /** 진동 RMS (mm/s), 구동 전류 (A), 베어링·모터 온도 (°C) — 새것일 때 */
  vib: number;
  cur: number;
  temp: number;
  /** 새것에서 마모 끝(1)까지 가동 시간 (시간, 가상) */
  wearHours: number;
  /** 무엇이 닳는가 (예: 볼스크루·베어링, 감속기, 노즐 축) */
  part: string;
  /** 진동 판정 기계 등급 (ISO 10816-1: I = 15 kW 이하 소형 · II = 15~75 kW 중형 · III = 대형 강체 기초). mes.ts VIB_ZONES */
  cls: 'I' | 'II' | 'III';
  grade: SourceGrade;
  note?: string;
}

/** 기종 (P9) */
export interface VariantDef {
  code: string;
  name: string;
  desc: string;
  /** 설비별 사이클 배수 (없으면 1) */
  cycle?: Record<string, number>;
  grade: SourceGrade;
  note?: string;
}

/** 기종 변경 셋업 (P9) */
export interface ChangeoverDef {
  station: string;
  /** 분 (가상) */
  minutes: number;
  /** 무엇을 바꾸는가 (지그·프로그램·라벨 …) */
  what: string;
  grade: SourceGrade;
}

export interface MaterialDef {
  code: string;
  name: string;
  supplier: string;
  lotSize: number;
}

export interface TransferDef {
  code: string;
  name: string;
  from: { line: LineCode; step: string };
  /** 다른 라인 공정의 투입 버퍼, 또는 창고 */
  to: { line: LineCode; step: string } | { warehouse: string };
  /** 한 번에 싣는 개수 */
  lot: number;
  amr: string;
  /** 출발 버퍼 → 도착 지점 경로 (m) */
  path: [number, number][];
}

export interface AmrDef {
  code: string;
  name: string;
  home: [number, number];
  /** m/s */
  speed: number;
  /** 싣기·내리기 (초, 협동로봇 작업) */
  handleSec: number;
  desc: string;
  grade: SourceGrade;
}

export interface ScenarioEffect {
  station: string;
  /** wear = 상태 감시 마모 진행 속도 (P9 예지 보전, step amount = 속도에 더하는 배수. 예: 4면 5배 빠르게) */
  target: 'tag' | 'attr' | 'measure' | 'cycle' | 'wear';
  key?: string;
  /** drift = 분당 rate씩 limit까지 · step = 즉시 amount */
  mode: 'drift' | 'step';
  rate?: number;
  limit?: number;
  amount?: number;
  /**
   * 자재 코드. 있으면 이 효과는 시나리오가 켜질 때 들어온 그 자재의 '불량 LOT'를 쓴 부품에만 걸린다.
   * 켜는 순간 새 LOT로 바뀌고, 끄면 그 LOT를 격리하고 다른 LOT로 바꾼다.
   */
  lot?: string;
}

export interface ScenarioDef {
  id: string;
  name: string;
  line: LineCode;
  summary: string;
  effects: ScenarioEffect[];
  /** 화면에서 보이는 증상 */
  symptom: string;
  /** 찾아야 할 진짜 원인 */
  rootCause: string;
  /** 원인을 찾아가는 길 (면접 시연용) */
  howToFind: string;
}

export interface WarehouseDef {
  code: string;
  name: string;
  pos: [number, number];
  size: [number, number];
}

export interface FactoryDef {
  name: string;
  site: string;
  disclaimer: string;
  size: [number, number];
  materials: MaterialDef[];
  lines: LineDef[];
  transfers: TransferDef[];
  amrs: AmrDef[];
  scenarios: ScenarioDef[];
  warehouses: WarehouseDef[];
  aisles: { x0: number; x1: number; z0: number; z1: number }[];
}
