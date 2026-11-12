import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { OperatorModule } from '../operator/operator.module';
import { ProductionModule } from '../production/production.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { AssistantTools } from './assistant.tools';
import { StandardsIndex } from './standards.index';
import { SttService } from './stt.service';

@Module({
  imports: [LiveModule, ProductionModule, OperatorModule],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantTools, StandardsIndex, SttService],
})
export class AssistantModule {}
