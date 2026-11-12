'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { FACTORY, LINES, STATIONS, type LineDef, type StationDef } from '@lumitwin/shared';
import { calloutsFor } from '@/components/scene/machines';
import { useLive } from '@/lib/live';
import { defectName } from '@/lib/names';
import { guideFor } from '@/lib/station-guide';

type Station = StationDef & { line: LineDef['code'] };

const LINE = Object.fromEntries(LINES.map((l) => [l.code, l])) as Record<string, LineDef>;
const MATERIAL = Object.fromEntries(FACTORY.materials.map((m) => [m.code, m]));
const WAREHOUSE = Object.fromEntries(FACTORY.warehouses.map((w) => [w.code, w]));

/** 끝 글자 받침 유무로 조사를 고른다. 숫자는 읽는 소리로 (AMR-02가, AMR-03이) */
function batchim(word: string): number {
  const ch = word.trim().slice(-1);
  const c = ch.charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28;
  const digit: Record<string, number> = { '0': 21, '1': 8, '2': 0, '3': 16, '4': 0, '5': 0, '6': 1, '7': 8, '8': 8, '9': 0 };
  return digit[ch] ?? 0;
}
const iGa = (w: string) => `${w}${batchim(w) ? '이' : '가'}`;
const euRo = (w: string) => `${w}${batchim(w) && batchim(w) !== 8 ? '으로' : '로'}`;

const stepOf = (line: LineDef, code: string) => line.steps.find((s) => s.code === code);
/** 공정에서 제품을 처리하는 설비 (사이클 0인 보조 설비 제외) */
const workers = (line: LineDef, step: string) => line.stations.filter((s) => s.step === step && s.cycle > 0).map((s) => s.code);
/** 공정에 붙은 보조 설비 (건조기처럼 제품을 직접 만들지 않는다) */
const helpers = (line: LineDef, step: string) => line.stations.filter((s) => s.step === step && s.cycle <= 0).map((s) => s.code);

// ───────── 흐름: 들어오는 것 → 나가는 것, 앞·뒤 공정 (공장 정의에서 계산) ─────────

interface FlowIn {
  name: string;
  qty: number;
  kind: 'step' | 'transfer' | 'material';
  note: string;
}
/** 앞·뒤 공정 한 칸. code가 있으면 설비 버튼, 없으면 창고 같은 끝점 */
interface Endpoint {
  code?: string;
  label: string;
  via?: string;
}
interface Flow {
  inputs: FlowIn[];
  output: { name: string; qty?: number; notes: string[] };
  prev: Endpoint[];
  next: Endpoint[];
  peers: string[];
}

