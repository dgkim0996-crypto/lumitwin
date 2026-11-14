import { Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { STATIONS, type ActorInfo } from '@lumitwin/shared';
import { clientIp } from '../access/access';
import { AuditService } from '../auth/audit.service';
import { Actor, Perm } from '../auth/perm.decorator';
import { LiveService } from './live.service';

@Controller('live')
export class LiveController {
  constructor(
    private readonly live: LiveService,
    private readonly audit: AuditService,
  ) {}

  @Get('snapshot')
  snapshot() {
    return this.live.snapshot();
  }

  @Get('spc')
  spcSummary() {
    return this.live.spcSummary();
  }

  @Get('spc/:station')
  spc(@Param('station') station: string) {
    if (!STATIONS[station]) throw new NotFoundException(`설비 ${station}이(가) 없습니다`);
    return this.live.spc(station);
  }

  /** 6대 로스: 설비·라인·공장별 시간 구성 */
  @Get('losses')
  losses() {
    return this.live.losses();
  }

  @Get('alarms')
  alarms() {
    return this.live.alarmList;
  }

  /** 알람 확인: 누가 확인했는지 감사 기록에 남긴다 (이미 확인된 알람은 다시 남기지 않는다) */
  @Post('alarms/:id/ack')
  @Perm('alarm.ack')
  async ack(@Param('id', ParseIntPipe) id: number, @Actor() who: ActorInfo, @Req() req: Request) {
    const was = this.live.alarmList.find((x) => x.id === id)?.acked;
    const a = this.live.ack(id);
    if (!a) throw new NotFoundException(`알람 ${id}이(가) 없습니다`);
    if (!was) await this.audit.log(who, 'alarm.ack', a.station, { id: a.id, kind: a.kind, severity: a.severity, title: a.title }, clientIp(req));
    return a;
  }
}
