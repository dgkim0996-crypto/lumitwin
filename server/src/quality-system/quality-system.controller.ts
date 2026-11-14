import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { ActorInfo, ChangeRequest } from '@lumitwin/shared';
import { clientIp } from '../access/access';
import { AuditService } from '../auth/audit.service';
import { Actor, Perm } from '../auth/perm.decorator';
import { QualitySystemService } from './quality-system.service';

/** 품질 시스템 API: 4M 변경점(조회·신고·승인), 초·중·종물 검사 기록, 설비별 초물 대기 */
@Controller()
export class QualitySystemController {
  constructor(
    private readonly quality: QualitySystemService,
    private readonly audit: AuditService,
  ) {}

  @Get('changes')
  changes(
    @Query('line') line?: string,
    @Query('station') station?: string,
    @Query('category') category?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.quality.changes({ line, station, category, from, to, limit });
  }

  /** 변경점 신고 (작업자 태블릿·변경점 화면) */
  @Post('changes')
  @Perm('change.register')
  async register(@Body() body: ChangeRequest, @Actor() who: ActorInfo, @Req() req: Request) {
    const v = await this.quality.register(body, who);
    await this.audit.log(who, 'change.register', v.station, { id: v.id, simId: v.simId, category: v.category, kind: v.kind, detail: v.detail, fa: v.faStatus === 'PENDING' }, clientIp(req));
    return v;
  }

  /** 변경점 승인 (품질 확인 서명) */
  @Post('changes/:id/approve')
  @Perm('change.approve')
  async approve(@Param('id', ParseIntPipe) id: number, @Actor() who: ActorInfo, @Req() req: Request) {
    const v = await this.quality.approve(id, who);
    await this.audit.log(who, 'change.approve', v.station, { id: v.id, simId: v.simId, faStatus: v.faStatus, faSerial: v.faSerial }, clientIp(req));
    return v;
  }

  @Get('inspections')
  inspections(
    @Query('line') line?: string,
    @Query('station') station?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.quality.inspections({ line, station, type, from, to, limit });
  }

  /** 수동 초물 판정 (설비 단위, 품질 확인 권한). 몸통 { result: 'OK'|'NG', serial?, note? } */
  @Post('quality-system/fa/:station')
  @Perm('change.approve')
  async manualFirst(@Param('station') station: string, @Body() body: { result?: string; serial?: string; note?: string }, @Actor() who: ActorInfo, @Req() req: Request) {
    const v = await this.quality.manualFirst(station, body, who);
    const note = typeof body?.note === 'string' ? body.note.slice(0, 200) : undefined;
    await this.audit.log(who, 'change.first-article', station, { result: v.result, serial: v.serial, resolved: v.resolved, ...(note ? { note } : {}) }, clientIp(req));
    return v;
  }

  /** 설비별 초물 대기 (메모리, 인터록과 같은 답) */
  @Get('quality-system/fa-status')
  faStatus() {
    return this.quality.faStatus();
  }
}