function stationFlow(def: Station): Flow {
  const line = LINE[def.line];
  const step = stepOf(line, def.step);
  if (!step) return { inputs: [], output: { name: '-', notes: [] }, prev: [], next: [], peers: [] };
  const utility = def.cycle <= 0;
  const aux = helpers(line, step.code).filter((c) => c !== def.code);
  const inputs: FlowIn[] = [];
  const prev: Endpoint[] = [];

  for (const i of step.inputs) {
    if (i.step && !utility) {
      const s = stepOf(line, i.step);
      const codes = workers(line, i.step);
      inputs.push({ name: s?.itemName ?? i.step, qty: i.qty, kind: 'step', note: `${s?.name ?? i.step} · ${codes.join(', ')}` });
      prev.push(...codes.map((code) => ({ code, label: s?.name ?? '' })));
    } else if (i.transfer && !utility) {
      const tr = FACTORY.transfers.find((t) => t.code === i.transfer);
      if (!tr) continue;
      const fl = LINE[tr.from.line];
      const fs = stepOf(fl, tr.from.step);
      const codes = workers(fl, tr.from.step);
      inputs.push({ name: fs?.itemName ?? tr.from.step, qty: i.qty, kind: 'transfer', note: `${fl.short} 라인 ${codes.join(', ')}에서 ${iGa(tr.amr)} ${tr.lot}개씩 운반` });
      prev.push(...codes.map((code) => ({ code, label: fs?.name ?? '', via: tr.amr })));
    } else if (i.material) {
      const m = MATERIAL[i.material];
      const via = aux.length && !utility ? ` · ${aux.map((c) => STATIONS[c]?.name ?? c).join(', ')} 거쳐 투입` : '';
      inputs.push({ name: m?.name ?? i.material, qty: i.qty, kind: 'material', note: `구매 자재 · LOT 기록${via}` });
    }
  }
  if (!utility) prev.push(...aux.map((code) => ({ code, label: '보조 설비' })));
  if (prev.length === 0 && inputs.some((x) => x.kind === 'material')) prev.push({ label: WAREHOUSE.RM?.name ?? '자재 창고' });

  const next: Endpoint[] = [];
  const notes: string[] = [];
  if (utility) {
    const codes = workers(line, step.code);
    next.push(...codes.map((code) => ({ code, label: step.name })));
    notes.push(`${codes.join(', ')}에 바로 공급`);
    return { inputs, output: { name: guideFor(def).output ?? '-', notes }, prev, next, peers: [] };
  }

  for (const s of line.steps) if (s.inputs.some((i) => i.step === step.code)) next.push(...workers(line, s.code).map((code) => ({ code, label: s.name })));
  for (const tr of FACTORY.transfers) {
    if (tr.from.line !== line.code || tr.from.step !== step.code) continue;
    if ('warehouse' in tr.to) {
      const wh = WAREHOUSE[tr.to.warehouse]?.name ?? tr.to.warehouse;
      next.push({ label: wh, via: tr.amr });
      notes.push(`${iGa(tr.amr)} ${tr.lot}개씩 ${euRo(wh)}`);
    } else {
      const tl = LINE[tr.to.line];
      const ts = stepOf(tl, tr.to.step);
      next.push(...workers(tl, tr.to.step).map((code) => ({ code, label: ts?.name ?? '', via: tr.amr })));
      notes.push(`${iGa(tr.amr)} ${tr.lot}개씩 ${tl.short} 라인 ${euRo(ts?.name ?? tr.to.step)}`);
    }
  }

  if (def.batch) notes.unshift(`한 사이클에 ${def.batch}개`);
  if (def.slots) notes.unshift(`안에 ${def.slots}개가 동시에 머문다`);
  const comps = step.inputs.filter((i) => i.step || i.transfer);
  if (step.serial === 'new') notes.push(comps.length ? `새 시리얼 ${step.prefix ?? ''}… 발번 · 넣은 부품은 계보로 연결` : `새 시리얼 ${step.prefix ?? ''}… 발번`);
  else if (comps.length > 1) notes.push(`${inputs[0]?.name ?? ''} 시리얼을 이어 쓰고 나머지 부품은 계보로 연결`);
  else notes.push('시리얼 그대로 이어 감');
  const judged = (def.defects ?? []).some((d) => !d.latent) || (def.measures?.length ?? 0) > 0 || (def.detects?.length ?? 0) > 0;
  if (judged) notes.push('NG 판정품은 여기서 빠지고 합격품만 넘어간다');
  else if ((def.defects ?? []).some((d) => d.latent)) notes.push('불량이 생겨도 판정 없이 실려 간다 (뒤 검사에서 검출)');

  const peers = workers(line, step.code).filter((c) => c !== def.code);
  return { inputs, output: { name: step.itemName, qty: 1, notes }, prev, next, peers };
}

// ───────── 흐름 그래프: 앞쪽·뒤쪽 설비 (잠재 불량의 출처·속성의 쓰임새를 찾는 데 쓴다) ─────────

interface Node {
  line: LineDef;
  step: string;
}
const nodeKey = (n: Node) => `${n.line.code}:${n.step}`;

function nextNodes(n: Node): Node[] {
  const out: Node[] = n.line.steps.filter((s) => s.inputs.some((i) => i.step === n.step)).map((s) => ({ line: n.line, step: s.code }));
  for (const tr of FACTORY.transfers) if (tr.from.line === n.line.code && tr.from.step === n.step && !('warehouse' in tr.to)) out.push({ line: LINE[tr.to.line], step: tr.to.step });
  return out;
}

function prevNodes(n: Node): Node[] {
  const out: Node[] = [];
  for (const i of stepOf(n.line, n.step)?.inputs ?? []) {
    if (i.step) out.push({ line: n.line, step: i.step });
    const tr = i.transfer ? FACTORY.transfers.find((t) => t.code === i.transfer) : undefined;
    if (tr) out.push({ line: LINE[tr.from.line], step: tr.from.step });
  }
  return out;
}

