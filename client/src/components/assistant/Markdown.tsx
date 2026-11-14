'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Fragment, type ReactNode } from 'react';
import { STATIONS } from '@lumitwin/shared';
import { useAssistant } from '@/lib/assistant';
import { useLive } from '@/lib/live';
import { useUi, type FocusTarget } from '@/lib/ui';

/**
 * AI 비서 답과 작업표준서를 그리는 작은 마크다운 렌더러 (문단·목록·표·굵게·코드·제목).
 * 글 속의 설비 코드·LOT·시리얼·표준서 인용·화면 경로는 눌러서 바로 가는 링크로 바꾼다.
 */

// WO-HL-261114-001 · HOLD-261114-001 · NCR-261114-0003 · [WS-HL-03 §7] · WS-COM-01 · /trace?lot=… · GEARSET-261112-534 · OM26111200186 · OSM-FT-01
// 실행 MES 문서 번호를 맨 앞에 둔다 (HOLD-…·WO-HL-…의 일부가 LOT 번호로 잡히지 않게)
const TOKEN =
  /\b(WO-(?:HL|EM|OSM)-\d{6}-\d{3}|HOLD-\d{6}-\d{3}|NCR-\d{6}-\d{4})\b|(\[)?(WS-(?:HL|EM|OSM|COM)-\d{2})(?:\s*§\s*(\d+))?(\])?|(\/(?:production|spc|quality|trace|orders|ncr|changes|control-plan|reports|energy|maintenance|losses)(?:\?[A-Za-z0-9=&%_-]+)?)|\b([A-Z][A-Z0-9_]+-\d{6}-\d{3})\b|\b([A-Z]{2}\d{11})\b|\b((?:HL|EM|OSM)-[A-Z0-9]+(?:-[A-Z0-9]+)?)\b/g;

const PAGE_NAMES: Record<string, string> = {
  '/production': '생산 현황',
  '/spc': 'SPC',
  '/quality': '불량 분석',
  '/trace': '추적·Hold',
  '/operator': '작업자 태블릿',
  '/orders': '작업지시',
  '/ncr': '불량 처리',
  '/changes': '변경점',
  '/control-plan': '관리계획서',
  '/reports': '교대 일보',
  '/energy': '에너지',
  '/maintenance': '설비 보전',
  '/losses': '로스 분석',
};

/** 실행 MES 문서 번호 → 그 문서를 다루는 화면 */
const DOC_PAGE: [RegExp, string, string][] = [
  [/^WO-/, '/orders', '작업지시 화면에서 보기'],
  [/^HOLD-/, '/trace', '추적·Hold 화면에서 보기'],
  [/^NCR-/, '/ncr', '불량 처리 화면에서 보기'],
];

function useNavigate() {
  const router = useRouter();
  const path = usePathname();
  const select = useLive((s) => s.select);
  const openTrace = useLive((s) => s.openTrace);
  const setFocus = useUi((s) => s.setFocus);
  const openStandard = useAssistant((s) => s.openStandard);
  // 작업표준서 창 안의 링크로 다른 화면에 갈 때는 창을 닫아야 가려지지 않는다
  const closeStandard = () => openStandard(null);
  return {
    station(code: string) {
      closeStandard();
      select(code);
      if (path !== '/') router.push('/');
    },
    page(href: string) {
      closeStandard();
      const [p, q] = href.split('?');
      const f: FocusTarget = {};
      for (const [k, v] of new URLSearchParams(q ?? '')) if (['station', 'defect', 'material', 'lot', 'serial'].includes(k)) f[k as keyof FocusTarget] = v;
      if (Object.keys(f).length) setFocus(f);
      if (path !== p || q) router.push(href);
    },
    lot(lot: string) {
      closeStandard();
      setFocus({ lot });
      router.push(`/trace?lot=${encodeURIComponent(lot)}`);
    },
    serial(s: string) {
      closeStandard();
      openTrace(s);
    },
    standard: (id: string, n?: number) => openStandard({ id, n }),
  };
}

const linkCls = 'rounded px-0.5 text-info underline decoration-info/40 underline-offset-2 hover:bg-info/10 hover:decoration-info';

