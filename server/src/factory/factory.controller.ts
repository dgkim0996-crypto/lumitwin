import { Controller, Get } from '@nestjs/common';
import { DEFECT_NAMES, FACTORY } from '@lumitwin/shared';
import { MqttBrokerService } from '../mqtt/mqtt-broker.service';
import { LiveService } from '../live/live.service';

@Controller()
export class FactoryController {
  constructor(
    private readonly mqtt: MqttBrokerService,
    private readonly live: LiveService,
  ) {}

  /** 공장 정의 (라인·공정·설비·태그·불량 인과·시나리오). 화면과 챗봇이 같은 원본을 본다 */
  @Get('factory')
  factory() {
    return { ...FACTORY, defectNames: DEFECT_NAMES };
  }

  @Get('health')
  health() {
    return { ok: true, mqtt: { port: this.mqtt.port, clients: this.mqtt.clientCount, received: this.mqtt.received }, virtualNow: this.live.virtualNow };
  }
}