/** 이 설비보다 뒤(down) 또는 앞(up)에 있는 설비들. 같은 공정의 보조 설비 ↔ 본 설비도 포함 */
function reach(def: Station, dir: 'up' | 'down'): Station[] {
  const start: Node = { line: LINE[def.line], step: def.step };
  const utility = def.cycle <= 0;
  const out: Station[] = start.line.stations
    .filter((s) => s.step === def.step && s.code !== def.code && (dir === 'down' ? utility && s.cycle > 0 : !utility && s.cycle <= 0))
    .map((s) => STATIONS[s.code]);
  const seen = new Set([nodeKey(start)]);
  const queue = [start];
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of dir === 'down' ? nextNodes(n) : prevNodes(n)) {
      if (seen.has(nodeKey(m))) continue;
      seen.add(nodeKey(m));
      queue.push(m);
      out.push(...m.line.stations.filter((s) => s.step === m.step).map((s) => STATIONS[s.code]));
    }
  }
  // 흐름 순서 (가까운 공정부터)
  return out.filter(Boolean);
}

// ───────── 핵심 조건·판정 (태그·검사값·불량 인과에서 계산) ─────────

interface Point {
  group: number;
  label: string;
  value?: string;
  spec?: string;
  badge?: string;
  /** 설명 줄. 배열이면 한 줄씩 */
  sub?: string | string[];
}

const fmt = (v: number) => Number(v.toFixed(4)).toLocaleString('ko-KR', { maximumFractionDigits: 4 });
const withUnit = (v: string, unit: string) => (unit ? `${v} ${unit}` : v);

function specText(lsl: number | undefined, usl: number | undefined, unit: string): string | undefined {
  if (lsl != null && usl != null) return withUnit(`${fmt(lsl)}~${fmt(usl)}`, unit);
  if (usl != null) return withUnit(`≤ ${fmt(usl)}`, unit);
  if (lsl != null) return withUnit(`≥ ${fmt(lsl)}`, unit);
  return undefined;
}

interface RefInfo {
  name: string;
  unit: string;
  nominal?: number;
  lsl?: number;
  usl?: number;
  /** 다른 설비의 값이면 그 설비 코드 */
  at?: string;
  attr?: boolean;
}

function resolveRef(ref: string, here: Station, upstream: Station[]): RefInfo {
  const kind = ref.slice(0, ref.indexOf(':'));
  const name = ref.slice(ref.indexOf(':') + 1);
  if (kind === 'tag') {
    const [code, key] = name.includes('.') ? (name.split('.', 2) as [string, string]) : [here.code, name];
    const t = STATIONS[code]?.tags.find((x) => x.key === key);
    return { name: t?.name ?? key, unit: t?.unit ?? '', nominal: t?.nominal, lsl: t?.lsl, usl: t?.usl, at: code === here.code ? undefined : code };
  }
  if (kind === 'attr') {
    const local = here.attrs?.find((a) => a.key === name);
    if (local) return { name: local.name, unit: local.unit, nominal: local.base, attr: true };
    for (const s of [...upstream, ...Object.values(STATIONS)]) {
      const a = s.attrs?.find((x) => x.key === name);
      if (a) return { name: a.name, unit: a.unit, nominal: a.base, attr: true, at: s.code };
    }
  }
  return { name, unit: '' };
}

const dirWord = (dir: 1 | -1 | 0) => (dir > 0 ? '높으면' : dir < 0 ? '낮으면' : '벗어나면');

/** 어떤 값(ref)을 쓰는 설비와 그 결과 이름 (불량·검사값·부품 속성) */
function usersOf(ref: string, among: Station[]): { code: string; names: string[] }[] {
  const out: { code: string; names: string[] }[] = [];
  for (const s of among) {
    const names = [
      ...(s.defects ?? []).filter((d) => d.drivers.some((x) => x.ref === ref)).map((d) => d.name),
      ...(s.measures ?? []).filter((m) => m.terms.some((x) => x.ref === ref)).map((m) => m.name),
      ...(s.attrs ?? []).filter((a) => a.terms.some((x) => x.ref === ref)).map((a) => a.name),
      ...s.tags.filter((t) => t.terms?.some((x) => x.ref === ref)).map((t) => t.name),
    ];
    if (names.length) out.push({ code: s.code, names });
  }
  return out;
}

/** 쓰는 곳 문장. 같은 결과를 내는 병렬 설비는 한데 묶는다 (EM-FCT-B1·EM-FCT-B2 셀 전압 측정 오차) */
function usersText(users: { code: string; names: string[] }[]): string {
  const by = new Map<string, string[]>();
  for (const u of users) by.set(u.names.join('·'), [...(by.get(u.names.join('·')) ?? []), u.code]);
  return `→ ${[...by.entries()].map(([names, codes]) => `${codes.join('·')} ${names}`).join(', ')}`;
}