function Linkified({ text, nav }: { text: string; nav: ReturnType<typeof useNavigate> }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const [all, mesDoc, open, doc, sec, close, page, lot, serial, station] = m;
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    last = at + all.length;
    const docPage = mesDoc ? DOC_PAGE.find(([re]) => re.test(mesDoc)) : undefined;
    if (mesDoc && docPage) {
      out.push(
        <button key={at} className={`${linkCls} num`} title={docPage[2]} onClick={() => nav.page(docPage[1])}>
          {mesDoc}
        </button>,
      );
    } else if (doc) {
      // 짝이 맞는 대괄호만 링크에 포함한다
      const label = `${doc}${sec ? ` §${sec}` : ''}`;
      if (open && !close) out.push('[');
      out.push(
        <button key={at} className={`${linkCls} num text-[0.95em]`} title="작업표준서 열기" onClick={() => nav.standard(doc, sec ? Number(sec) : undefined)}>
          {open && close ? `[${label}]` : label}
        </button>,
      );
      if (close && !open) out.push(']');
    } else if (page) {
      // 경로 그대로(/trace?lot=…)는 읽기 어려우니 화면 이름으로 보이고, 실제 경로는 툴팁에 둔다
      const base = page.split('?')[0];
      out.push(
        <button key={at} className={linkCls} title={page} onClick={() => nav.page(page)}>
          {PAGE_NAMES[base] ?? base} 화면 ↗
        </button>,
      );
    } else if (lot) {
      out.push(
        <button key={at} className={`${linkCls} num`} title="추적 화면에서 LOT 영향 범위 보기" onClick={() => nav.lot(lot)}>
          {lot}
        </button>,
      );
    } else if (serial) {
      out.push(
        <button key={at} className={`${linkCls} num`} title="제품 이력 추적" onClick={() => nav.serial(serial)}>
          {serial}
        </button>,
      );
    } else if (station && STATIONS[station]) {
      out.push(
        <button key={at} className={`${linkCls} num`} title={`3D 공장에서 ${STATIONS[station].name} 보기`} onClick={() => nav.station(station)}>
          {station}
        </button>,
      );
    } else out.push(all);
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** 굵게(**)와 코드(`)를 나누고, 나머지 글만 링크로 바꾼다 */
function Inline({ text, nav }: { text: string; nav: ReturnType<typeof useNavigate> }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('`') && p.endsWith('`') && p.length > 2)
          return (
            <code key={i} className="num rounded bg-white/10 px-1 text-[0.9em]">
              {p.slice(1, -1)}
            </code>
          );
        if (p.startsWith('**') && p.endsWith('**') && p.length > 4)
          return (
            <strong key={i} className="font-semibold text-ink">
              <Linkified text={p.slice(2, -2)} nav={nav} />
            </strong>
          );
        return <Linkified key={i} text={p} nav={nav} />;
      })}
    </>
  );
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'h'; level: number; text: string; n?: number };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

function parse(src: string, headings: boolean): Block[] {
  const lines = src.replace(/\r/g, '').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      const n = /^(\d+)\.\s/.exec(h[2]);
      blocks.push(headings ? { kind: 'h', level: h[1].length, text: h[2], n: n ? Number(n[1]) : undefined } : { kind: 'p', lines: [`**${h[2]}**`] });
      i++;
      continue;
    }
    if (t.startsWith('|') && /^\|?\s*:?-{2,}/.test(lines[i + 1]?.trim() ?? '')) {
      const head = cells(t);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    const ul = /^[-*•]\s+(.*)$/;
    const ol = /^\d+[.)]\s+(.*)$/;
    if (ul.test(t) || ol.test(t)) {
      const kind = ul.test(t) ? 'ul' : 'ol';
      const re = kind === 'ul' ? ul : ol;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i].trim())) items.push(re.exec(lines[i++].trim())![1]);
      blocks.push({ kind, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith('|') && !ul.test(lines[i].trim()) && !ol.test(lines[i].trim()) && !/^#{1,4}\s/.test(lines[i].trim()))
      para.push(lines[i++].trim());
    if (para.length) blocks.push({ kind: 'p', lines: para });
    else i++;
  }
  return blocks;
}

export function Markdown({ text, headings = false, sectionId }: { text: string; headings?: boolean; sectionId?: (n: number) => string }) {
  const nav = useNavigate();
  const blocks = parse(text, headings);
  return (
    <div className="space-y-2 text-[13px] leading-relaxed text-ink/95">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h':
            return (
              <h3 key={i} id={b.n != null && sectionId ? sectionId(b.n) : undefined} className="scroll-mt-3 pt-2 text-sm font-semibold text-ink">
                <Inline text={b.text} nav={nav} />
              </h3>
            );
          case 'ul':
          case 'ol': {
            const List = b.kind === 'ul' ? 'ul' : 'ol';
            return (
              <List key={i} className={b.kind === 'ul' ? 'list-disc space-y-0.5 pl-5' : 'list-decimal space-y-0.5 pl-5'}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inline text={it} nav={nav} />
                  </li>
                ))}
              </List>
            );
          }
          case 'table':
            return (
              <div key={i} className="scroll-thin overflow-x-auto rounded-md border border-line">
                <table className="w-full text-[12px]">
                  <thead className="bg-white/[0.04] text-sub">
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} className="whitespace-nowrap px-2 py-1 text-left font-medium">
                          <Inline text={c} nav={nav} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j} className="border-t border-line/60 align-top">
                        {r.map((c, k) => (
                          <td key={k} className="px-2 py-1">
                            <Inline text={c} nav={nav} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return (
              <p key={i}>
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    <Inline text={l} nav={nav} />
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
