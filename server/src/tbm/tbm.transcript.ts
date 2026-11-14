import { TBM_MAX_CHARS, TBM_MAX_LINES, type TbmLine } from '@lumitwin/shared';

// 올린 대화록(텍스트·자막 파일)이나 받아쓴 음성을 번호 붙은 줄로 바꾼다. 판정기·검증기·화면이 같은 줄 번호를 쓴다.

/** 대화록을 받을 수 없을 때 (한국어 문장) */
export class TranscriptError extends Error {}

/** 한 줄이 이보다 길면 문장 끝에서 나눈다 (줄 번호로 근거를 가리키려면 줄이 짧아야 한다, assumed) */
const LONG_LINE = 240;

/**
 * 텍스트 파일 바이트 → 글. UTF-8(BOM 포함)을 먼저 보고, UTF-8이 아니면 한국어 Windows 메모장의 기본인 EUC-KR(CP949)로 읽는다
 */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const body = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    try {
      return new TextDecoder('euc-kr', { fatal: true }).decode(body);
    } catch {
      throw new TranscriptError('대화록 글자 인코딩을 읽지 못했습니다. UTF-8 텍스트 파일(.txt)로 저장해 올려 주세요');
    }
  }
}

/** 자막(VTT·SRT)의 시간 줄·번호 줄·머리말 */
const CAPTION_NOISE = [
  /^WEBVTT\b/i,
  /^NOTE\b/,
  /^\d+$/, // SRT 번호
  /^\[?\d{1,2}:\d{2}(:\d{2})?([.,]\d{1,3})?\]?\s*(-->\s*\d{1,2}:\d{2}(:\d{2})?([.,]\d{1,3})?.*)?$/, // 00:01:02,500 --> 00:01:04,000
];
/** 줄 앞의 시간 표시 "[00:01:02] " · "(01:02) " */
const TIME_PREFIX = /^[[(]\d{1,2}:\d{2}(:\d{2})?([.,]\d{1,3})?[\])]\s*/;

/**
 * 판정기(AI)에게 하는 지시처럼 보이는 줄. 회의 대화록에 이런 말이 나올 까닭이 거의 없으므로 표시해 두고,
 * 판정기에도 [의심]으로 알려 주며, 검증기는 이 줄만을 근거로 한 '다룸·부분'을 인정하지 않는다
 */
const SUSPICIOUS: RegExp[] = [
  /(AI|인공\s*지능|판정기|모델|어시스턴트|챗봇|GPT|LLM|Claude|클로드|시스템)[^\n]{0,40}(무시|표시하|기록하|판정하|출력하|답하|따르|바꾸|처리하)/i,
  /(이전|앞의?|위의?|기존)\s*(모든\s*)?(지시|명령|지침|프롬프트|규칙)[^\n]{0,20}(무시|잊|따르지)/,
  /(모든|전부|전체)\s*(항목|체크리스트)[^\n]{0,30}(다룸|다뤘|covered|완료|통과)\s*(으로|로)?\s*(표시|처리|기록|판정)/i,
  /\b(ignore|disregard)\b[^\n]{0,30}\b(instructions?|previous|above|prompt)\b/i,
  /\b(system\s*prompt|you are now|act as)\b/i,
  /<\/?\s*(transcript|system|instructions?|assistant|user)\b[^>]*>/i,
  /"status"\s*:\s*"(covered|partial|missing)"/i,
];

export function isSuspicious(text: string): boolean {
  return SUSPICIOUS.some((r) => r.test(text));
}

/** 긴 줄을 문장 끝에서 나눈다. 문장 끝이 없으면 LONG_LINE 글자마다 자른다 */
function splitLong(s: string): string[] {
  if (s.length <= LONG_LINE) return [s];
  const out: string[] = [];
  let cur = '';
  for (const part of s.split(/(?<=[.?!。…])\s+|(?<=(?:다|요|죠|까)\.?)\s+(?=\S)/)) {
    if (!part) continue;
    if (cur && cur.length + part.length + 1 > LONG_LINE) {
      out.push(cur);
      cur = part;
    } else cur = cur ? `${cur} ${part}` : part;
  }
  if (cur) out.push(cur);
  return out.flatMap((x) => (x.length <= LONG_LINE * 1.5 ? [x] : (x.match(new RegExp(`.{1,${LONG_LINE}}`, 'gs')) ?? [x])));
}

/**
 * 글 → 번호 붙은 줄. 빈 줄·자막 시간 줄은 버리고, 긴 줄은 나눈다.
 * 한도를 넘으면 앞부분만 쓰지 않고 거절한다 (말없이 자르면 뒤에서 다룬 항목을 '안 다룸'으로 잘못 판정한다)
 */
export function toLines(text: string): TbmLine[] {
  const raw = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (raw.length > TBM_MAX_CHARS * 1.2) throw new TranscriptError(`대화록이 너무 깁니다 (${raw.length.toLocaleString()}자). ${TBM_MAX_CHARS.toLocaleString()}자 이하로 나눠 올려 주세요`);
  const texts: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.replace(TIME_PREFIX, '').replace(/\s+/g, ' ').trim();
    if (!t || CAPTION_NOISE.some((r) => r.test(t))) continue;
    texts.push(...splitLong(t));
  }
  const chars = texts.reduce((n, t) => n + t.length, 0);
  if (!texts.length) throw new TranscriptError('대화록에 글이 없습니다');
  if (texts.length > TBM_MAX_LINES) throw new TranscriptError(`대화록이 너무 깁니다 (${texts.length}줄). ${TBM_MAX_LINES}줄 이하로 나눠 올려 주세요`);
  if (chars > TBM_MAX_CHARS) throw new TranscriptError(`대화록이 너무 깁니다 (${chars.toLocaleString()}자). ${TBM_MAX_CHARS.toLocaleString()}자 이하로 나눠 올려 주세요`);
  return texts.map((t, i) => (isSuspicious(t) ? { n: i + 1, text: t, suspicious: true } : { n: i + 1, text: t }));
}

/** 낱말 비교용: 소문자, 공백·문장부호 제거 ("비상 정지" = "비상정지") */
export function squash(s: string): string {
  return s.toLowerCase().replace(/[\s.,!?·…'"“”‘’()[\]{}<>~\-_:;/\\|]+/g, '');
}
