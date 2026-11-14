// 관리계획서 (Control Plan, P9): 공장 정의(설비 태그·측정·불량·검사)에서 공정별 관리 항목·방법·주기·이상 시 조치를 만든다.
// 열 구성은 AIAG 관리계획서(APQP 산출물, IATF 16949 8.5.1.1) 양식을 따른다: 공정 번호·이름, 설비, 특성(제품/공정), 특별 특성,
// 규격, 평가·측정 방법, 시료 크기·주기, 관리 방법, 이상 시 조치(대응 계획).
// 공장 정의를 바꾸면 관리계획서도 같이 바뀐다 (따로 손으로 고치는 표가 아니다). 특별 특성 지정만 아래 SPECIAL_RULES 표로 정한다.

import { DEFECT_NAMES, FACTORY, LINES } from './factory';
import { SPC_SUBGROUP } from './live';
import {
  DISPOSITION_NAMES,
  ILK_RETRY_SEC,
  ILK_TIMEOUT_SEC,
  MID_INSPECT_HOURS,
  defaultDisposition,
  faRequired,
  inProductScope,
} from './mes';
import type { EquipmentKind, LineCode, LineDef, SourceGrade, StationDef } from './types';

// ─────────────────────────── 이름표 ───────────────────────────

/** 특성의 출처 */
export type CpSource = 'measure' | 'detect' | 'defect' | 'tag-continuous' | 'tag-cycle' | 'gate' | 'fa';
export const CP_SOURCE_NAMES: Record<CpSource, string> = {
  measure: '검사 측정값',
  detect: '검출 불량',
  defect: '설비 내 판정 불량',
  'tag-continuous': '공정 조건 (연속)',
  'tag-cycle': '공정 조건 (사이클)',
  gate: '공정 인터록',
  fa: '초·중·종물',
};

/** 평가·측정 방법 분류 */
export type CpEval = 'sensor' | 'cycle' | 'auto100' | 'detect' | 'inline' | 'fa' | 'mes';
export const CP_EVAL_NAMES: Record<CpEval, string> = {
  sensor: '센서 연속',
  cycle: '매 사이클',
  auto100: '전수 자동 검사',
  detect: 'AOI·ICT·기능 검출',
  inline: '설비 내 판정',
  fa: '초·중·종물',
  mes: 'MES 자동 판정',
};

/** 제품 특성(만들어진 물건의 성질) · 공정 특성(그 물건을 만드는 조건) */
export type CpCharKind = 'product' | 'process';
export const CP_CHAR_NAMES: Record<CpCharKind, string> = { product: '제품', process: '공정' };

/**
 * 특별 특성. CC = 법규·안전 (◆) · SC = 핵심 기능·고객 중요 (▲).
 * 기호는 고객사마다 다르다 (예: ◇·▽·Ⓢ 등). 여기서는 화면·인쇄에서 구별하기 쉬운 두 기호로 정했다 (가정)
 */
export type SpecialType = 'CC' | 'SC';
export const SPECIAL_SYMBOLS: Record<SpecialType, '◆' | '▲'> = { CC: '◆', SC: '▲' };
export const SPECIAL_NAMES: Record<SpecialType, string> = { CC: '법규·안전 특별 특성', SC: '핵심 기능 특별 특성' };
export const SPECIAL_DESC: Record<SpecialType, string> = {
  CC: '어기면 법규 위반이거나 사람이 다칠 수 있는 특성. 전수 검사를 줄이거나 빼지 않고, 이탈하면 라인을 세우고 품질 확인 뒤 다시 돌린다',
  SC: '제품 기능·수명이나 고객이 바로 느끼는 품질을 좌우하는 특성. 공정능력(Cpk 1.33 이상)을 관리하고 이탈하면 원인을 찾는다',
};

export interface SpecialMark {
  type: SpecialType;
  symbol: '◆' | '▲';
  /** 왜 특별 특성인가 */
  reason: string;
  /** 지정 근거의 등급 */
  grade: SourceGrade;
}

