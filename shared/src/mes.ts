// 실행 MES (P9) 공용 규칙: 역할·권한, 교대, 작업지시, 불량 처리, 인터록, 초·중·종물, 예지 보전 기준.
// 서버(판정)와 화면(버튼 막기·표시)과 시뮬레이터 설명이 같은 규칙을 보도록 여기 한 곳에 둔다.
// 숫자는 공개된 특정 공장 기준이 아니라 일반적인 관행에서 정한 가정값이다 (근거 등급은 각 항목 주석).

import { LINES, STATIONS } from './factory';
import type { ChangeCategory, ChangeKind, Disposition, InspectionType, InterlockCode } from './live';
import type { DefectDef, LineCode, LineDef, StationDef, StepDef } from './types';

// ─────────────────────────── 역할·권한 ───────────────────────────

export type Role = 'operator' | 'leader' | 'quality' | 'maintenance' | 'admin';

export const ROLES: { code: Role; name: string; desc: string }[] = [
  { code: 'operator', name: '작업자', desc: '설비 정지·재가동 사유, 작업 전 점검, 변경점 신고' },
  { code: 'leader', name: '조장', desc: '작업지시·생산 계획, 시뮬레이터 제어, 불량 처리 판정' },
  { code: 'quality', name: '품질', desc: '불량 처리(MRB) 판정, Hold 설정·해제, 변경점 승인' },
  { code: 'maintenance', name: '보전', desc: '고장 수리 완료, 예방·예지 보전 실시' },
  { code: 'admin', name: '관리자', desc: '모든 권한, 감사 기록 조회' },
];

export const ROLE_NAMES: Record<Role, string> = Object.fromEntries(ROLES.map((r) => [r.code, r.name])) as Record<Role, string>;

/** 권한 코드. 서버 컨트롤러는 @Perm('wo.manage')로 붙이고, 화면은 can()으로 버튼을 막는다 */
export type PermCode =
  | 'sim.control' // 배속·일시정지·초기화·시나리오
  | 'station.op' // 설비 정지·셋업·재가동·고장 등록
  | 'station.repair' // 고장 수리 완료·예방/예지 보전 실시
  | 'check.record' // 작업 전 점검 기록
  | 'wo.manage' // 작업지시 만들기·순서·수량·중단
  | 'ncr.dispose' // 불량 처리 판정 (수리·재작업·폐기·특채)
  | 'hold.create' // Hold 설정
  | 'hold.release' // Hold 해제·격리품 폐기
  | 'change.register' // 4M 변경점 신고
  | 'change.approve' // 변경점 승인·초물 판정 확인
  | 'alarm.ack' // 알람 확인
  | 'audit.read'; // 감사 기록 조회

export const PERMISSIONS: Record<PermCode, Role[]> = {
  'sim.control': ['leader', 'admin'],
  'station.op': ['operator', 'leader', 'maintenance', 'admin'],
  'station.repair': ['maintenance', 'admin'],
  'check.record': ['operator', 'leader', 'admin'],
  'wo.manage': ['leader', 'admin'],
  'ncr.dispose': ['quality', 'leader', 'admin'],
  'hold.create': ['quality', 'leader', 'admin'],
  'hold.release': ['quality', 'admin'],
  'change.register': ['operator', 'leader', 'quality', 'maintenance', 'admin'],
  'change.approve': ['quality', 'admin'],
  'alarm.ack': ['operator', 'leader', 'quality', 'maintenance', 'admin'],
  'audit.read': ['admin'],
};

export const PERM_NAMES: Record<PermCode, string> = {
  'sim.control': '시뮬레이터 제어',
  'station.op': '설비 정지·재가동',
  'station.repair': '수리 완료·보전 실시',
  'check.record': '작업 전 점검',
  'wo.manage': '작업지시 관리',
  'ncr.dispose': '불량 처리 판정',
  'hold.create': 'Hold 설정',
  'hold.release': 'Hold 해제',
  'change.register': '변경점 신고',
  'change.approve': '변경점 승인',
  'alarm.ack': '알람 확인',
  'audit.read': '감사 기록 조회',
};

