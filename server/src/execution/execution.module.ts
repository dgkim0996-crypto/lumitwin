import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { ProductionModule } from '../production/production.module';
import { QualitySystemModule } from '../quality-system/quality-system.module';
import { ExecutionController } from './execution.controller';
import { ExecutionService } from './execution.service';

/** 실행 MES (P9): 작업지시·생산 계획, 공정 인터록, 불량 처리(NCR), Hold */
@Module({ imports: [LiveModule, ProductionModule, QualitySystemModule], controllers: [ExecutionController], providers: [ExecutionService], exports: [ExecutionService] })
export class ExecutionModule {}