export interface CpSpec {
  lsl?: number;
  nominal?: number;
  usl?: number;
  unit: string;
  /** 사람이 읽는 규격 (예: "4.5 ~ 12 µm · 기준 8") */
  text: string;
}

export interface ControlPlanRow {
  /** 표 안에서 고유: `${station}:${source}:${key}` */
  id: string;
  /** 특성 번호: 공정 번호.순번 (예: 30.2) */
  no: string;
  /** 공정 번호 (라인의 공정 순서 × 10) */
  opNo: number;
  line: LineCode;
  step: string;
  stepName: string;
  station: string;
  stationName: string;
  equipment: EquipmentKind;
  charKind: CpCharKind;
  source: CpSource;
  /** 태그·측정 키 또는 불량 코드 */
  key: string;
  name: string;
  spec: CpSpec;
  special: SpecialMark | null;
  evalCode: CpEval;
  evaluation: string;
  sampleSize: string;
  frequency: string;
  /** 관리 방법 (여러 개) */
  controls: string[];
  /** 이상 시 조치 (대응 계획) */
  reactions: string[];
  /** 특성 정의(규격·불량 모델)의 근거 등급 */
  grade: SourceGrade;
  note?: string;
}

export interface ControlPlanLine {
  line: LineCode;
  name: string;
  product: { code: string; name: string };
  variants: { code: string; name: string }[];
  /** 관리계획서 단계 (시작품 · 양산 준비 · 양산) */
  phase: string;
  docNo: string;
  rows: ControlPlanRow[];
  counts: { product: number; process: number; cc: number; sc: number; stations: number };
}

export interface ControlPlan {
  lines: ControlPlanLine[];
  /** 관리계획서가 따르는 MES 기준값 (mes.ts·live.ts) */
  basis: { spcSubgroup: number; midInspectHours: number; ilkTimeoutSec: number; ilkRetrySec: number };
}

// ─────────────────────────── 특별 특성 지정 ───────────────────────────

/**
 * 특별 특성 지정 표. 실제로는 고객 지정 + 설계·공정 FMEA(심각도 9~10 → CC, 영향 큰 기능 → SC)로 정한다.
 * 여기서는 공개 법규·자료와 공장 모델의 인과(어느 공정 조건이 어느 제품 특성을 움직이나)로 정했다. 등급은 지정 근거의 등급이다
 */
export interface SpecialRule {
  /** 태그·측정 키 또는 불량 코드 */
  key: string;
  line?: LineCode;
  station?: string;
  sources?: CpSource[];
  type: SpecialType;
  reason: string;
  grade: SourceGrade;
}