export function can(role: Role | null | undefined, perm: PermCode): boolean {
  return !!role && PERMISSIONS[perm].includes(role);
}

/** 요청한 사람 (서버 @Actor()·화면 useAuth().user). 인증을 끄면(AUTH=off) 서버는 SYSTEM_ACTOR로 본다 */
export interface ActorInfo {
  login: string;
  name: string;
  role: Role;
}

export const SYSTEM_ACTOR: ActorInfo = { login: 'system', name: '시스템', role: 'admin' };

/** 시연용 계정 (비밀번호는 서버 DEMO_PASSWORD, 기본 demo1234). 실제 사람이 아니다 */
export const DEMO_USERS: ActorInfo[] = [
  { login: 'op1', name: '현장 작업자', role: 'operator' },
  { login: 'lead1', name: '라인 조장', role: 'leader' },
  { login: 'qa1', name: '품질 담당', role: 'quality' },
  { login: 'mt1', name: '보전 담당', role: 'maintenance' },
  { login: 'admin', name: '시스템 관리자', role: 'admin' },
];

/** 로그인 쿠키 이름 (httpOnly, HMAC 서명) */
export const AUTH_COOKIE = 'lt_session';

/** GET /auth/me */
export interface MeView {
  /** 서버 인증이 켜져 있나 (AUTH=on). false면 화면은 모든 버튼을 연다 */
  enabled: boolean;
  user: ActorInfo | null;
  /** 로그인 화면의 시연 계정 버튼으로 비밀번호 없이 바로 로그인할 수 있나 (서버가 기본 비밀번호를 쓸 때) */
  demo: boolean;
}

/** 감사 기록 한 줄 (GET /audit) */
export interface AuditRow {
  id: string;
  /** 실제 시각 */
  at: string;
  /** 가상 시각 (그때 시뮬레이터 시계) */
  vAt: string | null;
  runId: number | null;
  user: string;
  role: string;
  action: string;
  target: string | null;
  detail: unknown;
  ip: string | null;
}

/** GET /audit */
export interface AuditView {
  rows: AuditRow[];
  /** 필터에 쓸 값 (전체 기록 기준, 많은 순) */
  actions: { action: string; count: number }[];
  users: { user: string; count: number }[];
}

// ─────────────────────────── 교대 ───────────────────────────

/** 2교대 (가정): 주간 08~20시, 야간 20~익일 08시 (한국 시각, 가상 시계 기준) */
export type ShiftCode = 'D' | 'N';
export const SHIFTS: { code: ShiftCode; name: string; startHour: number; hours: number }[] = [
  { code: 'D', name: '주간', startHour: 8, hours: 12 },
  { code: 'N', name: '야간', startHour: 20, hours: 12 },
];
export const SHIFT_NAMES: Record<ShiftCode, string> = { D: '주간', N: '야간' };

const KST_MS = 9 * 3600_000;

export interface ShiftSlot {
  code: ShiftCode;
  /** 교대가 시작한 날 (한국 시각, YYYY-MM-DD). 야간 02시는 전날 야간이다 */
  date: string;
  /** `${date}-${code}` */
  key: string;
  /** 시작·끝 (ISO, UTC) */
  start: string;
  end: string;
}

/** 가상 시각이 속한 교대 */
export function shiftOf(t: string | number | Date): ShiftSlot {
  const ms = typeof t === 'number' ? t : new Date(t).getTime();
  const local = ms + KST_MS;
  const day = Math.floor(local / 86_400_000) * 86_400_000; // 한국 시각 자정 (UTC ms에 9시간 더한 축)
  const hour = (local - day) / 3600_000;
  let startLocal: number;
  let code: ShiftCode;
  if (hour >= 8 && hour < 20) {
    code = 'D';
    startLocal = day + 8 * 3600_000;
  } else {
    code = 'N';
    startLocal = hour >= 20 ? day + 20 * 3600_000 : day - 4 * 3600_000;
  }
  const date = new Date(startLocal).toISOString().slice(0, 10);
  const start = startLocal - KST_MS;
  return { code, date, key: `${date}-${code}`, start: new Date(start).toISOString(), end: new Date(start + 12 * 3600_000).toISOString() };
}

