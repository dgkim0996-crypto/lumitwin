'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  LINES,
  OPERATOR_REASONS,
  REASON_MAX,
  STATIONS,
  type CheckRecordView,
  type CheckRequest,
  type OperatorStopKind,
  type StationOp,
  type StationState,
} from '@lumitwin/shared';
import { pageContext } from '@/components/assistant/AssistantPanel';
import { SpecBar } from '@/components/hud/StationPanel';
import { AccessBadge } from '@/components/hud/AccessBadge';
import { useAccess } from '@/lib/access';
import { api, simCommand } from '@/lib/api';
import { useAssistant } from '@/lib/assistant';
import { useGate } from '@/lib/auth';
import { cx, duration, kst, num, pct, STATE_COLOR, STATE_LABEL } from '@/lib/format';
import { useLive } from '@/lib/live';
import { defectName } from '@/lib/names';
import { remembered, useStationStandard } from '@/lib/operator';
import { useUi } from '@/lib/ui';
import { BottomSheet } from './BottomSheet';
import { OperatorQuality } from './OperatorQuality';

const STATE_HINT: Record<StationState, string> = {
  RUN: '가공 중입니다',
  IDLE: '앞 공정 부품을 기다리고 있습니다',
  BLOCKED: '뒤 버퍼가 가득 차 내보내지 못하고 있습니다',
  DOWN: '고장으로 멈췄습니다. 수리가 끝나면 수리 완료를 누르세요',
  SETUP: '셋업(준비 작업) 중입니다. 끝나면 재가동을 누르세요',
  STOP: '계획 정지 중입니다. 다시 돌릴 때 재가동을 누르세요',
};

type Sheet = { kind: OperatorStopKind } | { kind: 'start' } | { kind: 'repair' } | null;

