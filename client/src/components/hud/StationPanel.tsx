'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { LINES, STATIONS, type SpcChart, type StationState, type TagDef } from '@lumitwin/shared';
import { READ_ONLY_TITLE, useAccess } from '@/lib/access';
import { api, simCommand } from '@/lib/api';
import { cx, duration, GRADE_LABEL, KIND_LABEL, kst, num, pct, STATE_COLOR, STATE_LABEL } from '@/lib/format';
import { useLive } from '@/lib/live';
import { defectName, refName } from '@/lib/names';
import { SpcMini } from './SpcMini';
import { StationGuide } from './StationGuide';

function Grade({ g }: { g: keyof typeof GRADE_LABEL }) {
  const x = GRADE_LABEL[g];
  return (
    <span className="rounded px-1 text-[10px]" style={{ color: x.color, background: `${x.color}1f` }} title={x.hint}>
      {x.text}
    </span>
  );
}

/** 값이 규격(초록 띠) 안 어디에 있는지 보여 주는 막대 */
export function SpecBar({ v, nominal, sd, lsl, usl }: { v: number | undefined; nominal: number; sd: number; lsl?: number; usl?: number }) {
  const lo = Math.min(lsl ?? nominal - 4 * sd, nominal - 4 * sd);
  const hi = Math.max(usl ?? nominal + 4 * sd, nominal + 4 * sd);
  const p = (x: number) => `${Math.max(0, Math.min(100, ((x - lo) / (hi - lo || 1)) * 100))}%`;
  const out = v != null && ((lsl != null && v < lsl) || (usl != null && v > usl));
  return (
    <div className="relative h-1.5 w-full rounded bg-white/10">
      {(lsl != null || usl != null) && (
        <div className="absolute inset-y-0 rounded bg-run/25" style={{ left: p(lsl ?? lo), right: `calc(100% - ${p(usl ?? hi)})` }} />
      )}
      <div className="absolute inset-y-[-2px] w-px bg-white/40" style={{ left: p(nominal) }} />
      {v != null && <div className={cx('absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full', out ? 'bg-down' : 'bg-info')} style={{ left: p(v) }} />}
    </div>
  );
}

function TagRow({ t, v, here }: { t: TagDef; v: number | undefined; here: string }) {
  const out = v != null && ((t.lsl != null && v < t.lsl) || (t.usl != null && v > t.usl));
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate">
          {t.name} <Grade g={t.grade} />
          {t.mode === 'cycle' && <span className="ml-1 text-[10px] text-dim">사이클</span>}
        </span>
        <span className={cx('num shrink-0', out && 'text-down')}>
          {num(v, t.digits)} <span className="text-dim">{t.unit}</span>
        </span>
      </div>
      <SpecBar v={v} nominal={t.nominal} sd={t.sd} lsl={t.lsl} usl={t.usl} />
      {t.terms && t.terms.length > 0 && <div className="mt-0.5 text-[10px] text-dim">← {t.terms.map((x) => refName(x.ref, here)).join(', ')}에 따라 변함</div>}
    </div>
  );
}

const STATE_ORDER: StationState[] = ['RUN', 'IDLE', 'BLOCKED', 'DOWN', 'SETUP', 'STOP'];

/** open·onToggle을 주면 제목을 눌러 접고 펼 수 있다 (접힌 동안은 내용을 그리지 않는다) */
function Section({ title, children, right, open, onToggle }: { title: string; children: ReactNode; right?: ReactNode; open?: boolean; onToggle?: () => void }) {
  const shown = open ?? true;
  return (
    <div className="border-t border-line px-4 py-3">
      <div className={cx('flex items-center justify-between text-xs font-semibold text-sub', shown && 'mb-1.5')}>
        {onToggle ? (
          <button onClick={onToggle} className="flex items-center gap-1 hover:text-ink" aria-expanded={shown}>
            <span className="inline-block w-2.5 text-[10px] text-dim">{shown ? '▾' : '▸'}</span>
            {title}
          </button>
        ) : (
          <span>{title}</span>
        )}
        {shown && right}
      </div>
      {shown && children}
    </div>
  );
}