/** 교대 키(`2026-11-13-D`) → 교대 */
export function shiftByKey(key: string): ShiftSlot | null {
  const m = /^(\d{4}-\d{2}-\d{2})-([DN])$/.exec(key);
  if (!m) return null;
  const hour = m[2] === 'D' ? 8 : 20;
  const start = Date.parse(`${m[1]}T${String(hour).padStart(2, '0')}:00:00+09:00`);
  return shiftOf(start);
}

// ─────────────────────────── 작업지시·생산 계획 ───────────────────────────

export type WoStatus = 'PLANNED' | 'RUNNING' | 'DONE' | 'CANCELLED';
export const WO_STATUS_NAMES: Record<WoStatus, string> = { PLANNED: '계획', RUNNING: '진행', DONE: '완료', CANCELLED: '중단' };

/**
 * 자동 계획의 작업지시 1건 수량 (가정): 약 2시간분 (택트 × 수량). 자동 계획은 기종을 번갈아 내므로 2시간마다 기종 변경 셋업이 생긴다
 */
export const WO_LOT: Record<LineCode, number> = { HL: 96, EM: 160, OSM: 120 };
/** 자동 계획: 라인마다 대기(PLANNED) 작업지시를 이만큼 앞서 둔다 */
export const WO_AHEAD = 3;
/** 한 작업지시 수량 한도 (화면 입력 검사) */
export const WO_QTY_MAX = 2000;

/** 작업지시 번호: WO-HL-261113-001 */
export function woCode(line: LineCode, t: string | number | Date, seq: number): string {
  const d = new Date(new Date(t).getTime() + KST_MS).toISOString().slice(2, 10).replace(/-/g, '');
  return `WO-${line}-${d}-${String(seq).padStart(3, '0')}`;
}

// ─────────────────────────── 공정 경로 도우미 ───────────────────────────

export function lineOf(code: LineCode): LineDef {
  const l = LINES.find((x) => x.code === code);
  if (!l) throw new Error(`라인 ${code} 없음`);
  return l;
}

export function stepOf(line: LineDef, step: string): StepDef | undefined {
  return line.steps.find((s) => s.code === step);
}

/** 이 공정의 주 개체가 바로 앞에 거쳐야 하는 공정 (같은 라인의 첫 번째 공정 입력). 새로 발번하는 공정은 없음 */
export function prevStep(line: LineDef, step: string): string | undefined {
  const s = stepOf(line, step);
  if (!s || s.serial === 'new') return undefined;
  return s.inputs.find((i) => i.step)?.step;
}

/** 제품 경로: 투입 공정(release)부터 최종 공정까지 시리얼을 이어 쓰는 공정들 (순서대로) */
export function productSteps(line: LineDef): string[] {
  const out = [line.release];
  for (;;) {
    const next = line.steps.find((s) => s.serial === 'keep' && s.inputs.find((i) => i.step)?.step === out[out.length - 1]);
    if (!next) break;
    out.push(next.code);
  }
  return out;
}

/** 이 공정이 제품 경로에 있나 (기종·작업지시가 붙고, 불량이 나면 불량 처리(NCR)를 연다) */
export function inProductScope(line: LineDef, step: string): boolean {
  return productSteps(line).includes(step);
}

/** 검사 공정: 측정값이나 잠재 불량 검출이 있는 설비 */
export function isInspection(s: StationDef): boolean {
  return !!(s.measures?.length || s.detects?.length);
}

/** 초물 검사가 필요한 설비: 인터록 게이트이거나 측정값이 있는 설비 (보조 설비 제외) */
export function faRequired(s: StationDef): boolean {
  return !s.aux && (!!s.gate || !!s.measures?.length);
}

/** 기종 변경 때 이 설비의 셋업 (없으면 셋업 없이 바로 다음 기종) */
export function changeoverOf(line: LineDef, station: string) {
  return line.changeover.find((c) => c.station === station);
}

