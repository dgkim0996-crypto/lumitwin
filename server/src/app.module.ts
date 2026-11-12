import { Module } from '@nestjs/common';
import { AccessController } from './access/access.controller';
import { AssistantModule } from './assistant/assistant.module';
import { FactoryController } from './factory/factory.controller';
import { LiveModule } from './live/live.module';
import { MqttModule } from './mqtt/mqtt.module';
import { OperatorModule } from './operator/operator.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductionModule } from './production/production.module';
import { SimController } from './sim-control/sim.controller';

@Module({
  imports: [PrismaModule, MqttModule, LiveModule, ProductionModule, OperatorModule, AssistantModule],
  controllers: [FactoryController, SimController, AccessController],
})
export class AppModule {}
