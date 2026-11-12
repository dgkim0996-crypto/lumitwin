'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { AssistantChatRequest, AssistantEvent, AssistantInfo, AssistantMode, AssistantRef, AssistantUsage } from '@lumitwin/shared';
import { API } from '@/lib/api';

export interface ChatTool {
  id: string;
  name: string;
  label: string;
  input: Record<string, unknown>;
  done: boolean;
  ok?: boolean;
  summary?: string;
  refs: AssistantRef[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools: ChatTool[];
  status: 'streaming' | 'done' | 'error' | 'stopped';
  error?: string;
  mode?: AssistantMode;
  model?: string | null;
  usage?: AssistantUsage;
  ms?: number;
  /** 음성으로 물은 질문 */
  voice?: boolean;
  /** 답 위에 붙이는 안내 (예: 서버가 다시 떠서 앞 대화 맥락이 끊김) */
  notice?: string;
}

interface AssistantState {
  info: AssistantInfo | null;
  conversationId: string | null;
  messages: ChatMessage[];
  busy: boolean;
  /** 작업표준서 보기 창 (문서 ID와 절 번호) */
  standard: { id: string; n?: number } | null;
  setInfo: (i: AssistantInfo) => void;
  openStandard: (s: { id: string; n?: number } | null) => void;
  send: (message: string, context: AssistantChatRequest['context'], opts?: { voice?: boolean }) => Promise<void>;
  stop: () => void;
  reset: () => void;
}

let abort: AbortController | null = null;
const uid = () => Math.random().toString(36).slice(2, 10);

// 대화는 탭 단위(sessionStorage)로 남겨 새로고침해도 이어 본다. 서버도 같은 대화를 2시간 기억한다
export const useAssistant = create<AssistantState>()(
  persist(
    (set, get) => {
  /** 마지막(답하는 중인) 메시지만 고친다 */
  const patchLast = (fn: (m: ChatMessage) => ChatMessage) =>
    set((s) => {
      const msgs = s.messages.slice();
      const i = msgs.length - 1;
      if (i >= 0 && msgs[i].role === 'assistant') msgs[i] = fn(msgs[i]);
      return { messages: msgs };
    });

  const onEvent = (e: AssistantEvent) => {
    switch (e.type) {
      case 'start': {
        // 보낸 대화 ID를 서버가 모르면(서버 재시작·2시간 경과) 새 대화로 시작한 것이다
        const prev = get().conversationId;
        const lost = prev != null && prev !== e.conversationId && get().messages.length > 2;
        set({ conversationId: e.conversationId });
        patchLast((m) => ({ ...m, mode: e.mode, model: e.model, notice: lost ? '서버가 다시 시작됐거나 오래 지나 앞 대화 맥락이 이어지지 않습니다. 이 질문부터 새로 답합니다.' : undefined }));
        break;
      }
      case 'tool':
        patchLast((m) => ({ ...m, tools: [...m.tools, { id: e.id, name: e.name, label: e.label, input: e.input, done: false, refs: [] }] }));
        break;
      case 'tool_result':
        patchLast((m) => ({ ...m, tools: m.tools.map((t) => (t.id === e.id ? { ...t, done: true, ok: e.ok, summary: e.summary, refs: e.refs } : t)) }));
        break;
      case 'text':
        patchLast((m) => ({ ...m, text: m.text + e.delta }));
        break;
      case 'done':
        patchLast((m) => ({ ...m, status: 'done', usage: e.usage, ms: e.ms }));
        break;
      case 'error':
        patchLast((m) => ({ ...m, status: 'error', error: e.message }));
        break;
    }
  };

  return {
    info: null,
    conversationId: null,
    messages: [],
    busy: false,
    standard: null,
    setInfo: (info) => set({ info }),
    openStandard: (standard) => set({ standard }),

    async send(message, context, opts) {
      const text = message.trim();
      if (!text || get().busy) return;
      abort = new AbortController();
      set((s) => ({
        busy: true,
        messages: [
          ...s.messages,
          { id: uid(), role: 'user', text, tools: [], status: 'done', voice: opts?.voice },
          { id: uid(), role: 'assistant', text: '', tools: [], status: 'streaming' },
        ],
      }));
      try {
        const res = await fetch(`${API}/assistant/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversationId: get().conversationId ?? undefined, message: text, context } satisfies AssistantChatRequest),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.message ?? `요청 실패 (${res.status})`);
        }
        // NDJSON: 한 줄에 이벤트 하나
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) onEvent(JSON.parse(line) as AssistantEvent);
          }
        }
        // 서버가 done/error 없이 끊었으면
        patchLast((m) => (m.status === 'streaming' ? { ...m, status: 'error', error: '응답이 중간에 끊겼습니다' } : m));
      } catch (err) {
        if ((err as Error).name === 'AbortError') patchLast((m) => ({ ...m, status: 'stopped' }));
        else patchLast((m) => ({ ...m, status: 'error', error: (err as Error).message || 'MES 서버에 연결하지 못했습니다' }));
      } finally {
        // 멈추거나 끊겨 결과를 못 받은 조회는 진행 중으로 남기지 않는다
        patchLast((m) => (m.tools.some((t) => !t.done) ? { ...m, tools: m.tools.map((t) => (t.done ? t : { ...t, done: true, ok: undefined, summary: '중단됨' })) } : m));
        abort = null;
        set({ busy: false });
      }
    },

    stop() {
      abort?.abort();
    },

    reset() {
      abort?.abort();
      set({ conversationId: null, messages: [] });
    },
  };
    },
    {
      name: 'lumitwin.assistant',
      version: 1,
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ conversationId: s.conversationId, messages: s.messages.slice(-60) }),
      // 답하던 중에 새로고침했으면 그 답은 멈춘 것으로 둔다
      merge: (saved, cur) => {
        const p = (saved ?? {}) as Partial<AssistantState>;
        return {
          ...cur,
          conversationId: p.conversationId ?? null,
          messages: (p.messages ?? []).map((m) =>
            m.status === 'streaming' || m.tools.some((t) => !t.done)
              ? {
                  ...m,
                  status: m.status === 'streaming' ? ('stopped' as const) : m.status,
                  tools: m.tools.map((t) => (t.done ? t : { ...t, done: true, ok: undefined, summary: '중단됨' })),
                }
              : m,
          ),
        };
      },
    },
  ),
);
