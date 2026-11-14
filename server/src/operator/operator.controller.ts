import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SYSTEM_ACTOR, type ActorInfo, type CheckRequest } from '@lumitwin/shared';
import { clientIp } from '../access/access';
import { AuditService } from '../auth/audit.service';
import { Actor, Perm } from '../auth/perm.decorator';
import { OperatorService } from './operator.service';

/** 작업자 태블릿 API. 설비 정지·재가동은 /sim/station(가상 PLC 명령)으로 따로 보낸다 */
@Controller('operator')
export class OperatorController {
  constructor(
    private readonly operator: OperatorService,
    private readonly audit: AuditService,
  ) {}

  @Get('checks')
  checks(@Query('station') station?: string, @Query('limit') limit?: string) {
    return this.operator.checks(station || undefined, limit ? Number(limit) || 10 : 10);
  }

  /** 작업 전 점검 저장. 점검자를 비워 두면 로그인한 사람 이름으로 남긴다 (인증을 끄면 비운 그대로) */
  @Post('checks')
  @Perm('check.record')
  async saveCheck(@Body() body: CheckRequest, @Actor() who: ActorInfo, @Req() req: Request) {
    const typed = typeof body?.by === 'string' ? body.by.trim() : '';
    const by = typed || (who.login !== SYSTEM_ACTOR.login ? who.name : '');
    const row = await this.operator.saveCheck({ ...body, by });
    await this.audit.log(who, 'check.record', row.station, { id: row.id, items: row.items.length, ngCount: row.ngCount, by: row.by }, clientIp(req));
    return row;
  }
}
