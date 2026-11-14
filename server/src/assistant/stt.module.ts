import { Module } from '@nestjs/common';
import { SttService } from './stt.service';

/** 음성 받아쓰기. AI 비서(음성 질의)와 TBM 회의 녹음이 같은 인스턴스(연결 확인 캐시)를 쓴다 */
@Module({
  providers: [SttService],
  exports: [SttService],
})
export class SttModule {}