export const SPECIAL_RULES: SpecialRule[] = [
  // ── 헤드램프 ──
  {
    key: 'aim_v', line: 'HL', type: 'CC', grade: 'confirmed',
    reason: '전조등 광축은 등화 법규(UN R149·FMVSS 108) 시험 항목이다. 위로 틀어지면 맞은편 운전자 눈부심, 아래로 틀어지면 전방 시야 부족',
  },
  {
    key: 'max_kcd', line: 'HL', type: 'CC', grade: 'confirmed',
    reason: '최대 광도는 등화 법규(UN R149·FMVSS 108) 배광 기준 항목이다. 모자라면 야간 시인 거리가 줄어든다',
  },
  {
    key: 'CONN', line: 'HL', sources: ['detect'], type: 'CC', grade: 'weak',
    reason: '커넥터 미체결 램프는 점등되지 않는다. 등화 미작동은 법규 위반이자 야간 안전 문제 (EOL이 마지막 거름망)',
  },
  {
    key: 'COLD', line: 'HL', sources: ['detect'], type: 'CC', grade: 'weak',
    reason: 'LED 모듈 냉납은 진동·열 사이클에서 간헐 소등으로 이어진다. 등화 미작동과 같은 안전 영향',
  },
  { key: 'lamp_current', line: 'HL', type: 'SC', grade: 'assumed', reason: '소비 전류는 LED 구동 회로·배선 이상을 걸러 내는 기능 특성' },
  {
    key: 'leak_drop', line: 'HL', type: 'SC', grade: 'weak',
    reason: '기밀 불량은 수분 침투 → 김서림·LED·커넥터 부식으로 이어진다 (램프의 대표 시장 불만 유형)',
  },
  { key: 'hotmelt_temp', line: 'HL', type: 'SC', grade: 'weak', reason: '핫멜트 온도는 실링 완전성 → 기밀(▲)을 좌우하는 공정 조건' },
  { key: 'bead_volume', line: 'HL', type: 'SC', grade: 'weak', reason: '실런트 도포량은 실링 완전성 → 기밀(▲)을 좌우하는 공정 조건' },
  { key: 'al_thick', line: 'HL', type: 'SC', grade: 'weak', reason: '알루미늄 반사막 두께 → 반사율 → 최대 광도(◆)에 영향을 주는 공정 조건' },
  { key: 'coat_thick', line: 'HL', type: 'SC', grade: 'weak', reason: '하드코트 두께가 모자라면 내후·내마모가 떨어져 렌즈 황변·흐림 → 광도 저하' },
  // ── 전장 (BMS) ──
  {
    key: 'cell_v_err', line: 'EM', type: 'CC', grade: 'weak',
    reason: '셀 전압 측정 정확도는 BMS가 과충전·과방전을 막는 판단의 입력이다 (기능 안전 ISO 26262 대상 기능). 틀리면 셀 발열·손상',
  },
  { key: 'sleep_ua', line: 'EM', type: 'SC', grade: 'weak', reason: '암전류가 크면 주차 중 배터리가 방전돼 시동이 안 걸린다' },
  { key: 'insulation', line: 'EM', type: 'SC', grade: 'assumed', reason: '절연저항이 낮으면 습기에서 누설 전류·부식 단락이 생긴다 (코팅 품질의 최종 확인)' },
  { key: 'paste_volume', line: 'EM', type: 'SC', grade: 'weak', reason: '페이스트 체적은 미납·브리지(SMT 불량의 대부분)를 좌우한다' },
  { key: 'peak_temp', station: 'EM-RF-B', type: 'SC', grade: 'weak', reason: '리플로우 피크 온도가 낮으면 냉납 (외관 검사로 절반만 보인다) → BMS 기능 상실' },
  { key: 'tal', station: 'EM-RF-B', type: 'SC', grade: 'weak', reason: '액상선 이상 시간(TAL)이 짧으면 냉납, 길면 부품 열손상' },
  { key: 'coat_thick', line: 'EM', type: 'SC', grade: 'weak', reason: '컨포멀 코팅 두께 → 절연·내습 (절연저항 ▲)' },
  // ── 사이드미러 ──
  {
    key: 'CONN', line: 'OSM', sources: ['detect'], type: 'CC', grade: 'weak',
    reason: '커넥터 미체결이면 미러의 턴시그널(방향지시등)이 켜지지 않는다. 등화 법규(UN R6·FMVSS 108) 항목',
  },
  {
    key: 'glass_force', line: 'OSM', type: 'CC', grade: 'weak',
    reason: '글래스 압입력이 모자라면 주행 진동에 글래스가 빠져 후방 시야를 잃는다 (간접 시계 장치 법규 UN R46)',
  },
  { key: 'heater_a', line: 'OSM', type: 'SC', grade: 'assumed', reason: '히터 성능 → 김서림·성에 제거 (궂은 날씨 후방 시야)' },
  { key: 'noise', line: 'OSM', type: 'SC', grade: 'weak', reason: '작동 소음은 고객이 바로 느끼는 감성 품질 항목 (액추에이터 공개 사양 47 dB(A) 미만)' },
  { key: 'fold_time', line: 'OSM', type: 'SC', grade: 'assumed', reason: '폴딩 시간은 액추에이터 기능·수명 특성' },
  { key: 'fold_current', line: 'OSM', type: 'SC', grade: 'assumed', reason: '모터 전류 상승은 기어 마찰·과부하의 신호 (모터 수명)' },
  { key: 'grease_mg', line: 'OSM', type: 'SC', grade: 'weak', reason: '그리스가 모자라면 기어 마찰 → 작동 소음(▲)·전류 상승' },
  // ── 공통 ──
  { key: 'screw_torque', type: 'SC', grade: 'assumed', reason: '체결 토크가 모자라면 진동에 풀리고, 넘치면 나사산·보스가 상한다' },
];

