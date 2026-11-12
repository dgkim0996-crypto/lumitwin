// 작업자 태블릿: 설비 앞에서 작업자가 입력하는 것 (비가동 사유, 작업 전 점검)

/**
 * 작업자가 설비를 세울 때 고르는 사유. 사유에 따라 설비 상태가 갈린다.
 * - stop  → 계획 정지(STOP): OEE 계획 시간에서 뺀다
 * - setup → 셋업(SETUP): 가동률 손실로 잡힌다 (품종·금형 교체 같은 준비 시간)
 * - fail  → 고장(DOWN): 수리 완료를 누를 때까지 멈춰 있다
 */
export const OPERATOR_REASONS = {
  stop: ['교대·휴식', '계획 보전', '청소·정리', '생산 계획 없음'],
  setup: ['금형·지그 교체', '품종 교체', '조건 조정·초품 확인'],
  fail: ['기계 이상', '전기·제어 이상', '센서·계측 이상', '이음·진동', '누설', '안전장치 작동'],
} as const;

export type OperatorStopKind = keyof typeof OPERATOR_REASONS;

/** 사유 하나의 최대 길이 (서버가 자른다) */
export const REASON_MAX = 40;

/** 작업 전 점검 한 항목 (작업표준서 "작업 전 점검" 절의 한 줄) */
export interface CheckItem {
  text: string;
  /** true = 이상 없음 · false = 이상 */
  ok: boolean;
}

export interface CheckRequest {
  station: string;
  /** 점검 항목을 가져온 작업표준서 ID */
  doc?: string | null;
  items: CheckItem[];
  /** 점검자 (이름 또는 사번, 선택) */
  by?: string | null;
}

export interface CheckRecordView {
  id: number;
  station: string;
  doc: string | null;
  items: CheckItem[];
  ngCount: number;
  by: string | null;
  /** 가상 시각 */
  at: string;
}

/** 이 접속이 보기 전용인지 (공개 링크로 들어온 방문자는 설비·시뮬레이터를 바꾸지 못한다) */
export interface AccessInfo {
  readOnly: boolean;
  /** 서버에 제어 키가 설정돼 있어, 키를 넣으면 조작할 수 있는지 */
  unlockable: boolean;
}

/** 제어 키를 실어 보내는 요청 머리글 */
export const CONTROL_KEY_HEADER = 'x-lumitwin-key';