export function variantName(line: LineDef | LineCode, code: string | null | undefined): string {
  if (!code) return '-';
  const l = typeof line === 'string' ? lineOf(line) : line;
  const v = l.variants.find((x) => x.code === code);
  return v ? `${v.code} ${v.name}` : code;
}

/** 불량 코드의 정의 (설비 불량 → 측정 규격 이탈 순으로 찾는다. 잠재 불량은 처음 만든 설비의 정의) */
export function defectDefOf(code: string): { def?: DefectDef; measure?: NonNullable<StationDef['measures']>[number] } {
  for (const s of Object.values(STATIONS)) {
    const d = s.defects?.find((x) => x.code === code);
    if (d) return { def: d };
  }
  for (const s of Object.values(STATIONS)) {
    const m = s.measures?.find((x) => x.defect === code);
    if (m) return { measure: m };
  }
  return {};
}

// ─────────────────────────── 불량 처리 (NCR) ───────────────────────────

export type NcrStatus = 'OPEN' | 'WAIT_MRB' | 'REPAIRING' | 'REINSPECT' | 'CLOSED';
export const NCR_STATUS_NAMES: Record<NcrStatus, string> = {
  OPEN: '접수',
  WAIT_MRB: 'MRB 판정 대기',
  REPAIRING: '수리·재작업 중',
  REINSPECT: '재검사 대기',
  CLOSED: '종결',
};

export const DISPOSITION_NAMES: Record<Disposition, string> = { REPAIR: '수리', REWORK: '재작업', SCRAP: '폐기', UAI: '특채 (그대로 사용)' };

/** 수리·재작업 기본값 (가정): 정의에 없으면 10분, 성공 85% */
export const REPAIR_DEFAULT = { minutes: 10, prob: 0.85 } as const;
/** 라인마다 수리대 작업자 수 (가정) */
export const REPAIR_TECHS = 1;

export type AutoRule = 'defect-rule' | 'default-repair' | 'default-scrap' | 'reinspect-ng' | 'repair-failed' | 'manual';
export const AUTO_RULE_NAMES: Record<AutoRule, string> = {
  'defect-rule': '불량 코드별 처리 기준',
  'default-repair': '검사 공정 기본 (수리 뒤 재검사)',
  'default-scrap': '가공 공정 기본 (폐기)',
  'reinspect-ng': '재검사 다시 불합격 → 폐기',
  'repair-failed': '수리 실패 → 폐기',
  manual: '담당자 판정',
};

/**
 * 불량이 났을 때 MES가 자동으로 내리는 처리. 'MRB'면 자동으로 정하지 않고 품질 담당자를 기다린다.
 * 1) 불량 코드(또는 측정)에 disposition이 있으면 그대로 2) 제품 경로의 검사 공정이면 수리 뒤 재검사 3) 아니면 폐기
 */
export function defaultDisposition(lineCode: LineCode, stationCode: string, defect: string): { action: Disposition | 'MRB'; rule: AutoRule; minutes: number; prob: number } {
  const { def, measure } = defectDefOf(defect);
  const src = def ?? measure;
  const minutes = src?.repairMin ?? REPAIR_DEFAULT.minutes;
  const prob = src?.repairProb ?? REPAIR_DEFAULT.prob;
  if (src?.disposition) return { action: src.disposition, rule: 'defect-rule', minutes, prob };
  const st = STATIONS[stationCode];
  if (st && isInspection(st) && inProductScope(lineOf(lineCode), st.step)) return { action: 'REPAIR', rule: 'default-repair', minutes, prob };
  return { action: 'SCRAP', rule: 'default-scrap', minutes, prob };
}

// ─────────────────────────── 인터록 ───────────────────────────