/** 이 특성의 특별 특성 지정 (앞 규칙이 이긴다: 라인·설비를 좁힌 규칙을 먼저 둔다) */
export function specialOf(line: LineCode, station: string, source: CpSource, key: string, rules: SpecialRule[] = SPECIAL_RULES): SpecialMark | null {
  const r = rules.find((x) => x.key === key && (!x.line || x.line === line) && (!x.station || x.station === station) && (!x.sources || x.sources.includes(source)));
  return r ? { type: r.type, symbol: SPECIAL_SYMBOLS[r.type], reason: r.reason, grade: r.grade } : null;
}

// ─────────────────────────── 만들기 ───────────────────────────

/** 숫자 규격을 읽기 쉬운 글로: "4.5 ~ 12 µm · 기준 8" · "≤ 1000 Pa" · "≥ 32 kcd" */
export function specText(lsl: number | undefined, usl: number | undefined, unit: string, nominal?: number): string {
  const u = unit ? ` ${unit}` : '';
  const range = lsl != null && usl != null ? `${lsl} ~ ${usl}${u}` : usl != null ? `≤ ${usl}${u}` : lsl != null ? `≥ ${lsl}${u}` : '규격 없음';
  return nominal != null ? `${range} · 기준 ${nominal}` : range;
}

/** 측정·검출 설비 종류별 평가 방법 */
const EVAL_BY_KIND: Partial<Record<EquipmentKind, string>> = {
  'leak-tester': '압력 강하법 기밀 시험',
  photometry: '카메라식 배광·광축 측정 (암실)',
  'eol-tester': '최종 전기 시험 (점등·통신·절연)',
  spi: '3D 높이·체적 측정',
  aoi: 'AOI 영상 판정',
  ict: 'ICT 핀 접촉 전기 시험',
  fct: '기능 시험 (셀 전압·전류·통신)',
  'function-tester': '기능 시험 (폴딩·전류·소음·히터)',
};

type Station = StationDef;

/**
 * 잠재 불량이 생긴 설비: 이 공정의 입력을 거슬러 올라가며(가까운 공정부터) 그 불량을 만드는 설비를 찾는다.
 * 다른 라인에서 이송돼 온 부품(예: 전장 LED 레인 → 헤드램프 조립)도 따라간다
 */
export function defectOrigin(lineCode: LineCode, step: string, defect: string, lines: LineDef[] = LINES): (Station & { line: LineCode }) | null {
  const all = [...lines, ...LINES.filter((l) => !lines.some((x) => x.code === l.code))];
  const lineBy = new Map(all.map((l) => [l.code, l]));
  const seen = new Set<string>();
  const queue: [LineCode, string][] = [];
  const enqueueInputs = (lc: LineCode, sc: string) => {
    const s = lineBy.get(lc)?.steps.find((x) => x.code === sc);
    for (const i of s?.inputs ?? []) {
      if (i.step) queue.push([lc, i.step]);
      else if (i.transfer) {
        const t = FACTORY.transfers.find((x) => x.code === i.transfer);
        if (t) queue.push([t.from.line, t.from.step]);
      }
    }
  };
  enqueueInputs(lineCode, step);
  while (queue.length) {
    const [lc, sc] = queue.shift()!;
    if (seen.has(`${lc}.${sc}`)) continue;
    seen.add(`${lc}.${sc}`);
    const st = lineBy.get(lc)?.stations.find((x) => x.step === sc && x.defects?.some((d) => d.code === defect));
    if (st) return { ...st, line: lc };
    enqueueInputs(lc, sc);
  }
  return null;
}

