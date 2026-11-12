'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '@/lib/api';

/** 브라우저 음성 인식 (Chrome·Edge: webkitSpeechRecognition). 타입 정의가 표준 lib에 없어 필요한 만큼만 적는다 */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechCtor = new () => SpeechRecognitionLike;

function speechCtor(): SpeechCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** 녹음 최대 길이. 넘으면 저절로 멈추고 받아쓴다 */
const MAX_RECORD_MS = 20_000;

export type VoiceMode = 'server' | 'browser' | null;

/**
 * 음성 질의. 서버 받아쓰기(Whisper, STT_BASE_URL)가 켜져 있으면 녹음해서 올리고,
 * 꺼져 있으면 브라우저 음성 인식으로 대신한다. 둘 다 없으면 쓸 수 없다.
 * - 서버 방식: 버튼을 누르면 녹음, 다시 누르면 멈추고 받아쓴다
 * - 브라우저 방식: 말을 멈추면 저절로 끝난다. 받아쓰는 동안 중간 결과를 보여 준다
 */
export function useVoiceInput(serverStt: boolean, onFinal: (text: string) => void, onInterim?: (text: string) => void, onServerDown?: () => void) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserOk, setBrowserOk] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const speech = useRef<SpeechRecognitionLike | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalRef = useRef(onFinal);
  const interimRef = useRef(onInterim);
  const downRef = useRef(onServerDown);
  finalRef.current = onFinal;
  interimRef.current = onInterim;
  downRef.current = onServerDown;

  useEffect(() => setBrowserOk(!!speechCtor()), []);
  const mode: VoiceMode = serverStt ? 'server' : browserOk ? 'browser' : null;

  const upload = useCallback(async (blob: Blob) => {
    setTranscribing(true);
    try {
      const form = new FormData();
      form.append('audio', blob, blob.type.includes('ogg') ? 'speech.ogg' : blob.type.includes('mp4') ? 'speech.m4a' : 'speech.webm');
      const res = await fetch(`${API}/assistant/transcribe`, { method: 'POST', body: form });
      const body = await res.json().catch(() => null);
      // 받아쓰기 서버가 꺼졌으면(502·503) 상태를 다시 받아 다음부터 브라우저 음성 인식으로 대신한다
      if (res.status === 502 || res.status === 503) downRef.current?.();
      if (!res.ok) throw new Error(body?.message ?? `받아쓰기 실패 (${res.status})`);
      const text = String(body?.text ?? '').trim();
      if (text) finalRef.current(text);
      else setError('말소리를 알아듣지 못했습니다. 다시 말해 주세요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTranscribing(false);
    }
  }, []);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (rec.current && rec.current.state !== 'inactive') rec.current.stop();
    speech.current?.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (mode === 'server') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true } });
        const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
        const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
        const chunks: Blob[] = [];
        r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        r.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          setRecording(false);
          rec.current = null;
          const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
          if (blob.size > 1_000) void upload(blob);
        };
        rec.current = r;
        r.start();
        setRecording(true);
        timer.current = setTimeout(stop, MAX_RECORD_MS);
      } catch (e) {
        setError((e as Error).name === 'NotAllowedError' ? '마이크 권한이 필요합니다' : `마이크를 열지 못했습니다: ${(e as Error).message}`);
      }
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) return setError('이 브라우저는 음성 인식을 지원하지 않습니다');
    const s = new Ctor();
    s.lang = 'ko-KR';
    s.interimResults = true;
    s.continuous = false;
    let finalText = '';
    s.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      interimRef.current?.(finalText + interim);
    };
    s.onerror = (e) => setError(e.error === 'not-allowed' ? '마이크 권한이 필요합니다' : e.error === 'no-speech' ? '말소리가 들리지 않았습니다' : `음성 인식 오류: ${e.error}`);
    s.onend = () => {
      setRecording(false);
      speech.current = null;
      if (finalText.trim()) finalRef.current(finalText.trim());
    };
    speech.current = s;
    s.start();
    setRecording(true);
  }, [mode, stop, upload]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      speech.current?.abort();
      if (rec.current && rec.current.state !== 'inactive') rec.current.stop();
    },
    [],
  );

  return { mode, recording, transcribing, error, start, stop, clearError: () => setError(null) };
}
