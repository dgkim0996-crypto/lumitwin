import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { ProductionModule } from '../production/production.module';
import { QualitySystemController } from './quality-system.controller';
import { QualitySystemService } from './quality-system.service';

/** 품질 시스템 (P9): 4M 변경점, 초·중·종물, 관리계획서(화면이 shared/control-plan.ts로 만든다) */
@Module({ imports: [LiveModule, ProductionModule], controllers: [QualitySystemController], providers: [QualitySystemService], exports: [QualitySystemService] })
export class QualitySystemModule {}
