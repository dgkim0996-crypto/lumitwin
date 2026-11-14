import { Module } from '@nestjs/common';
import { SttModule } from '../assistant/stt.module';
import { ExecutionModule } from '../execution/execution.module';
import { InsightsModule } from '../insights/insights.module';
import { LiveModule } from '../live/live.module';
import { ProductionModule } from '../production/production.module';
import { QualitySystemModule } from '../quality-system/quality-system.module';
import { TbmController } from './tbm.controller';
import { TbmService } from './tbm.service';

/** TBM 회의 체크리스트 대조 (P10). 실행 MES·품질·상태 감시는 조회만 한다. AI 비서가 이 모듈을 가져다 조회 도구로 쓴다 */
@Module({
  imports: [LiveModule, ProductionModule, ExecutionModule, QualitySystemModule, InsightsModule, SttModule],
  controllers: [TbmController],
  providers: [TbmService],
  exports: [TbmService],
})
export class TbmModule {}
