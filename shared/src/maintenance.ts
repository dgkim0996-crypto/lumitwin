// 설비 보전: 고장 이력, MTBF·MTTR(실적 vs 설계), 계획 보전(PM) 주기, 작업 전 점검(자주보전)

import { OPERATOR_REASONS } from './operator';
import type { EquipmentKind, LineCode, SourceGrade } from './types';

/** 작업자가 계획 보전을 할 때 고르는 계획 정지 사유. 이 사유로 세웠다가 다시 돌린 시각이 마지막 PM이 된다 */
export const PM_REASON = OPERATOR_REASONS.stop[1];
/** 주기의 이 비율을 넘으면 '임박' */
export const PM_SOON = 0.85;
/** 고장이 이보다 적으면 MTBF·MTTR 실적은 표본이 작아 믿기 어렵다 (화면에서 흐리게, 비서도 단서를 단다) */
export const MAINT_MIN_FAILURES = 3;
/** 실적이 설계보다 이만큼 나쁘면 짚는다: MTBF가 설계의 70% 밑이면 고장이 잦고, MTTR이 설계의 1.5배 위면 수리가 오래 걸린다 */
export const MTBF_WARN = 0.7;
export const MTTR_WARN = 1.5;

/** 계획 보전 기준: 가동 시간(고장·계획 정지·셋업 제외)이 every시간 쌓이면 한다 */
export interface PmPlan {
  /** 주기 (가동 시간, 시간) */
  every: number;
  /** 할 일 */
  task: string;
  /** 표준 작업 시간 (분) */
  minutes: number;
  grade: SourceGrade;
}

/**
 * 설비 종류별 계획 보전. 소모·오염이 빠른 것(스텐실, 노즐, 접촉 핀)은 짧게, 열·진공 설비의 큰 정비는 길게 잡았다.
 * 주기와 작업 시간은 일반적인 설비 보전 관행에서 정한 가정값이다 (공개된 특정 공장 기준이 아니다).
 */
export const PM_PLANS: Record<EquipmentKind, PmPlan> = {
  dryer: { every: 168, task: '제습 필터 청소·이슬점 센서 확인', minutes: 20, grade: 'assumed' },
  injection: { every: 24, task: '금형 벤트·파팅면 세척, 이젝터 핀 그리스', minutes: 30, grade: 'assumed' },
  'tunnel-hardcoat': { every: 24, task: '플로코터 노즐·배기 필터 청소, UV 램프 조도 확인', minutes: 40, grade: 'assumed' },
  metallizer: { every: 48, task: '챔버 방착판 교체·도어 오링 점검', minutes: 60, grade: 'assumed' },
  'assembly-cell': { every: 24, task: '그리퍼·체결 공구 토크 점검', minutes: 15, grade: 'assumed' },
  sealer: { every: 24, task: '핫멜트 탱크·노즐 청소, 온도 확인', minutes: 20, grade: 'assumed' },
  'leak-tester': { every: 24, task: '기준 누설 시료로 검사기 확인, 실링 지그 점검', minutes: 15, grade: 'assumed' },
  photometry: { every: 24, task: '카메라·스크린 청소, 기준 램프로 교정 확인', minutes: 15, grade: 'assumed' },
  'eol-tester': { every: 24, task: '접촉 핀·커넥터 점검, 기준 시료 확인', minutes: 15, grade: 'assumed' },
  packer: { every: 168, task: '라벨 프린터 헤드 청소·그리퍼 점검', minutes: 10, grade: 'assumed' },
  'laser-marker': { every: 168, task: '렌즈·집진 필터 청소', minutes: 15, grade: 'assumed' },
  printer: { every: 8, task: '스텐실 하부 세척·스퀴지 점검', minutes: 15, grade: 'assumed' },
  spi: { every: 168, task: '카메라·조명 청소, 기준판 확인', minutes: 15, grade: 'assumed' },
  mounter: { every: 24, task: '노즐·피더 점검과 청소', minutes: 30, grade: 'assumed' },
  reflow: { every: 168, task: '플럭스 회수 장치·컨베이어 체인 청소', minutes: 60, grade: 'assumed' },
  aoi: { every: 168, task: '카메라·조명 청소, 기준판 확인', minutes: 15, grade: 'assumed' },
  'router-cobot': { every: 24, task: '라우터 비트 교체·집진 필터 청소', minutes: 20, grade: 'assumed' },
  ict: { every: 72, task: '프로브 핀 점검·교체', minutes: 20, grade: 'assumed' },
  coater: { every: 24, task: '도포 밸브·노즐 세척', minutes: 20, grade: 'assumed' },
  fct: { every: 24, task: '지그 접촉 핀 점검, 기준 시료 확인', minutes: 15, grade: 'assumed' },
  'screw-cell': { every: 24, task: '체결 공구 토크 교정 확인', minutes: 15, grade: 'assumed' },
  'tunnel-paint': { every: 24, task: '도장 건 노즐·부스 필터 청소', minutes: 40, grade: 'assumed' },
  'actuator-cell': { every: 24, task: '그리스 도포기·압입 지그 점검', minutes: 15, grade: 'assumed' },
  'function-tester': { every: 24, task: '소음 측정 마이크·지그 점검, 기준 시료 확인', minutes: 15, grade: 'assumed' },
};

