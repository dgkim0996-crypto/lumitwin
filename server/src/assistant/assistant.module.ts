import { Module } from '@nestjs/common';
import { ExecutionModule } from '../execution/execution.module';
import { InsightsModule } from '../insights/insights.module';
import { LiveModule } from '../live/live.module';
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { OperatorModule } from '../operator/operator.module';
import { ProductionModule } from '../production/production.module';
import { QualitySystemModule } from '../quality-system/quality-system.module';
import { TbmModule } from '../tbm/tbm.module';
import { AssistantController } from './assistant.controller';
import { MesTools } from './assistant.mes-tools';
import { AssistantService } from './assistant.service';
import { AssistantTools } from './assistant.tools';
import { StandardsIndex } from './standards.index';
import { SttModule } from './stt.module';

/** AI 현장 비서. 실행 MES·품질 체계·분석·TBM 모듈의 서비스는 조회만 한다 (그 모듈들은 비서를 모르므로 순환 의존이 없다) */
@Module({
  imports: [LiveModule, ProductionModule, OperatorModule, MaintenanceModule, ExecutionModule, QualitySystemModule, InsightsModule, TbmModule, SttModule],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantTools, MesTools, StandardsIndex],
})
export class AssistantModule {}
