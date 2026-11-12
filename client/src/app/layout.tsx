import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
// 글꼴은 판타스틸 ERP의 IBM Plex Sans KR 조각을 그대로 쓴다 (빌드 때 외부에서 받지 않음, OFL)
import '@/styles/fonts.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'LumiTwin · 가상 램프·전장 스마트공장',
  description: '헤드램프·BMS·사이드미러 3개 라인을 공정 단위로 모델링한 디지털 트윈 + MES 포트폴리오 (공개 자료 기반 가상 공장)',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
