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
}

export interface LineDef {
  code: LineCode;
  name: string;
  short: string;
  color: string;
  desc: string;
  product: { code: string; name: string };
  taktSec: number;
  /** 베이 범위 (m) */
  bay: { x0: number; x1: number; z0: number; z1: number };
  steps: StepDef[];
  stations: StationDef[];
  finalStep: string;
  /** 3D 컨베이어 경로 (화면용) */
  conveyors: [number, number][][];
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
  target: 'tag' | 'attr' | 'measure' | 'cycle';
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
