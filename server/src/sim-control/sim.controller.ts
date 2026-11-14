import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { FACTORY, REASON_MAX, SIM_SPEEDS, STATION_OPS, STATIONS, type ActorInfo, type SimCommand, type StationOp } from '@lumitwin/shared';
import { clientIp } from '../access/access';
import { AuditService } from '../auth/audit.service';
import { stationOpPerm } from '../auth/auth.core';
import { Actor, assertCan, LoginRequired, Perm } from '../auth/perm.decorator';
import { MqttBrokerService } from '../mqtt/mqtt-broker.service';
import { LiveService } from '../live/live.service';

/**
 * 시뮬레이터 제어. 화면 → REST → MQTT 명령 토픽(lt/v1/cmd) → 가상 PLC.
 * 실제 공장이라면 이 자리가 설비 원격 정지·재가동 같은 제어 명령이다: 역할 권한(@Perm)을 확인하고 감사 기록을 남긴다.
 */
@Controller('sim')
export class SimController {
  constructor(
    private readonly mqtt: MqttBrokerService,
    private readonly live: LiveService,
    private readonly audit: AuditService,
  ) {}

  @Get('status')
  status() {
    const t = this.live.tick();
    return {
      connected: t.connected.sim,
      sim: t.sim,
      link: t.sim?.link ?? 'mqtt',
      gateway: t.connected.edge ? t.edge : null,
      edgeClients: this.mqtt.clientCount,
      received: this.mqtt.received,
    };
  }

  @Post('speed')
  @HttpCode(202)
  @Perm('sim.control')
  async speed(@Body() body: { speed?: unknown }, @Actor() who: ActorInfo, @Req() req: Request) {
    const speed = Number(body?.speed);
    if (!(SIM_SPEEDS as readonly number[]).includes(speed)) throw new BadRequestException(`배속은 ${SIM_SPEEDS.join('·')} 중 하나입니다`);
    const r = await this.send({ action: 'speed', speed });
    await this.audit.log(who, 'sim.speed', null, { speed }, clientIp(req));
    return r;
  }

  @Post('pause')
  @HttpCode(202)
  @Perm('sim.control')
  async pause(@Actor() who: ActorInfo, @Req() req: Request) {
    const r = await this.send({ action: 'pause' });
    await this.audit.log(who, 'sim.pause', null, null, clientIp(req));
    return r;
  }

  @Post('resume')
  @HttpCode(202)
  @Perm('sim.control')
  async resume(@Actor() who: ActorInfo, @Req() req: Request) {
    const r = await this.send({ action: 'resume' });
    await this.audit.log(who, 'sim.resume', null, null, clientIp(req));
    return r;
  }

  @Post('reset')
  @HttpCode(202)
  @Perm('sim.control')
  async reset(@Actor() who: ActorInfo, @Req() req: Request) {
    const r = await this.send({ action: 'reset' });
    await this.audit.log(who, 'sim.reset', null, null, clientIp(req));
    return r;
  }

  @Post('scenario')
  @HttpCode(202)
  @Perm('sim.control')
  async scenario(@Body() body: { id?: unknown; on?: unknown }, @Actor() who: ActorInfo, @Req() req: Request) {
    const id = String(body?.id ?? '');
    const sc = FACTORY.scenarios.find((s) => s.id === id);
    if (!sc) throw new BadRequestException(`시나리오 ${id}이(가) 없습니다`);
    const on = Boolean(body?.on);
    const r = await this.send({ action: 'scenario', id, on });
    await this.audit.log(who, 'sim.scenario', id, { on, name: sc.name }, clientIp(req));
    return r;
  }

  /** 설비 명령: 로그인만 가드가 보고, 권한은 명령에 따라 고른다 (수리 완료·보전 실시는 보전 권한) */
  @Post('station')
  @HttpCode(202)
  @LoginRequired()
  async station(@Body() body: { code?: unknown; op?: unknown; reason?: unknown }, @Actor() who: ActorInfo, @Req() req: Request) {
    const code = String(body?.code ?? '');
    const op = String(body?.op ?? '') as StationOp;
    if (!STATIONS[code]) throw new BadRequestException(`설비 ${code}이(가) 없습니다`);
    if (!STATION_OPS.includes(op)) throw new BadRequestException(`명령은 ${STATION_OPS.join('·')} 중 하나입니다`);
    assertCan(who, stationOpPerm(op));
    // 작업자 태블릿이 고른 비가동 사유. 화면에 그대로 보이므로 줄바꿈을 지우고 길이를 자른다
    const reason = typeof body?.reason === 'string' ? body.reason.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX) : '';
    const r = await this.send({ action: 'station', code, op, ...(reason ? { reason } : {}) });
    await this.audit.log(who, `station.${op}`, code, reason ? { reason } : null, clientIp(req));
    return r;
  }

  private async send(cmd: SimCommand) {
    if (!this.live.tick().connected.sim) throw new BadRequestException('시뮬레이터가 연결되어 있지 않습니다 (npm run sim)');
    await this.mqtt.sendCommand(cmd);
    return { sent: cmd };
  }
}