function dispositionText(line: LineDef, st: Station, defect: string): string {
  if (!inProductScope(line, st.step)) return '불량 즉시 폐기 (제품 경로 밖 부품, NCR 없음)';
  const d = defaultDisposition(line.code, st.code, defect);
  if (d.action === 'MRB') return 'NCR 개설 → MRB 판정 대기 (품질 담당이 수리·폐기·특채 결정)';
  const how = d.action === 'REPAIR' || d.action === 'REWORK' ? `${DISPOSITION_NAMES[d.action]} ${d.minutes}분 → 검출 공정 재검사` : DISPOSITION_NAMES[d.action];
  return `NCR 자동 개설 → ${how}`;
}

/**
 * 공장 정의로 관리계획서를 만든다 (순수 함수).
 * - 제품 특성: 검사 측정값(전수 자동 검사) · 검출 불량(AOI·ICT·기능 시험) · 설비 내 판정 불량(외관·조립)
 * - 공정 특성: 규격(하한·상한)이 있는 태그. 연속 태그는 센서 규격 경보, 사이클 태그는 가공마다 기록하고 X̄-R 관리도로 감시
 * - 설비 관리: 인터록 게이트 설비의 투입 확인, 초물 대상 설비의 초·중·종물
 */
export function buildControlPlan(lines: LineDef[] = LINES, rules: SpecialRule[] = SPECIAL_RULES): ControlPlan {
  return {
    lines: lines.map((l) => buildLine(l, rules, lines)),
    basis: { spcSubgroup: SPC_SUBGROUP, midInspectHours: MID_INSPECT_HOURS, ilkTimeoutSec: ILK_TIMEOUT_SEC, ilkRetrySec: ILK_RETRY_SEC },
  };
}

