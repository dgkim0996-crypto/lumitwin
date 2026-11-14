'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  SHIFT_NAMES,
  TBM_AUDIO_MAX_BYTES,
  TBM_FOLLOWUP_NAMES,
  TBM_JOB_NAMES,
  TBM_SOURCE_NAMES,
  TBM_STATUS_NAMES,
  TBM_TEXT_MAX_BYTES,
  lineOf,
  shiftByKey,
  shiftOf,
  type LineCode,
  type TbmChecklistView,
  type TbmFollowUpKind,
  type TbmItem,
  type TbmItemResult,
  type TbmItemSource,
  type TbmMeetingDetail,
  type TbmMeetingView,
  type TbmStatus,
} from '@lumitwin/shared';
import { ModeBadge } from '@/components/assistant/ModeBadge';
import { Empty } from '@/components/charts/kit';
import { LineSwitcher, PageShell } from '@/components/mes/PageShell';
import { TbmRecorder } from '@/components/tbm/TbmRecorder';
import { useGate } from '@/lib/auth';
import { GRADE_LABEL, cx, kst } from '@/lib/format';
import { JOB_TONE, TBM_TONE, fetchTbmSample, isBusy, useTbmChecklist, useTbmFollowUp, useTbmMeeting, useTbmMeetings, useTbmUpload } from '@/lib/tbm';
import { useUi } from '@/lib/ui';

const TEXT_EXT = /\.(txt|text|md|vtt|srt)$/i;
const SOURCE_TONE: Record<TbmItemSource, string> = { CLIENT: 'text-info', SAFETY: 'text-warn', MES: 'text-run' };
const STATUS_ORDER: TbmStatus[] = ['MISSING', 'UNCERTAIN', 'PARTIAL', 'COVERED'];

