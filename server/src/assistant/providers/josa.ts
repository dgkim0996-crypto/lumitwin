/** 받침에 맞춰 조사를 붙인다. 괄호 설명은 빼고 마지막 글자로 본다 (모의 모드 답 틀이 같이 쓴다) */
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
