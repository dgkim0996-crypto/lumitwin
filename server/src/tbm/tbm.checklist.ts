import {
  FACTORY,
  HOLD_KIND_NAMES,
  LINES,
  STATIONS,
  TBM_MES_ITEMS_MAX,
  tbmFixedItems,
  type FaStationView,
  type HoldView,
  type LineCode,
  type QuarantineView,
  type StationHealth,
  type TbmItem,
} from '@lumitwin/shared';

// 그날 MES 상태에서 TBM 자동 항목을 만든다. 회의를 올리는 순간의 상태를 회의 기록에 그대로 남긴다(나중에 상태가 바뀌어도
// 그 회의가 무엇과 대조됐는지 알 수 있게). 순수 함수라 서비스 없이 시험한다.

/** 체크리스트를 만들 때 보는 MES 상태 (그 라인 것만 골라 넣지 않아도 된다: 여기서 거른다) */
export interface TbmMesState {
  /** 지금 고장(DOWN)인 설비 코드 */
  downStations: string[];
  holds: HoldView[];
  quarantine: QuarantineView[];
  fa: FaStationView[];
  health: StationHealth[];
  /** 라인별 MRB(불량 판정) 대기 건수 */
  mrbWaiting: Partial<Record<LineCode, number>>;
}

const CHECK = ['확인', '점검', '체크', '반드시', '꼭', '공유', '주의', '조심'];
/** 설비 이름에서 뺄 흔한 낱말 (이 말만으로 그 설비를 가리킨다고 볼 수 없다, assumed) */
const STOP = new Set(['라인', '셀', '협동로봇', '양팔', '이동', '기능', '2캐비티', '좌', '우', '좌우', '검사', '시험', '선택', '최종', '모듈']);

/** 자재 코드 → 쓰는 라인 */
const MATERIAL_LINES = new Map<string, LineCode[]>();
for (const l of LINES) {
  for (const s of l.steps) {
    for (const i of s.inputs) {
      if (!i.material) continue;
      const arr = MATERIAL_LINES.get(i.material) ?? [];
      if (!arr.includes(l.code)) arr.push(l.code);
      MATERIAL_LINES.set(i.material, arr);
    }
  }
}
/** 시리얼 앞 글자 → 라인 (공정이 새 시리얼을 매길 때의 prefix) */
const PREFIX_LINE: [string, LineCode][] = LINES.flatMap((l) => l.steps.filter((s) => s.prefix).map((s) => [s.prefix as string, l.code] as [string, LineCode]));
const MATERIAL_NAMES = new Map(FACTORY.materials.map((m) => [m.code, m.name]));

const serialLine = (serial: string): LineCode | null => PREFIX_LINE.find(([p]) => serial.startsWith(p))?.[1] ?? null;

/** 이름 → 핵심 낱말: 한글 2자 이상·영문 3자 이상, 숫자 섞인 말(650t)·흔한 말 제외. '~기'로 끝나는 긴 설비 이름은 끝 세 글자도 (진공증착기 → 증착기) */
export function nameWords(name: string): string[] {
  const out = new Set<string>();
  for (const w of name.split(/[\s()+·/,]+/)) {
    if (!w || /\d/.test(w) || STOP.has(w)) continue;
    const hangul = /[가-힣]/.test(w);
    if (hangul ? w.length < 2 : w.length < 3) continue;
    out.add(w);
    if (hangul && w.length >= 4 && w.endsWith('기')) out.add(w.slice(-3));
  }
  return [...out];
}

/** 설비 본 이름(괄호 앞)의 낱말과 붙은 두 낱말 */
function mainWords(name: string): { words: string[]; pairs: string[] } {
  // 괄호 안 설명("(폴딩·소음·히팅)")은 설비를 부르는 이름이 아니라 뺀다
  const main = name.split('(')[0];
  const toks = main.split(/[\s+·/,]+/).filter((w) => w && !/\d/.test(w));
  const pairs: string[] = [];
  for (let i = 0; i + 1 < toks.length; i++) if (!STOP.has(toks[i + 1]) || toks[i + 1] === '라인') pairs.push(`${toks[i]} ${toks[i + 1]}`);
  return { words: nameWords(main), pairs };
}

/** 낱말이 공장 전체 설비 이름에 몇 번 나오나 ('사출기'·'리플로우 오븐'은 여러 대) */
const WORD_COUNT = new Map<string, number>();
for (const s of Object.values(STATIONS)) {
  const m = mainWords(s.name);
  for (const w of new Set([...m.words, ...m.pairs])) WORD_COUNT.set(w, (WORD_COUNT.get(w) ?? 0) + 1);
}

/**
 * 회의에서 그 설비를 가리켰다고 볼 낱말: 설비 코드, 이 설비에만 있는 이름 낱말, 붙은 두 낱말("렌즈 사출기").
 * 여러 설비에 겹치는 낱말 하나("사출기")만으로는 어느 설비인지 모르므로 쓰지 않는다
 */
function stationWords(code: string): string[] {
  const st = STATIONS[code];
  if (!st) return [code];
  const m = mainWords(st.name);
  return [...new Set([code, ...[...m.words, ...m.pairs].filter((w) => (WORD_COUNT.get(w) ?? 0) <= 1)])];
}