/** ok = 여유 · soon = 임박(주기의 85% 이상) · due = 주기 초과 · doing = 지금 계획 보전 중 */
export type PmStatus = 'ok' | 'soon' | 'due' | 'doing';

export const PM_STATUS_NAMES: Record<PmStatus, string> = { ok: '여유', soon: '임박', due: '초과', doing: '보전 중' };

/** 고장 한 건 */
export interface FailureView {
  station: string;
  line: LineCode;
  /** 고장 사유 ('(작업자 등록)' 꼬리표는 뗀다) */
  reason: string;
  /** 작업자가 태블릿에서 등록한 고장 (아니면 설비가 스스로 멈춘 것) */
  byOperator: boolean;
  start: string;
  /** 수리 완료 시각. 아직 고장 중이면 null */
  end: string | null;
  /** 고장 시간 (가상 초, 진행 중이면 지금까지) */
  sec: number;
}

export interface StationMaintenance {
  station: string;
  line: LineCode;
  /** 지금 고장 중인지 */
  down: boolean;
  failures: number;
  /** 고장 정지 시간 합 (초, 진행 중인 고장 포함) */
  downSec: number;
  /** 끝난 고장 수와 그 수리 시간 합 (MTTR용) */
  repairs: number;
  repairSec: number;
  /** 가동 시간 = 실행 시간 − 고장 − 계획 정지 − 셋업 (초) */
  upSec: number;
  /** 실적 MTBF = 가동 시간 ÷ 고장 수, MTTR = 끝난 고장의 평균 수리 시간 (분). 없으면 null */
  mtbf: number | null;
  mttr: number | null;
  /** 공장 정의의 설계값 (시뮬레이터 고장 모델의 평균, 분) */
  designMtbf: number;
  designMttr: number;
  /** 가용도 = 가동 ÷ (가동 + 고장) */
  availability: number | null;
  lastFailure: FailureView | null;
  pm: {
    plan: PmPlan;
    /** 마지막 계획 보전을 끝낸 가상 시각. 이번 실행에서 안 했으면 null (실행 시작부터 센다) */
    lastAt: string | null;
    count: number;
    /** 마지막 계획 보전(없으면 실행 시작) 뒤 쌓인 가동 시간 (초) */
    sinceSec: number;
    status: PmStatus;
  };
  /** 작업 전 점검(자주보전) 마지막 기록. 이번 실행에서 안 했으면 null */
  check: { at: string; ngCount: number } | null;
}

export interface MaintenanceReport {
  /** 지금 가상 시각 */
  t: string | null;
  runStartedAt: string | null;
  stations: StationMaintenance[];
  /** 최근 고장 (새것부터, 최대 300건) */
  failures: FailureView[];
  /** 계획 보전을 한 구간 (새것부터, 최대 300건). end가 null이면 지금 보전 중 */
  pmWork: { station: string; start: string; end: string | null }[];
  /** 고장 사유별 건수·시간 (시간 큰 순) */
  reasons: { reason: string; count: number; sec: number; stations: string[] }[];
}

export interface MaintenanceTotals {
  failures: number;
  downSec: number;
  upSec: number;
  mtbf: number | null;
  mttr: number | null;
  availability: number | null;
  downNow: number;
  pmDue: number;
  pmSoon: number;
}

/** 여러 설비를 합친 지표 (설비 시간 합 기준: 공장 MTBF = 모든 설비 가동 시간 합 ÷ 고장 수 합) */
export function maintenanceTotals(list: StationMaintenance[]): MaintenanceTotals {
  let failures = 0;
  let downSec = 0;
  let upSec = 0;
  let repairs = 0;
  let repairSec = 0;
  for (const s of list) {
    failures += s.failures;
    downSec += s.downSec;
    upSec += s.upSec;
    repairs += s.repairs;
    repairSec += s.repairSec;
  }
  return {
    failures,
    downSec,
    upSec,
    mtbf: failures ? upSec / failures / 60 : null,
    mttr: repairs ? repairSec / repairs / 60 : null,
    availability: upSec + downSec > 0 ? upSec / (upSec + downSec) : null,
    downNow: list.filter((s) => s.down).length,
    pmDue: list.filter((s) => s.pm.status === 'due').length,
    pmSoon: list.filter((s) => s.pm.status === 'soon').length,
  };
}