function keyPoints(def: Station): Point[] {
  const up = reach(def, 'up');
  const down = reach(def, 'down');
  const badgeOf = (r: RefInfo) => (r.at ? (r.attr ? `${r.at}에서 옴` : r.at) : r.attr ? '이 설비 계산값' : undefined);

  // A. 불량을 좌우하는 조건: 원인 값마다 한 줄 (낮으면 X · 높으면 Y)
  const byRef = new Map<string, { dir: 1 | -1 | 0; name: string; latent?: boolean }[]>();
  for (const d of def.defects ?? []) for (const dr of d.drivers) byRef.set(dr.ref, [...(byRef.get(dr.ref) ?? []), { dir: dr.dir, name: d.name, latent: d.latent }]);
  const A: Point[] = [...byRef.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([ref, effs]) => {
      const r = resolveRef(ref, def, up);
      const words = ([1, -1, 0] as const)
        .map((dir) => {
          const xs = effs.filter((e) => e.dir === dir);
          if (!xs.length) return '';
          const allLatent = xs.every((e) => e.latent);
          const names = xs.map((e) => (e.latent && !allLatent ? `${e.name}(숨은 불량)` : e.name)).join('·');
          return `${dirWord(dir)} ${names}${allLatent ? ' (숨은 불량)' : ''}`;
        })
        .filter(Boolean);
      return {
        group: 0,
        label: r.name,
        value: r.nominal != null ? withUnit(fmt(r.nominal), r.unit) : undefined,
        spec: specText(r.lsl, r.usl, ''),
        badge: badgeOf(r),
        sub: words.join(' · '),
      };
    });

  // B. 판정 기준: 검사값 규격과 그 값을 좌우하는 앞 공정 값
  const B: Point[] = (def.measures ?? []).map((m) => {
    const drivers = m.terms.map((t) => resolveRef(t.ref, def, up)).map((r) => (r.at ? `${r.name}(${r.at})` : r.name));
    return {
      group: 1,
      label: m.name,
      value: specText(m.lsl, m.usl, m.unit),
      sub: `벗어나면 NG${drivers.length ? ` · 좌우하는 값: ${drivers.join(', ')}` : ''}`,
    };
  });

  // C. 앞 공정에서 숨어 온 불량을 찾아내는 확률과 그 출처
  const C: Point[] = def.detects?.length
    ? [
        {
          group: 2,
          label: '찾아내는 숨은 불량 (검출률)',
          sub: def.detects.map((d) => {
            // 먼 공정부터 (흐름 순서)
            const from = up.filter((s) => s.defects?.some((x) => x.code === d.defect && x.latent)).map((s) => s.code).reverse();
            return `${defectName(d.defect)} ${Math.round(d.prob * 100)}%${from.length ? ` ← ${from.join(', ')}에서 생김` : ''}`;
          }),
        },
      ]
    : [];
  // C'. 여기서 생긴 숨은 불량이 뒤에서 걸리는 곳
  const latent = (def.defects ?? []).filter((d) => d.latent);
  if (latent.length)
    C.push({
      group: 2,
      label: '숨은 불량이 걸리는 곳 (검출률)',
      sub: latent.map((d) => {
        const at = new Map<number, string[]>();
        for (const s of down) {
          const x = s.detects?.find((y) => y.defect === d.code);
          if (x) at.set(Math.round(x.prob * 100), [...(at.get(Math.round(x.prob * 100)) ?? []), s.code]);
        }
        const where = [...at.entries()].map(([p, codes]) => `${codes.join('·')} ${p}%`).join(', ');
        return `${d.name} → ${where || '검출하는 뒤 공정 없음'}`;
      }),
    });

  // D. 이 설비의 값이 뒤 공정에서 쓰이는 곳 (부품 속성·다른 설비가 참조하는 태그)
  const D: Point[] = [];
  for (const a of def.attrs ?? []) {
    const users = usersOf(`attr:${a.key}`, down);
    if (users.length) D.push({ group: 3, label: a.name, badge: '부품에 실려 감', sub: usersText(users) });
  }
  for (const t of def.tags) {
    const users = usersOf(`tag:${def.code}.${t.key}`, Object.values(STATIONS));
    if (users.length) D.push({ group: 3, label: t.name, badge: '다른 설비가 참조', sub: usersText(users) });
  }

  // E. 위에서 나온 게 적으면 규격 있는 태그로 채운다 (속성 계산에 들어가는 태그 먼저)
  const used = new Set([...byRef.keys()].map((r) => r.replace(/^tag:/, '')));
  const feeds = (key: string) => [
    ...(def.attrs ?? []).filter((a) => a.terms.some((x) => x.ref === `tag:${key}`)).map((a) => a.name),
    ...def.tags.filter((t) => t.terms?.some((x) => x.ref === `tag:${key}`)).map((t) => t.name),
  ];
  const E: Point[] = def.tags
    .filter((t) => (t.lsl != null || t.usl != null) && !used.has(t.key))
    .sort((a, b) => feeds(b.key).length - feeds(a.key).length)
    .map((t) => ({
      group: 4,
      label: t.name,
      value: withUnit(fmt(t.nominal), t.unit),
      spec: specText(t.lsl, t.usl, ''),
      sub: feeds(t.key).length ? `→ ${feeds(t.key).join('·')}에 반영` : undefined,
    }));

  // 묶음마다 하나씩 돌아가며 최대 4줄 (한 종류만 줄줄이 나오지 않게)
  const groups = [A, B, C, D];
  const out: Point[] = [];
  for (let round = 0; out.length < 4 && groups.some((g) => g.length > round); round++) for (const g of groups) if (g[round] && out.length < 4) out.push(g[round]);
  for (const e of E) if (out.length < 3) out.push(e);
  return out.sort((a, b) => a.group - b.group);
}

