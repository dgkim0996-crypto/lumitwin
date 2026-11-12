'use client';

import dynamic from 'next/dynamic';
import { FACTORY } from '@lumitwin/shared';
import { AlarmFeed } from '@/components/hud/AlarmFeed';
import { LinePanel } from '@/components/hud/LinePanel';
import { StationPanel } from '@/components/hud/StationPanel';
import { TopBar } from '@/components/hud/TopBar';
import { SceneLabels } from '@/components/scene/SceneLabels';
import { cx } from '@/lib/format';
import { useLive } from '@/lib/live';
import { useUi } from '@/lib/ui';

// WebGL은 브라우저에서만 돈다
const FactoryScene = dynamic(() => import('@/components/scene/FactoryScene'), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-sm text-dim">3D 공장을 불러오는 중…</div>,
});

function Waiting() {
  const socket = useLive((s) => s.socket);
  const sim = useLive((s) => s.simConnected);
  if (socket && sim) return null;
  return (
    <div className="panel pointer-events-auto absolute left-1/2 top-16 z-20 -translate-x-1/2 px-4 py-2 text-sm">
      {!socket ? 'MES 서버(8790)에 연결하는 중…' : '시뮬레이터(가상 엣지)를 기다리는 중… npm run sim'}
    </div>
  );
}

export default function Home() {
  // AI 비서 패널이 열리면 설비 상세 패널이 그 왼쪽으로 비켜 선다 (비서 답의 설비 링크를 눌러도 상세가 보이게)
  const assistant = useUi((s) => s.assistantOpen);
  return (
    <main className="relative h-screen w-screen overflow-hidden">
      <div className="absolute inset-0">
        <FactoryScene />
        <SceneLabels />
      </div>
      <div className="pointer-events-none absolute inset-0 z-10 flex flex-col gap-2 p-2">
        <TopBar />
        <div className={cx('flex min-h-0 flex-1 gap-2', assistant && 'pr-[448px]')}>
          <div className="flex w-[300px] shrink-0 flex-col gap-2">
            <LinePanel />
            <AlarmFeed />
          </div>
          <div className="flex-1" />
          <StationPanel />
        </div>
        <div className="pointer-events-none text-[10px] text-dim">{FACTORY.disclaimer} 설비를 누르면 상세가 열립니다 · 마우스 끌기: 회전, 오른쪽 끌기: 이동, 휠: 확대</div>
      </div>
      <Waiting />
    </main>
  );
}