const shiftLabel = (key: string) => {
  const s = shiftByKey(key);
  return s ? `${s.date.slice(5)} ${SHIFT_NAMES[s.code]}` : key;
};
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
const sec = (ms: number | null) => (ms == null ? '−' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}초`);

/** 올릴 것 (파일·녹음·예시 대화록) */
interface Pending {
  input: 'TEXT' | 'AUDIO';
  name: string;
  size: number;
  file?: File;
  text?: string;
  from: 'file' | 'record' | 'sample';
}

function Chip({ tone, children, title }: { tone: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[11px] whitespace-nowrap', tone)}>
      {children}
    </span>
  );
}

function Card({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('card min-w-0 p-3', className)}>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export default function TbmPage() {
  const line = useUi((s) => s.line) as LineCode;
  const checklist = useTbmChecklist(line);
  const meetings = useTbmMeetings(line);
  const [selected, setSelected] = useState<number | null>(null);
  const [shift, setShift] = useState<string | null>(null);

  // 라인을 바꾸면 그 라인의 가장 최근 회의를 고른다
  useEffect(() => setSelected(null), [line]);
  useEffect(() => {
    if (selected == null && meetings.data?.length) setSelected(meetings.data[0].id);
  }, [meetings.data, selected]);

  const c = checklist.data;
  const curShift = c?.shift ?? null;
  const shifts = useMemo(() => {
    if (!curShift) return [];
    const out = [curShift];
    let s = shiftByKey(curShift);
    for (let i = 0; i < 3 && s; i++) {
      s = shiftOf(Date.parse(s.start) - 1);
      out.push(s.key);
    }
    return out;
  }, [curShift]);

  return (
    <PageShell
      title="TBM 점검"
      desc="작업 전 안전 회의(TBM) 녹음이나 대화록을 올리면, 원청·안전팀 항목과 오늘 MES 상태(고장 설비·Hold·초물 대기·예지 보전)에서 만든 항목에 대조해 다룸·부분·안 다룸과 근거 문장을 보여 줍니다. 빠진 항목은 알람으로 올리고, 조장이 보완·확인을 체크하면 감사 기록에 남습니다."
      filters={
        <>
          <LineSwitcher />
          <label className="flex items-center gap-1.5 text-xs text-sub">
            교대
            <select
              aria-label="교대"
              value={shift ?? curShift ?? ''}
              onChange={(e) => setShift(e.target.value)}
              className="rounded border border-line bg-white/5 px-2 py-1.5 text-xs text-ink"
            >
              {shifts.map((k, i) => (
                <option key={k} value={k} className="bg-[#0e1622]">
                  {shiftLabel(k)}
                  {i === 0 ? ' (지금)' : ''}
                </option>
              ))}
            </select>
          </label>
          {c && (
            <span className="flex items-center gap-1.5 text-xs text-sub">
              판정 <ModeBadge mode={c.mode} model={c.model} />
            </span>
          )}
          {c && (
            <span className={cx('text-xs', c.stt ? 'text-sub' : 'text-dim')} title={c.stt ? '서버 받아쓰기(Whisper)가 켜져 있어 음성을 올릴 수 있습니다' : 'STT_BASE_URL이 없거나 받아쓰기 서버가 꺼져 있습니다 (npm run whisper)'}>
              받아쓰기 {c.stt ? '켜짐' : '꺼짐 · 대화록(.txt)만'}
            </span>
          )}
        </>
      }
    >
      <div className="grid gap-3 @5xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="min-w-0 space-y-3">
          <UploadCard line={line} shift={shift ?? curShift} checklist={c} onUploaded={(id) => setSelected(id)} />
          <ChecklistCard checklist={c} loading={checklist.isPending} />
        </div>
        <div className="min-w-0 space-y-3">
          <MeetingList meetings={meetings.data ?? []} selected={selected} onSelect={setSelected} loading={meetings.isPending} />
          {selected != null && <MeetingDetail id={selected} />}
        </div>
      </div>
    </PageShell>
  );
}

// ─────────────────────────── 올리기 ───────────────────────────

function UploadCard({ line, shift, checklist, onUploaded }: { line: LineCode; shift: string | null; checklist?: TbmChecklistView; onUploaded: (id: number) => void }) {
  const gate = useGate('tbm.record');
  const upload = useTbmUpload();
  const [pending, setPending] = useState<Pending | null>(null);
  const [mode, setMode] = useState<'file' | 'record'>('file');
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const stt = checklist?.stt ?? false;

  useEffect(() => {
    setPending(null);
    setErr(null);
  }, [line]);

  const pick = (f: File | null | undefined, from: Pending['from'] = 'file') => {
    setErr(null);
    if (!f) return;
    const isText = TEXT_EXT.test(f.name) || f.type.startsWith('text/');
    if (isText) {
      if (f.size > TBM_TEXT_MAX_BYTES) return setErr(`대화록 파일은 ${TBM_TEXT_MAX_BYTES / 1024}KB 이하여야 합니다`);
      setPending({ input: 'TEXT', name: f.name, size: f.size, file: f, from });
      return;
    }
    if (!/^(audio|video)\//.test(f.type) && !/\.(webm|weba|ogg|oga|opus|mp3|mpga|m4a|mp4|aac|wav|flac)$/i.test(f.name)) {
      return setErr('대화록(.txt·.vtt·.srt) 또는 음성 파일만 올릴 수 있습니다');
    }
    if (f.size > TBM_AUDIO_MAX_BYTES) return setErr(`음성 파일은 ${TBM_AUDIO_MAX_BYTES / 1024 / 1024}MB 이하여야 합니다 (받아쓰기 서버 한도). 녹음을 나눠 올려 주세요`);
    if (!stt) return setErr('받아쓰기 서버가 꺼져 있어 음성은 올릴 수 없습니다. 대화록 텍스트 파일(.txt)로 올려 주세요');
    setPending({ input: 'AUDIO', name: f.name, size: f.size, file: f, from });
  };

  const sample = async () => {
    setErr(null);
    try {
      const s = await fetchTbmSample(line);
      setPending({ input: 'TEXT', name: s.fileName, size: new Blob([s.text]).size, text: s.text, from: 'sample' });
      setPreview(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const submit = async () => {
    if (!pending) return;
    setErr(null);
    const form = new FormData();
    form.append('line', line);
    if (shift) form.append('shift', shift);
    if (pending.file) form.append('file', pending.file, pending.name);
    else if (pending.text != null) {
      form.append('text', pending.text);
      form.append('fileName', pending.name);
    }
    try {
      const m = await upload.mutateAsync(form);
      setPending(null);
      setPreview(false);
      if (input.current) input.current.value = '';
      onUploaded(m.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const tab = (on: boolean) => cx('px-3 py-1.5', on ? 'bg-white/15 text-ink' : 'text-sub hover:bg-white/10');

  return (
    <Card
      title={`회의 올리기 · ${lineOf(line).name}`}
      right={
        <div role="group" aria-label="올리는 방법" className="flex overflow-hidden rounded-md border border-line text-xs">
          <button type="button" aria-pressed={mode === 'file'} className={tab(mode === 'file')} onClick={() => setMode('file')}>
            파일
          </button>
          <button type="button" aria-pressed={mode === 'record'} className={tab(mode === 'record')} onClick={() => setMode('record')}>
            브라우저 녹음
          </button>
        </div>
      }
    >
      {mode === 'file' ? (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            pick(e.dataTransfer.files?.[0]);
          }}
          className="rounded-md border border-dashed border-line bg-white/[0.02] p-3 text-center"
        >
          <input
            ref={input}
            data-testid="tbm-file"
            type="file"
            accept=".txt,.vtt,.srt,.md,text/plain,audio/*,video/webm,video/mp4"
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          <button type="button" onClick={() => input.current?.click()} className="rounded-md border border-info/50 bg-info/10 px-3 py-1.5 text-sm text-info hover:bg-info/20">
            파일 고르기
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-dim">
            대화록 .txt·.vtt·.srt ({TBM_TEXT_MAX_BYTES / 1024}KB까지) · 음성 .webm·.m4a·.mp3·.wav 등 ({TBM_AUDIO_MAX_BYTES / 1024 / 1024}MB까지, 받아쓰기 서버 필요)
            <br />
            여기에 끌어다 놓아도 됩니다. 한 줄에 한 사람의 말이면 근거를 가리키기 좋습니다.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-line bg-white/[0.02] p-3">
          <TbmRecorder
            disabled={!stt}
            title={stt ? undefined : '받아쓰기 서버가 꺼져 있어 녹음을 받아쓸 수 없습니다 (npm run whisper)'}
            onDone={(f) => pick(f, 'record')}
          />
          <p className="mt-2 text-[11px] text-dim">녹음은 이 브라우저에만 있다가 올리면 서버가 받아쓰고, 음성 파일은 저장하지 않습니다(받아쓴 글만 남김).</p>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" data-testid="tbm-sample" onClick={sample} className="rounded-md border border-line px-2.5 py-1 text-xs text-sub hover:bg-white/10" title="일부 항목을 일부러 빠뜨리고, 판정기에게 지시하는 줄을 하나 넣은 예시">
          예시 대화록으로 해 보기
        </button>
        <span className="text-[11px] text-dim">판정기에게 지시하는 줄이 섞인 예시입니다 — 그 줄은 근거로 쓰지 않는 것을 볼 수 있습니다.</span>
      </div>

      {pending && (
        <div className="mt-3 rounded-md border border-info/30 bg-info/[0.06] p-2.5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Chip tone="border-line text-sub">{pending.input === 'TEXT' ? '대화록' : '음성'}</Chip>
            <span className="min-w-0 flex-1 truncate" title={pending.name}>
              {pending.name}
            </span>
            <span className="num text-xs text-dim">{kb(pending.size)}</span>
            {pending.text != null && (
              <button type="button" onClick={() => setPreview((p) => !p)} className="text-xs text-sub underline-offset-2 hover:underline">
                {preview ? '내용 접기' : '내용 보기'}
              </button>
            )}
          </div>
          {preview && pending.text != null && (
            <pre className="scroll-thin mt-2 max-h-48 overflow-auto rounded bg-black/30 p-2 text-[11.5px] leading-relaxed whitespace-pre-wrap text-sub">{pending.text}</pre>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="tbm-submit"
              onClick={submit}
              disabled={!gate.ok || upload.isPending}
              title={gate.title ?? '올리면 받아쓰기·대조를 서버에서 처리합니다 (감사 기록)'}
              className="rounded-md border border-run/50 bg-run/15 px-3 py-1.5 text-sm text-run hover:bg-run/25 disabled:opacity-40"
            >
              {upload.isPending ? '올리는 중…' : '올리고 대조하기'}
            </button>
            <button type="button" onClick={() => setPending(null)} className="rounded-md px-2 py-1.5 text-xs text-sub hover:bg-white/10">
              취소
            </button>
            {shift && <span className="text-[11px] text-dim">{shiftLabel(shift)} 교대 회의로 저장</span>}
          </div>
        </div>
      )}
      {err && <p className="mt-2 rounded border border-down/40 bg-down/10 px-2 py-1.5 text-xs text-down">{err}</p>}
      {!gate.ok && gate.title && <p className="mt-2 text-[11px] text-dim">{gate.title}</p>}
    </Card>
  );
}

// ─────────────────────────── 체크리스트 ───────────────────────────

function ChecklistCard({ checklist, loading }: { checklist?: TbmChecklistView; loading: boolean }) {
  const groups = useMemo(() => {
    const by = new Map<TbmItemSource, TbmItem[]>();
    for (const i of checklist?.items ?? []) by.set(i.source, [...(by.get(i.source) ?? []), i]);
    return (['CLIENT', 'SAFETY', 'MES'] as TbmItemSource[]).map((s) => ({ source: s, items: by.get(s) ?? [] }));
  }, [checklist]);
  return (
    <Card title={`오늘 체크리스트 ${checklist ? `· ${checklist.items.length}항목` : ''}`} right={checklist?.t && <span className="num text-[11px] text-dim">가상 {kst(checklist.t)}</span>}>
      {loading && !checklist ? (
        <Empty h={120}>체크리스트를 읽는 중…</Empty>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.source}>
              <div className={cx('mb-1 text-xs font-medium', SOURCE_TONE[g.source])}>
                {TBM_SOURCE_NAMES[g.source]} {g.source === 'MES' ? '(지금 MES 상태에서)' : ''} · {g.items.length}
              </div>
              {g.items.length === 0 ? (
                <p className="text-[11px] text-dim">{g.source === 'MES' ? '지금은 고장·Hold·초물 대기·예지 보전 경고·MRB 대기가 없어 자동 항목이 없습니다.' : '없음'}</p>
              ) : (
                <ul className="space-y-1">
                  {g.items.map((i) => (
                    <li key={i.code} className="flex items-start gap-2 text-[12.5px]" title={i.desc}>
                      <span className="mt-1 size-1.5 shrink-0 rounded-full bg-current opacity-50" />
                      <span className="min-w-0 flex-1">
                        {i.title}
                        <span className="block truncate text-[11px] text-dim">{i.desc}</span>
                      </span>
                      <span className="shrink-0 text-[10px]" style={{ color: GRADE_LABEL[i.grade].color }} title={GRADE_LABEL[i.grade].hint}>
                        {GRADE_LABEL[i.grade].text}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <p className="text-[11px] leading-relaxed text-dim">
            원청·안전팀 항목은 일반적인 제조 현장 TBM 관행에서 정한 가정값입니다. MES 자동 항목은 회의를 올리는 순간의 상태로 고정돼 회의 기록에 함께 저장됩니다.
          </p>
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────── 회의 목록 ───────────────────────────

function Counts({ m }: { m: TbmMeetingView }) {
  if (m.status !== 'DONE') return null;
  const c = m.counts;
  return (
    <span className="flex flex-wrap gap-1">
      <Chip tone={TBM_TONE.COVERED}>다룸 {c.covered}</Chip>
      {c.partial > 0 && <Chip tone={TBM_TONE.PARTIAL}>부분 {c.partial}</Chip>}
      {c.missing > 0 && <Chip tone={TBM_TONE.MISSING}>안 다룸 {c.missing}</Chip>}
      {c.uncertain > 0 && <Chip tone={TBM_TONE.UNCERTAIN}>불확실 {c.uncertain}</Chip>}
    </span>
  );
}

function MeetingList({ meetings, selected, onSelect, loading }: { meetings: TbmMeetingView[]; selected: number | null; onSelect: (id: number) => void; loading: boolean }) {
  return (
    <Card title={`회의 기록 · ${meetings.length}건`}>
      {loading && !meetings.length ? (
        <Empty h={80}>회의 기록을 읽는 중…</Empty>
      ) : !meetings.length ? (
        <Empty h={80}>아직 올린 회의가 없습니다. 왼쪽에서 대화록·녹음을 올리거나 예시 대화록으로 해 보세요.</Empty>
      ) : (
        <ul className="scroll-thin max-h-60 space-y-1 overflow-y-auto pr-1">
          {meetings.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                data-testid="tbm-meeting-row"
                data-id={m.id}
                data-status={m.status}
                onClick={() => onSelect(m.id)}
                className={cx('flex w-full flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs', selected === m.id ? 'border-info/50 bg-info/10' : 'border-line hover:bg-white/[0.06]')}
              >
                <span className="num text-sub">#{m.id}</span>
                <span>{shiftLabel(m.shift)}</span>
                <Chip tone="border-line text-sub">{m.input === 'TEXT' ? '대화록' : '음성'}</Chip>
                <Chip tone={JOB_TONE[m.status]}>{TBM_JOB_NAMES[m.status]}</Chip>
                <Counts m={m} />
                {m.status === 'DONE' && m.open > 0 && <span className="text-warn">확인 필요 {m.open}</span>}
                <span className="ml-auto text-dim">
                  {m.createdBy ?? '−'} · {kst(m.createdAt, true)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ─────────────────────────── 회의 상세 ───────────────────────────

function MeetingDetail({ id }: { id: number }) {
  const q = useTbmMeeting(id);
  const d = q.data;
  const [mark, setMark] = useState<number[]>([]);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => setMark([]), [id]);

  const show = (lines: number[]) => {
    setMark(lines);
    const el = box.current?.querySelector(`[data-n="${lines[0]}"]`) as HTMLElement | null;
    if (el && box.current) box.current.scrollTo({ top: el.offsetTop - box.current.offsetTop - 40, behavior: 'smooth' });
  };

  if (!d) return <Card title={`회의 #${id}`}>{q.isError ? <p className="text-xs text-down">{(q.error as Error).message}</p> : <Empty h={120}>읽는 중…</Empty>}</Card>;
  const items = [...d.items].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));

  return (
    <div data-testid="tbm-detail" data-id={d.id} data-status={d.status} className="space-y-3">
      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            회의 #{d.id} · {lineOf(d.line).name} · {shiftLabel(d.shift)}
            <Chip tone={JOB_TONE[d.status]}>{TBM_JOB_NAMES[d.status]}</Chip>
          </span>
        }
        right={<ModeBadge mode={d.mode} model={d.model} compact />}
      >
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-sub">
          <span>올린 사람 {d.createdBy ?? '−'}</span>
          <span>{d.input === 'TEXT' ? '대화록' : '음성'} {d.fileName ?? ''}</span>
          <span className="num">전사 {d.lineCount}줄</span>
          {d.status === 'DONE' && <span className="num">처리 {sec(d.ms)}{d.chunks > 1 ? ` · ${d.chunks}조각으로 나눠 판정` : ''}</span>}
          {d.alarmed && <span className="text-warn">알람 올림 (TBM 미흡)</span>}
        </div>
        {isBusy(d.status) && (
          <p className="mt-2 flex items-center gap-2 text-xs text-info">
            <span className="size-2 animate-pulse rounded-full bg-info" />
            {d.status === 'TRANSCRIBING' ? '받아쓰기 서버가 녹음을 글로 바꾸는 중입니다' : `${d.mode === 'mock' ? '규칙으로' : d.mode === 'local' ? '로컬 LLM이' : 'Claude가'} 체크리스트와 대조하는 중입니다`} — 이 화면을 닫아도 서버에서 계속합니다.
          </p>
        )}
        {d.status === 'FAILED' && <p className="mt-2 rounded border border-down/40 bg-down/10 px-2 py-1.5 text-xs text-down">{d.error}</p>}
        {d.status === 'DONE' && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Counts m={d} />
            {d.open > 0 ? <span className="text-xs text-warn">조장 확인 필요 {d.open}항목</span> : <span className="text-xs text-run">확인할 항목 없음</span>}
          </div>
        )}
      </Card>

      {d.status === 'DONE' && (
        <div className="grid gap-3 @3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card title="항목별 판정">
            <ul className="space-y-2">
              {items.map((i) => (
                <ItemRow key={i.code} meeting={d} item={i} onShow={show} active={mark.length > 0 && i.evidence.join() === mark.join()} />
              ))}
            </ul>
            {d.changes.length > 0 && (
              <details className="mt-3 text-[11.5px] text-sub">
                <summary className="cursor-pointer text-xs">검증기가 고친 것 {d.changes.length}건</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {d.changes.map((c, k) => (
                    <li key={k}>{c}</li>
                  ))}
                </ul>
              </details>
            )}
            <p className="mt-3 text-[11px] leading-relaxed text-dim">
              불확실 = 판정기가 다뤘다고 했지만 서버 검증기가 근거 줄에서 그 내용을 확인하지 못한 항목입니다. {d.mode === 'mock' && '모의 모드는 낱말 규칙이라 말을 바꿔 하면 놓칠 수 있습니다.'}
            </p>
          </Card>
          <Card title={`전사 · ${d.lines.length}줄`} right={mark.length > 0 && <button type="button" onClick={() => setMark([])} className="text-[11px] text-sub hover:underline">강조 지우기</button>}>
            <div ref={box} data-testid="tbm-transcript" className="scroll-thin max-h-[560px] space-y-0.5 overflow-y-auto pr-1">
              {d.lines.map((l) => (
                <div
                  key={l.n}
                  data-n={l.n}
                  className={cx(
                    'flex gap-2 rounded px-1.5 py-0.5 text-[12.5px] leading-relaxed',
                    mark.includes(l.n) && 'bg-info/15 ring-1 ring-info/40',
                    l.suspicious && 'bg-down/[0.07] text-sub',
                  )}
                >
                  <span className="num w-7 shrink-0 text-right text-[11px] text-dim">{l.n}</span>
                  <span className="min-w-0">
                    {l.text}
                    {l.suspicious && <span className="ml-1 rounded bg-down/15 px-1 text-[10.5px] text-down">판정기에게 하는 지시로 보여 근거로 쓰지 않음</span>}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function ItemRow({ meeting, item, onShow, active }: { meeting: TbmMeetingDetail; item: TbmItemResult; onShow: (lines: number[]) => void; active: boolean }) {
  const gate = useGate('tbm.confirm');
  const follow = useTbmFollowUp(meeting.id);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needs = item.status !== 'COVERED';

  const send = async (kind: TbmFollowUpKind) => {
    setErr(null);
    try {
      await follow.mutateAsync({ code: item.code, kind, note: note.trim() || null });
      setOpen(false);
      setNote('');
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <li data-testid="tbm-item" data-code={item.code} data-status={item.status} className={cx('rounded-md border px-2.5 py-2', active ? 'border-info/50 bg-info/[0.06]' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={TBM_TONE[item.status]} title={item.judged && item.judged !== item.status ? `판정기는 '${TBM_STATUS_NAMES[item.judged]}'라 했지만 검증기가 내렸습니다` : undefined}>
          {TBM_STATUS_NAMES[item.status]}
        </Chip>
        <span className="min-w-0 flex-1 text-[13px]" title={item.desc}>
          {item.title}
        </span>
        <span className={cx('text-[10.5px]', SOURCE_TONE[item.source])}>{TBM_SOURCE_NAMES[item.source]}</span>
      </div>
      {(item.quote || item.evidence.length > 0) && (
        <div className="mt-1 flex flex-wrap items-baseline gap-1.5 text-[12px]">
          {item.evidence.length > 0 && (
            <button type="button" onClick={() => onShow(item.evidence)} className="num rounded border border-line px-1 text-[11px] text-info hover:bg-info/10" title="전사에서 근거 줄 보기">
              {item.evidence.map((n) => `${n}줄`).join(' · ')}
            </button>
          )}
          {item.quote && <span className="text-sub">“{item.quote}”</span>}
        </div>
      )}
      {item.note && <p className="mt-0.5 text-[11.5px] text-dim">{item.note}</p>}
      {needs && (
        <div className="mt-1.5">
          {item.followUp ? (
            <p data-testid="tbm-followup" className="text-[11.5px] text-run">
              ✓ {TBM_FOLLOWUP_NAMES[item.followUp.kind]} · {item.followUp.by} · {kst(item.followUp.at, true)}
              {item.followUp.note ? ` — ${item.followUp.note}` : ''}
            </p>
          ) : open ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={200}
                placeholder={item.status === 'PARTIAL' ? '메모 (선택)' : '메모 (확인은 이유 필수: 예) 오늘 해당 작업 없음)'}
                className="min-w-0 flex-1 rounded border border-white/15 bg-white/5 px-2 py-1 text-[12px] text-ink placeholder:text-dim"
              />
              <button type="button" disabled={follow.isPending} onClick={() => send('SUPPLEMENTED')} className="rounded border border-run/50 bg-run/10 px-2 py-1 text-[11.5px] text-run hover:bg-run/20 disabled:opacity-40" title="빠진 내용을 작업자에게 따로 전달했다">
                보완 전달함
              </button>
              <button type="button" disabled={follow.isPending} onClick={() => send('CONFIRMED')} className="rounded border border-info/50 bg-info/10 px-2 py-1 text-[11.5px] text-info hover:bg-info/20 disabled:opacity-40" title="실제로는 다뤘거나 오늘 해당 없음을 확인했다">
                확인함
              </button>
              <button type="button" onClick={() => setOpen(false)} className="px-1.5 py-1 text-[11.5px] text-sub hover:underline">
                취소
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!gate.ok}
              title={gate.title ?? '조장이 빠진 항목을 보완하거나 확인하면 감사 기록에 남습니다'}
              onClick={() => setOpen(true)}
              className="rounded border border-line px-2 py-0.5 text-[11.5px] text-sub hover:bg-white/10 disabled:opacity-40"
            >
              조장 보완·확인
            </button>
          )}
          {err && <p className="mt-1 text-[11px] text-down">{err}</p>}
        </div>
      )}
    </li>
  );
}
