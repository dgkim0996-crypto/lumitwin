import type { LineCode, StationState } from './types';

// ─────────────────────────── MQTT (가상 엣지 → MES) ───────────────────────────
// ISA-95 계층(라인/셀)을 토픽 경로로 쓴다. sim/lumisim/mqtt_io.py 와 같은 규칙이어야 한다.

export const TOPIC_ROOT = 'lt/v1';
export const TOPICS = {
  tags: (line: string, station: string) => `${TOPIC_ROOT}/${line}/${station}/tags`,
  state: (line: string, station: string) => `${TOPIC_ROOT}/${line}/${station}/state`,
  unit: (line: string, station: string) => `${TOPIC_ROOT}/${line}/${station}/unit`,
  amr: (code: string) => `${TOPIC_ROOT}/amr/${code}`,
  simStatus: `${TOPIC_ROOT}/sim/status`,
  simEvent: `${TOPIC_ROOT}/sim/event`,
  edgeStatus: `${TOPIC_ROOT}/edge/status`,
  cmd: `${TOPIC_ROOT}/cmd`,
} as const;

export interface TagsMsg {
  /** 가상 시각 (ISO) */
  t: string;
  v: Record<string, number>;
  /** 현재 상태 (늦게 붙은 수신자도 상태를 알 수 있게 매번 싣는다) */
  s?: StationState;
  r?: string;
}

export interface StateMsg {
  t: string;
  state: StationState;
  reason?: string;
}

export interface UnitMsg {
  t: string;
  start: string;
  serial: string;
  item: string;
  step: string;
  station: string;
  line: LineCode;
  result: 'OK' | 'NG';
  defect?: string;
  /** 사이클 태그 + 측정값 */
  values: Record<string, number>;
  /** 이 설비에서 계산한 부품 속성 */
  attrs?: Record<string, number>;
  /** 조립에 들어간 부품 시리얼 */
  comps?: string[];
  /** 투입 자재 LOT (자재 코드 → LOT 번호) */
  lots?: Record<string, string>;
  cycle: number;
  /** 시뮬레이터만 아는 진실: 검사를 빠져나간 잠재 불량 (출하 유출) */
  escaped?: string[];
}

export type AmrState = 'IDLE' | 'TO_PICK' | 'LOADING' | 'MOVING' | 'UNLOADING' | 'RETURNING' | 'CHARGING';

export interface AmrMsg {
  t: string;
  x: number;
  z: number;
  heading: number;
  state: AmrState;
  transfer: string;
  battery: number;
  load: number;
}

export interface SimStatusMsg {
  t: string;
  startedAt: string;
  speed: number;
  running: boolean;
  /** 설비 신호가 오는 길: mqtt = 시뮬레이터가 브로커로 바로 · opcua = 가상 PLC(OPC UA) → 엣지 게이트웨이 → 브로커 */
  link?: DataLink;
  scenarios: { id: string; startedAt: string; level: number }[];
  /** `${line}.${step}` → 출력 버퍼 개수 */
  buffers: Record<string, number>;
  /** 이송 도착 버퍼 (예: T-LED → 헤드램프 조립 앞 LED 모듈) */
  inbound: Record<string, number>;
  /** 창고 입고 누계 (품목 → 개수) */
  warehouse: Record<string, number>;
  /** 출하 유출(검사를 빠져나간 잠재 불량) 누계 */
  escaped: Record<string, number>;
}

export type DataLink = 'mqtt' | 'opcua';

/** 엣지 게이트웨이(OPC UA → MQTT) 상태. 2초마다 온다 (실제 시각) */
export interface EdgeStatusMsg {
  t: string;
  endpoint: string;
  opcua: 'connected' | 'connecting';
  mqtt: boolean;
  /** 이번 OPC UA 연결이 붙은 시각 */
  since: string | null;
  reconnects: number;
  /** 탐색으로 찾은 설비·태그 수 */
  stations: number;
  tags: number;
  /** OPC UA에서 받은 것: value = 태그 값 알림, state·unit = 이벤트 */
  received: Record<string, number>;
  /** MQTT로 보낸 것 (tags·state·unit·status) */
  sent: Record<string, number>;
  /** MQTT가 끊긴 동안 쌓아 둔 기록 수, 버퍼가 넘쳐 버린 기록 수, 끊긴 동안 버린 태그 묶음 수 */
  buffered: number;
  dropped: number;
  skipped: number;
  /** 생산 실적 순번이 건너뛴 수 (빠진 기록) */
  gaps: number;
}

