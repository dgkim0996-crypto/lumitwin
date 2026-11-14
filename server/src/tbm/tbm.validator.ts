import { TBM_STATUS_RANK, type TbmItem, type TbmItemResult, type TbmLine, type TbmStatus } from '@lumitwin/shared';
import { squash } from './tbm.transcript';

// 판정기(모의 규칙·로컬 LLM·Claude)가 낸 결과를 서버가 다시 확인한다. 판정기는 믿지 않는다:
// - 없는 항목 코드는 버리고, 판정기가 빠뜨린 항목은 '불확실'로 채운다
// - '다룸·부분'인데 근거 줄이 없거나, 범위 밖이거나, 지시문 의심 줄뿐이거나, 근거 줄에서 그 항목 내용을 찾을 수 없으면 '불확실'로 내린다
// - 인용은 근거 줄에 실제로 있는 말일 때만 남긴다

/** 판정기 한 항목 (JSON 스키마와 같은 모양) */
export interface JudgeItem {
  code: string;
  status: 'covered' | 'partial' | 'missing';
  evidence: number[];
  quote: string;
  note: string;
}

const STATUS_MAP: Record<JudgeItem['status'], TbmStatus> = { covered: 'COVERED', partial: 'PARTIAL', missing: 'MISSING' };
const MAX_EVIDENCE = 5;
const MAX_NOTE = 200;
const MAX_QUOTE = 160;

/** 판정기 출력(모양을 믿을 수 없는 값)을 항목 배열로. 모양이 틀린 항목은 버리고 기록한다 */
export function parseJudge(value: unknown): { items: JudgeItem[]; dropped: string[] } {
  const dropped: string[] = [];
  const raw = value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items) ? ((value as { items: unknown[] }).items) : null;
  if (!raw) return { items: [], dropped: ['판정기 출력에 items 배열이 없음'] };
  const items: JudgeItem[] = [];
  for (const [i, r] of raw.entries()) {
    if (!r || typeof r !== 'object') {
      dropped.push(`${i + 1}번째 판정이 객체가 아님`);
      continue;
    }
    const o = r as Record<string, unknown>;
    const code = typeof o.code === 'string' ? o.code.trim() : '';
    const status = typeof o.status === 'string' ? o.status.trim().toLowerCase() : '';
    if (!code || !(status in STATUS_MAP)) {
      dropped.push(`${i + 1}번째 판정의 code·status가 잘못됨 (${String(o.code ?? '').slice(0, 30)} · ${String(o.status ?? '').slice(0, 20)})`);
      continue;
    }
    const evidence = Array.isArray(o.evidence) ? o.evidence.map((n) => Number(n)).filter((n) => Number.isInteger(n)) : [];
    items.push({ code, status: status as JudgeItem['status'], evidence, quote: typeof o.quote === 'string' ? o.quote : '', note: typeof o.note === 'string' ? o.note : '' });
  }
  return { items, dropped };
}

const cleanText = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function base(item: TbmItem): Omit<TbmItemResult, 'status' | 'judged' | 'evidence' | 'quote' | 'note'> {
  const { keys: _k, acts: _a, ...rest } = item;
  return { ...rest, ref: item.ref ?? null, followUp: null };
}

/** 인용이 근거 줄에 그대로 있는가 (공백·문장부호는 무시, … 로 끊은 인용은 조각마다) */
function quoteFound(quote: string, evText: string): boolean {
  const parts = quote.split(/…|\.\.\./).map(squash).filter((p) => p.length >= 4);
  return parts.length > 0 && parts.every((p) => evText.includes(p));
}

/**
 * 판정 결과 검증. lines는 전사 전체(줄 번호가 전체 기준), judged는 이 판정(조각 하나)의 출력
 * @returns 체크리스트 순서의 결과와 검증 기록
 */
