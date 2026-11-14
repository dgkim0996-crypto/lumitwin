import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { ProductionModule } from '../production/production.module';
import { EnergyService } from './energy.service';
import { HealthService } from './health.service';
import { HealthController, InsightsController } from './insights.controller';
import { InsightsData } from './insights.data';
import { ReportsService } from './reports.service';

/** 분석 (P9): 교대별 일보, 에너지, 예지 보전 */
@Module({
  imports: [LiveModule, ProductionModule],
  controllers: [InsightsController, HealthController],
  providers: [InsightsData, ReportsService, EnergyService, HealthService],
  exports: [HealthService, ReportsService, EnergyService],
})
export class InsightsModule {}
