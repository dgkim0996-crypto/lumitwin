'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LINES, STATIONS } from '@lumitwin/shared';
import { cx, kst, STATE_COLOR, STATE_LABEL } from '@/lib/format';
import { useLive } from '@/lib/live';
import { remembered } from '@/lib/operator';

/** 작업자 태블릿: 이 태블릿이 붙어 있는 설비를 고른다 (한 번 고르면 기억한다) */
export default function OperatorPicker() {
  const stations = useLive((s) => s.stations);
  const simT = useLive((s) => s.sim?.t);
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    const c = remembered.station();
    setLast(c && STATIONS[c] ? c : null);
  }, []);

  return (
    <main className="scroll-thin h-screen overflow-y-auto">
      <div className="mx-auto max-w-[1200px] px-4 pt-4 pb-10">
        <header className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold">작업자 태블릿</h1>
            <p className="mt-1 text-sm text-sub">이 태블릿이 놓인 설비를 고르세요. 설비 상태, 비가동 사유 입력, 작업 전 점검, 작업표준서, 음성 질문을 한 화면에서 합니다.</p>
          </div>
          <span className="num text-xl font-semibold">{kst(simT)}</span>
          <Link href="/" className="flex h-12 items-center rounded-lg border border-line bg-white/5 px-4 text-base hover:bg-white/10">
            MES 화면으로
          </Link>
        </header>

        {last && (
          <Link
            href={`/operator/${last}`}
            className="mt-4 flex min-h-16 items-center gap-3 rounded-xl border border-info/50 bg-info/10 px-4 py-3 hover:bg-info/20"
          >
            <span className="text-sm text-info">이어서</span>
            <span className="num text-lg font-semibold">{last}</span>
            <span className="text-lg">{STATIONS[last].name}</span>
            <span className="ml-auto text-2xl text-info" aria-hidden>
              →
            </span>
          </Link>
        )}

        {LINES.map((l) => (
          <section key={l.code} className="mt-6" aria-label={l.name}>
            <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">
              <span className="size-3 rounded-full" style={{ background: l.color }} />
              {l.name}
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {l.stations.map((s) => {
                const st = stations[s.code]?.state ?? 'IDLE';
                return (
                  <Link
                    key={s.code}
                    href={`/operator/${s.code}`}
                    className={cx('flex min-h-20 flex-col justify-between rounded-xl border bg-white/[0.03] p-3 hover:bg-white/[0.08]', s.code === last ? 'border-info/50' : 'border-line')}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="num text-xs text-sub">{s.code}</span>
                      <span className="rounded px-1.5 py-0.5 text-xs font-semibold text-black" style={{ background: STATE_COLOR[st] }}>
                        {STATE_LABEL[st]}
                      </span>
                    </span>
                    <span className="mt-1 text-base leading-snug font-medium">{s.name}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