export const INTERLOCK_NAMES: Record<InterlockCode, string> = {
  ROUTE: '공정 순서 위반',
  NG: '불량 미처리',
  HOLD: 'Hold 대상',
  WO: '작업지시 불일치',
  FA: '초물 미승인',
  REPAIR: '재검사 순서 위반',
};
/** 시뮬레이터가 MES 응답을 기다리는 최대 시간 (실제 초). 넘기면 확인 없이 통과시키고 ilkSkip을 붙인다 */
export const ILK_TIMEOUT_SEC = 3;
/** WAIT 응답 뒤 다시 묻는 간격 (실제 초) */
export const ILK_RETRY_SEC = 1;
/** 앞 공정 실적이 아직 안 왔을 때 기다려 주는 시간 (실제 초). OPC UA 경로는 실적이 엣지를 거쳐 늦게 온다 */
export const ROUTE_GRACE_SEC = 5;

// ─────────────────────────── Hold ───────────────────────────

export type HoldKind = 'LOT' | 'SERIAL';
export type HoldStatus = 'ACTIVE' | 'RELEASED';
export const HOLD_STATUS_NAMES: Record<HoldStatus, string> = { ACTIVE: '격리 중', RELEASED: '해제' };
/** Hold 해제 때 판정 */
export type HoldResult = 'RELEASE' | 'SCRAP';

// ─────────────────────────── 4M 변경점·초중종물 ───────────────────────────

export const CHANGE_CATEGORY_NAMES: Record<ChangeCategory, string> = { MAN: '사람 (Man)', MACHINE: '설비 (Machine)', MATERIAL: '자재 (Material)', METHOD: '방법 (Method)' };
export const CHANGE_KIND_NAMES: Record<ChangeKind, string> = {
  shift: '교대 (작업자 변경)',
  repair: '고장 수리 뒤 재가동',
  lot: '자재 LOT 변경',
  changeover: '기종 변경',
  condition: '공정 조건 변경',
  pm: '예방·예지 보전',
  user: '작업자 신고',
};
/** 변경점 종류의 4M 분류 */
export const CHANGE_KIND_CATEGORY: Record<ChangeKind, ChangeCategory> = {
  shift: 'MAN',
  repair: 'MACHINE',
  lot: 'MATERIAL',
  changeover: 'METHOD',
  condition: 'METHOD',
  pm: 'MACHINE',
  user: 'METHOD',
};

export type FaStatus = 'PENDING' | 'OK' | 'NG' | 'NONE';
export const FA_STATUS_NAMES: Record<FaStatus, string> = { PENDING: '초물 대기', OK: '초물 합격', NG: '초물 불합격', NONE: '해당 없음' };

export const INSPECTION_NAMES: Record<InspectionType, string> = { FIRST: '초물', MID: '중물', LAST: '종물' };
/** 중물 검사 간격 (가상 시간, 가정) */
export const MID_INSPECT_HOURS = 4;

// ─────────────────────────── 예지 보전 ───────────────────────────

/**
 * 진동 판정 구역 경계 (mm/s RMS, ISO 10816-1 기계 등급별). A/B = 신품 수준 상한 · B/C = 장기 운전 한계(경고) · C/D = 손상 우려(위험).
 * ISO 10816-1은 ISO 20816-1로 바뀌었고 원문은 유료라 2차 자료로 확인한 값이다 (weak)
 */
export const VIB_ZONES: Record<'I' | 'II' | 'III', { ab: number; bc: number; cd: number }> = {
  I: { ab: 0.71, bc: 1.8, cd: 4.5 },
  II: { ab: 1.12, bc: 2.8, cd: 7.1 },
  III: { ab: 1.8, bc: 4.5, cd: 11.2 },
};
export const VIB_ZONES_GRADE = 'weak' as const;
/** 상태 감시 신호 간격 (가상 초) */
export const HEALTH_INTERVAL_SEC = 60;

export type HealthLevel = 'good' | 'watch' | 'warn' | 'danger';
export const HEALTH_LEVEL_NAMES: Record<HealthLevel, string> = { good: '양호', watch: '관찰', warn: '경고 (보전 계획)', danger: '위험 (즉시 보전)' };

/** 진동 값의 구역 */
export function vibLevel(cls: 'I' | 'II' | 'III', vib: number): HealthLevel {
  const z = VIB_ZONES[cls];
  return vib >= z.cd ? 'danger' : vib >= z.bc ? 'warn' : vib >= z.ab ? 'watch' : 'good';
}
