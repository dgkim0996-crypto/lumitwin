import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { ProductionModule } from '../production/production.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';

@Module({ imports: [LiveModule, ProductionModule], controllers: [MaintenanceController], providers: [MaintenanceService], exports: [MaintenanceService] })
export class MaintenanceModule {}
