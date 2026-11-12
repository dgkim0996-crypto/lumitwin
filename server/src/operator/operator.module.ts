import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { ProductionModule } from '../production/production.module';
import { OperatorController } from './operator.controller';
import { OperatorService } from './operator.service';

@Module({ imports: [LiveModule, ProductionModule], controllers: [OperatorController], providers: [OperatorService], exports: [OperatorService] })
export class OperatorModule {}