const stationLabel = (code: string) => `${STATIONS[code]?.name ?? code} (${code})`;

/** 이 Hold가 그 라인에 걸리는가: LOT은 그 자재를 쓰는 라인, SERIAL은 시리얼 앞 글자·격리품 위치로 */
function holdLines(h: HoldView, quarantine: QuarantineView[]): LineCode[] {
  if (h.kind === 'LOT' && h.material) return MATERIAL_LINES.get(h.material) ?? [];
  const set = new Set<LineCode>();
  for (const s of h.serials) {
    const l = serialLine(s);
    if (l) set.add(l);
  }
  for (const q of quarantine) if (q.holdId === h.id) set.add(q.line);
  return [...set];
}

/** 그 라인의 MES 자동 항목. 고장 → Hold → 초물 대기 → 예지 보전(위험 먼저) → MRB 순으로 TBM_MES_ITEMS_MAX개까지 */
export function mesItems(line: LineCode, s: TbmMesState): TbmItem[] {
  const items: TbmItem[] = [];
  const inLine = (code: string) => STATIONS[code]?.line === line;

  for (const code of s.downStations.filter(inLine)) {
    items.push({
      code: `MES-DOWN-${code}`, source: 'MES', ref: code, grade: 'confirmed',
      title: `고장 설비 공유: ${stationLabel(code)}`,
      desc: '지금 고장으로 멈춘 설비를 알리고, 수리 중 접근 금지·잠금(LOTO) 확인과 대체 작업을 짚는다',
      keys: stationWords(code),
      acts: [...CHECK, '고장', '수리', '정지', '멈춰', '멈췄', 'LOTO', '잠금', '접근', '들어가지', '건드리지'],
    });
  }
  for (const h of s.holds.filter((x) => x.status === 'ACTIVE' && holdLines(x, s.quarantine).includes(line))) {
    const target = h.kind === 'LOT' ? `${MATERIAL_NAMES.get(h.material ?? '') ?? h.material} LOT ${h.lot}` : `시리얼 ${h.serials.length}개`;
    items.push({
      code: `MES-HOLD-${h.code}`, source: 'MES', ref: h.code, grade: 'confirmed',
      title: `Hold 공유: ${h.code} · ${target}`,
      desc: `${HOLD_KIND_NAMES[h.kind]} Hold(${h.reason})를 알려, 모르고 투입하거나 옮기지 않게 한다`,
      keys: ['Hold', '홀드', '격리', '보류', h.code, ...(h.lot ? [h.lot] : []), ...(h.material ? nameWords(MATERIAL_NAMES.get(h.material) ?? '') : [])],
      acts: [...CHECK, '쓰지', '투입 금지', '사용 금지', '손대지', '옮기지', '금지'],
    });
  }
  for (const f of s.fa.filter((x) => x.line === line && x.pending.length)) {
    items.push({
      code: `MES-FA-${f.station}`, source: 'MES', ref: f.station, grade: 'confirmed',
      title: `초물 확인 대기: ${stationLabel(f.station)}`,
      desc: `변경점(${f.pending[0].detail}) 뒤 첫 제품 초물 검사가 아직 나오지 않았다. 초물 판정 전 양산 진행 금지를 짚는다`,
      keys: ['초물', '첫 제품', ...stationWords(f.station)],
      acts: [...CHECK, '검사', '받고', '판정', '기다'],
    });
  }
  const pdm = s.health
    .filter((h) => h.line === line && (h.level === 'warn' || h.level === 'danger'))
    .sort((a, b) => Number(b.level === 'danger') - Number(a.level === 'danger'));
  for (const h of pdm) {
    items.push({
      code: `MES-PDM-${h.station}`, source: 'MES', ref: h.station, grade: 'weak',
      title: `예지 보전 ${h.level === 'danger' ? '위험' : '경고'}: ${stationLabel(h.station)} ${h.part}`,
      desc: `${h.part} 진동이 커졌다. 이상 소리·진동이 나면 멈추고 보전을 부르라고 짚는다`,
      keys: [...stationWords(h.station), ...nameWords(h.part), '진동'],
      acts: [...CHECK, '보전', '교체', '이상', '소리', '멈추', '멈춰'],
    });
  }
  const mrb = s.mrbWaiting[line] ?? 0;
  if (mrb > 0) {
    items.push({
      code: 'MES-MRB', source: 'MES', ref: null, grade: 'confirmed',
      title: `MRB 판정 대기 불량 ${mrb}건`,
      desc: '판정을 기다리는 불량품이 있다. 판정 전 불량품을 라인에 다시 넣지 않게 한다',
      keys: ['MRB', '불량 판정', '판정 대기', 'NCR', '수리대', '불량품'],
      acts: [...CHECK, '판정', '처리', '넣지', '금지'],
    });
  }
  return items.slice(0, TBM_MES_ITEMS_MAX);
}

/** 대조할 체크리스트 = 원청·안전팀 고정 항목 + 그날 MES 자동 항목 */
export function buildChecklist(line: LineCode, s: TbmMesState): TbmItem[] {
  return [...tbmFixedItems(line), ...mesItems(line, s)];
}