export interface SimEventMsg {
  t: string;
  kind: 'scenario-on' | 'scenario-off' | 'reset' | 'speed' | 'pause' | 'resume' | 'failure' | 'repair' | 'lot-change';
  message: string;
  station?: string;
  scenario?: string;
}

export type SimCommand =
  | { action: 'speed'; speed: number }
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'reset' }
  | { action: 'scenario'; id: string; on: boolean }
  /** stop = 계획 정지 · setup = 셋업 · start = 재가동(정지·셋업 풀기) · fail = 고장 등록 · repair = 수리 완료. reason은 작업자가 고른 사유 */
  | { action: 'station'; code: string; op: StationOp; reason?: string };

export const STATION_OPS = ['stop', 'setup', 'start', 'repair', 'fail'] as const;
export type StationOp = (typeof STATION_OPS)[number];

export const SIM_SPEEDS = [1, 5, 20, 60] as const;

// ─────────────────────────── 실시간 화면 (MES → 화면, Socket.io) ───────────────────────────

export interface Oee {
  availability: number;
  performance: number;
  quality: number;
  oee: number;
}

export interface StationLive {
  code: string;
  state: StationState;
  reason?: string;
  /** 현재 상태가 시작된 가상 시각 */
  since: string;
  tags: Record<string, number>;
  /** 최근 가공 1건 */
  last?: Pick<UnitMsg, 't' | 'serial' | 'result' | 'defect' | 'values' | 'cycle'>;
  ok: number;
  ng: number;
  /** 불량 코드 → 개수 */
  defects: Record<string, number>;
  oee: Oee;
  /** 상태별 누적 시간 (초) */
  stateSec: Partial<Record<StationState, number>>;
}

export interface LineLive {
  code: LineCode;
  output: number;
  ng: number;
  fpy: number;
  oee: Oee;
  /** 최근 1시간(가상) 생산 수 */
  lastHour: number;
  downStations: string[];
}

export interface AlarmLive {
  id: number;
  t: string;
  station: string;
  severity: 'info' | 'warn' | 'critical';
  /** CHECK = 작업자가 태블릿의 작업 전 점검에서 이상을 표시함 */
  kind: 'DOWN' | 'SPC' | 'LIMIT' | 'QUALITY' | 'SCENARIO' | 'CHECK';
  title: string;
  detail?: string;
  acked: boolean;
}

export interface LiveSnapshot {
  sim: SimStatusMsg | null;
  stations: Record<string, StationLive>;
  lines: Record<string, LineLive>;
  amrs: Record<string, AmrMsg>;
  alarms: AlarmLive[];
  edge: EdgeStatusMsg | null;
  connected: LiveConnected;
}

/** sim = 시뮬레이터 상태 메시지가 오는가 · edge = 엣지 게이트웨이 상태가 오는가 (OPC UA 경로일 때만 의미가 있다) */
export interface LiveConnected {
  sim: boolean;
  edge: boolean;
}

/** 소켓 이벤트 이름 */
export const SOCKET = {
  snapshot: 'snapshot',
  tick: 'tick',
  unit: 'unit',
  alarm: 'alarm',
  event: 'sim-event',
} as const;

export interface TickPayload {
  sim: SimStatusMsg | null;
  stations: Record<string, StationLive>;
  lines: Record<string, LineLive>;
  amrs: Record<string, AmrMsg>;
  edge: EdgeStatusMsg | null;
  connected: LiveConnected;
}

// ─────────────────────────── SPC (X̄-R 관리도) ───────────────────────────

/** 부분군 크기. 같은 설비에서 연속으로 나온 5개를 한 부분군으로 묶는다 */
export const SPC_SUBGROUP = 5;