// ───────── 화면 ─────────

function Sub({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-baseline justify-between text-[11px] font-semibold text-sub">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function Chip({ e, dir, select }: { e: Endpoint; dir: 'prev' | 'next' | 'peer'; select: (c: string) => void }) {
  const st = e.code ? STATIONS[e.code] : undefined;
  const inner = (
    <>
      {dir === 'prev' && <span className="text-dim">←</span>}
      {st && <span className="size-1.5 shrink-0 rounded-full" style={{ background: LINE[st.line]?.color }} />}
      {e.code && <span className="num">{e.code}</span>}
      <span className="text-sub">{e.label}</span>
      {e.via && <span className="rounded bg-info/15 px-1 text-[10px] text-info">{e.via}</span>}
      {dir === 'next' && <span className="text-dim">→</span>}
    </>
  );
  if (!st || !e.code) return <span className="flex items-center gap-1 rounded border border-dashed border-line px-1.5 py-0.5 text-[11px]">{inner}</span>;
  const code = e.code;
  return (
    <button onClick={() => select(code)} title={`${st.name} 보기`} className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] hover:bg-white/10">
      {inner}
    </button>
  );
}

function NavRow({ label, items, dir, select }: { label: string; items: Endpoint[]; dir: 'prev' | 'next' | 'peer'; select: (c: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="w-7 shrink-0 pt-0.5 text-[10px] text-dim">{label}</span>
      <div className="flex min-w-0 flex-wrap gap-1">
        {items.map((e, i) => (
          <Chip key={`${e.code ?? e.label}${i}`} e={e} dir={dir} select={select} />
        ))}
      </div>
    </div>
  );
}

/** 설비 상세 맨 위 "하는 일": 한 줄 요약 · 들어오는 것 → 나가는 것 · 작업 순서 · 핵심 조건 · 3D 부위 · 앞뒤 공정 */
export function StationGuide({ def }: { def: Station }) {
  const [open, setOpen] = useState(true);
  const select = useLive((s) => s.select);
  const line = LINE[def.line];
  const g = guideFor(def);
  const flow = useMemo(() => stationFlow(def), [def]);
  const points = useMemo(() => keyPoints(def), [def]);
  const callouts = calloutsFor(def);

  return (
    <div className="border-t border-line px-4 py-3">
      <div className="mb-1 flex items-center justify-between text-xs font-semibold text-sub">
        <span>하는 일</span>
        <button onClick={() => setOpen((v) => !v)} className="text-[11px] font-normal text-info hover:underline">
          {open ? '접기' : '자세히'}
        </button>
      </div>
      <p className="text-[13px] leading-relaxed">{g.summary}</p>

      {open && (
        <>
          {g.terms && g.terms.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-0.5">
              {g.terms.map((t) => {
                const [k, ...rest] = t.split(' = ');
                return (
                  <div key={t} className="text-[11px] leading-snug text-dim">
                    {rest.length ? (
                      <>
                        <span className="font-medium text-sub">{k}</span> = {rest.join(' = ')}
                      </>
                    ) : (
                      t
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-3 flex items-stretch gap-1.5">
            <div className="min-w-0 flex-1 rounded bg-white/[0.04] px-2 py-1.5">
              <div className="text-[10px] text-dim">들어오는 것</div>
              {flow.inputs.length === 0 && <div className="mt-1 text-xs text-dim">-</div>}
              {flow.inputs.map((x, i) => (
                <div key={i} className="mt-1">
                  <div className="flex items-baseline gap-1 text-xs">
                    <span className="min-w-0 truncate">{x.name}</span>
                    <span className="num shrink-0 text-dim">×{x.qty}</span>
                    {x.kind === 'transfer' && <span className="shrink-0 rounded bg-info/15 px-1 text-[10px] text-info">AMR</span>}
                  </div>
                  <div className="text-[10px] leading-snug text-dim">{x.note}</div>
                </div>
              ))}
            </div>
            <div className="flex items-center text-sub">→</div>
            <div className="w-[138px] shrink-0 rounded px-2 py-1.5" style={{ background: `${line.color}14`, boxShadow: `inset 0 0 0 1px ${line.color}40` }}>
              <div className="text-[10px] text-dim">나가는 것</div>
              <div className="mt-1 text-xs font-semibold">
                {flow.output.name}
                {flow.output.qty != null && <span className="num font-normal text-dim"> ×{flow.output.qty}</span>}
              </div>
              {flow.output.notes.map((n) => (
                <div key={n} className="mt-0.5 text-[10px] leading-snug text-dim">
                  {n}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-2">
            <NavRow label="앞" items={flow.prev} dir="prev" select={select} />
            <NavRow label="병렬" items={flow.peers.map((code) => ({ code, label: '같은 공정' }))} dir="peer" select={select} />
            <NavRow label="뒤" items={flow.next} dir="next" select={select} />
          </div>

          {g.steps.length > 0 && (
            <Sub title="작업 순서">
              <ol className="flex flex-col gap-1">
                {g.steps.map((s, i) => (
                  <li key={i} className="flex gap-2 text-xs leading-snug">
                    <span className="num mt-px flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-black" style={{ background: line.color }}>
                      {i + 1}
                    </span>
                    <span>{s}</span>
                  </li>
                ))}
              </ol>
            </Sub>
          )}

          {(points.length > 0 || g.why) && (
            <Sub title="핵심 조건·판정">
              <ul className="flex flex-col gap-1.5">
                {points.map((p, i) => (
                  <li key={i} className="text-xs leading-snug">
                    <div className="flex flex-wrap items-baseline gap-x-1.5">
                      <span className="font-medium">{p.label}</span>
                      {p.value && <span className="num text-sub">{p.value}</span>}
                      {p.spec && <span className="text-[10px] text-dim">규격 {p.spec}</span>}
                      {p.badge && <span className="rounded bg-white/[0.06] px-1 text-[10px] text-dim">{p.badge}</span>}
                    </div>
                    {(Array.isArray(p.sub) ? p.sub : p.sub ? [p.sub] : []).map((line) => (
                      <div key={line} className="text-[11px] text-dim">
                        {line}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
              {g.why && (
                <div className="mt-2 rounded px-2 py-1.5 text-[11px] leading-relaxed text-sub" style={{ background: `${line.color}10`, borderLeft: `2px solid ${line.color}` }}>
                  <span className="font-semibold">왜 중요한가</span> · {g.why}
                </div>
              )}
            </Sub>
          )}

          {callouts.length > 0 && (
            <Sub title="3D에서 보이는 부분" right={<span className="font-normal text-dim">설비 위 이름표</span>}>
              <ul className="flex flex-col gap-0.5">
                {callouts.map((c, i) => (
                  <li key={i} className="text-xs leading-snug">
                    <span className="font-medium">{c.text}</span>
                    {c.note && <span className="text-dim"> — {c.note}</span>}
                  </li>
                ))}
              </ul>
            </Sub>
          )}

          <div className="mt-3 text-[11px] leading-relaxed text-dim">
            <span className="text-sub">설비 메모</span> · {def.desc}
            {def.note && <div className="mt-1">{def.note}</div>}
          </div>
        </>
      )}
    </div>
  );
}
