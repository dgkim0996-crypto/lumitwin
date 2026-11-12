import { Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFECT_NAMES, STATIONS, type StandardDoc, type StandardMeta } from '@lumitwin/shared';

/** 검색 결과 한 절 */
export interface StandardHit {
  /** 'WS-HL-03#4' (문서#절) */
  ref: string;
  doc: string;
  title: string;
  n: number;
  section: string;
  text: string;
  score: number;
}

interface Chunk {
  doc: string;
  title: string;
  n: number;
  section: string;
  text: string;
  tf: Map<string, number>;
  len: number;
}

// BM25 상수 (일반적인 값)
const K1 = 1.2;
const B = 0.75;
/** 도구 결과로 넘길 절 본문 최대 길이 */
const MAX_SECTION_CHARS = 1800;

/**
 * 한국어는 형태소 분석기 없이 두 글자씩 겹쳐 자른다(이슬점이 → 이슬·슬점·점이). 조사가 붙어도 겹치는 조각이 남아 찾힌다.
 * 영문·숫자는 설비 코드(hl-vm-01)를 통째로 두고 조각도 더한다.
 */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const m of s.toLowerCase().matchAll(/[a-z0-9]+(?:[-_.][a-z0-9]+)*|[가-힣]+/g)) {
    const w = m[0];
    if (/^[가-힣]+$/.test(w)) {
      if (w.length === 1) out.push(w);
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
    } else {
      out.push(w);
      if (/[-_]/.test(w)) for (const p of w.split(/[-_]/)) if (p.length > 1) out.push(p);
    }
  }
  return out;
}

const range = (lsl: number | undefined, usl: number | undefined) =>
  lsl == null && usl == null ? '−' : lsl == null ? `${usl} 이하` : usl == null ? `${lsl} 이상` : `${lsl} ~ ${usl}`;

/** `{{조건표:HL-VM-01}}` → 공장 정의의 태그·검사값 표. 문서와 시뮬레이터가 같은 값을 보게 한다 */
export function conditionTable(code: string): string {
  const st = STATIONS[code];
  if (!st) return `(알 수 없는 설비 ${code})`;
  const rows: string[] = [];
  for (const t of st.tags) {
    const kind = t.mode === 'cycle' ? '가공마다 기록' : '연속 감시';
    rows.push(`| ${t.name} | \`${t.key}\` | ${t.nominal} | ${range(t.lsl, t.usl)} | ${t.unit} | ${kind} |`);
  }
  for (const m of st.measures ?? []) {
    rows.push(`| ${m.name} | \`${m.key}\` | ${m.base} | ${range(m.lsl, m.usl)} | ${m.unit} | 검사값 → 벗어나면 ${DEFECT_NAMES[m.defect] ?? m.defect} |`);
  }
  // 표 뒤에 빈 줄을 둬야 다음 줄(다음 설비 제목)이 표의 행으로 붙지 않는다
  return [
    `**${st.code} ${st.name}** (사이클 ${st.cycle}초${st.batch ? ` · ${st.batch}개 배치` : ''})`,
    '',
    '| 항목 | 태그 | 기준값 | 관리 범위 | 단위 | 구분 |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

function parseFrontMatter(src: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: src.slice(m[0].length) };
}

const list = (v: string | undefined) => (v ?? '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * 작업표준서(docs/standards/*.md) 검색. 절(## n.) 단위로 잘라 BM25로 찾는다.
 * 임베딩을 쓰지 않아 키 없이 돌고, 설비 코드·태그 이름처럼 정확한 용어에 강하다.
 */
@Injectable()
export class StandardsIndex implements OnModuleInit {
  private readonly logger = new Logger('Standards');
  private docs = new Map<string, StandardDoc>();
  private chunks: Chunk[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;

  async onModuleInit(): Promise<void> {
    const dir = [process.env.STANDARDS_DIR, path.resolve(process.cwd(), 'docs/standards'), path.resolve(process.cwd(), '../docs/standards')].find(
      (d): d is string => !!d && existsSync(d),
    );
    if (!dir) {
      this.logger.warn('작업표준서 폴더(docs/standards)를 찾지 못했습니다');
      return;
    }
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
    for (const f of files) this.add(await readFile(path.join(dir, f), 'utf8'), f.replace(/\.md$/, ''));
    for (const c of this.chunks) for (const t of c.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.chunks.reduce((a, c) => a + c.len, 0) / Math.max(1, this.chunks.length);
    this.logger.log(`작업표준서 ${this.docs.size}건 · ${this.chunks.length}절 색인`);
  }

  private add(src: string, fallbackId: string): void {
    const { meta, body } = parseFrontMatter(src);
    const id = meta.id || fallbackId;
    const title = meta.title || id;
    const stations = list(meta.stations);
    const markdown = body.replace(/\{\{조건표:([A-Z0-9-]+)\}\}/g, (_, code: string) => conditionTable(code));
    const sections: StandardDoc['sections'] = [];
    // 절 머리 앞의 글(머리말)은 0절로 둔다
    const parts = markdown.split(/^(?=## )/m);
    const head = `${title} ${id} ${stations.join(' ')} ${stations.map((s) => STATIONS[s]?.name ?? '').join(' ')}`;
    for (const part of parts) {
      const hm = /^## (?:(\d+)\.\s*)?(.+)$/m.exec(part);
      const n = hm?.[1] ? Number(hm[1]) : hm ? sections.length + 1 : 0;
      const section = hm ? hm[2].trim() : '개요';
      const text = (hm ? part.slice(hm[0].length) : part).trim();
      if (!text) continue;
      if (hm) sections.push({ n, title: section });
      // 문서 제목·설비 이름·절 제목을 본문 앞에 붙여 색인한다 (절만 떼어 와도 무슨 문서인지 찾히게)
      const tokens = tokenize(`${head} ${section} ${section} ${text}`);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.chunks.push({ doc: id, title, n, section, text, tf, len: tokens.length });
    }
    this.docs.set(id, { id, title, line: meta.line || null, stations, revision: meta.revision || null, sections, markdown });
  }

  get size(): number {
    return this.docs.size;
  }

  list(): StandardMeta[] {
    return [...this.docs.values()].map(({ markdown: _m, ...meta }) => meta);
  }

  get(id: string): StandardDoc {
    const d = this.docs.get(id);
    if (!d) throw new NotFoundException(`작업표준서 ${id}를 찾을 수 없습니다`);
    return d;
  }

  /** 설비를 주면 그 설비를 다루는 문서의 절에 가산점을 준다 */
  search(query: string, k = 4, station?: string): StandardHit[] {
    const q = [...new Set(tokenize(query))];
    if (!q.length || !this.chunks.length) return [];
    const N = this.chunks.length;
    const scored = this.chunks.map((c) => {
      let s = 0;
      for (const t of q) {
        const f = c.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * c.len) / this.avgLen));
      }
      if (station && s > 0 && this.docs.get(c.doc)?.stations.includes(station)) s *= 1.5;
      // "목적과 적용 범위" 절은 문서 전체를 요약해 낱말이 다 걸리지만 답이 되는 일은 드물다
      if (/목적|적용\s*범위/.test(c.section)) s *= 0.5;
      return { c, s };
    });
    return scored
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map(({ c, s }) => ({
        ref: `${c.doc}#${c.n}`, doc: c.doc, title: c.title, n: c.n, section: c.section,
        text: c.text.length > MAX_SECTION_CHARS ? `${c.text.slice(0, MAX_SECTION_CHARS)}…` : c.text, score: Math.round(s * 100) / 100,
      }));
  }
}
