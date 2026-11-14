'use client';

import dynamic from 'next/dynamic';

// 설비 모델 미리보기 (메뉴에는 없다). 쓰는 법은 components/scene/MachineGallery.tsx 맨 위
const MachineGallery = dynamic(() => import('@/components/scene/MachineGallery'), {
  ssr: false,
  loading: () => <div className="flex h-screen items-center justify-center text-sm text-dim">설비 모델을 불러오는 중…</div>,
});

export default function MachinesPage() {
  return <MachineGallery />;
}
