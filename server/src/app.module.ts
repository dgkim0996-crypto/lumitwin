import { Module } from '@nestjs/common';
import { AccessController } from './access/access.controller';
import { AssistantModule } from './assistant/assistant.module';
import { AuthModule } from './auth/auth.module';
import { ExecutionModule } from './execution/execution.module';
import { FactoryController } from './factory/factory.controller';
import { InsightsModule } from './insights/insights.module';
import { LiveModule } from './live/live.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { MqttModule } from './mqtt/mqtt.module';
import { OperatorModule } from './operator/operator.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductionModule } from './production/production.module';
import { QualitySystemModule } from './quality-system/quality-system.module';
import { SimController } from './sim-control/sim.controller';
import { TbmModule } from './tbm/tbm.module';

@Module({
  imports: [
    PrismaModule,
    MqttModule,
    LiveModule,
    ProductionModule,
    AuthModule,
    OperatorModule,
    MaintenanceModule,
    QualitySystemModule,
    ExecutionModule,
    InsightsModule,
    TbmModule,
    AssistantModule,
  ],
  controllers: [FactoryController, SimController, AccessController],
})
export class AppModule {}
