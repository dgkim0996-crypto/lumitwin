import { Controller, Get, NotFoundException, Param, ParseIntPipe, Post } from '@nestjs/common';
import { STATIONS } from '@lumitwin/shared';
import { LiveService } from './live.service';

@Controller('live')
export class LiveController {
  constructor(private readonly live: LiveService) {}

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

  @Get('alarms')
  alarms() {
    return this.live.alarmList;
  }

  @Post('alarms/:id/ack')
  ack(@Param('id', ParseIntPipe) id: number) {
    const a = this.live.ack(id);
    if (!a) throw new NotFoundException(`알람 ${id}이(가) 없습니다`);
    return a;
  }
}