function buildLine(line: LineDef, rules: SpecialRule[], lines: LineDef[]): ControlPlanLine {
  const rows: ControlPlanRow[] = [];
  const stepIndex = new Map(line.steps.map((s, i) => [s.code, i]));
  // 공정 순서 → 같은 공정 안에서는 라인 정의의 설비 순서
  const stations = [...line.stations].sort((a, b) => (stepIndex.get(a.step) ?? 99) - (stepIndex.get(b.step) ?? 99));
  const seq = new Map<number, number>();

  for (const st of stations) {
    const step = line.steps.find((s) => s.code === st.step);
    const opNo = ((stepIndex.get(st.step) ?? 0) + 1) * 10;
    const scope = inProductScope(line, st.step);
    const fa = faRequired(st);
    const base = { line: line.code, step: st.step, stepName: step?.name ?? st.step, station: st.code, stationName: st.name, equipment: st.kind, opNo };
    const push = (r: Omit<ControlPlanRow, 'id' | 'no' | keyof typeof base | 'special'>) => {
      const n = (seq.get(opNo) ?? 0) + 1;
      seq.set(opNo, n);
      const special = specialOf(line.code, st.code, r.source, r.key, rules);
      const reactions = special?.type === 'CC' ? ['◆ 이탈 시 라인 정지 검토 · 품질 확인 전 출하 보류', ...r.reactions] : r.reactions;
      const controls = special?.type === 'SC' && r.source !== 'detect' && r.source !== 'defect' ? [...r.controls, '공정능력 Cpk ≥ 1.33 관리'] : r.controls;
      rows.push({ ...base, ...r, id: `${st.code}:${r.source}:${r.key}`, no: `${opNo}.${n}`, special, reactions, controls });
    };
    // 하류 게이트 인터록이 미처리 불량을 막는다 (제품 경로 안에서만 불량 처리·인터록이 돈다)
    const downstream = scope ? ['하류 게이트 인터록: 불량 처리 안 끝난 개체 투입 거부'] : [];
    const evalName = EVAL_BY_KIND[st.kind];

    // ── 제품 특성: 검사 측정값 ──
    for (const m of st.measures ?? []) {
      push({
        charKind: 'product', source: 'measure', key: m.key, name: m.name,
        spec: { lsl: m.lsl, usl: m.usl, nominal: m.base, unit: m.unit, text: specText(m.lsl, m.usl, m.unit, m.base) },
        evalCode: 'auto100', evaluation: `${CP_EVAL_NAMES.auto100} · ${evalName ?? '설비 자동 측정'}`,
        sampleSize: '전수', frequency: `매 개체 · 관리도 부분군 ${SPC_SUBGROUP}개`,
        controls: [`SPC X̄-R 관리도 (n=${SPC_SUBGROUP}, 판정 규칙 R1~R4 알람)`, '규격 판정 (전수 합·불)', ...downstream],
        reactions: [dispositionText(line, st, m.defect), 'SPC 이상 → SPC 알람 · 공정 조건·계측기 확인', '원인 구간 판정 → LOT·시리얼 Hold'],
        grade: m.grade, note: m.note,
      });
    }

    // ── 제품 특성: 검출 불량 (앞 공정에서 생긴 잠재 불량을 이 설비가 찾는다) ──
    for (const d of st.detects ?? []) {
      const origin = defectOrigin(line.code, st.step, d.defect, lines);
      const def = origin?.defects?.find((x) => x.code === d.defect);
      const name = def?.name ?? DEFECT_NAMES[d.defect] ?? d.defect;
      push({
        charKind: 'product', source: 'detect', key: d.defect, name: `${name} 없음`,
        spec: { unit: '', text: `불량 없음 · 검출률 ${Math.round(d.prob * 100)}%` },
        evalCode: 'detect', evaluation: `${CP_EVAL_NAMES.detect} · ${evalName ?? '설비 자동 판정'}`,
        sampleSize: '전수', frequency: '매 개체',
        controls: ['검출 판정 (전수)', ...downstream],
        reactions: [
          dispositionText(line, st, d.defect),
          origin ? `발생 공정 조건 확인: ${origin.code} ${origin.name}` : '발생 공정 조건 확인',
          '같은 시기 생산품 추적 → 필요 시 Hold',
        ],
        grade: st.grade,
        note: d.prob < 0.7 ? `검출률이 낮다 (${Math.round(d.prob * 100)}%): 뒤 공정 검사와 함께 관리` : undefined,
      });
    }

    // ── 제품 특성: 설비 안에서 판정하는 불량 (잠재 불량은 뒤 검출 공정에서 다룬다) ──
    for (const d of (st.defects ?? []).filter((x) => !x.latent)) {
      push({
        charKind: 'product', source: 'defect', key: d.code, name: `${d.name} 없음`,
        spec: { unit: '', text: '불량 없음 (한도 견본)' },
        evalCode: 'inline', evaluation: `${CP_EVAL_NAMES.inline} · 가공마다 합·불`,
        sampleSize: '전수', frequency: '가공마다',
        controls: ['불량률 감시 (최근 40개 중 10% 이상 → 알람)', ...downstream],
        reactions: [dispositionText(line, st, d.code), '불량률 상승 → QUALITY 알람 · 원인 공정 조건 확인'],
        grade: d.grade, note: d.note,
      });
    }

    // ── 공정 특성: 규격이 있는 태그 ──
    for (const t of st.tags) {
      if (t.lsl == null && t.usl == null) continue;
      const spec = { lsl: t.lsl, usl: t.usl, nominal: t.nominal, unit: t.unit, text: specText(t.lsl, t.usl, t.unit, t.nominal) };
      if (t.mode === 'continuous') {
        push({
          charKind: 'process', source: 'tag-continuous', key: t.key, name: t.name, spec,
          evalCode: 'sensor', evaluation: `${CP_EVAL_NAMES.sensor} · 설비 센서 → MQTT`,
          sampleSize: '연속', frequency: '실시간 1초마다 수집',
          controls: ['규격 경보 (3회 연속 이탈)', '추세 그래프 (자기상관이 있어 관리도 알람은 쓰지 않음)'],
          reactions: ['규격 이탈 → LIMIT 경보 · 조건 복원', '이탈 구간 생산품 추적 → 필요 시 Hold'],
          grade: t.grade, note: t.note,
        });
      } else {
        push({
          charKind: 'process', source: 'tag-cycle', key: t.key, name: t.name, spec,
          evalCode: 'cycle', evaluation: `${CP_EVAL_NAMES.cycle} · 가공 기록 (개체 이력에 남음)`,
          sampleSize: (st.batch ?? 1) > 1 ? `배치마다 1값 (${st.batch}개)` : '가공마다 1값', frequency: `매 사이클 · 관리도 부분군 ${SPC_SUBGROUP}개`,
          controls: [`X̄-R 관리도 감시 (n=${SPC_SUBGROUP}, 알람 없음)`, '규격 표시'],
          reactions: ['관리도 규칙 위반 → 조건 확인·조정', '규격 밖 사이클 → 그 개체 추적 · 필요 시 Hold'],
          grade: t.grade, note: t.note,
        });
      }
    }

    // ── 설비 관리: 투입 확인 (공정 인터록) ──
    if (st.gate) {
      push({
        charKind: 'process', source: 'gate', key: 'interlock', name: '투입 확인 (공정 인터록)',
        spec: { unit: '', text: '공정 순서 · 불량 처리 · Hold · 작업지시 · 초물 모두 통과' },
        evalCode: 'mes', evaluation: `${CP_EVAL_NAMES.mes} · 투입 요청마다 MES가 판정`,
        sampleSize: '전수', frequency: '투입마다',
        controls: ['인터록 게이트 (실수 방지 장치)', '거부·대기 이력 기록'],
        reactions: [
          '거부 → 격리 구역 이송 · INTERLOCK 알람',
          `대기(초물·실적 지연) → ${ILK_RETRY_SEC}초마다 다시 확인`,
          `MES 무응답 ${ILK_TIMEOUT_SEC}초 → 통과시키고 기록 (사후 확인)`,
        ],
        grade: 'assumed',
      });
    }

    // ── 설비 관리: 초·중·종물 ──
    if (fa) {
      push({
        charKind: 'product', source: 'fa', key: 'fa', name: '초·중·종물 검사',
        spec: { unit: '', text: '이 설비의 측정값·사이클 태그 규격 전 항목' },
        evalCode: 'fa',
        evaluation: `초물: 4M 변경점 뒤 첫 개체 · 중물: ${MID_INSPECT_HOURS}시간마다 · 종물: 교대 끝·작업지시 마지막 개체`,
        sampleSize: '각 1개', frequency: `변경점마다 · ${MID_INSPECT_HOURS}시간마다 · 교대·작업지시마다`,
        controls: [st.gate ? '초물 승인 전 후속 투입 대기 (인터록 FA)' : '초물 판정 기록', '변경점 승인 (품질 서명)'],
        reactions: ['초물 불합격 → FA 알람 · 다음 개체를 다시 초물로', '중·종물 불합격 → 직전 합격 검사 이후 생산품 범위 Hold 검토'],
        grade: 'assumed',
      });
    }
  }

  const count = (f: (r: ControlPlanRow) => boolean) => rows.filter(f).length;
  return {
    line: line.code,
    name: line.name,
    product: line.product,
    variants: line.variants.map((v) => ({ code: v.code, name: v.name })),
    phase: '양산 (Production)',
    docNo: `CP-${line.product.code}`,
    rows,
    counts: {
      product: count((r) => r.charKind === 'product'),
      process: count((r) => r.charKind === 'process'),
      cc: count((r) => r.special?.type === 'CC'),
      sc: count((r) => r.special?.type === 'SC'),
      stations: new Set(rows.map((r) => r.station)).size,
    },
  };
}