export type SpcRule = 'R1' | 'R2' | 'R3' | 'R4';

/** 판정 규칙 (Western Electric·Nelson 규칙 중 일부) */
export const SPC_RULES: Record<SpcRule, string> = {
  R1: '관리한계(3σ) 이탈',
  R2: '중심선 한쪽으로 연속 9점',
  R3: '연속 6점 상승 또는 하강',
  R4: '범위(R) 관리한계 이탈',
};

export interface SpcPoint {
  /** 부분군 마지막 부품의 가상 시각 */
  t: string;
  mean: number;
  range: number;
  flags: SpcRule[];
}

export interface SpcChart {
  station: string;
  key: string;
  name: string;
  unit: string;
  /** cycle = 사이클마다 나오는 공정값 · measure = 검사 측정값 · continuous = 연속 공정값(참고용: 자기상관이 있어 알람은 규격 경보로만 한다) */
  source: 'cycle' | 'measure' | 'continuous';
  n: number;
  /** 관리 기준: 설계값(표준값이 주어진 관리도). σ는 공장 정의의 잡음과 인과 계수로 계산한다 */
  cl: number;
  sigma: number;
  ucl: number;
  lcl: number;
  rCl: number;
  rUcl: number;
  lsl?: number;
  usl?: number;
  /** 최근 부분군으로 계산한 공정능력. 규격이 없거나 점이 부족하면 null */
  cpk: number | null;
  points: SpcPoint[];
  /** 이 특성에서 알람을 낸다 */
  alarms: boolean;
}

// ─────────────────────────── 조회 API 응답 ───────────────────────────

export interface ProcessRecordView {
  serial: string;
  item: string;
  line: string;
  step: string;
  station: string;
  result: 'OK' | 'NG';
  defect: string | null;
  cycleSec: number;
  values: Record<string, number>;
  attrs: Record<string, number> | null;
  lots: Record<string, string> | null;
  comps: string[];
  escaped: string[];
  startedAt: string;
  endedAt: string;
}

/** 제품(시리얼) 현재 상태 (production_unit 한 줄) */
export interface ProductionUnitView {
  runId: number;
  serial: string;
  item: string;
  line: string;
  lastStep: string;
  lastStation: string;
  status: 'WIP' | 'NG' | 'DONE' | 'CONSUMED';
  defect: string | null;
  parentSerial: string | null;
  firstAt: string;
  lastAt: string;
}

/** 시리얼 하나의 이력: 거친 공정 + 하위 부품(재귀) */
export interface TraceNode {
  serial: string;
  item: string | null;
  status: string | null;
  defect: string | null;
  parentSerial: string | null;
  records: ProcessRecordView[];
  children: TraceNode[];
}

export interface LotTrace {
  lot: string;
  material: string | null;
  /** 이 LOT를 직접 쓴 부품 (설비별 개수) */
  byStation: { station: string; parts: number }[];
  parts: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  /** 그 부품이 조립돼 들어간 맨 위 제품(최종 제품 또는 중간에 불량 처리된 반제품). 회수 범위가 된다 */
  finished: { serial: string; item: string | null; line: string | null; status: string | null; defect: string | null; parts: number; lastAt: string | null }[];
}

/** 자재 LOT별 품질: 이 LOT를 쓴 부품이 (조립된 상위 제품까지 따라가서) 어떻게 판정됐나 */
export interface LotQuality {
  material: string;
  lot: string;
  /** 이 LOT를 쓴 부품 수 */
  parts: number;
  /** 부품 자신 또는 조립된 상위 제품이 불량 판정을 받은 수 */
  ng: number;
  /** 최종 공정까지 양품으로 끝난 수 */
  done: number;
  firstUsedAt: string;
  lastUsedAt: string;
}

/** 다섯 숫자 요약 + 평균·표준편차 (상자 그림용) */
export interface BoxStats {
  n: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  mean: number;
  sd: number;
}

