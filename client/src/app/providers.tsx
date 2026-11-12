'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { AssistantPanel } from '@/components/assistant/AssistantPanel';
import { StandardViewer } from '@/components/assistant/StandardViewer';
import { TraceDialog } from '@/components/hud/TraceDialog';
import { useLiveConnection } from '@/lib/live';

/** 실시간 소켓, 이력 추적 창, AI 비서(대화)는 화면을 옮겨 다녀도 하나만 유지한다 */
function LiveRoot() {
  useLiveConnection();
  return (
    <>
      <AssistantPanel />
      <TraceDialog />
      <StandardViewer />
    </>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 2_000 } } }));
  return (
    <QueryClientProvider client={client}>
      {children}
      <LiveRoot />
    </QueryClientProvider>
  );
}
