import { BadRequestException, Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { FACTORY, REASON_MAX, SIM_SPEEDS, STATION_OPS, STATIONS, type SimCommand, type StationOp } from '@lumitwin/shared';
import { MqttBrokerService } from '../mqtt/mqtt-broker.service';
import { LiveService } from '../live/live.service';

/**
 * 시뮬레이터 제어. 화면 → REST → MQTT 명령 토픽(lt/v1/cmd) → 가상 PLC.
 * 실제 공장이라면 이 자리가 설비 원격 정지·재가동 같은 제어 명령이고, 권한과 이력 관리가 붙는다.
 */
@Controller('sim')
export class SimController {
  constructor(
    private readonly mqtt: MqttBrokerService,
    private readonly live: LiveService,
  ) {}

  @Get('status')
  status() {
    const t = this.live.tick();
    return { connected: t.connected.sim, sim: t.sim, edgeClients: this.mqtt.clientCount, received: this.mqtt.received };
  }

  @Post('speed')
  @HttpCode(202)
  speed(@Body() body: { speed?: unknown }) {
    const speed = Number(body?.speed);
    if (!(SIM_SPEEDS as readonly number[]).includes(speed)) throw new BadRequestException(`배속은 ${SIM_SPEEDS.join('·')} 중 하나입니다`);
    return this.send({ action: 'speed', speed });
  }

  @Post('pause')
  @HttpCode(202)
  pause() {
    return this.send({ action: 'pause' });
  }

  @Post('resume')
  @HttpCode(202)
  resume() {
    return this.send({ action: 'resume' });
  }

  @Post('reset')
  @HttpCode(202)
  reset() {
    return this.send({ action: 'reset' });
  }

  @Post('scenario')
  @HttpCode(202)
  scenario(@Body() body: { id?: unknown; on?: unknown }) {
    const id = String(body?.id ?? '');
    if (!FACTORY.scenarios.some((s) => s.id === id)) throw new BadRequestException(`시나리오 ${id}이(가) 없습니다`);
    return this.send({ action: 'scenario', id, on: Boolean(body?.on) });
  }

  @Post('station')
  @HttpCode(202)
  station(@Body() body: { code?: unknown; op?: unknown; reason?: unknown }) {
    const code = String(body?.code ?? '');
    const op = String(body?.op ?? '') as StationOp;
    if (!STATIONS[code]) throw new BadRequestException(`설비 ${code}이(가) 없습니다`);
    if (!STATION_OPS.includes(op)) throw new BadRequestException(`명령은 ${STATION_OPS.join('·')} 중 하나입니다`);
    // 작업자 태블릿이 고른 비가동 사유. 화면에 그대로 보이므로 줄바꿈을 지우고 길이를 자른다
    const reason = typeof body?.reason === 'string' ? body.reason.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX) : '';
    return this.send({ action: 'station', code, op, ...(reason ? { reason } : {}) });
  }

  private async send(cmd: SimCommand) {
    if (!this.live.tick().connected.sim) throw new BadRequestException('시뮬레이터가 연결되어 있지 않습니다 (npm run sim)');
    await this.mqtt.sendCommand(cmd);
    return { sent: cmd };
  }
}
