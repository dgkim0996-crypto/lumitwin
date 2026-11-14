import { Controller, Get, Query } from '@nestjs/common';
import { TtlCache } from '../common/ttl-cache';
import { MaintenanceService } from './maintenance.service';

@Controller('maintenance')
export class MaintenanceController {
  /** 고장·보전 집계는 실행 전체 상태 기록을 훑는다. 같은 실행 조회는 2초 동안 같이 쓴다 */
  private readonly cache = new TtlCache<Awaited<ReturnType<MaintenanceService['report']>>>(2_000);

  constructor(private readonly maintenance: MaintenanceService) {}

  /** 설비별 고장·MTBF·MTTR·계획 보전 상태, 최근 고장 이력, 고장 사유별 합계 */
  @Get()
  report(@Query('run') run?: string) {
    const id = run ? Number.parseInt(run, 10) || undefined : undefined;
    return this.cache.get(String(id ?? 'now'), () => this.maintenance.report(id));
  }
}
