import type { TbmItem, TbmLine } from '@lumitwin/shared';
import { squash } from './tbm.transcript';
import type { JudgeItem } from './tbm.validator';

/**
 * 모의 모드 판정 (API 키도 로컬 LLM도 없을 때). 낱말 규칙이라 말을 바꿔 하면 놓친다(한계는 화면·문서에 적는다).
 * - 핵심 낱말이 나온 줄에 조치 낱말이 함께(같은 줄 또는 바로 다음 말) 나오면 '다룸'
 * - 핵심 낱말만 나오면 '부분', 아예 안 나오면 '안 다룸'
 * - 판정기에게 지시하는 줄(의심 줄)은 보지 않는다
 */
export function ruleJudge(items: TbmItem[], lines: TbmLine[]): JudgeItem[] {
  const usable = lines.filter((l) => !l.suspicious).map((l) => ({ ...l, sq: squash(l.text) }));
  return items.map((item): JudgeItem => {
    const keys = item.keys.map((k) => ({ raw: k, sq: squash(k) })).filter((k) => k.sq);
    const acts = item.acts.map((a) => ({ raw: a, sq: squash(a) })).filter((a) => a.sq);
    const keyLines: number[] = [];
    let firstKey: string | null = null;
    for (const [i, l] of usable.entries()) {
      const key = keys.find((k) => l.sq.includes(k.sq));
      if (!key) continue;
      keyLines.push(l.n);
      firstKey ??= key.raw;
      // 핵심 낱말 자체가 조치 낱말로 세지지 않게 그 부분을 빼고 본다 ("전원 차단" 안의 "차단")
      const rest = l.sq.split(key.sq).join(' ');
      const same = acts.find((a) => rest.includes(a.sq));
      const next = usable[i + 1];
      const after = !same && next ? acts.find((a) => next.sq.includes(a.sq)) : undefined;
      const act = same ?? after;
      if (act) {
        return {
          code: item.code,
          status: 'covered',
          evidence: same ? [l.n] : [l.n, next.n],
          quote: l.text.slice(0, 120),
          note: `낱말 '${key.raw}'와 조치 말 '${act.raw}'${same ? '' : '(다음 말)'}이 나옴`,
        };
      }
    }
    if (keyLines.length) {
      const first = usable.find((l) => l.n === keyLines[0]);
      return { code: item.code, status: 'partial', evidence: keyLines.slice(0, 3), quote: first?.text.slice(0, 120) ?? '', note: `낱말 '${firstKey}'은 나오지만 조치·확인 말이 없음` };
    }
    return { code: item.code, status: 'missing', evidence: [], quote: '', note: '관련 낱말이 나오지 않음' };
  });
}