/** 카드 머리 */
function Card({ title, right, children, className, label }: { title: string; right?: ReactNode; children: ReactNode; className?: string; label?: string }) {
  return (
    <section className={cx('card min-w-0 p-4', className)} aria-label={label ?? title}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function MicIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="2" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ───────────── 상태 ─────────────

function StateHero({ code }: { code: string }) {
  const live = useLive((s) => s.stations[code]);
  const simT = useLive((s) => s.sim?.t);
  const state = live?.state ?? 'IDLE';
  const since = live && simT ? (Date.parse(simT) - Date.parse(live.since)) / 1000 : NaN;
  const count = (live?.ok ?? 0) + (live?.ng ?? 0);
  const last = live?.last;
  return (
    <section className="card order-1 min-w-0 overflow-hidden" aria-label="설비 상태">
      <div className="flex">
        <div className="w-2.5 shrink-0" style={{ background: STATE_COLOR[state] }} />
        <div className="min-w-0 flex-1 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-lg px-3 py-1 text-3xl font-bold text-black" style={{ background: STATE_COLOR[state] }}>
              {STATE_LABEL[state]}
            </span>
            <span className="text-lg text-sub">{Number.isFinite(since) ? `${duration(since)}째` : ''}</span>
          </div>
          <p className="mt-2 text-base text-sub">{STATE_HINT[state]}</p>
          {live?.reason && (
            <p className="mt-1 text-lg">
              사유 <b className={state === 'DOWN' ? 'text-down' : 'text-ink'}>{live.reason}</b>
            </p>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                ['양품', String(live?.ok ?? 0), ''],
                ['불량', String(live?.ng ?? 0), (live?.ng ?? 0) > 0 ? 'text-down' : ''],
                ['불량률', count ? pct((live?.ng ?? 0) / count) : '-', ''],
                ['OEE', pct(live?.oee.oee), ''],
              ] as const
            ).map(([k, v, c]) => (
              <div key={k} className="rounded-lg bg-white/[0.04] px-3 py-2">
                <div className="text-sm text-sub">{k}</div>
                <div className={cx('num text-2xl font-semibold', c)}>{v}</div>
              </div>
            ))}
          </div>
          {last && (
            <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-base">
              <span className="text-sub">최근 판정</span>
              <span className="num text-sub">{kst(last.t)}</span>
              <span className="num">{last.serial}</span>
              <span className={cx('font-semibold', last.result === 'NG' ? 'text-down' : 'text-run')}>
                {last.result}
                {last.defect ? ` · ${defectName(last.defect)}` : ''}
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ───────────── 공정 조건 ─────────────

/** 한쪽 한계만 있는 규격은 "0.35 이하" / "45 이상"으로 읽기 쉽게 */
function rangeText(lsl?: number | null, usl?: number | null): string {
  if (lsl != null && usl != null) return `${lsl} ~ ${usl}`;
  if (usl != null) return `${usl} 이하`;
  if (lsl != null) return `${lsl} 이상`;
  return '없음';
}

function Conditions({ code }: { code: string }) {
  const def = STATIONS[code];
  const live = useLive((s) => s.stations[code]);
  const rows = [
    ...def.tags.map((t) => ({
      key: t.key, name: t.name, unit: t.unit, digits: t.digits, nominal: t.nominal, sd: t.sd, lsl: t.lsl, usl: t.usl,
      v: t.mode === 'cycle' ? (live?.last?.values[t.key] ?? live?.tags[t.key]) : live?.tags[t.key],
      note: t.mode === 'cycle' ? '가공마다' : '연속',
    })),
    ...(def.measures ?? []).map((m) => ({
      key: m.key, name: m.name, unit: m.unit, digits: m.digits, nominal: m.base, sd: m.sd, lsl: m.lsl, usl: m.usl,
      v: live?.last?.values[m.key], note: '검사값',
    })),
  ];
  const outs = rows.filter((r) => r.v != null && ((r.lsl != null && r.v < r.lsl) || (r.usl != null && r.v > r.usl))).length;
  const hasValue = rows.some((r) => r.v != null);
  return (
    <Card
      title="공정 조건"
      className="order-5"
      right={
        outs ? (
          <span className="rounded bg-down/15 px-2 py-0.5 text-sm text-down">범위 이탈 {outs}</span>
        ) : hasValue ? (
          <span className="text-sm text-run">모두 범위 안</span>
        ) : (
          <span className="text-sm text-dim">값을 기다리는 중</span>
        )
      }
    >
      <div className="divide-y divide-line">
        {rows.map((r) => {
          const out = r.v != null && ((r.lsl != null && r.v < r.lsl) || (r.usl != null && r.v > r.usl));
          return (
            <div key={r.key} className="py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-base">
                  {r.name} <span className="text-xs text-dim">{r.note}</span>
                </span>
                <span className={cx('num shrink-0 text-2xl font-semibold', out && 'text-down')}>
                  {num(r.v, r.digits)} <span className="text-sm font-normal text-sub">{r.unit}</span>
                </span>
              </div>
              <div className="mt-1">
                <SpecBar v={r.v} nominal={r.nominal} sd={r.sd} lsl={r.lsl} usl={r.usl} />
              </div>
              <div className="mt-0.5 text-xs text-dim">
                기준 {r.nominal} · 관리 범위 {rangeText(r.lsl, r.usl)}
                {out && <span className="ml-2 font-semibold text-down">범위를 벗어났습니다</span>}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ───────────── 조작 (비가동 사유) ─────────────

const SHEET_TITLE: Record<OperatorStopKind, { title: string; desc: string; op: StationOp; tone: string }> = {
  stop: { title: '계획 정지', desc: '계획된 정지입니다. OEE 계획 시간에서 빠집니다.', op: 'stop', tone: 'border-white/30 bg-white/10' },
  setup: { title: '셋업 시작', desc: '품종·금형 교체 같은 준비 작업입니다. 가동률 손실로 잡힙니다.', op: 'setup', tone: 'border-info/50 bg-info/15 text-info' },
  fail: { title: '고장 등록', desc: '설비 이상으로 세웁니다. 알람이 올라가고 수리 완료를 누를 때까지 멈춥니다.', op: 'fail', tone: 'border-down/50 bg-down/15 text-down' },
};

function Confirm({ label, onConfirm, pending, items, check, tone }: { label: string; onConfirm: () => void; pending: boolean; items: string[]; check: string; tone: string }) {
  const [ok, setOk] = useState(false);
  return (
    <>
      {items.length > 0 && (
        <ul className="scroll-thin mb-3 max-h-[38vh] space-y-1.5 overflow-y-auto rounded-lg border border-line bg-white/[0.03] p-3 text-base leading-snug">
          {items.map((t) => (
            <li key={t} className="flex gap-2">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-warn" />
              {t}
            </li>
          ))}
        </ul>
      )}
      <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border border-line px-3 text-base">
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} className="size-6 accent-[#3ddc84]" />
        {check}
      </label>
      <button disabled={!ok || pending} onClick={onConfirm} className={cx('mt-3 h-16 w-full rounded-xl border text-xl font-semibold disabled:opacity-40', tone)}>
        {pending ? '명령 보내는 중…' : label}
      </button>
    </>
  );
}

function ReasonPicker({ kind, onPick, pending }: { kind: OperatorStopKind; onPick: (reason: string) => void; pending: boolean }) {
  const [other, setOther] = useState('');
  return (
    <>
      <div className="text-sm text-sub">사유를 고르세요</div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {OPERATOR_REASONS[kind].map((r) => (
          <button key={r} disabled={pending} onClick={() => onPick(r)} className={cx('min-h-16 rounded-xl border px-3 text-lg font-medium disabled:opacity-40', SHEET_TITLE[kind].tone)}>
            {r}
          </button>
        ))}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (other.trim()) onPick(other.trim());
        }}
      >
        <input
          value={other}
          onChange={(e) => setOther(e.target.value.slice(0, REASON_MAX))}
          placeholder="기타 사유 직접 입력"
          aria-label="기타 사유"
          className="h-14 min-w-0 flex-1 rounded-xl border border-line bg-white/[0.04] px-3 text-base outline-none placeholder:text-dim focus:border-info/60"
        />
        <button disabled={!other.trim() || pending} className="h-14 shrink-0 rounded-xl border border-line bg-white/10 px-4 text-base disabled:opacity-40">
          이 사유로
        </button>
      </form>
    </>
  );
}

function Actions({ code, safety, troubleN, docId }: { code: string; safety: string[]; troubleN?: number; docId?: string }) {
  const state = useLive((s) => s.stations[code]?.state ?? 'IDLE');
  const connected = useLive((s) => s.simConnected);
  const { readOnly } = useAccess();
  // 조작 가능: 시뮬레이터가 붙어 있고, 공개 링크(보기 전용)가 아닐 때
  const sim = connected && !readOnly;
  // 역할 권한 (P9): 정지·셋업·재가동·고장 등록 = station.op, 수리 완료 = station.repair (보전).
  // useGate가 보기 전용 → 로그인 → 권한 순으로 판단해 막힌 이유(title)를 준다 — 서버 403과 같은 기준
  const opGate = useGate('station.op');
  const repairGate = useGate('station.repair');
  const openStandard = useAssistant((s) => s.openStandard);
  const [sheet, setSheet] = useState<Sheet>(null);
  const op = useMutation({
    mutationFn: (x: { op: StationOp; reason?: string }) => simCommand({ action: 'station', code, op: x.op, reason: x.reason }),
    onSuccess: () => setSheet(null),
  });
  const close = () => {
    setSheet(null);
    op.reset();
  };
  const running = state === 'RUN' || state === 'IDLE' || state === 'BLOCKED';
  const big = 'flex min-h-20 flex-col items-center justify-center rounded-xl border px-2 text-xl font-semibold disabled:opacity-40';

  return (
    <Card
      title="설비 조작"
      className="order-2"
      right={readOnly ? <span className="text-sm text-warn">보기 전용</span> : !connected && <span className="text-sm text-warn">시뮬레이터 연결 대기</span>}
    >
      {running && (
        <div className="grid grid-cols-3 gap-2">
          {(['stop', 'setup', 'fail'] as const).map((k) => (
            <button key={k} disabled={!sim || !opGate.ok} title={opGate.title} onClick={() => setSheet({ kind: k })} className={cx(big, SHEET_TITLE[k].tone)}>
              {SHEET_TITLE[k].title}
              <span className="mt-0.5 text-xs font-normal opacity-80">사유 선택</span>
            </button>
          ))}
        </div>
      )}
      {(state === 'STOP' || state === 'SETUP') && (
        <button disabled={!sim || !opGate.ok} title={opGate.title} onClick={() => setSheet({ kind: 'start' })} className={cx(big, 'w-full border-run/50 bg-run/15 text-run')}>
          재가동
        </button>
      )}
      {state === 'DOWN' && (
        <div className="grid grid-cols-2 gap-2">
          <button disabled={!sim || !repairGate.ok} title={repairGate.title} onClick={() => setSheet({ kind: 'repair' })} className={cx(big, 'border-run/50 bg-run/15 text-run')}>
            수리 완료
            <span className="mt-0.5 text-xs font-normal opacity-80">{repairGate.ok || repairGate.readOnly ? '안전 확인 후' : '보전 담당 권한'}</span>
          </button>
          <button disabled={!docId} onClick={() => docId && openStandard({ id: docId, n: troubleN })} className={cx(big, 'border-line bg-white/5')}>
            조치 방법
            <span className="mt-0.5 text-xs font-normal text-sub">작업표준서{troubleN ? ` §${troubleN}` : ''}</span>
          </button>
        </div>
      )}
      <p className="mt-2 text-xs text-dim">
        {readOnly
          ? '공개 링크는 보기 전용이라 조작 버튼이 잠겨 있습니다. 시연자 화면에서 누르면 사유가 설비 상태 이력(MES)에 남고 여기에도 바로 보입니다.'
          : '가상 PLC에 명령을 보냅니다. 고른 사유는 설비 상태 이력(MES)에 남고 3D 화면·AI 비서에도 보입니다.'}
      </p>
      {op.error && !sheet && <div className="mt-1 text-sm text-down">{(op.error as Error).message}</div>}

      {sheet && sheet.kind !== 'start' && sheet.kind !== 'repair' && (
        <BottomSheet title={SHEET_TITLE[sheet.kind].title} desc={SHEET_TITLE[sheet.kind].desc} onClose={close}>
          <ReasonPicker kind={sheet.kind} pending={op.isPending} onPick={(reason) => op.mutate({ op: SHEET_TITLE[sheet.kind as OperatorStopKind].op, reason })} />
          {op.error && <div className="mt-2 text-sm text-down">{(op.error as Error).message}</div>}
        </BottomSheet>
      )}
      {sheet?.kind === 'repair' && (
        <BottomSheet title="수리 완료" desc="설비를 다시 돌리기 전에 작업표준서의 안전 항목을 확인하세요." onClose={close}>
          <Confirm
            items={safety}
            check="안전 항목을 확인했고, 설비 안에 사람·공구가 없습니다"
            label="수리 완료 · 재가동"
            tone="border-run/50 bg-run/20 text-run"
            pending={op.isPending}
            onConfirm={() => op.mutate({ op: 'repair' })}
          />
          {op.error && <div className="mt-2 text-sm text-down">{(op.error as Error).message}</div>}
        </BottomSheet>
      )}
      {sheet?.kind === 'start' && (
        <BottomSheet title="재가동" desc={state === 'SETUP' ? '셋업을 끝내고 다시 돌립니다. 초품 확인을 마쳤는지 보세요.' : '계획 정지를 풀고 다시 돌립니다.'} onClose={close}>
          <Confirm
            items={[]}
            check="설비 안에 사람·공구가 없고 덮개·안전문이 닫혀 있습니다"
            label="재가동"
            tone="border-run/50 bg-run/20 text-run"
            pending={op.isPending}
            onConfirm={() => op.mutate({ op: 'start' })}
          />
          {op.error && <div className="mt-2 text-sm text-down">{(op.error as Error).message}</div>}
        </BottomSheet>
      )}
    </Card>
  );
}

// ───────────── 묻기 ─────────────

function Ask({ code }: { code: string }) {
  const state = useLive((s) => s.stations[code]?.state);
  const path = usePathname();
  const askByVoice = useUi((s) => s.askByVoice);
  const setOpen = useUi((s) => s.setAssistantOpen);
  const busy = useAssistant((s) => s.busy);
  const send = useAssistant((s) => s.send);
  const quick = [
    state === 'DOWN' ? '이 설비 고장 조치 방법 알려 줘' : '이 설비 지금 상태 알려 줘',
    '이 설비 불량 원인이 뭐야?',
    '이 설비 작업 순서 알려 줘',
  ];
  const ask = (q: string) => {
    setOpen(true);
    if (!busy) void send(q, pageContext(path, null));
  };
  return (
    <Card title="AI 비서에게 묻기" className="order-3">
      <button onClick={askByVoice} className="flex min-h-20 w-full items-center justify-center gap-3 rounded-xl border border-info/50 bg-info/15 text-xl font-semibold text-info hover:bg-info/25">
        <MicIcon />
        말로 묻기
      </button>
      <p className="mt-1.5 text-xs text-dim">누르면 비서 창이 열리고 바로 듣습니다. 서버 받아쓰기는 말한 뒤 마이크를 한 번 더 누르고, 브라우저 음성 인식은 말을 멈추면 끝납니다.</p>
      <div className="mt-3 flex flex-col gap-2">
        {quick.map((q) => (
          <button key={q} disabled={busy} onClick={() => ask(q)} className="min-h-12 rounded-lg border border-line bg-white/[0.03] px-3 text-left text-base hover:bg-white/[0.08] disabled:opacity-40">
            {q}
          </button>
        ))}
      </div>
    </Card>
  );
}

// ───────────── 알람 ─────────────

function StationAlarms({ code }: { code: string }) {
  const alarms = useLive((s) => s.alarms);
  const ackLocal = useLive((s) => s.ackLocal);
  const ackGate = useGate('alarm.ack');
  const mine = alarms.filter((a) => a.station === code);
  const open = mine.filter((a) => !a.acked);
  const shown = [...open, ...mine.filter((a) => a.acked)].slice(0, 5);
  const ack = async (id: number) => {
    ackLocal(id);
    await api.post(`/live/alarms/${id}/ack`).catch(() => {});
  };
  const sev = { critical: 'bg-down', warn: 'bg-warn', info: 'bg-info' } as const;
  return (
    <Card title="이 설비 알람" className="order-4" right={<span className={cx('text-sm', open.length ? 'text-warn' : 'text-sub')}>미확인 {open.length}건</span>}>
      {shown.length === 0 && <div className="py-2 text-base text-dim">알람이 없습니다</div>}
      <div className="divide-y divide-line">
        {shown.map((a) => (
          <div key={a.id} className={cx('flex items-center gap-3 py-2.5', a.acked && 'opacity-50')}>
            <span className={cx('h-10 w-1.5 shrink-0 rounded', sev[a.severity])} />
            <div className="min-w-0 flex-1">
              <div className="num text-xs text-dim">{kst(a.t)}</div>
              <div className="text-base leading-snug">{a.title}</div>
              {a.detail && <div className="text-sm leading-snug text-sub">{a.detail}</div>}
            </div>
            {!a.acked && !ackGate.readOnly && (
              <button
                disabled={!ackGate.ok}
                title={ackGate.title}
                onClick={() => ack(a.id)}
                className="h-12 shrink-0 rounded-lg border border-line bg-white/10 px-4 text-base hover:bg-white/20 disabled:opacity-40"
              >
                확인
              </button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ───────────── 작업 전 점검 ─────────────

function Checklist({ code, items, docId, loading }: { code: string; items: string[]; docId?: string; loading: boolean }) {
  const qc = useQueryClient();
  const simT = useLive((s) => s.sim?.t);
  const [answers, setAnswers] = useState<Record<number, boolean>>({});
  const [by, setBy] = useState('');
  const [saved, setSaved] = useState<CheckRecordView | null>(null);
  const recordGate = useGate('check.record');
  useEffect(() => setBy(remembered.by()), []);
  useEffect(() => {
    setAnswers({});
    setSaved(null);
  }, [code]);
  const history = useQuery({
    queryKey: ['checks', code],
    queryFn: () => api.get<CheckRecordView[]>(`/operator/checks?station=${encodeURIComponent(code)}&limit=3`),
    refetchInterval: 30_000,
  });
  const save = useMutation({
    mutationFn: (body: CheckRequest) => api.post<CheckRecordView>('/operator/checks', body),
    onSuccess: (r) => {
      setSaved(r);
      setAnswers({});
      remembered.setBy(by.trim());
      void qc.invalidateQueries({ queryKey: ['checks', code] });
    },
  });
  const done = items.filter((_, i) => answers[i] !== undefined).length;
  const last = history.data?.[0];
  const ago = last && simT ? (Date.parse(simT) - Date.parse(last.at)) / 1000 : NaN;

  return (
    <Card
      title="작업 전 점검"
      className="order-6"
      right={
        last ? (
          <span className={cx('text-sm', last.ngCount ? 'text-warn' : 'text-run')}>
            최근 {kst(last.at).slice(0, 5)}
            {Number.isFinite(ago) ? ` (${duration(ago)} 전)` : ''} · {last.ngCount ? `이상 ${last.ngCount}건` : '이상 없음'}
          </span>
        ) : (
          <span className="text-sm text-warn">이번 실행에서 아직 안 함</span>
        )
      }
    >
      {loading && <div className="text-base text-dim">작업표준서를 불러오는 중…</div>}
      {!loading && items.length === 0 && <div className="text-base text-dim">이 설비의 작업표준서에 작업 전 점검 항목이 없습니다.</div>}
      {items.length > 0 && (
        <>
          <p className="text-xs text-dim">
            항목은 작업표준서 {docId}의 &ldquo;작업 전 점검&rdquo; 절에서 가져왔습니다. 이상으로 표시하면 MES 알람이 올라갑니다.
          </p>
          <div className="mt-1 divide-y divide-line">
            {items.map((t, i) => (
              <div key={t} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                <p className="min-w-[12rem] flex-1 text-base leading-snug">{t}</p>
                <div className="flex shrink-0 gap-1.5" role="group" aria-label={`점검 항목 ${i + 1}`}>
                  <button
                    aria-pressed={answers[i] === true}
                    onClick={() => setAnswers((a) => ({ ...a, [i]: true }))}
                    className={cx('h-12 rounded-lg border px-3 text-base', answers[i] === true ? 'border-run/60 bg-run/20 font-semibold text-run' : 'border-line bg-white/[0.03] text-sub')}
                  >
                    이상 없음
                  </button>
                  <button
                    aria-pressed={answers[i] === false}
                    onClick={() => setAnswers((a) => ({ ...a, [i]: false }))}
                    className={cx('h-12 rounded-lg border px-3 text-base', answers[i] === false ? 'border-down/60 bg-down/20 font-semibold text-down' : 'border-line bg-white/[0.03] text-sub')}
                  >
                    이상
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={by}
              onChange={(e) => setBy(e.target.value.slice(0, 30))}
              placeholder="점검자 (선택)"
              aria-label="점검자"
              className="h-14 w-40 min-w-0 flex-1 rounded-xl border border-line bg-white/[0.04] px-3 text-base outline-none placeholder:text-dim focus:border-info/60 sm:flex-none"
            />
            <button
              disabled={done < items.length || save.isPending || !recordGate.ok}
              title={recordGate.title}
              onClick={() => save.mutate({ station: code, doc: docId ?? null, by: by.trim() || null, items: items.map((text, i) => ({ text, ok: answers[i] === true })) })}
              className="h-14 flex-1 rounded-xl border border-info/50 bg-info/20 px-4 text-lg font-semibold text-info disabled:opacity-40"
            >
              {recordGate.readOnly
                ? '보기 전용 (기록 안 됨)'
                : !recordGate.ok
                  ? '점검 기록 권한 없음'
                  : save.isPending
                    ? '기록하는 중…'
                    : `점검 결과 기록 (${done}/${items.length})`}
            </button>
          </div>
          {save.error && <div className="mt-2 text-sm text-down">{(save.error as Error).message}</div>}
          {saved && (
            <div className={cx('mt-2 rounded-lg px-3 py-2 text-base', saved.ngCount ? 'bg-warn/15 text-warn' : 'bg-run/15 text-run')}>
              {kst(saved.at)}에 기록했습니다{saved.ngCount ? ` · 이상 ${saved.ngCount}건으로 알람을 올렸습니다` : ' · 모두 이상 없음'}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ───────────── 작업표준서 ─────────────

function Standard({ meta, section }: { meta?: { id: string; title: string; revision: string | null }; section: Record<'safety' | 'precheck' | 'steps' | 'trouble', number | undefined> }) {
  const openStandard = useAssistant((s) => s.openStandard);
  const buttons: [string, number | undefined][] = [
    ['전체 보기', undefined],
    ['안전', section.safety],
    ['작업 순서', section.steps],
    ['이상 발생 시 조치', section.trouble],
  ];
  return (
    <Card title="작업표준서" className="order-7">
      {!meta ? (
        <div className="text-base text-dim">이 설비를 다루는 작업표준서가 없습니다. AI 비서에게 공통 표준(설비 보전·SPC)을 물어보세요.</div>
      ) : (
        <>
          <div className="text-base">
            <span className="num text-info">{meta.id}</span> {meta.title}
            {meta.revision && <span className="text-sm text-dim"> · 개정 {meta.revision}</span>}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {buttons
              .filter(([, n], i) => i === 0 || n != null)
              .map(([label, n]) => (
                <button key={label} onClick={() => openStandard({ id: meta.id, n })} className="min-h-14 rounded-lg border border-line bg-white/[0.03] px-3 text-base hover:bg-white/[0.08]">
                  {label}
                  {n != null && <span className="ml-1 text-sm text-dim">§{n}</span>}
                </button>
              ))}
          </div>
        </>
      )}
    </Card>
  );
}

// ───────────── 최근 가공 ─────────────

function RecentUnits({ code }: { code: string }) {
  const units = useLive((s) => s.units);
  const openTrace = useLive((s) => s.openTrace);
  const mine = units.filter((u) => u.station === code).slice(0, 6);
  return (
    <Card title="최근 가공" className="order-8">
      {mine.length === 0 && <div className="text-base text-dim">이 화면을 연 뒤로 아직 없습니다</div>}
      <div className="divide-y divide-line">
        {mine.map((u) => (
          <button key={`${u.serial}${u.t}`} onClick={() => openTrace(u.serial)} className="flex min-h-12 w-full items-center gap-3 py-2 text-left text-base hover:bg-white/[0.04]">
            <span className="num w-20 text-sub">{kst(u.t)}</span>
            <span className="num text-info">{u.serial}</span>
            <span className={cx('ml-auto font-semibold', u.result === 'NG' ? 'text-down' : 'text-run')}>
              {u.result}
              {u.defect ? ` · ${defectName(u.defect)}` : ''}
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

// ───────────── 화면 ─────────────

function Header({ code }: { code: string }) {
  const def = STATIONS[code];
  const line = LINES.find((l) => l.code === def.line);
  const simT = useLive((s) => s.sim?.t);
  const socket = useLive((s) => s.socket);
  const sim = useLive((s) => s.simConnected);
  const select = useLive((s) => s.select);
  const open = useUi((s) => s.assistantOpen);
  const setOpen = useUi((s) => s.setAssistantOpen);
  const router = useRouter();
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b border-line px-2 sm:gap-3 sm:px-3" style={{ background: 'var(--color-panel-solid)' }}>
      <Link href="/operator" className="flex h-12 shrink-0 items-center rounded-lg border border-line bg-white/5 px-3 text-base hover:bg-white/10" title="다른 설비 고르기">
        ← <span className="ml-1 hidden sm:inline">설비 바꾸기</span>
      </Link>
      <span className="h-10 w-1.5 shrink-0 rounded" style={{ background: line?.color }} />
      <div className="min-w-0 flex-1">
        <div className="num truncate text-xs text-sub">
          {code} · {line?.short}
        </div>
        <h1 className="truncate text-xl leading-tight font-semibold">{def.name}</h1>
      </div>
      <div className="hidden shrink-0 text-right md:block">
        <div className="num text-2xl leading-none font-semibold">{kst(simT)}</div>
        <div className="mt-1 flex items-center justify-end gap-2 text-xs text-sub">
          <span className={cx('size-2 rounded-full', socket ? 'bg-run' : 'bg-down blink')} />
          MES
          <span className={cx('size-2 rounded-full', sim ? 'bg-run' : 'bg-down blink')} />
          엣지
        </div>
      </div>
      <AccessBadge size="lg" />
      <button
        onClick={() => {
          select(code);
          router.push('/');
        }}
        className="hidden h-12 shrink-0 rounded-lg border border-line bg-white/5 px-3 text-base hover:bg-white/10 lg:block"
      >
        3D에서 보기
      </button>
      <button
        onClick={() => setOpen(!open)}
        aria-pressed={open}
        className={cx('h-12 shrink-0 rounded-lg border px-3 text-base', open ? 'border-info/60 bg-info/20 text-info' : 'border-line bg-white/5 hover:bg-white/10')}
      >
        AI 비서
      </button>
    </header>
  );
}

/**
 * 작업자 태블릿 화면: 설비 한 대 앞에서 쓰는 큰 글씨·큰 버튼 화면.
 * 가로(태블릿 가로·PC)에서는 두 단, 세로에서는 한 단으로 접는다. 한 단일 때는 조작·질문이 상태 바로 아래 오게 순서를 바꾼다.
 */
export function OperatorScreen({ code }: { code: string }) {
  const def = STATIONS[code];
  const socket = useLive((s) => s.socket);
  const sim = useLive((s) => s.simConnected);
  const assistant = useUi((s) => s.assistantOpen);
  const std = useStationStandard(def ? code : null);
  useEffect(() => {
    if (def) remembered.setStation(code);
  }, [code, def]);

  if (!def) {
    return (
      <main className="flex h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-lg">설비 {code}을(를) 찾을 수 없습니다.</p>
        <Link href="/operator" className="flex h-12 items-center rounded-lg border border-line bg-white/5 px-4 text-base hover:bg-white/10">
          설비 고르기
        </Link>
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col">
      <Header code={code} />
      <div className={cx('scroll-thin min-h-0 flex-1 overflow-y-auto', assistant && 'lg:pr-[448px]')}>
        <div className="@container mx-auto max-w-[1400px] p-3 pb-10">
          {(!socket || !sim) && (
            <div className="mb-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-base">
              {!socket ? 'MES 서버에 연결하는 중입니다.' : '시뮬레이터(가상 엣지)가 연결되지 않았습니다. 설비 조작은 연결된 뒤에 할 수 있습니다.'}
            </div>
          )}
          <div className="flex flex-col gap-3 @4xl:grid @4xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] @4xl:items-start">
            <div className="contents @4xl:flex @4xl:flex-col @4xl:gap-3">
              <StateHero code={code} />
              <Conditions code={code} />
              <Checklist code={code} items={std.precheck} docId={std.meta?.id} loading={std.loading} />
            </div>
            <div className="contents @4xl:flex @4xl:flex-col @4xl:gap-3">
              <Actions code={code} safety={std.safety} troubleN={std.section.trouble} docId={std.meta?.id} />
              <Ask code={code} />
              <OperatorQuality code={code} className="order-4" />
              <StationAlarms code={code} />
              <Standard meta={std.meta} section={std.section} />
              <RecentUnits code={code} />
            </div>
          </div>
          <p className="mt-4 text-center text-xs text-dim">공개 자료를 바탕으로 만든 가상 공장의 시연 화면입니다. SL과 무관한 개인 프로젝트입니다.</p>
        </div>
      </div>
    </main>
  );
}
