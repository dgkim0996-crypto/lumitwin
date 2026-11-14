// 품질 시스템 (P9) 조회 API 응답 형태: 4M 변경점, 초·중·종물 검사.
// 관리계획서는 control-plan.ts (공장 정의에서 만든다). 이름표(4M 분류·종류·초물 상태)는 mes.ts에 있다.

import type { ChangeCategory, ChangeKind, InspectionType } from './live';
import type { FaStatus } from './mes';
import type { LineCode, SourceGrade } from './types';

/** SIM = 시뮬레이터(설비)가 감지한 변경점 · USER = 작업자·담당자가 MES에 신고한 변경점 */
export type ChangeSource = 'SIM' | 'USER';
export const CHANGE_SOURCE_NAMES: Record<ChangeSource, string> = { SIM: '설비 감지', USER: '사람 신고' };

/** 변경점 한 건 (change_point 한 줄) */
export interface ChangePointView {
  id: number;
  /** 가상 시각 (ISO) */
  at: string;
  line: LineCode;
  station: string;
  category: ChangeCategory;
  kind: ChangeKind;
  detail: string;
  source: ChangeSource;
  /** 시뮬레이터 변경점 번호('S12') 또는 MES 번호('U3'). 초물 검사가 이 번호를 가리킨다 */
  simId: string | null;
  /** 신고한 사람 (로그인 아이디). 설비 감지면 null */
  createdBy: string | null;
  faStatus: FaStatus;
  /** 초물 판정을 낸 개체와 시각 */
  faSerial: string | null;
  faAt: string | null;
  /** 품질 담당 확인(서명) */
  approvedBy: string | null;
  approvedAt: string | null;
}

/** 사람이 신고할 때 고르는 종류: user = 일반 신고 · condition = 공정 조건 변경 */
export const CHANGE_USER_KINDS = ['user', 'condition'] as const satisfies readonly ChangeKind[];
export type ChangeUserKind = (typeof CHANGE_USER_KINDS)[number];

/** POST /changes 본문 */
export interface ChangeRequest {
  station: string;
  category: ChangeCategory;
  detail: string;
  /** 이 변경 뒤 초물 검사가 필요한가 (기본은 설비가 초물 대상이면 true) */
  fa: boolean;
  kind?: ChangeUserKind;
}

/** 신고 내용 최대 길이 (서버가 자른다) */
export const CHANGE_DETAIL_MAX = 200;

/**
 * 태블릿 신고 양식의 빠른 선택 (분류별 흔한 변경). 현장 4M 변경 관리 대장에 자주 나오는 항목을 일반화한 가정값이다 (assumed)
 */
export const CHANGE_PRESETS: Record<ChangeCategory, string[]> = {
  MAN: ['대체 작업자 투입', '신규 작업자 배치 (교육 이수)', '작업자 휴식 교대'],
  MACHINE: ['지그·치구 교체', '공구·노즐·소모품 교체', '설비 조정·보정', '금형 교체·수리'],
  MATERIAL: ['자재 LOT 수동 교체', '대체 자재 사용 (승인품)', '협력사 변경 자재 투입'],
  METHOD: ['공정 조건 변경 (승인 범위 안)', '작업 표준 개정 적용', '검사 방법·프로그램 변경'],
};
export const CHANGE_PRESETS_GRADE: SourceGrade = 'assumed';

/** 초·중·종물 검사 한 건 (inspection 한 줄) */
export interface InspectionView {
  id: number;
  at: string;
  line: LineCode;
  station: string;
  type: InspectionType;
  serial: string;
  result: 'OK' | 'NG';
  /** 측정값 + 사이클 태그 */
  values: Record<string, number>;
  variant: string | null;
  /** 초물이면 변경점 (ChangePoint.id) */
  changeId: number | null;
  /** 초물이면 변경점 번호 ('S12'·'U3') */
  changeSimId: string | null;
  /** 검사·확인한 사람 (자동 측정이면 null) */
  by: string | null;
}

/** 초물을 기다리는 변경점 (그 설비의 대기 목록 한 줄) */
export interface FaPendingView {
  /** ChangePoint.id. DB에 아직 안 쓴 순간이면 0 */
  changeId: number;
  simId: string | null;
  since: string;
  category: ChangeCategory;
  kind: ChangeKind;
  detail: string;
  /** PENDING = 초물 아직 안 나옴 · NG = 초물이 불합격해 다음 개체를 다시 초물로 기다림 */
  status: Extract<FaStatus, 'PENDING' | 'NG'>;
}

/** 설비별 초물 상태 (GET /quality-system/fa-status) */
export interface FaStationView {
  station: string;
  line: LineCode;
  /** 이 설비가 변경점마다 초물 검사 대상인가 (mes.ts faRequired) */
  faRequired: boolean;
  /** 대기 중인 변경점 (오래된 것부터). 비어 있으면 대기 없음 */
  pending: FaPendingView[];
  /** 이 실행에서 마지막 초물 판정 */
  lastFirst: { at: string; serial: string; result: 'OK' | 'NG'; changeSimId: string | null } | null;
}

/** 변경점 목록 필터 (화면 → 서버 쿼리) */
export interface ChangeQuery {
  line?: LineCode;
  station?: string;
  category?: ChangeCategory;
  from?: string;
  to?: string;
  limit?: number;
}

export interface InspectionQuery {
  line?: LineCode;
  station?: string;
  type?: InspectionType;
  from?: string;
  to?: string;
  limit?: number;
}
