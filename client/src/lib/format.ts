import type { EquipmentKind, SourceGrade, StationState } from '@lumitwin/shared';

export const STATE_LABEL: Record<StationState, string> = {
  RUN: '가동',
  IDLE: '투입 대기',
  BLOCKED: '배출 대기',
  DOWN: '고장',
  SETUP: '셋업',
  STOP: '정지',
};

/** 경광등·배지 색 (3D와 화면이 같은 색을 쓴다) */
export const STATE_COLOR: Record<StationState, string> = {
  RUN: '#3ddc84',
  IDLE: '#8b9bb4',
  BLOCKED: '#f5b544',
  DOWN: '#ff4d5e',
  SETUP: '#4fb3ff',
  STOP: '#5b6578',
};

export const KIND_LABEL: Record<EquipmentKind, string> = {
  dryer: '제습 건조기',
  injection: '사출 성형기',
  'tunnel-hardcoat': '하드코팅 경화로',
  metallizer: '진공 증착기',
  'assembly-cell': '조립 셀',
  sealer: '실링기',
  'leak-tester': '리크 검사기',
  photometry: '배광 검사기',
  'eol-tester': '최종 검사기',
  packer: '포장기',
  'laser-marker': '레이저 마킹기',
  printer: '스크린 프린터',
  spi: '3D SPI',
  mounter: '칩 마운터',
  reflow: '리플로우 오븐',
  aoi: 'AOI',
  'router-cobot': '라우터 + 협동로봇',
  ict: 'ICT',
  coater: '컨포멀 코터',
  fct: '기능 검사기',
  'screw-cell': '체결 셀',
  'tunnel-paint': '도장 라인',
  'actuator-cell': '액추에이터 조립 셀',
  'function-tester': '기능 검사기',
};

export const GRADE_LABEL: Record<SourceGrade, { text: string; color: string; hint: string }> = {
  confirmed: { text: '확인', color: '#3ddc84', hint: '공개 자료에서 확인한 값' },
  weak: { text: '근거 약함', color: '#f5b544', hint: '업계 일반 자료로 추정한 값' },
  assumed: { text: '가정', color: '#8b9bb4', hint: '시뮬레이션을 위해 정한 값' },
};

const KST = 9 * 3600_000;

/** 가상 시각(UTC ISO) → 한국 시각 문자열 */
export function kst(iso: string | undefined | null, withDate = false): string {
  if (!iso) return '--:--:--';
  const d = new Date(Date.parse(iso) + KST);
  const p = (n: number) => String(n).padStart(2, '0');
  const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  return withDate ? `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${time}` : time;
}

export function duration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '-';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}

export const pct = (v: number | undefined, digits = 1) => (v == null || !Number.isFinite(v) ? '-' : `${(v * 100).toFixed(digits)}%`);

export function num(v: number | undefined | null, digits?: number): string {
  if (v == null || !Number.isFinite(v)) return '-';
  if (digits != null) return v.toFixed(digits);
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
}

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');
