// 실행 MES (P9) 조회 API 응답·요청 형태: 작업지시·인터록·불량 처리(NCR)·Hold.
// 규칙(상태 이름·자동 판정·한도)은 mes.ts, MQTT 메시지는 live.ts에 있다.

import type { Disposition, InterlockCode } from './live';
import type { AutoRule, HoldKind, HoldResult, HoldStatus, NcrStatus, WoStatus } from './mes';
import type { LineCode } from './types';

/** 메모·사유 글자 수 한도 (화면 입력 검사와 서버 검사가 같은 값을 쓴다) */
export const EXEC_NOTE_MAX = 200;
/** 시리얼 Hold 한 건에 넣을 수 있는 시리얼 수 */
export const HOLD_SERIALS_MAX = 200;

// ─────────────────────────── 작업지시·생산 계획 ───────────────────────────

/** AUTO = 자동 계획(실행 시작·대기 건 보충) · USER = 조장이 만든 것 */
export type WoSource = 'AUTO' | 'USER';
export const WO_SOURCE_NAMES: Record<WoSource, string> = { AUTO: '자동 계획', USER: '수동' };

/** 대기·진행 작업지시의 예상 투입 시각 (택트로 계산한 계획값, 가상 시각) */
export interface WoPlanSlot {
  start: string;
  end: string;
  /** 바로 앞 작업지시와 기종이 달라 기종 변경 셋업이 들어간다 */
  changeover: boolean;
  /** 기종 변경 셋업 (분, 라인 설비 셋업의 합) */
  setupMin: number;
  /** 한 개 투입 간격 (초): 계획 택트와 이 기종의 병목 사이클 중 긴 것 */
  pitchSec: number;
}

export interface WorkOrderView {
  id: number;
  /** WO-HL-261113-001 */
  code: string;
  line: LineCode;
  variant: string;
  qty: number;
  /** 같은 라인 안의 투입 순서 (작을수록 먼저) */
  seq: number;
  status: WoStatus;
  /** 투입 수 (시뮬레이터가 알려 준 값과 투입 공정 실적 중 큰 값) */
  released: number;
  /** 최종 공정 양품 수 · 폐기 수 */
  doneQty: number;
  scrapQty: number;
  /** 아직 라인 안에 있는 수 = 투입 − 양품 − 폐기 */
  wip: number;
  source: WoSource;
  createdBy: string | null;
  note: string | null;
  /** 가상 시각 (ISO) */
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** 진행(투입 중)·대기 작업지시의 예상 투입 시각. 완료·중단이면 null */
  plan: WoPlanSlot | null;
  /** 지금 투입 공정이 투입하고 있는 작업지시 */
  releasing: boolean;
}

/** POST /orders */
export interface WorkOrderCreate {
  line: LineCode;
  variant: string;
  qty: number;
  note?: string;
}

/** PATCH /orders/:id (수량은 대기 중일 때만 바꿀 수 있다) */
export interface WorkOrderPatch {
  qty?: number;
  note?: string | null;
}

/** POST /orders/reorder: 대기(PLANNED) 작업지시의 새 순서. 빠진 것은 원래 순서대로 뒤에 붙는다 */
export interface WorkOrderReorder {
  line: LineCode;
  ids: number[];
}

// ─────────────────────────── 불량 처리 (NCR) ───────────────────────────

/** 종결된 NCR의 결말 */
export type NcrOutcome = 'REPAIRED' | 'SCRAPPED' | 'UAI';
export const NCR_OUTCOME_NAMES: Record<NcrOutcome, string> = { REPAIRED: '수리 합격', SCRAPPED: '폐기', UAI: '특채' };

export interface NcrView {
  id: number;
  /** NCR-261113-0001 */
  code: string;
  serial: string;
  item: string;
  line: LineCode;
  station: string;
  step: string;
  defect: string;
  variant: string | null;
  workOrder: number | null;
  woCode: string | null;
  status: NcrStatus;
  disposition: Disposition | null;
  rule: AutoRule | null;
  /** 판정한 사람 (자동 판정이면 'MES 자동') */
  decidedBy: string | null;
  decidedAt: string | null;
  repairOk: boolean | null;
  /** 수리대에서 걸린 시간 (분, 가상) */
  repairMin: number | null;
  /** 재검사 결과 */
  reinspect: 'OK' | 'NG' | null;
  /** 이 시리얼의 몇 번째 불량인가 */
  attempt: number;
  openedAt: string;
  closedAt: string | null;
  note: string | null;
  outcome: NcrOutcome | null;
}

/** POST /ncr/:id/disposition */
export interface NcrDisposeInput {
  decision: Disposition;
  note?: string;
}

export interface NcrSummary {
  total: number;
  /** 종결 안 된 건 (접수·MRB 대기·수리 중·재검사 대기) */
  open: number;
  byStatus: Record<NcrStatus, number>;
  /** 수리·재작업이 끝난 건 중 재검사 합격 비율 (끝난 건이 없으면 null) */
  repairSuccess: number | null;
  repairDone: number;
  /** 수리대 평균 시간 (분, 가상) */
  avgRepairMin: number | null;
  scrapped: number;
  uai: number;
  /** 불량 코드 상위 (건수 순) */
  topDefects: { defect: string; n: number }[];
}

/** GET /ncr */
export interface NcrList {
  items: NcrView[];
  summary: NcrSummary;
}

/** GET /ncr/:id */
export interface NcrDetail extends NcrView {
  /** 같은 시리얼의 다른 NCR (오래된 것부터) */
  history: NcrView[];
  /** 불량 처리 기준이 권하는 처리 (mes.ts defaultDisposition) */
  suggested: { action: Disposition | 'MRB'; rule: AutoRule; minutes: number; prob: number };
}

