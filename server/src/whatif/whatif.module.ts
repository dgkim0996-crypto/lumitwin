import { Module } from '@nestjs/common';
import { ExecutionModule } from '../execution/execution.module';
import { InsightsModule } from '../insights/insights.module';
import { LiveModule } from '../live/live.module';
import { ProductionModule } from '../production/production.module';
import { WhatIfController } from './whatif.controller';
import { WhatIfService } from './whatif.service';

/** What-if 계획 시뮬레이션 (P11). 실시간 계층·실행 MES·상태 감시는 조회만 하고, 반영(apply)만 실행 MES의 작업지시 API를 쓴다. AI 비서가 결과 조회 도구로 쓴다 */
@Module({
  imports: [LiveModule, ProductionModule, ExecutionModule, InsightsModule],
  controllers: [WhatIfController],
  providers: [WhatIfService],
  exports: [WhatIfService],
})
export class WhatIfModule {}
