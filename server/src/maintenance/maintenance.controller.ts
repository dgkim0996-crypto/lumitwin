import { Controller, Get, Query } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';

@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  /** 설비별 고장·MTBF·MTTR·계획 보전 상태, 최근 고장 이력, 고장 사유별 합계 */
  @Get()
  report(@Query('run') run?: string) {
    const id = run ? Number.parseInt(run, 10) || undefined : undefined;
    return this.maintenance.report(id);
  }
}