// ─────────────────────────── Hold·격리 ───────────────────────────

export const HOLD_KIND_NAMES: Record<HoldKind, string> = { LOT: '자재 LOT', SERIAL: '시리얼' };
export const HOLD_RESULT_NAMES: Record<HoldResult, string> = { RELEASE: '해제 (다시 흘림)', SCRAP: '폐기' };

export interface HoldView {
  id: number;
  /** HOLD-261113-001 */
  code: string;
  kind: HoldKind;
  material: string | null;
  lot: string | null;
  serials: string[];
  reason: string;
  status: HoldStatus;
  createdBy: string | null;
  createdAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseNote: string | null;
  result: HoldResult | null;
  /** 이 Hold 때문에 인터록에서 걸려 격리 구역에 있는 시리얼 (투입 묶음의 주 시리얼) */
  quarantined: string[];
}

/** POST /holds. LOT면 material·lot, SERIAL이면 serials가 있어야 한다. 사유 필수 */
export interface HoldCreate {
  kind: HoldKind;
  material?: string;
  lot?: string;
  serials?: string[];
  reason: string;
}

/** POST /holds/:id/release. 메모 필수 */
export interface HoldReleaseInput {
  result: HoldResult;
  note: string;
}

/** 영향 범위의 맨 위 제품 한 줄 */
export interface HoldImpactTop {
  serial: string;
  item: string | null;
  line: string | null;
  status: string | null;
  defect: string | null;
  /** 이 Hold 대상(LOT를 쓴 부품·시리얼)이 몇 개 들어갔나 */
  parts: number;
  lastAt: string | null;
}

/** Hold 영향 범위: 대상 개체(LOT를 쓴 부품 또는 Hold 시리얼)와 그것이 조립된 맨 위 제품 */
export interface HoldImpact {
  /** 대상 개체 수 (LOT를 직접 쓴 부품 또는 Hold 시리얼) */
  base: number;
  /** 맨 위 제품 상태별 수 (DONE = 완제품·창고, WIP·HOLD·REPAIR = 공정 안, NG·SCRAP …) */
  byStatus: Record<string, number>;
  /** 완제품 (최종 공정 통과: 창고·출하 대기 포함) */
  finished: number;
  /** 아직 공정 안 (WIP·HOLD·REPAIR·NG) */
  inProcess: number;
  tops: HoldImpactTop[];
  /** tops가 잘렸나 */
  truncated: boolean;
}

export interface HoldDetail extends HoldView {
  impact: HoldImpact;
}

/** 인터록에 걸려 격리 구역에 있는 투입 묶음 하나 */
export interface QuarantineView {
  /** 주 시리얼 (새로 발번하는 공정이면 발번할 시리얼) */
  serial: string;
  comps: string[];
  line: LineCode;
  station: string;
  step: string;
  code: InterlockCode;
  reason: string;
  holdId: number | null;
  holdCode: string | null;
  wo: number | null;
  variant: string | null;
  at: string;
}

/** GET /holds */
export interface HoldList {
  holds: HoldView[];
  /** 지금 격리 구역에 있는 묶음 (Hold 말고 다른 인터록 거부 포함) */
  quarantine: QuarantineView[];
}

// ─────────────────────────── 인터록 ───────────────────────────

export interface InterlockView {
  id: number;
  line: LineCode;
  station: string;
  step: string;
  serial: string;
  verdict: 'NG' | 'WAIT';
  code: InterlockCode;
  reason: string;
  comps: string[];
  at: string;
}

export interface InterlockCount {
  ok: number;
  ng: number;
  wait: number;
}

export interface InterlockStats {
  /** 서버가 켜진 뒤 (또는 이번 실행이 시작된 뒤) 메모리로 센 판정 수. 통과(OK)는 DB에 남기지 않아 여기서만 센다 */
  live: InterlockCount & { since: string | null };
  /** 이번 실행 DB 기록: 사유별 거부·대기 건수 */
  byCode: { code: InterlockCode; ng: number; wait: number }[];
  /** 설비별 (메모리 통과 수 + DB 거부·대기 수) */
  byStation: ({ station: string } & InterlockCount)[];
  /** MES 응답이 늦어 확인 없이 통과한 개체 수 (공정 기록 ilkSkip) */
  skipped: number;
}

/** GET /interlock */
export interface InterlockReport {
  recent: InterlockView[];
  stats: InterlockStats;
}

// ─────────────────────────── 라인 실행 요약 ───────────────────────────

export interface LineExecution {
  line: LineCode;
  /** 지금 투입 중인 작업지시 (가장 최근에 내려 준 것) */
  current: WorkOrderView | null;
  /** 진행 중(투입이 끝나도 라인 안에 남은 것 포함) 작업지시 */
  running: WorkOrderView[];
  planned: number;
  /** 다음에 내려 줄 대기 작업지시 */
  next: WorkOrderView | null;
  ncrOpen: number;
  waitMrb: number;
  repairing: number;
  /** MES가 기억하는 격리 묶음 수 (시뮬레이터 개수는 SimStatusMsg.lines) */
  quarantine: number;
  ilk: InterlockCount;
}

/** GET /execution/summary (3D 라인 패널용) */
export interface ExecutionSummary {
  t: string | null;
  /** 기동 복원이 끝났나 (false면 인터록이 WAIT로 답하는 중) */
  ready: boolean;
  lines: LineExecution[];
  holdsActive: number;
}
