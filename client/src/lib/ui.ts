'use client';

import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { LineCode } from '@lumitwin/shared';

/** 다른 화면(AI 비서 링크, 불량 분석의 LOT 편중 등)이 "이것을 열어 달라"고 넘기는 대상 */
export interface FocusTarget {
  station?: string;
  defect?: string;
  material?: string;
  lot?: string;
  serial?: string;
}

/** MES 화면끼리 공유하는 선택 상태 (화면을 옮겨도 고른 라인이 유지된다) */
interface UiState {
  line: LineCode;
  setLine: (l: LineCode) => void;
  /** 화면이 받아서 적용하면 지운다 */
  focus: FocusTarget | null;
  setFocus: (f: FocusTarget | null) => void;
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  /** 늘어날 때마다 비서 패널이 열리며 음성 입력을 시작한다 (작업자 태블릿의 큰 마이크 버튼) */
  voiceSeq: number;
  askByVoice: () => void;
}

export const useUi = create<UiState>((set) => ({
  line: 'HL',
  setLine: (line) => set({ line }),
  focus: null,
  setFocus: (focus) => set({ focus }),
  assistantOpen: false,
  setAssistantOpen: (assistantOpen) => set({ assistantOpen }),
  voiceSeq: 0,
  askByVoice: () => set((s) => ({ assistantOpen: true, voiceSeq: s.voiceSeq + 1 })),
}));

const FOCUS_KEYS = ['station', 'defect', 'material', 'lot', 'serial'] as const;

/**
 * 화면이 열릴 때 주소의 ?station=…&material=… 을, 열려 있는 동안에는 setFocus로 들어온 대상을 받아 적용한다.
 * 같은 화면 안에서 링크를 눌러도(주소만 바뀌고 화면은 그대로) 다시 적용되게 주소 대신 상태로 넘긴다.
 */
export function useFocusTarget(apply: (f: FocusTarget) => void) {
  const focus = useUi((s) => s.focus);
  const setFocus = useUi((s) => s.setFocus);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const f: FocusTarget = {};
    for (const k of FOCUS_KEYS) {
      const v = p.get(k);
      if (v) f[k] = v;
    }
    if (Object.keys(f).length && !useUi.getState().focus) applyRef.current(f);
  }, []);
  useEffect(() => {
    if (!focus) return;
    applyRef.current(focus);
    setFocus(null);
  }, [focus, setFocus]);
}
