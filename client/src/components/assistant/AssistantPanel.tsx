'use client';

import { useQuery } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { STATIONS, type AssistantInfo } from '@lumitwin/shared';
import { api } from '@/lib/api';
import { useAssistant, type ChatMessage, type ChatTool } from '@/lib/assistant';
import { cx } from '@/lib/format';
import { useLive } from '@/lib/live';
import { useUi } from '@/lib/ui';
import { useVoiceInput } from '@/lib/voice';
import { Markdown } from './Markdown';

const PAGE_LABEL: Record<string, string> = { '/': '3D 공장', '/production': '생산 현황', '/spc': 'SPC', '/quality': '불량 분석', '/trace': '추적', '/operator': '작업자 태블릿' };

/** 작업자 태블릿(/operator/설비코드)은 주소의 설비가 "이 설비"다 */
function operatorStation(path: string): string | null {
  const m = /^\/operator\/([^/?#]+)/.exec(path);
  const code = m ? decodeURIComponent(m[1]) : null;
  return code && STATIONS[code] ? code : null;
}

/** 지금 화면의 문맥 (비서에게 질문과 함께 보낸다) */
export function pageContext(path: string, selected: string | null): { page: string; station: string | null } {
  const op = operatorStation(path);
  if (op) return { page: `작업자 태블릿 (${path}) — 설비 앞의 작업자가 묻는다`, station: op };
  return { page: PAGE_LABEL[path] ? `${PAGE_LABEL[path]} (${path})` : path, station: path === '/' ? selected : null };
}

const pageLabel = (path: string) => PAGE_LABEL[path] ?? (operatorStation(path) ? '작업자 태블릿' : path);

/** 도구 호출 한 줄: 무엇을 조회했고 결과가 어땠는지. 눌러서 입력값을 본다 */
function ToolRow({ t }: { t: ChatTool }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="text-[11.5px]">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-1.5 text-left hover:text-ink" title="조회 입력값 보기">
        {/* 진행 중(깜빡임) · 성공 · 실패 · 중단(회색, ok 없음) */}
        <span className={cx('mt-[3px] size-2 shrink-0 rounded-full', !t.done ? 'animate-pulse bg-info' : t.ok === true ? 'bg-run' : t.ok === false ? 'bg-down' : 'bg-white/30')} />
        <span className="min-w-0">
          <span className="text-sub">{t.label}</span>
          {t.summary && <span className={cx('ml-1', t.ok === false ? 'text-down' : 'text-dim')}>— {t.summary}</span>}
        </span>
      </button>
      {open && <pre className="num mt-0.5 ml-3.5 overflow-x-auto rounded bg-white/5 px-2 py-1 text-[10.5px] text-dim">{`${t.name}(${JSON.stringify(t.input)})`}</pre>}
    </li>
  );
}

function AssistantBubble({ m, last }: { m: ChatMessage; last: boolean }) {
  const thinking = m.status === 'streaming' && !m.text && m.tools.every((t) => t.done);
  return (
    <div className="space-y-2">
      {m.notice && <div className="rounded-md border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs text-ink">{m.notice}</div>}
      {m.tools.length > 0 && (
        <ul className="space-y-0.5 rounded-md border border-line bg-white/[0.02] px-2 py-1.5" aria-label="조회한 공장 데이터">
          {m.tools.map((t) => (
            <ToolRow key={t.id} t={t} />
          ))}
        </ul>
      )}
      {m.text && <Markdown text={m.text} />}
      {thinking && <div className="text-xs text-dim">{m.tools.length ? '조회 결과를 정리하는 중…' : '질문을 살펴보는 중…'}</div>}
      {m.status === 'error' && <div className="rounded-md border border-down/40 bg-down/10 px-2 py-1.5 text-xs text-down">{m.error}</div>}
      {m.status === 'stopped' && <div className="text-xs text-dim">답을 멈췄습니다.</div>}
      {m.status === 'done' && last && (
        <div className="num text-[10.5px] text-dim">
          {m.mode === 'mock' ? '모의 모드' : m.model}
          {m.tools.length ? ` · 조회 ${m.tools.length}회` : ''}
          {m.ms != null ? ` · ${(m.ms / 1000).toFixed(1)}초` : ''}
          {m.usage ? ` · 토큰 입력 ${m.usage.input.toLocaleString()}(캐시 ${m.usage.cacheRead.toLocaleString()}) / 출력 ${m.usage.output.toLocaleString()}` : ''}
        </div>
      )}
    </div>
  );
}

function MicIcon({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="2" fill={on ? 'currentColor' : 'none'} />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * AI 현장 비서 패널. 어느 화면에서나 상단 바의 버튼으로 연다(화면을 옮겨도 대화가 남는다).
 * 질문 → 서버가 공장 데이터 도구를 불러 답을 흘려보냄 → 도구 호출과 답을 실시간으로 그린다.
 */
export function AssistantPanel() {
  const open = useUi((s) => s.assistantOpen);
  const setOpen = useUi((s) => s.setAssistantOpen);
  const { messages, busy, info, send, stop, reset, setInfo } = useAssistant();
  const selected = useLive((s) => s.selected);
  const path = usePathname();
  const [input, setInput] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // 받아쓰기 서버(Whisper)는 따로 켜고 끄므로, 열려 있는 동안 1분마다 상태를 다시 받는다
  const infoQ = useQuery({
    queryKey: ['assistant-info'],
    queryFn: () => api.get<AssistantInfo>('/assistant/info'),
    staleTime: 60_000,
    refetchInterval: open ? 60_000 : false,
    enabled: open,
  });
  useEffect(() => {
    if (infoQ.data) setInfo(infoQ.data);
  }, [infoQ.data, setInfo]);

  const context = pageContext(path, selected);
  const ask = (text: string, voice = false) => {
    if (!text.trim() || busy) return;
    setInput('');
    void send(text, context, { voice });
  };
  const voice = useVoiceInput(
    !!info?.stt.enabled,
    (t) => ask(t, true),
    (t) => setInput(t),
    () => void infoQ.refetch(),
  );

  // 작업자 태블릿의 큰 마이크 버튼: 패널을 열고 바로 듣기 시작한다 (받아쓰기 방식이 정해진 뒤에)
  const voiceSeq = useUi((s) => s.voiceSeq);
  const seen = useRef(voiceSeq);
  const startVoice = voice.start;
  useEffect(() => {
    // 서버 받아쓰기를 쓸지(info)를 알 때까지 기다린다. 이미 듣거나 답하는 중이면 이번 요청은 버린다
    if (voiceSeq === seen.current || !open || !info) return;
    seen.current = voiceSeq;
    if (!voice.mode || busy || voice.recording || voice.transcribing) return;
    void startVoice();
  }, [open, info, voiceSeq, voice.mode, busy, voice.recording, voice.transcribing, startVoice]);

  // 새 글이 올라오면 아래로 (사용자가 위로 올려 읽는 중이면 그대로 둔다)
  const lastText = messages[messages.length - 1]?.text.length ?? 0;
  const lastTools = messages[messages.length - 1]?.tools.length ?? 0;
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastText, lastTools]);
  useEffect(() => {
    if (open) setTimeout(() => box.current?.focus(), 50);
  }, [open]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      // Ctrl+/ 로 열고 닫는다
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        setOpen(!useUi.getState().assistantOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask(input);
    }
  };

  if (!open) return null;
  const mode = info?.mode;
  return (
    <aside
      className="panel pointer-events-auto fixed top-16 right-2 bottom-2 z-40 flex w-[440px] max-w-[calc(100vw-16px)] flex-col"
      style={{ background: 'var(--color-panel-solid)' }}
      aria-label="AI 현장 비서"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">AI 현장 비서</span>
            {mode && (
              <span
                className={cx('rounded px-1.5 py-px text-[10.5px]', mode === 'claude' ? 'bg-info/20 text-info' : 'bg-white/10 text-sub')}
                title={mode === 'claude' ? `Claude API (${info?.model})` : 'API 키 없이 규칙으로 질문을 해석하고, 같은 도구로 실제 공장 데이터를 조회합니다'}
              >
                {mode === 'claude' ? 'Claude' : '모의 모드'}
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-dim">
            공장 데이터·작업표준서로 답합니다 · 보고 있는 화면: {pageLabel(path)}
            {context.station ? ` · 선택 설비 ${context.station}` : ''}
          </div>
        </div>
        {messages.length > 0 && (
          <button onClick={reset} disabled={busy} className="rounded px-2 py-1 text-xs text-sub hover:bg-white/10 disabled:opacity-40" title="대화를 비우고 새로 시작">
            새 대화
          </button>
        )}
        <button onClick={() => setOpen(false)} className="rounded px-2 py-1 text-sm text-sub hover:bg-white/10" title="닫기 (Ctrl+/)">
          닫기
        </button>
      </div>

      <div ref={list} className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-[13px] leading-relaxed text-sub">
              설비 상태, 불량 원인, LOT 영향 범위, 작업 절차를 물어보세요. 답할 때 어떤 데이터를 조회했는지 함께 보여 주고, 설비 코드·LOT·표준서 인용을 누르면 해당 화면으로 갑니다.
              {context.station && ` ${operatorStation(path) ? '이 태블릿의 설비' : '3D에서 고른 설비'}(${context.station} ${STATIONS[context.station]?.name ?? ''})는 "이 설비"로 물을 수 있습니다.`}
            </p>
            <div className="flex flex-col gap-1.5">
              {(info?.suggestions ?? []).map((s) => (
                <button key={s} onClick={() => ask(s)} className="rounded-md border border-line bg-white/[0.03] px-2.5 py-1.5 text-left text-[13px] hover:border-info/50 hover:bg-info/10">
                  {s}
                </button>
              ))}
            </div>
            {mode === 'mock' && (
              <p className="text-[11px] leading-relaxed text-dim">
                지금은 모의 모드입니다: 질문을 규칙으로 해석해 정해진 틀로 답합니다. 서버에 ANTHROPIC_API_KEY를 넣으면 Claude가 같은 도구로 자유로운 질문에 답합니다.
              </p>
            )}
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-info/15 px-3 py-1.5 text-[13px]">
                {m.voice && (
                  <span className="mr-1 inline-block align-[-3px] text-info" title="음성으로 물음">
                    <MicIcon on={false} />
                  </span>
                )}
                {m.text}
              </div>
            </div>
          ) : (
            <AssistantBubble key={m.id} m={m} last={i === messages.length - 1} />
          ),
        )}
      </div>

      <div className="border-t border-line p-2">
        {voice.error && (
          <div className="mb-1.5 flex items-center justify-between rounded bg-warn/10 px-2 py-1 text-[11px] text-warn">
            {voice.error}
            <button onClick={voice.clearError} className="text-sub hover:text-ink">
              ×
            </button>
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <textarea
            ref={box}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="비서에게 할 질문"
            rows={Math.min(4, Math.max(1, input.split('\n').length))}
            placeholder={voice.recording ? '듣고 있습니다… 다시 누르면 멈춥니다' : voice.transcribing ? '받아쓰는 중…' : '질문을 입력하세요 (Enter 보내기, Shift+Enter 줄바꿈)'}
            className="scroll-thin min-h-[36px] flex-1 resize-none rounded-md border border-line bg-white/[0.04] px-2.5 py-2 text-[13px] outline-none placeholder:text-dim focus:border-info/60"
          />
          <button
            onClick={() => (voice.recording ? voice.stop() : voice.start())}
            disabled={!voice.mode || busy || voice.transcribing}
            aria-label={voice.recording ? '음성 입력 멈추기' : '음성으로 묻기'}
            aria-pressed={voice.recording}
            title={
              !voice.mode
                ? '음성 질의를 쓸 수 없습니다 (서버 STT_BASE_URL 또는 브라우저 음성 인식 필요)'
                : voice.mode === 'server'
                  ? `음성으로 묻기 (서버 받아쓰기 · ${info?.stt.model})`
                  : '음성으로 묻기 (브라우저 음성 인식)'
            }
            className={cx(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-md border disabled:opacity-40',
              voice.recording ? 'animate-pulse border-down/60 bg-down/20 text-down' : 'border-line bg-white/5 text-sub hover:bg-white/10 hover:text-ink',
            )}
          >
            {voice.transcribing ? <span className="size-3 animate-spin rounded-full border-2 border-sub border-t-transparent" /> : <MicIcon on={voice.recording} />}
          </button>
          {busy ? (
            <button onClick={stop} className="h-9 shrink-0 rounded-md border border-line bg-white/10 px-3 text-sm hover:bg-white/20">
              멈춤
            </button>
          ) : (
            <button onClick={() => ask(input)} disabled={!input.trim()} className="h-9 shrink-0 rounded-md bg-info/80 px-3 text-sm font-medium text-black hover:bg-info disabled:opacity-40">
              보내기
            </button>
          )}
        </div>
        <div className="mt-1 text-[10px] text-dim">조회만 합니다. 설비 정지·재가동 같은 조작은 설비 상세 패널이나 작업자 태블릿에서 직접 하세요. 답은 상관 분석이라 현장 확인이 필요합니다.</div>
      </div>
    </aside>
  );
}
