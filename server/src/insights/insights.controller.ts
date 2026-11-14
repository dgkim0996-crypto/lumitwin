import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TtlCache } from '../common/ttl-cache';
import { EnergyService } from './energy.service';
import { HealthService } from './health.service';
import { ReportsService } from './reports.service';

const runOf = (run?: string) => (run ? Number.parseInt(run, 10) || undefined : undefined);

/** 에너지 계산은 구간의 상태 기록을 모두 훑어 무겁다. 같은 조건은 3초 동안 같이 쓴다 (화면은 10초마다 다시 부른다) */
const ENERGY_TTL_MS = 3_000;

/** 교대 일보·에너지 (조회만: 상태를 바꾸지 않으므로 권한 없이 열린다) */
@Controller()
export class InsightsController {
  private readonly energyCache = new TtlCache<Awaited<ReturnType<EnergyService['report']>>>(ENERGY_TTL_MS);

  constructor(
    private readonly reports: ReportsService,
    private readonly energy: EnergyService,
  ) {}

  /** 고를 수 있는 교대 목록 (새것부터) */
  @Get('reports/shifts')
  shifts(@Query('run') run?: string) {
    return this.reports.shifts(runOf(run));
  }

  /** 교대 일보: ?key=2026-11-13-D&line=HL */
  @Get('reports/shift')
  shift(@Query('key') key: string, @Query('line') line?: string, @Query('run') run?: string) {
    return this.reports.shift(key, line || undefined, runOf(run));
  }

  /** 교대 일보 CSV 내려받기 (엑셀용 UTF-8 BOM) */
  @Get('reports/shift.csv')
  async csv(@Query('key') key: string, @Res({ passthrough: true }) res: Response, @Query('run') run?: string) {
    const text = await this.reports.csv(key, runOf(run));
    const name = `교대일보-${key}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shift-report-${key.replace(/[^\w-]/g, '')}.csv"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Cache-Control', 'no-store');
    return text;
  }

  /** 에너지: ?from=&to=(ISO)&line= · from 대신 hours=8(지금부터 거슬러 몇 시간, 기본 24) */
  @Get('energy')
  energyReport(@Query('from') from?: string, @Query('to') to?: string, @Query('line') line?: string, @Query('hours') hours?: string, @Query('run') run?: string) {
    const q = { from, to, hours, line: line || undefined, run: runOf(run) };
    return this.energyCache.get(JSON.stringify(q), () => this.energy.report(q));
  }
}

/** 예지 보전 (상태 감시): 설비 보전 화면의 '예지 보전' 영역 */
@Controller('maintenance/health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  view() {
    return this.health.view();
  }

  @Get(':station')
  detail(@Param('station') station: string) {
    return this.health.detail(station);
  }
}
