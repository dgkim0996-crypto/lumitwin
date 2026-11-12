import { DEFECT_NAMES, FACTORY, LINES, STATIONS, type LineCode } from '@lumitwin/shared';
import { SUGGESTIONS } from '../assistant.prompt';
import { toolLabel, type AssistantTools, type ToolOutcome } from '../assistant.tools';
import type { AssistantProvider, TurnInput } from './provider';

/* eslint-disable @typescript-eslint/no-explicit-any -- 도구 결과(JSON)를 템플릿에 꽂기만 한다 */
type Any = any;

const GENERIC_WORDS = new Set(['규격', '이탈', '불량', '라인', '셀']);
const hangulOnly = (s: string) => s.replace(/[^가-힣a-z0-9]/gi, '').toLowerCase();
const grams = (s: string) => {
  const h = hangulOnly(s);
  const out = new Set<string>();
  for (let i = 0; i + 1 < h.length; i++) out.add(h.slice(i, i + 2));
  return out;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Entities {
  station?: string;
  line?: LineCode;
  defect?: string;
  material?: string;
  lot?: string;
  serial?: string;
}

/** 설비 이름에서 어느 설비인지 가리지 못하는 낱말 */
const STATION_STOP = new Set(['검사기', '시험기', '테스터', '라인', '셀', '조립', '설비', '오븐', '사출기', '카메라식']);
const stationWords = (name: string) =>
  name
    .split(/[\s()·,/]+/)
    .map((w) => w.replace(/[^가-힣a-z0-9]/gi, ''))
    .filter((w) => w.length >= 2 && !STATION_STOP.has(w) && !/^\d+$/.test(w));

/**
 * 질문 속 설비 이름 찾기. 특징 낱말(예: 리크, 진공증착기, 배광, 도장)이 들어 있으면 그 설비,
 * 없으면 이름의 두 글자 조각이 절반 넘게 겹치는 설비. 후보가 둘 이상 비슷하면 고르지 않는다.
 */
function matchStation(m: string, line?: LineCode): string | undefined {
  const pool = Object.values(STATIONS).filter((s) => !line || s.line === line);
  const words = pool
    .map((s) => ({ code: s.code, score: stationWords(s.name).filter((w) => m.includes(w)).reduce((a, w) => a + w.length, 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (words[0] && words[0].score > (words[1]?.score ?? 0)) return words[0].code;
  const mg = grams(m);
  const scored = pool
    .map((s) => {
      const g = grams(s.name.replace(/\(.*?\)/g, ''));
      let hit = 0;
      for (const x of g) if (mg.has(x)) hit++;
      return { code: s.code, score: g.size ? hit / g.size : 0, hit };
    })
    .sort((a, b) => b.score - a.score || b.hit - a.hit);
  if (scored[0] && scored[0].score >= 0.5 && scored[0].hit >= 2 && scored[0].score > (scored[1]?.score ?? 0)) return scored[0].code;
  return undefined;
}

/** 질문에서 설비·라인·불량·자재·LOT·시리얼을 뽑는다 */
export function extractEntities(m: string, ctx: TurnInput['context'], memo: TurnInput['conv']['memo']): Entities {
  const e: Entities = {};
  const lot = /\b([A-Z0-9_]+-\d{6}-\d{3})\b/i.exec(m);
  if (lot) e.lot = lot[1].toUpperCase();
  const serial = /\b([A-Z]{2}\d{11})\b/i.exec(m);
  if (serial) e.serial = serial[1].toUpperCase();

  if (/헤드램프|\bHL\b/i.test(m)) e.line = 'HL';
  else if (/전장|BMS|\bEM\b|LED\s*모듈/i.test(m)) e.line = 'EM';
  else if (/사이드\s*미러|미러|\bOSM\b/i.test(m)) e.line = 'OSM';

  const code = /\b([A-Z]{2,3}-[A-Z]{2,4}-[A-Z0-9]{1,3})\b/i.exec(m);
  if (code && STATIONS[code[1].toUpperCase()]) e.station = code[1].toUpperCase();
  else if (/이\s*설비|이\s*장비|선택한|여기/.test(m) && ctx.station) e.station = ctx.station;
  else if (/그\s*설비|거기|그\s*장비/.test(m) && memo.station) e.station = memo.station;
  else e.station = matchStation(m, e.line);

  let best = 0;
  for (const [c, name] of Object.entries(DEFECT_NAMES)) {
    const words = name.split(/[\s()·]+/).filter((w) => w.length >= 2 && !GENERIC_WORDS.has(w));
    const score = (new RegExp(`\\b${c}\\b`).test(m) ? 3 : 0) + words.filter((w) => m.includes(w)).length;
    if (score > best) [best, e.defect] = [score, c];
  }
  for (const mat of FACTORY.materials) {
    const head = mat.name.split(/[·\s(]/)[0];
    if (new RegExp(`\\b${mat.code}\\b`, 'i').test(m) || (head.length >= 2 && m.includes(head))) {
      e.material = mat.code;
      break;
    }
  }
  return e;
}

/**
 * 모의 모드: API 키 없이 돈다. 질문에서 뜻과 대상을 규칙으로 골라 Claude 모드와 같은 도구를 부르고,
 * 도구가 돌려준 실제 공장 데이터로 정해진 틀의 답을 만든다. 화면에는 도구 호출이 똑같이 보인다.
 */
export class MockProvider implements AssistantProvider {
  readonly mode = 'mock' as const;
  readonly model = null;

  constructor(private readonly tools: AssistantTools) {}

  async run(turn: TurnInput) {
    const { conv, message: m, context } = turn;
    const e = extractEntities(m, context, conv.memo);
    const call = async (name: string, input: Record<string, unknown> = {}): Promise<ToolOutcome> => {
      const id = `mock_${Math.random().toString(36).slice(2, 10)}`;
      const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      turn.emit({ type: 'tool', id, name, label: toolLabel(name, clean), input: clean });
      await sleep(120);
      const out = await this.tools.run(name, clean);
      turn.emit({ type: 'tool_result', id, ok: out.ok, summary: out.summary, refs: out.refs });
      return out;
    };

    const text = await this.answer(m, e, call);
    if (e.station) conv.memo.station = e.station;
    if (e.line) conv.memo.line = e.line;
    // 글자를 조금씩 흘려보내 Claude 모드와 같은 느낌을 낸다
    for (const piece of text.match(/[\s\S]{1,8}/g) ?? []) {
      if (turn.signal.aborted) break;
      turn.emit({ type: 'text', delta: piece });
      await sleep(8);
    }
    return undefined;
  }

  private async answer(m: string, e: Entities, call: (name: string, input?: Record<string, unknown>) => Promise<ToolOutcome>): Promise<string> {
    const wantsHow = /표준|절차|기준|방법|어떻게|조치|규격|점검|LOTO|안전|순서|대응/i.test(m);
    const wantsCause = /원인|왜|요인|이유/.test(m);
    const wantsDown = /고장|멈[춘췄추]|정지|다운|비가동/.test(m);

    if (e.lot) {
      const out = await call('lot_trace', { lot: e.lot });
      return out.ok ? lotTraceText(out.data) : out.summary;
    }
    if (e.serial) {
      const out = await call('trace_serial', { serial: e.serial });
      return out.ok ? traceText(out.data) : out.summary;
    }
    if (/LOT|로트/i.test(m) && e.material) {
      const out = await call('lot_quality', { material: e.material });
      return out.ok ? lotQualityText(out.data) : out.summary;
    }
    // "OEE가 왜 낮아?"는 불량 원인보다 시간 손실 질문이라 요인 비교 전에 본다
    if (/로스|손실|loss/i.test(m) || (/oee/i.test(m) && /왜|낮|원인|줄이|개선|어디/.test(m))) {
      const out = await call('six_losses', { line: e.line });
      return out.ok ? lossText(out.data) : out.summary;
    }
    if (wantsDown && wantsHow) {
      const ov = await call('factory_overview');
      const down = (ov.data as Any).stopped.filter((x: Any) => x.state === '고장');
      const target: string | undefined = e.station ?? down[0]?.code;
      // 공통 고장 대응 절차와, 그 설비 표준서의 관련 절을 따로 찾는다
      const common = await call('search_standards', { query: '고장 정지 비상정지 잠금 표지 LOTO 보고 재가동 초품 검사' });
      let specific: Any[] = [];
      if (target) {
        const reason = down.find((x: Any) => x.code === target)?.reason ?? '';
        const s = await call('search_standards', { query: `${STATIONS[target]?.name ?? ''} 고장 ${reason} 이상 조치 점검`, station: target });
        specific = (((s.data as Any).hits ?? []) as Any[]).filter((h) => !h.ref.startsWith('WS-COM') && /조치|점검|대응|이상/.test(h.section) && h.text.includes(target)).slice(0, 2);
      }
      const lead = down.length ? '' : '\n\n고장이 나면 이렇게 대응합니다.';
      const more = specific.length ? `\n\n${target} 관련 절: ${specific.map((h) => `[${h.ref}] ${h.section}`).join(', ')}` : '';
      return `${downText(ov.data)}${lead}\n\n${procedureText(common.data)}${more}`;
    }
    if (wantsCause) return this.causeAnswer(e, call);
    // "불량 많은 순서"의 '순서'를 절차로 읽지 않게, 순위 질문을 표준서 검색보다 먼저 본다
    if (/파레토|불량.{0,8}(많|순위|순서|랭킹|top)|(많|자주).{0,6}불량/i.test(m)) {
      const out = await call('defect_pareto', { line: e.line });
      return paretoText(out.data, e.line);
    }
    if (wantsHow) {
      const out = await call('search_standards', { query: m, station: e.station });
      return standardsText(out.data, m);
    }
    if (/불량|파레토|\bNG\b/i.test(m)) {
      const out = await call('defect_pareto', { line: e.line });
      return paretoText(out.data, e.line);
    }
    if (/spc|cpk|관리도|공정\s*능력|관리\s*항목/i.test(m)) {
      if (e.station) return stationText((await call('station_status', { station: e.station })).data, true);
      return spcText((await call('spc_overview', { line: e.line })).data, /cpk|공정\s*능력/i.test(m));
    }
    if (/알람|경보/.test(m)) {
      const out = await call('list_alarms', { station: e.station, unacked_only: /미확인|확인\s*안/.test(m) || undefined });
      return alarmsText(out.data);
    }
    if (wantsDown) return downText((await call('factory_overview')).data);
    if (/시간대|시간별|실적|목표|생산량|몇\s*개/.test(m)) {
      if (e.line) return hourlyText((await call('hourly_output', { line: e.line })).data);
      return overviewText((await call('factory_overview')).data);
    }
    if (e.station) return stationText((await call('station_status', { station: e.station })).data, false);
    if (/현황|상태|어때|oee|요약|전체|공장|브리핑|상황|fpy/i.test(m)) return overviewText((await call('factory_overview')).data);
    return helpText();
  }

  /**
   * 원인 질문: 대상 설비를 정하고(없으면 파레토 1위) 요인 비교를 한 뒤
   * - 1위 요인 설비에 투입된 자재 LOT가 불량품 쪽에 몰렸으면 → 그 자재의 LOT별 불량률 비교
   * - 요인만 뚜렷하면 → 그 설비의 현재 상태·관리도
   * - 둘 다 없으면 → 검사기 자체를 의심
   * 마지막으로 근거가 될 작업표준서 절을 찾는다.
   */
  private async causeAnswer(e: Entities, call: (name: string, input?: Record<string, unknown>) => Promise<ToolOutcome>): Promise<string> {
    let station = e.station;
    let defect = e.defect;
    let lead = '';
    if (!station || !defect) {
      const p = await call('defect_pareto', { line: e.line ?? (station ? STATIONS[station]?.line : undefined) });
      const rows = ((p.data as Any).top ?? []) as Any[];
      const pick = rows.find((r) => (!station || r.station === station) && (!defect || r.defect === defect)) ?? rows.find((r) => !station || r.station === station);
      if (!pick) return '이번 실행에는 아직 불량 기록이 없어 원인을 비교할 수 없습니다.';
      if (!station) lead = `${defect ? `${pick.defectName} 불량이 가장 많은 설비` : '불량이 가장 많은 곳'}부터 봤습니다(${pick.station} ${pick.stationName} · ${pick.defectName} ${pick.n}건).\n\n`;
      station = pick.station;
      defect = defect ?? pick.defect;
    }
    const f = await call('defect_factors', { station, defect });
    if (!f.ok) return f.summary;
    const d = f.data as Any;
    if (!d.ngCount || d.ngCount < 5) return `${lead}${factorsText(d)}`;

    const top = d.factors?.[0];
    const strong = top && Math.abs(top.effect) >= STRONG_EFFECT;
    const skews = ((d.lotSkew ?? []) as Any[]).filter((l) => l.z >= 3);
    const skewed = (top && skews.find((l) => l.usedAt === top.station)) ?? (!strong ? skews[0] : undefined);
    // 설비 공정값(tag)은 자재 LOT로 바뀌지 않는다. 그 값이 뚜렷이 갈리면 같은 시기의 LOT 편중은 "그때 쓰던 LOT"일 수 있어
    // 설비를 먼저 본다. 다만 불량품 거의 전부가 그 LOT를 썼으면 LOT가 앞선다. 부품 속성(attr)이 갈리면 LOT가 그 속성을 바꿨을 수 있다
    const equipmentFirst = !!(skewed && strong && top.kind === 'tag' && skewed.ngSharePct < LOT_DOMINANT_PCT);
    const lot = equipmentFirst ? undefined : skewed;
    const confounded = equipmentFirst ? skewed : undefined;
    // 검출 설비가 검사기면, 뚜렷한 요인이 없을 때 제품보다 검사기 자체를 의심한다
    const inspector = /검사|시험|AOI|SPI|ICT|FCT|EOL/i.test(STATIONS[station ?? '']?.name ?? '');
    let verdict: string;
    let detail = '';
    if (lot) {
      const q = await call('lot_quality', { material: lot.material });
      const at = STATIONS[lot.usedAt];
      verdict = `${lot.usedAt} ${at?.name ?? ''}에 투입된 ${lot.materialName} LOT ${josa(lot.lot, ['이', '가'])} 원인일 가능성이 큽니다. 불량품의 ${lot.ngSharePct}%가 이 LOT를 썼고 같은 시기 양품은 ${lot.okSharePct}%입니다${top && top.station === lot.usedAt ? `. 이 LOT가 들어간 부품에서 ${josa(top.name, ['이', '가'])} 함께 달라졌습니다` : ''}.`;
      if (q.ok) detail = lotQualityText(q.data, true);
    } else if (strong) {
      const s = await call('station_status', { station: top.station });
      verdict = `${top.station} ${top.stationName}의 ${josa(top.name, ['을', '를'])} 먼저 점검하세요. 불량품과 양품이 이 값에서 가장 크게 갈립니다.`;
      if (confounded)
        verdict += ` 같은 시기에 쓰던 ${confounded.materialName} LOT ${confounded.lot}도 불량품 쪽에 많지만(${confounded.ngSharePct}% vs ${confounded.okSharePct}%), ${josa(top.name, ['은', '는'])} 설비 공정값이라 자재 LOT로 바뀌지 않습니다. 그 시기에 쓰던 LOT라서 함께 오른 것일 수 있으니, 설비를 바로잡은 뒤에도 그 LOT의 불량률이 높으면 LOT를 의심하세요.`;
      if (s.ok) detail = factorStationText(s.data, top.key);
    } else {
      verdict = inspector
        ? '공정값·부품 속성·자재 LOT로는 불량품과 양품이 뚜렷이 갈리지 않습니다. 제품보다 검사기 자체(영점·마스터 시료·지그)를 먼저 의심하세요.'
        : '기록된 공정값·부품 속성·자재 LOT로는 불량품과 양품이 뚜렷이 갈리지 않습니다. 기록되지 않는 원인(작업 환경, 필터·청소 상태, 작업 방법)을 표준서의 이상 조치 표로 확인하세요.';
    }
    const std = await call('search_standards', {
      query: `${d.defectName ?? ''} ${top && (strong || lot) ? top.name : inspector ? '검사기 영점 마스터 시료' : '증가 원인'} ${lot ? 'LOT 격리' : ''} 이상 조치`,
      station: lot?.usedAt ?? (strong ? top.station : station),
    });
    // 근거 행은 판단 쪽 낱말로 고른다 (LOT 판단이면 LOT 격리 행, 설비 판단이면 그 공정값 행)
    const rowQuery = lot ? `${lot.materialName} 불량 LOT 격리 사용 중지` : strong ? `${top.name} ${d.defectName ?? ''}` : inspector ? '검사기 영점 마스터 시료 드리프트' : `${d.defectName ?? ''} 증가`;
    const stdLine = standardsBrief(std.data, rowQuery);
    return `${lead}${factorsText(d)}\n\n판단: ${verdict}${detail ? `\n\n${detail}` : ''}${stdLine ? `\n\n${stdLine}` : ''}\n\n효과 크기와 LOT 편중은 상관이라, 원인 확정은 설비 점검이나 LOT 격리 후 불량률 비교로 해야 합니다.`;
  }
}

/** 효과 크기 |d|가 이 이상이면 "뚜렷이 갈린다"고 본다 */
const STRONG_EFFECT = 0.8;
/** 불량품의 이 비율(%) 이상이 한 LOT를 썼으면, 설비 공정값이 함께 갈려도 LOT를 먼저 의심한다 */
const LOT_DOMINANT_PCT = 90;

/** 받침에 맞춰 조사를 붙인다. 괄호 설명은 빼고 마지막 글자로 본다 */
export function josa(word: string, [withBatchim, without]: [string, string]): string {
  const base = word.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const last = base[base.length - 1] ?? '';
  const code = last.charCodeAt(0);
  let batchim: boolean | null = null;
  if (code >= 0xac00 && code <= 0xd7a3) batchim = (code - 0xac00) % 28 !== 0;
  else if (/[0-9]/.test(last)) batchim = '013678'.includes(last);
  // 숫자 뒤 t는 "톤"(사출기 650t), 그 밖의 영문자는 이름으로 읽는다: 엘·엠·엔·알만 받침이 있다
  else if (/\dt$/i.test(base)) batchim = true;
  else if (/[a-z]/i.test(last)) batchim = 'lmnr'.includes(last.toLowerCase());
  if (batchim === null) return `${word}${withBatchim}(${without})`;
  return word + (batchim ? withBatchim : without);
}

// ───────────── 답 틀 ─────────────

const n0 = (v: number | null | undefined) => (v == null ? '−' : v.toLocaleString('ko-KR'));

/** 상태가 이어진 시간(가상 분): 1분 미만은 "가동 중", 1시간이 넘으면 "3시간 5분째" */
function lasting(state: string, minutes: number | null | undefined): string {
  if (minutes == null) return state;
  if (minutes < 1) return `${state} 중`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${state} ${h ? `${h}시간${m ? ` ${m}분` : ''}` : `${m}분`}째`;
}

function overviewText(d: Any): string {
  const lines = d.lines as Any[];
  const worst = [...lines].sort((a, b) => a.oeePct - b.oeePct)[0];
  const behind = lines.filter((l) => l.lastHour < l.targetPerHour * 0.9);
  const downN = d.stopped.filter((x: Any) => x.state === '고장').length;
  const behindNames = behind.map((l) => l.name).join(', ');
  const head = downN
    ? `지금 고장 설비가 ${downN}대 있습니다.`
    : behind.length
      ? `고장 설비는 없지만 ${josa(behindNames, ['이', '가'])} 최근 1시간 목표에 못 미칩니다.`
      : '모든 라인이 최근 1시간 목표 근처로 돌고 있습니다.';
  const table = ['| 라인 | 완성 | 최근 1시간 / 목표 | OEE | FPY |', '|---|---|---|---|---|', ...lines.map((l) => `| ${l.name} | ${n0(l.output)} | ${l.lastHour} / ${l.targetPerHour} | ${l.oeePct}% | ${l.fpyPct}% |`)].join('\n');
  const stopped = d.stopped.length ? `\n\n멈춘 설비\n${d.stopped.map((x: Any) => `- ${x.code} ${x.name}: ${lasting(x.state, x.minutes)}${x.reason ? ` (사유: ${x.reason})` : ''}`).join('\n')}` : '';
  const kinds = Object.entries(d.alarms.byKind ?? {}).sort((a, b) => (b[1] as number) - (a[1] as number)).map(([k, n]) => `${k} ${n}`).join(' · ');
  const alarms = d.alarms.unacked ? `\n\n확인 안 된 알람이 ${d.alarms.unacked}건(${kinds}) 있습니다. 최근: ${d.alarms.latest.slice(0, 3).map((a: Any) => a.title).join(' / ')}` : '';
  return `${head} (가상 시각 ${d.virtualTime ?? '−'}${d.speed ? `, ${d.speed}배속` : ''})\n\n${table}${stopped}${alarms}\n\nOEE가 가장 낮은 곳은 ${worst.name}(${worst.oeePct}%, 가동률 ${worst.availabilityPct}% · 성능 ${worst.performancePct}%)입니다. 자세한 흐름은 /production 에서 볼 수 있습니다.`;
}

function downText(d: Any): string {
  const down = d.stopped.filter((x: Any) => x.state === '고장');
  if (!down.length) return `지금 고장 난 설비는 없습니다.${d.stopped.length ? ` 셋업·계획 정지 중인 설비: ${d.stopped.map((x: Any) => `${x.code} ${x.name}(${x.state})`).join(', ')}` : ''}`;
  return `고장 설비 ${down.length}대가 있습니다.\n${down.map((x: Any) => `- ${x.code} ${x.name}: ${lasting('정지', x.minutes)}${x.reason ? `, 사유 ${x.reason}` : ''}`).join('\n')}\n\n설비 상세 패널(3D 화면에서 설비 클릭)에서 상태 이력과 원격 명령(수리 완료)을 볼 수 있습니다.`;
}

/** 표준서 절에서 질문과 겹치는 표 행만 골라 보여 준다 */
function excerpt(text: string, query: string): string {
  const qg = grams(query);
  const lines = text.split('\n');
  const table = lines.filter((l) => l.trim().startsWith('|'));
  if (table.length >= 4) {
    const [head, sep, ...rows] = table;
    const scored = rows.map((r) => ({ r, s: [...grams(r)].filter((g) => qg.has(g)).length })).sort((a, b) => b.s - a.s);
    const pick = scored.filter((x) => x.s > 0).slice(0, 3).map((x) => x.r);
    const prose = lines.filter((l) => !l.trim().startsWith('|') && l.trim()).slice(0, 2).join('\n');
    return [prose, head, sep, ...(pick.length ? pick : rows.slice(0, 3))].filter(Boolean).join('\n');
  }
  return lines.filter((l) => l.trim()).slice(0, 8).join('\n');
}

function standardsText(d: Any, query: string): string {
  const hits = (d.hits ?? []) as Any[];
  if (!hits.length) return '작업표준서에서 맞는 내용을 찾지 못했습니다. 설비 이름이나 불량 이름을 넣어 다시 물어봐 주세요.';
  const [top, ...rest] = hits;
  return `작업표준서 [${top.ref}] ${top.title} — ${top.section}\n\n${excerpt(top.text, query)}${rest.length ? `\n\n함께 볼 절: ${rest.map((h) => `[${h.ref}] ${h.section}`).join(', ')}` : ''}`;
}

function paretoText(d: Any, line?: string): string {
  const top = (d.top ?? []) as Any[];
  if (!top.length) return '이번 실행에는 아직 불량 기록이 없습니다.';
  const scope = line ? `${LINES.find((l) => l.code === line)?.name} ` : '';
  return `${scope}불량은 모두 ${n0(d.totalNg)}건이고, 많은 순서는 다음과 같습니다.\n\n| 설비 | 불량 | 건수 | 비중 |\n|---|---|---|---|\n${top.slice(0, 6).map((r) => `| ${r.station} ${r.stationName} | ${r.defectName} | ${r.n} | ${r.sharePct}% |`).join('\n')}\n\n원인을 보려면 "${top[0].station} ${top[0].defectName} 원인이 뭐야?"처럼 물어보세요.`;
}

function lossText(d: Any): string {
  const ranked = (Object.entries(d.lossPct ?? {}) as [string, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!d.plannedMin || !ranked.length) return '아직 집계된 시간이 없어 로스를 나눌 수 없습니다. 시뮬레이터가 조금 돈 뒤 다시 물어봐 주세요.';
  const top = ((d.topStationLosses ?? []) as Any[]).slice(0, 5);
  const table = `| 로스 | 계획 시간 대비 |\n|---|---|\n${ranked.map(([k, v]) => `| ${k} | ${v}% |`).join('\n')}`;
  const list = top.map((x, i) => `${i + 1}. ${x.station} ${x.stationName} · ${x.loss} ${x.minutes}분 (그 설비 계획 시간의 ${x.ofStationPct}%)`).join('\n');
  const waiting = ((d.topWaiting ?? []) as Any[]).map((x) => `${x.station} ${x.minutes}분`).join(', ');
  const hint =
    ranked[0][0] === '순간 정지·공회전'
      ? `\n\n순간 정지·공회전(${waiting})은 대개 앞 설비가 멈추거나 느려 부품이 안 와서 생깁니다. 그 설비에서 줄일 수 있는 로스는 아래 순위를 보세요.`
      : '';
  return `${d.scope} OEE는 ${d.oeePct}%입니다. 계획 시간 ${n0(d.plannedMin)}분(설비 시간 합) 중 가장 큰 로스는 ${ranked[0][0]} ${ranked[0][1]}%입니다.${hint}\n\n${table}\n\n줄일 곳 (그 설비에서 직접 줄일 수 있는 로스, 잃은 시간 큰 순)\n${list || '아직 없음'}\n\n자세한 구성은 6대 로스 화면(/losses)에서 볼 수 있습니다.`;
}

function factorsText(d: Any): string {
  const f = (d.factors ?? []) as Any[];
  const what = `${d.station} ${d.stationName}의 ${d.defectName ?? '불량'}`;
  if (!d.ngCount) return `${what} 기록이 아직 없습니다.`;
  if (d.ngCount < 5) return `${josa(what, ['은', '는'])} 이번 실행에 ${d.ngCount}건뿐이라 양품과 비교하기에 적습니다(5건 이상 필요). 불량이 더 쌓인 뒤 다시 물어봐 주세요.`;
  if (!f.length) return `${what} ${d.ngCount}건을 양품 ${d.okCount}건과 비교했지만 뚜렷하게 갈리는 값이 없습니다.`;
  const top = f[0];
  const unit = top.unit ? ` ${top.unit}` : '';
  const upstream = top.station !== d.station ? ` 검출은 ${d.stationName}에서 됐지만, 갈리는 값은 ${top.relation === 'component' ? '조립돼 들어간 부품' : '앞 공정'}인 ${top.station} ${top.stationName}에 있습니다.` : '';
  const list = f.slice(0, 4).map((x, i) => `${i + 1}. ${x.station} ${x.stationName} · ${x.name}: 불량 중앙값 ${x.ngMedian} vs 양품 ${x.okMedian}${x.unit ? ` ${x.unit}` : ''} (d=${x.effect.toFixed(2)})`).join('\n');
  const lots = ((d.lotSkew ?? []) as Any[]).slice(0, 2);
  const lotLine = lots.length
    ? `\n\n불량품 쪽에 몰린 자재 LOT\n${lots.map((l) => `- ${l.materialName} ${l.lot}(${l.usedAt} 투입): 불량품 ${l.ngSharePct}% vs 양품 ${l.okSharePct}% (z=${l.z})`).join('\n')}`
    : '';
  return `${what} ${d.ngCount}건을 같은 시기 양품 ${d.okCount}건과 비교했습니다. 가장 크게 갈리는 값은 ${top.stationName}의 ${top.name}입니다(불량 ${top.ngMedian}${unit} vs 양품 ${top.okMedian}${unit}, 효과 크기 d=${top.effect.toFixed(2)}).${upstream}\n\n${list}${lotLine}`;
}

/** 요인 설비의 지금 상태와, 요인 값의 현재값·관리도 */
function factorStationText(s: Any, key: string): string {
  const tag = (s.tags as Any[]).find((t) => t.key === key);
  const chart = (s.spc as Any[]).find((c) => c.key === key);
  const parts = [`${s.code} ${josa(s.name, ['은', '는'])} 지금 ${lasting(s.state, s.stateMinutes)}입니다.`];
  if (tag?.value != null) parts.push(`${tag.name} 현재값 ${tag.value}${tag.unit}(기준 ${tag.nominal}, 범위 ${tag.lsl ?? '−'}~${tag.usl ?? '−'})${tag.outOfSpec ? ', 관리 범위를 벗어났습니다' : ''}.`);
  if (chart) parts.push(`관리도 Cpk ${chart.cpk ?? '−'}${chart.flaggedRecent ? `, 최근 10점 중 ${chart.flaggedRecent}점 규칙 위반` : ''} (/spc?station=${s.code}).`);
  return parts.join(' ');
}

/** 산문 절은 첫 문장만 */
const firstSentence = (text: string) => (/^[\s\S]*?다\./.exec(text.trim())?.[0] ?? text.split('\n')[0]).trim();

/** 절차형 절 여러 개를 절 번호 순으로, 각 절의 첫 단계 두 개만 */
function procedureText(d: Any): string {
  const all = ((d?.hits ?? []) as Any[]).slice().sort((a, b) => a.ref.localeCompare(b.ref, 'ko', { numeric: true }));
  const body = all.filter((h) => !/목적|적용\s*범위/.test(h.section));
  const hits = body.length >= 2 ? body : all;
  if (!hits.length) return '작업표준서에서 고장 대응 절차를 찾지 못했습니다.';
  const steps = (text: string) =>
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^(\d+\.|-)\s/.test(l))
      .slice(0, 3)
      .map((l) => l.replace(/^(\d+\.|-)\s*/, ''))
      .join(' → ');
  return `작업표준서 고장 대응 절차\n${hits.map((h) => `- [${h.ref}] ${h.section}: ${steps(h.text) || firstSentence(h.text)}`).join('\n')}`;
}

/** 원인 답에 붙이는 표준서 한 줄: 가장 맞는 절과, 질문과 가장 겹치는 조치 행 하나 */
function standardsBrief(d: Any, query: string): string {
  const top = (d?.hits ?? [])[0] as Any;
  if (!top) return '';
  const row = excerptRows(top.text, query, 1)[0];
  if (!row) return `근거: [${top.ref}] ${top.section}`;
  const cells = row.split('|').map((c: string) => c.trim()).filter(Boolean);
  return `근거: [${top.ref}] ${top.section} — ${cells.length >= 4 ? `확인: ${cells[2]} / 조치: ${cells[3]}` : cells.join(' / ')}`;
}

/** 표 행 중 질문과 두 글자 조각이 가장 많이 겹치는 것 */
function excerptRows(text: string, query: string, n: number): string[] {
  const qg = grams(query);
  const rows = text.split('\n').filter((l) => l.trim().startsWith('|')).slice(2);
  return rows
    .map((r) => ({ r, s: [...grams(r)].filter((g) => qg.has(g)).length }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.r);
}

function lotQualityText(d: Any, brief = false): string {
  const sus = (d.top as Any[]).filter((x) => x.suspect);
  // 불량이 하나도 없는 LOT는 비교에 보탬이 안 돼 뺀다 (모두 0이면 위에서부터)
  const withNg = (d.top as Any[]).filter((x) => x.ng > 0);
  const rows = (withNg.length >= 2 ? withNg : (d.top as Any[])).slice(0, brief ? 4 : 6);
  const table = `| LOT | 부품 | 불량 | 불량률 | 다른 LOT | z |\n|---|---|---|---|---|---|\n${rows.map((x) => `| ${x.lot} | ${x.parts} | ${x.ng} | ${x.ngRatePct}% | ${x.othersRatePct}% | ${x.z} |`).join('\n')}`;
  const head = sus.length
    ? `${d.materialName} LOT ${d.lots}개 중 ${sus.map((x) => x.lot).join(', ')}에 불량이 몰려 있습니다.`
    : `${d.materialName} LOT ${d.lots}개 중 불량이 뚜렷하게 몰린 LOT는 없습니다.`;
  return `${head}\n\n${table}${sus.length ? `\n\n영향 범위와 회수·격리 대상은 /trace?lot=${sus[0].lot} 에서 볼 수 있습니다.` : ''}`;
}

function lotTraceText(d: Any): string {
  const s = d.byStatus ?? {};
  const ng = (d.ngExamples ?? []) as Any[];
  return `${d.lot}(${d.materialName ?? d.material ?? '자재'})는 부품 ${n0(d.partsUsed)}개에 쓰였고(${d.firstUsed} ~ ${d.lastUsed}), 그 부품이 들어간 맨 위 제품은 ${n0(d.topProducts)}개입니다.\n\n- 완성(회수 검토): ${s.DONE ?? 0}개\n- 공정 중(격리): ${s.WIP ?? 0}개\n- 불량 판정: ${s.NG ?? 0}개${ng.length ? `\n\n불량 예: ${ng.slice(0, 4).map((x) => `${x.serial}(${x.defectName ?? x.defect})`).join(', ')}` : ''}\n\n대상 목록과 CSV는 /trace?lot=${d.lot} 에서 받을 수 있습니다.`;
}

function traceText(d: Any): string {
  const t = d.tree;
  const ngStep = (t.steps as Any[]).find((s) => s.result === 'NG');
  const comps = (t.components as Any[]).map((c) => (typeof c === 'string' ? c : `${c.serial}(${c.item ?? ''}${c.status ? ` · ${c.status}` : ''})`));
  return `${t.serial}(${t.item ?? '품목 모름'})의 상태는 ${t.status ?? '모름'}입니다. 공정 ${t.steps.length}개를 거쳤고${ngStep ? `, ${ngStep.station}에서 ${DEFECT_NAMES[ngStep.defect] ?? ngStep.defect ?? '불량'} 판정을 받았습니다(${ngStep.at})` : ' 불량 판정은 없습니다'}.${comps.length ? `\n\n들어간 부품: ${comps.join(', ')}` : ''}${d.usedIn?.length ? `\n\n이 부품이 들어간 상위 제품: ${d.usedIn.join(' → ')}` : ''}`;
}

function stationText(d: Any, spcFocus: boolean): string {
  const outs = (d.tags as Any[]).filter((t) => t.outOfSpec);
  const spc = (d.spc as Any[]).filter((c) => c.cpk != null).sort((a, b) => a.cpk - b.cpk);
  const flagged = (d.spc as Any[]).filter((c) => c.flaggedRecent > 0);
  const spcLines = spc.slice(0, spcFocus ? 5 : 2).map((c) => `- ${c.name}: Cpk ${c.cpk}${c.flaggedRecent ? `, 최근 10점 중 ${c.flaggedRecent}점 규칙 위반(${c.rulesRecent.join(',')})` : ''}`).join('\n');
  const defects = (d.defects as Any[]).slice(0, 3).map((x) => `${x.name} ${x.n}`).join(', ');
  const head = `${d.code} ${josa(d.name, ['은', '는'])} 지금 ${lasting(d.state, d.stateMinutes)}${d.reason ? `(사유: ${d.reason})` : ''}입니다.`;
  const body = spcFocus
    ? `관리 항목 Cpk(낮은 순)\n${spcLines || '- 아직 점이 모자랍니다'}${flagged.length ? '' : '\n\n최근 규칙 위반은 없습니다.'}`
    : `OEE ${d.oee.oeePct}%(가동률 ${d.oee.availabilityPct}% · 성능 ${d.oee.performancePct}% · 양품률 ${d.oee.qualityPct}%), 처리 ${n0(d.processed)}개 중 불량 ${d.ng}개(${d.ngRatePct}%)${defects ? `: ${defects}` : ''}.${outs.length ? `\n\n관리 범위를 벗어난 공정값: ${outs.map((t) => `${t.name} ${t.value}${t.unit} (범위 ${t.lsl ?? '−'}~${t.usl ?? '−'})`).join(', ')}` : '\n\n공정값은 모두 관리 범위 안입니다.'}${spcLines ? `\n\nSPC\n${spcLines}` : ''}`;
  const c = d.lastCheck;
  const check = spcFocus || !c ? '' : `\n\n작업 전 점검(${c.t}${c.by ? `, ${c.by}` : ''}): ${c.ngItems.length ? `이상 ${c.ngItems.length}건 — ${c.ngItems.join(' / ')}` : `${c.items}개 항목 이상 없음`}`;
  return `${head}\n\n${body}${check}\n\n관리도는 /spc?station=${d.code} 에서 볼 수 있습니다.`;
}

function spcText(d: Any, cpkFirst: boolean): string {
  const low = (d.lowestCpk ?? []) as Any[];
  const flagged = (d.mostFlagged ?? []) as Any[];
  if (!low.length && !flagged.length) return `관리 항목 ${d.charts}개 모두 Cpk 1.33 이상이고 최근 규칙 위반도 없습니다.`;
  const table = (rows: Any[]) =>
    `| 설비 | 항목 | Cpk | 최근 10점 위반 |\n|---|---|---|---|\n${rows.map((c) => `| ${c.station} ${c.stationName ?? ''} | ${c.name}${c.ctq ? ' (CTQ)' : ''} | ${c.cpk ?? '−'} | ${c.flaggedRecent10} |`).join('\n')}`;
  const lowPart = low.length ? `공정능력이 모자란 항목(Cpk 낮은 순)\n\n${table(low.slice(0, 6))}` : 'Cpk 1.33 미만인 항목은 없습니다.';
  const flagPart = flagged.length ? `최근 규칙 위반이 많은 항목\n\n${table(flagged.slice(0, cpkFirst ? 3 : 6))}` : '최근 규칙 위반은 없습니다.';
  const body = cpkFirst ? `${lowPart}\n\n${flagPart}` : `${flagPart}\n\n${lowPart}`;
  return `관리 항목 ${d.charts}개 중 Cpk 1.33 미만 ${d.lowCpkCount}개, 최근 규칙 위반 ${d.flaggedCount}개입니다.\n\n${body}\n\n관리도는 /spc 에서 볼 수 있습니다. 조치 절차가 궁금하면 "SPC 이상 조치 방법"을 물어보세요.`;
}

function alarmsText(d: Any): string {
  const a = (d.alarms ?? []) as Any[];
  if (!a.length) return '조건에 맞는 알람이 없습니다.';
  return `알람 ${d.total}건 중 최근 ${a.length}건입니다.\n${a.map((x) => `- ${x.t} ${x.title}${x.acked ? '' : ' (미확인)'}`).join('\n')}`;
}

function hourlyText(d: Any): string {
  const h = (d.hours ?? []) as Any[];
  if (!h.length) return '시간대별 기록이 아직 없습니다.';
  const rows = h.slice(-6).map((x) => `| ${x.hour} | ${x.output} | ${x.ng} |`).join('\n');
  return `${d.name}의 시간당 목표는 ${d.targetPerHour}개입니다. 최근 시간대(가상 시각, 마지막 줄은 진행 중):\n\n| 시각 | 완성 | 불량 |\n|---|---|---|\n${rows}`;
}

function helpText(): string {
  return `모의 모드(API 키 없이 규칙으로 답하는 모드)라서 정해진 유형의 질문을 알아듣습니다. 이렇게 물어보세요.\n\n${SUGGESTIONS.map((s) => `- ${s}`).join('\n')}\n- 설비 이름(예: 진공증착기), LOT 번호, 시리얼을 넣어 물어보기\n\nANTHROPIC_API_KEY를 설정하면 Claude가 자유로운 질문에 답합니다.`;
}