export function validate(items: TbmItem[], lines: TbmLine[], judged: JudgeItem[], dropped: string[] = []): { results: TbmItemResult[]; changes: string[] } {
  const changes = [...dropped];
  const byN = new Map(lines.map((l) => [l.n, l]));
  const known = new Map(items.map((i) => [i.code, i]));
  const got = new Map<string, JudgeItem>();
  for (const j of judged) {
    if (!known.has(j.code)) {
      changes.push(`없는 항목 코드 ${j.code.slice(0, 40)}의 판정을 버림`);
      continue;
    }
    const prev = got.get(j.code);
    if (prev) {
      changes.push(`${j.code}을(를) 두 번 판정해 더 낮은 쪽을 버림`);
      if (TBM_STATUS_RANK[STATUS_MAP[j.status]] <= TBM_STATUS_RANK[STATUS_MAP[prev.status]]) continue;
    }
    got.set(j.code, j);
  }

  const results = items.map((item): TbmItemResult => {
    const j = got.get(item.code);
    if (!j) return { ...base(item), status: 'UNCERTAIN', judged: null, evidence: [], quote: null, note: '판정기가 이 항목을 판정하지 않았습니다. 대화록을 직접 확인해 주세요' };
    const judgedStatus = STATUS_MAP[j.status];
    const note = cleanText(j.note, MAX_NOTE) || null;
    if (judgedStatus === 'MISSING') return { ...base(item), status: 'MISSING', judged: 'MISSING', evidence: [], quote: null, note };

    // 다룸·부분: 근거 확인
    const inRange = [...new Set(j.evidence)].filter((n) => byN.has(n)).sort((a, b) => a - b);
    if (inRange.length < new Set(j.evidence).size) changes.push(`${item.code}: 전사에 없는 줄 번호를 근거에서 뺌 (${j.evidence.filter((n) => !byN.has(n)).slice(0, 5).join(', ')})`);
    const clean = inRange.filter((n) => !byN.get(n)?.suspicious);
    const down = (why: string): TbmItemResult => {
      changes.push(`${item.code}: '${j.status === 'covered' ? '다룸' : '부분'}' → '불확실' (${why})`);
      return { ...base(item), status: 'UNCERTAIN', judged: judgedStatus, evidence: inRange.slice(0, MAX_EVIDENCE), quote: null, note: `검증: ${why}` };
    };
    if (!inRange.length) return down('근거 줄이 없음');
    if (!clean.length) return down('근거가 판정기에게 지시하는 줄(의심 줄)뿐임');

    const evLines = clean.slice(0, MAX_EVIDENCE).map((n) => byN.get(n) as TbmLine);
    const evText = squash(evLines.map((l) => l.text).join(' '));
    const qOk = j.quote.trim() ? quoteFound(j.quote, evText) : false;
    const kOk = item.keys.some((k) => {
      const s = squash(k);
      return s.length > 0 && evText.includes(s);
    });
    if (!qOk && !kOk) return down('근거 줄에서 이 항목 내용을 찾지 못함');
    if (j.quote.trim() && !qOk) changes.push(`${item.code}: 근거 줄에 없는 인용을 지우고 근거 줄 글로 바꿈`);
    return {
      ...base(item),
      status: judgedStatus,
      judged: judgedStatus,
      evidence: evLines.map((l) => l.n),
      quote: qOk ? cleanText(j.quote, MAX_QUOTE) : cleanText(evLines[0].text, MAX_QUOTE),
      note,
    };
  });
  return { results, changes };
}

/**
 * 긴 전사를 조각으로 나눠 판정했을 때 합친다: 항목마다 가장 좋은 판정(다룸 > 부분 > 불확실 > 안 다룸)을 쓰고,
 * '다룸'이면 여러 조각의 근거를 모은다. 판정기가 조각마다 따로 보므로, 앞 조각에서 다룬 항목을 뒤 조각이 '안 다룸'이라 해도 된다
 */
export function mergeResults(parts: TbmItemResult[][]): TbmItemResult[] {
  if (parts.length === 1) return parts[0];
  return parts[0].map((first, i) => {
    const all = parts.map((p) => p[i]);
    const best = all.reduce((a, b) => (TBM_STATUS_RANK[b.status] > TBM_STATUS_RANK[a.status] ? b : a), first);
    if (best.status !== 'COVERED') return best;
    const evidence = [...new Set(all.filter((r) => r.status === 'COVERED').flatMap((r) => r.evidence))].sort((a, b) => a - b).slice(0, MAX_EVIDENCE);
    return { ...best, evidence };
  });
}

/** 줄을 글자 수 기준 조각으로 나눈다. 조각 경계에 걸친 대화를 놓치지 않게 앞 조각 끝 몇 줄을 겹친다 */
export function chunkLines(lines: TbmLine[], maxChars: number, overlap: number): TbmLine[][] {
  const total = lines.reduce((n, l) => n + l.text.length + 8, 0);
  if (total <= maxChars) return [lines];
  const out: TbmLine[][] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && (end === start || size + lines[end].text.length + 8 <= maxChars)) size += lines[end++].text.length + 8;
    out.push(lines.slice(start, end));
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return out;
}
