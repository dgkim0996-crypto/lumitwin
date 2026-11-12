'use client';

import type { ReactNode } from 'react';
import { LINES, type LineCode } from '@lumitwin/shared';
import { TopBar } from '@/components/hud/TopBar';
import { cx, pct } from '@/lib/format';
import { useLive } from '@/lib/live';
import { useUi } from '@/lib/ui';

/** MES 화면 틀: 상단 바(3D 화면과 같은 제어) + 제목 + 필터 줄 + 내용(세로 스크롤) */
export function PageShell({ title, desc, filters, children }: { title: string; desc: ReactNode; filters?: ReactNode; children: ReactNode }) {
  const socket = useLive((s) => s.socket);
  const sim = useLive((s) => s.simConnected);
  // AI 비서 패널(오른쪽 440px)이 열리면 내용이 그 밑에 가리지 않게 비켜 준다
  const assistant = useUi((s) => s.assistantOpen);
  return (
    <main className="flex h-screen flex-col gap-2 p-2">
      <TopBar />
      <div className={cx('scroll-thin min-h-0 flex-1 overflow-y-auto', assistant && 'pr-[448px]')}>
        {/* 화면 격자는 창 폭이 아니라 이 영역 폭(@container)을 따른다: 비서 패널이 열려 좁아지면 한 단으로 접힌다 */}
        <div className="@container mx-auto max-w-[1680px] px-2 pb-10">
          <div className="pt-3 pb-3">
            <h1 className="text-lg font-semibold">{title}</h1>
            <p className="mt-0.5 text-xs text-sub">{desc}</p>
          </div>
          {(!socket || !sim) && (
            <div className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-ink">
              {!socket ? 'MES 서버(8790)에 연결하는 중입니다.' : '시뮬레이터(가상 엣지)가 연결되지 않았습니다. npm run sim 으로 켜면 숫자가 움직입니다.'}
            </div>
          )}
          {filters && <div className="mb-3 flex flex-wrap items-center gap-2">{filters}</div>}
          {children}
        </div>
      </div>
    </main>
  );
}

/** 라인 선택 (필터 줄). 버튼마다 그 라인의 핵심 숫자를 같이 보여 준다 */
export function LineSwitcher() {
  const line = useUi((s) => s.line);
  const setLine = useUi((s) => s.setLine);
  const lines = useLive((s) => s.lines);
  return (
    <div role="tablist" aria-label="라인 선택" className="flex flex-wrap gap-2">
      {LINES.map((l) => {
        const lv = lines[l.code];
        const on = l.code === line;
        return (
          <button
            key={l.code}
            role="tab"
            aria-selected={on}
            onClick={() => setLine(l.code as LineCode)}
            className={cx('flex items-center gap-3 rounded-md border px-3 py-1.5 text-left', on ? 'border-info/60 bg-info/10' : 'border-line bg-white/[0.03] hover:bg-white/[0.07]')}
          >
            <span className="size-2.5 rounded-full" style={{ background: l.color }} />
            <span>
              <span className="block text-sm font-medium">{l.name}</span>
              <span className="num block text-[11px] text-sub">
                완성 {lv?.output ?? 0} · OEE {pct(lv?.oee.oee)} · FPY {pct(lv?.fpy)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 숫자 타일: 이름 · 값 · 보조 설명 */
export function Stat({ label, value, sub, children }: { label: string; value: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="card min-w-0 p-3">
      <div className="text-xs text-sub">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-dim">{sub}</div>}
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}
