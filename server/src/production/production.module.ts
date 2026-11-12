import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { LiveRestoreService } from './live-restore.service';
import { ProductionController } from './production.controller';
import { ProductionService } from './production.service';
import { ProductionWriter } from './production.writer';

@Module({ imports: [LiveModule], controllers: [ProductionController], providers: [ProductionWriter, ProductionService, LiveRestoreService], exports: [ProductionService, ProductionWriter] })
export class ProductionModule {}
