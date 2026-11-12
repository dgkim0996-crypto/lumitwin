'use client';

import { useParams } from 'next/navigation';
import { OperatorScreen } from '@/components/operator/OperatorScreen';

/** 작업자 태블릿: /operator/HL-VM-01 처럼 설비 코드로 연다 (태블릿을 그 설비 앞에 두고 이 주소를 홈 화면에 둔다) */
export default function OperatorStationPage() {
  const { code } = useParams<{ code: string }>();
  return <OperatorScreen code={decodeURIComponent(code ?? '')} />;
}