/** 설비 상세: 상태·OEE·공정 조건(태그)·검사값·불량 인과·SPC·최근 가공·원격 명령 */
export function StationPanel() {
  const code = useLive((s) => s.selected);
  const live = useLive((s) => (code ? s.stations[code] : undefined));
  const simT = useLive((s) => s.sim?.t);
  const units = useLive((s) => s.units);
  const select = useLive((s) => s.select);
  const openTrace = useLive((s) => s.openTrace);
  const [spcAll, setSpcAll] = useState(false);
  // 패널이 길어져 SPC·최근 가공은 접어 두고 연다 (설비를 바꿔도 펼친 상태는 유지)
  const [spcOpen, setSpcOpen] = useState(false);
  const [unitsOpen, setUnitsOpen] = useState(false);
  const def = code ? STATIONS[code] : undefined;
  const line = def ? LINES.find((l) => l.code === def.line) : undefined;

  const spc = useQuery({ queryKey: ['spc', code], queryFn: () => api.get<SpcChart[]>(`/live/spc/${code}`), enabled: !!code && spcOpen, refetchInterval: 3000 });
  const op = useMutation({ mutationFn: (o: 'stop' | 'start' | 'repair' | 'fail') => simCommand({ action: 'station', code: code!, op: o }) });
  const { readOnly } = useAccess();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && select(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [select]);

  if (!def || !line) return null;
  const state = live?.state ?? 'IDLE';
  const since = live && simT ? (Date.parse(simT) - Date.parse(live.since)) / 1000 : NaN;
  const ideal = def.cycle > 0 ? def.cycle / ((def.slots ?? 1) * (def.batch ?? 1)) : 0;
  const times = live?.stateSec ?? {};
  const total = STATE_ORDER.reduce((a, k) => a + (times[k] ?? 0), 0);
  const mine = units.filter((u) => u.station === def.code).slice(0, 8);
  const charts = (spc.data ?? []).filter((c) => spcAll || c.source !== 'continuous');
  const defects = Object.entries(live?.defects ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <aside className="panel pointer-events-auto scroll-thin flex max-h-full w-[400px] flex-col overflow-y-auto">
      <div className="h-0.5 shrink-0" style={{ background: line.color }} />
      <div className="px-4 pt-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-xs text-dim">
              <span className="num">{def.code}</span> · {KIND_LABEL[def.kind]} · {line.short}
            </div>
            <div className="text-base font-semibold leading-tight">{def.name}</div>
          </div>
          <button onClick={() => select(null)} className="rounded px-2 py-0.5 text-sm text-sub hover:bg-white/10" title="닫기 (Esc)">
            ✕
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded px-2 py-0.5 font-semibold text-black" style={{ background: STATE_COLOR[state] }}>
            {STATE_LABEL[state]}
          </span>
          <span className="text-sub">{Number.isFinite(since) ? `${duration(since)}째` : ''}</span>
          {live?.reason && <span className="text-down">사유: {live.reason}</span>}
          <span className="ml-auto">
            근거 <Grade g={def.grade} />
          </span>
        </div>
      </div>
      <div className="mt-3">
        <StationGuide def={def} />
      </div>

      <Section title="설비 종합 효율 (OEE)">
        <div className="grid grid-cols-4 gap-2 text-center">
          {(
            [
              ['OEE', live?.oee.oee],
              ['가동률', live?.oee.availability],
              ['성능', live?.oee.performance],
              ['양품률', live?.oee.quality],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="rounded bg-white/[0.04] py-1.5">
              <div className="num text-sm font-semibold">{pct(v)}</div>
              <div className="text-[10px] text-dim">{k}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex h-2 overflow-hidden rounded">
          {STATE_ORDER.map((k) => (times[k] ? <div key={k} style={{ width: `${(times[k]! / (total || 1)) * 100}%`, background: STATE_COLOR[k] }} title={`${STATE_LABEL[k]} ${duration(times[k]!)}`} /> : null))}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-dim">
          {STATE_ORDER.filter((k) => times[k]).map((k) => (
            <span key={k}>
              <span style={{ color: STATE_COLOR[k] }}>■</span> {STATE_LABEL[k]} {Math.round(((times[k] ?? 0) / (total || 1)) * 100)}%
            </span>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-3 text-xs">
          <div>
            양품 <span className="num">{live?.ok ?? 0}</span>
          </div>
          <div>
            불량 <span className={cx('num', (live?.ng ?? 0) > 0 && 'text-down')}>{live?.ng ?? 0}</span>
          </div>
          <div className="text-right text-dim">
            {ideal > 0 ? (
              <>
                이상 사이클 <span className="num">{num(ideal, 1)}</span>초/개
              </>
            ) : (
              '연속 운전 설비'
            )}
          </div>
        </div>
        <div className="mt-1 text-[10px] text-dim">
          사이클 {def.cycle}초{def.slots ? ` · 동시 ${def.slots}개` : ''}
          {def.batch ? ` · 배치 ${def.batch}개` : ''} · MTBF {def.mtbf}분 · MTTR {def.mttr}분
        </div>
      </Section>

      <Section title="공정 조건 (실시간 태그)">
        {def.tags.map((t) => (
          <TagRow key={t.key} t={t} v={t.mode === 'cycle' ? (live?.last?.values[t.key] ?? live?.tags[t.key]) : live?.tags[t.key]} here={def.code} />
        ))}
      </Section>

      {def.measures && def.measures.length > 0 && (
        <Section title="검사 측정값 (최근 1개)">
          {def.measures.map((m) => {
            const v = live?.last?.values[m.key];
            const out = v != null && ((m.lsl != null && v < m.lsl) || (m.usl != null && v > m.usl));
            return (
              <div key={m.key} className="py-1.5">
                <div className="flex justify-between text-xs">
                  <span>
                    {m.name} <Grade g={m.grade} />
                  </span>
                  <span className={cx('num', out && 'text-down')}>
                    {num(v, m.digits)} <span className="text-dim">{m.unit}</span>
                  </span>
                </div>
                <SpecBar v={v} nominal={m.base} sd={m.sd} lsl={m.lsl} usl={m.usl} />
                <div className="mt-0.5 text-[10px] text-dim">
                  규격 {m.lsl ?? '−'} ~ {m.usl ?? '−'} · 벗어나면 {defectName(m.defect)}
                  {m.terms.length > 0 && ` · ← ${m.terms.map((x) => refName(x.ref, def.code)).join(', ')}`}
                </div>
              </div>
            );
          })}
        </Section>
      )}

      {((def.defects?.length ?? 0) > 0 || (def.detects?.length ?? 0) > 0 || defects.length > 0) && (
        <Section title="불량 인과 (모델)">
          {def.defects?.map((d) => (
            <div key={d.code} className="py-1 text-xs">
              <div className="flex justify-between">
                <span>
                  {d.name} <Grade g={d.grade} /> {d.latent && <span className="text-[10px] text-warn">잠재 (뒤 공정에서 검출)</span>}
                </span>
                <span className="num text-sub">
                  {live?.defects[d.code] ?? 0}건 · 기본 {(d.base * 100).toFixed(2)}%
                </span>
              </div>
              {d.drivers.length > 0 && <div className="text-[10px] text-dim">원인: {d.drivers.map((x) => `${refName(x.ref, def.code)} ${x.dir > 0 ? '↑' : x.dir < 0 ? '↓' : '±'}`).join(', ')}</div>}
            </div>
          ))}
          {def.detects?.map((d) => (
            <div key={d.defect} className="py-0.5 text-xs text-sub">
              검출: {defectName(d.defect)} <span className="num">{Math.round(d.prob * 100)}%</span> {live?.defects[d.defect] ? <span className="num">· {live.defects[d.defect]}건</span> : null}
            </div>
          ))}
          {defects
            .filter(([c]) => !def.defects?.some((d) => d.code === c) && !def.detects?.some((d) => d.defect === c))
            .map(([c, n]) => (
              <div key={c} className="py-0.5 text-xs text-sub">
                {defectName(c)} <span className="num">{n}건</span>
              </div>
            ))}
        </Section>
      )}

      <Section
        title="SPC 관리도 (X̄, 부분군 5)"
        open={spcOpen}
        onToggle={() => setSpcOpen((v) => !v)}
        right={
          <button onClick={() => setSpcAll((v) => !v)} className="text-[11px] font-normal text-info hover:underline">
            {spcAll ? '연속값 숨기기' : '연속값도 보기'}
          </button>
        }
      >
        <div className="flex flex-col gap-2">
          {charts.length === 0 && <div className="text-xs text-dim">관리도로 볼 특성이 없습니다</div>}
          {charts.map((c) => (
            <SpcMini key={c.key} chart={c} />
          ))}
        </div>
      </Section>

      <Section title="최근 가공 (MES 기록)" open={unitsOpen} onToggle={() => setUnitsOpen((v) => !v)}>
        {mine.length === 0 && <div className="text-xs text-dim">아직 없습니다</div>}
        {mine.map((u) => (
          <div key={`${u.serial}${u.t}`} className="flex items-center gap-2 py-0.5 text-xs">
            <span className="num w-14 text-dim">{kst(u.t)}</span>
            <button className="num text-info hover:underline" onClick={() => openTrace(u.serial)}>
              {u.serial}
            </button>
            <span className={cx('ml-auto', u.result === 'NG' ? 'text-down' : 'text-run')}>
              {u.result}
              {u.defect ? ` ${defectName(u.defect)}` : ''}
            </span>
          </div>
        ))}
      </Section>

      <Section title="원격 명령 (가상 PLC)">
        <div className="grid grid-cols-4 gap-1.5 text-xs">
          {(
            [
              ['stop', '계획 정지'],
              ['start', '재가동'],
              ['fail', '고장 주입'],
              ['repair', '수리 완료'],
            ] as const
          ).map(([k, t]) => (
            <button
              key={k}
              disabled={op.isPending || readOnly}
              title={readOnly ? READ_ONLY_TITLE : undefined}
              onClick={() => op.mutate(k)}
              className={cx('rounded border border-line py-1.5 hover:bg-white/10 disabled:opacity-40', k === 'fail' && 'text-down')}
            >
              {t}
            </button>
          ))}
        </div>
        {op.error && <div className="mt-1 text-xs text-down">{(op.error as Error).message}</div>}
        <Link href={`/operator/${def.code}`} className="mt-2 block text-xs text-info hover:underline">
          이 설비의 작업자 태블릿 화면 열기 ↗ <span className="text-dim">(비가동 사유 입력·작업 전 점검)</span>
        </Link>
      </Section>
    </aside>
  );
}