/** 불량 요인 후보: 불량품과 양품의 공정 값 차이 */
export interface FactorCandidate {
  station: string;
  key: string;
  /** tag = 공정 조건 · attr = 부품 속성 · measure = 앞 공정 검사값 */
  kind: 'tag' | 'attr' | 'measure';
  /** self = 같은 시리얼이 앞서 거친 공정 · component = 조립돼 들어간 하위 부품의 공정 */
  relation: 'self' | 'component';
  /** 표준화 평균 차 = (불량 평균 − 양품 평균) / 합동 표준편차. 크기가 클수록 두 집단이 갈린다 */
  effect: number;
  ng: BoxStats;
  ok: BoxStats;
}

export interface FactorAnalysis {
  station: string;
  defect: string | null;
  ngCount: number;
  okCount: number;
  /** 비교한 구간 (가상 시각) */
  from: string | null;
  to: string | null;
  factors: FactorCandidate[];
  /** 불량품 쪽에 몰려 있는 자재 LOT (하위 부품까지 포함) */
  lots: LotSkew[];
}

/** 자재 LOT 편중: 불량품 중 이 LOT를 쓴 비율과 양품 중 비율 */
export interface LotSkew {
  material: string;
  lot: string;
  /** 이 LOT를 투입한 설비 */
  station: string;
  ng: number;
  ok: number;
  ngShare: number;
  okShare: number;
  /** 두 비율 차이의 z 값 */
  z: number;
}

// ─────────────────────────── 6대 로스 (TPM) ───────────────────────────
// 계획 시간 = 가치 시간 + 6대 로스. 가치 시간 ÷ 계획 시간 = OEE (가동률 × 성능 × 양품률과 같은 값)

export const LOSS_KEYS = ['breakdown', 'setup', 'minorStop', 'speed', 'defect', 'startup'] as const;
export type LossKey = (typeof LOSS_KEYS)[number];

export const LOSS_INFO: Record<LossKey, { name: string; factor: 'availability' | 'performance' | 'quality'; desc: string }> = {
  breakdown: { name: '고장', factor: 'availability', desc: '설비 고장으로 멈춘 시간 (고장 정지)' },
  setup: { name: '셋업·조정', factor: 'availability', desc: '품종·금형 교체, 조정으로 멈춘 시간' },
  minorStop: { name: '순간 정지·공회전', factor: 'performance', desc: '돌 수 있는데 앞에서 부품이 안 오거나(투입 대기) 뒤가 막혀(배출 대기) 쉰 시간' },
  speed: { name: '속도 저하', factor: 'performance', desc: '이상 사이클보다 느리게 가공해 더 든 시간' },
  defect: { name: '공정 불량', factor: 'quality', desc: '불량품을 만드는 데 쓴 시간 (재가동 직후 불량 제외)' },
  startup: { name: '초기 수율', factor: 'quality', desc: '고장·셋업·정지 뒤 다시 돌린 직후(10분) 나온 불량에 쓴 시간' },
};

export const LOSS_FACTOR_NAMES = { availability: '가동률', performance: '성능', quality: '양품률' } as const;

/** 재가동 뒤 이 시간(가상 초) 안에 나온 불량은 초기 수율 로스로 센다 */
export const STARTUP_WINDOW_SEC = 600;

/** 시간 구성 (가상 초) */
export interface LossTimes {
  /** 계획 시간 = 전체 − 계획 정지 */
  planned: number;
  /** 계획 정지 (작업자가 일부러 세운 시간. 로스로 세지 않는다) */
  stopped: number;
  /** 가치 시간 = 양품 수 × 한 개 시간. planned로 나누면 OEE */
  valuable: number;
  loss: Record<LossKey, number>;
}

export interface StationLoss extends LossTimes {
  station: string;
  line: LineCode;
  ok: number;
  ng: number;
  /** 그중 재가동 직후 불량 */
  startupNg: number;
}

export interface LossReport {
  /** 지금 가상 시각 */
  t: string | null;
  startupWindowSec: number;
  /** 공장 전체 (설비 시간 합) */
  total: LossTimes;
  lines: (LossTimes & { line: LineCode })[];
  stations: StationLoss[];
}