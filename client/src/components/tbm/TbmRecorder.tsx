'use client';

import { useEffect, useRef, useState } from 'react';
import { TBM_RECORD_MAX_SEC } from '@lumitwin/shared';
import { cx } from '@/lib/format';
import { recorderMime } from '@/lib/tbm';

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * 브라우저로 TBM 회의를 녹음한다 (마이크 권한 필요). 32kbps Opus라 20분이 약 5MB로 받아쓰기 서버 한도(25MB) 안에 든다.
 * 녹음은 이 브라우저 메모리에만 있다가, 올리면 서버가 받아쓰고 음성은 버린다
 */
export function TbmRecorder({ disabled, title, onDone }: { disabled: boolean; title?: string; onDone: (file: File) => void }) {
  const [state, setState] = useState<'idle' | 'rec' | 'done'>('idle');
  const [sec, setSec] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
      rec.current?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (rec.current?.state === 'recording') rec.current.stop();
  };

  const start = async () => {
    setErr(null);
    const mime = recorderMime();
    if (!mime || !navigator.mediaDevices?.getUserMedia) {
      setErr('이 브라우저는 녹음을 지원하지 않습니다. 녹음 파일을 올려 주세요');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true } });
    } catch {
      setErr('마이크를 쓸 수 없습니다. 브라우저 주소창의 마이크 권한을 확인해 주세요 (https 또는 localhost에서만 녹음됩니다)');
      return;
    }
    const chunks: Blob[] = [];
    const r = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 });
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const type = mime.split(';')[0];
      const blob = new Blob(chunks, { type });
      const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
      const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16).replace(/[-: ]/g, '');
      setUrl(URL.createObjectURL(blob));
      setState('done');
      onDone(new File([blob], `TBM 녹음 ${stamp}.${ext}`, { type }));
    };
    r.start(1000);
    rec.current = r;
    setSec(0);
    setState('rec');
    const t0 = Date.now();
    timer.current = setInterval(() => {
      const s = (Date.now() - t0) / 1000;
      setSec(s);
      if (s >= TBM_RECORD_MAX_SEC) stop();
    }, 250);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {state !== 'rec' ? (
          <button
            type="button"
            onClick={start}
            disabled={disabled}
            title={title ?? `최대 ${TBM_RECORD_MAX_SEC / 60}분`}
            className="flex items-center gap-1.5 rounded-md border border-down/50 bg-down/10 px-3 py-1.5 text-sm text-down hover:bg-down/20 disabled:opacity-40"
          >
            <span className="size-2.5 rounded-full bg-down" />
            {state === 'done' ? '다시 녹음' : '녹음 시작'}
          </button>
        ) : (
          <button type="button" onClick={stop} className="flex items-center gap-1.5 rounded-md border border-line bg-white/10 px-3 py-1.5 text-sm hover:bg-white/15">
            <span className="size-2.5 rounded-sm bg-ink" />
            녹음 끝
          </button>
        )}
        <span className={cx('num text-sm', state === 'rec' ? 'text-down' : 'text-sub')}>
          {state === 'rec' && <span className="mr-1 inline-block size-2 animate-pulse rounded-full bg-down" />}
          {mmss(sec)} / {mmss(TBM_RECORD_MAX_SEC)}
        </span>
      </div>
      {url && state === 'done' && <audio src={url} controls className="h-8 w-full" />}
      {err && <p className="text-xs text-down">{err}</p>}
    </div>
  );
}
