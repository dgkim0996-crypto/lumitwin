import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { CheckRequest } from '@lumitwin/shared';
import { OperatorService } from './operator.service';

/** 작업자 태블릿 API. 설비 정지·재가동은 /sim/station(가상 PLC 명령)으로 따로 보낸다 */
@Controller('operator')
export class OperatorController {
  constructor(private readonly operator: OperatorService) {}

  @Get('checks')
  checks(@Query('station') station?: string, @Query('limit') limit?: string) {
    return this.operator.checks(station || undefined, limit ? Number(limit) || 10 : 10);
  }

  @Post('checks')
  saveCheck(@Body() body: CheckRequest) {
    return this.operator.saveCheck(body);
  }
}
