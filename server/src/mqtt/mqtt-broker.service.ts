import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createServer, type Server } from 'node:net';
import { Aedes } from 'aedes';
import { TOPIC_ROOT, TOPICS, type SimCommand } from '@lumitwin/shared';

/** 토픽 하나를 받은 쪽에 넘기는 형태 */
export interface MqttInbound {
  topic: string;
  /** lt/v1 뒤의 경로 조각 (예: ['HL', 'HL-IM-L1', 'tags']) */
  parts: string[];
  payload: unknown;
}

type Handler = (msg: MqttInbound) => void;

/**
 * MES 안에 둔 MQTT 브로커 (aedes). 가상 엣지(시뮬레이터)가 여기로 태그·상태·가공 결과를 발행하고,
 * MES는 브로커의 publish 훅에서 바로 읽는다. 별도 브로커(Mosquitto 등)를 띄우지 않아도 되게 한 선택이다.
 * 실제 공장이라면 엣지 게이트웨이 → 외부 브로커(EMQX·Mosquitto) → MES 구독으로 바뀌고, 토픽 규칙은 그대로 쓴다.
 */
@Injectable()
export class MqttBrokerService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('MQTT');
  private broker: Aedes | null = null;
  private server: Server | null = null;
  private readonly handlers: Handler[] = [];
  private readonly clients = new Set<string>();
  /** 마지막으로 받은 시각 (ms, 실제 시계). 시뮬레이터 연결 여부 판단에 쓴다 */
  lastInboundAt = 0;
  received = 0;
  malformed = 0;

  readonly port = Number(process.env.MQTT_PORT ?? 1884);
  /** 받을 주소. 서버 한 대 배포에서는 127.0.0.1 로 두어 같은 서버의 시뮬레이터만 붙게 한다 (기본: 모든 주소, 다른 PC의 엣지도 받음) */
  readonly bind = process.env.MQTT_BIND || undefined;

  onMessage(handler: Handler): void {
    this.handlers.push(handler);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async onModuleInit(): Promise<void> {
    const broker = await Aedes.createBroker({ id: 'lumitwin-mes' });
    this.broker = broker;
    broker.on('client', (c) => {
      this.clients.add(c.id);
      this.logger.log(`엣지 접속: ${c.id}`);
    });
    broker.on('clientDisconnect', (c) => {
      this.clients.delete(c.id);
      this.logger.log(`엣지 끊김: ${c.id}`);
    });
    broker.on('publish', (packet, client) => {
      // client가 null이면 브로커 자신($SYS 등) 또는 MES가 보낸 명령이다
      if (!client || !packet.topic.startsWith(`${TOPIC_ROOT}/`)) return;
      let payload: unknown;
      try {
        payload = JSON.parse(packet.payload.toString());
      } catch {
        this.malformed++;
        return;
      }
      this.received++;
      this.lastInboundAt = Date.now();
      const msg: MqttInbound = { topic: packet.topic, parts: packet.topic.slice(TOPIC_ROOT.length + 1).split('/'), payload };
      for (const h of this.handlers) {
        try {
          h(msg);
        } catch (e) {
          this.logger.error(`처리 실패 ${packet.topic}: ${(e as Error).message}`);
        }
      }
    });
  }

  /**
   * 접속은 모든 모듈 초기화(실시간 집계 복원 포함)가 끝난 뒤에 받는다.
   * 복원 도중 들어온 값이 복원 결과에 덮여 사라지지 않게 하려는 것이다. 시뮬레이터는 1~5초 간격으로 다시 붙는다
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.broker) throw new Error('브로커가 만들어지지 않았습니다');
    const server = createServer(this.broker.handle);
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.bind, () => resolve());
    });
    this.logger.log(`브로커 대기 중: mqtt://${this.bind ?? 'localhost'}:${this.port}`);
  }

  /** 시뮬레이터(가상 PLC)에 명령을 보낸다 */
  sendCommand(cmd: SimCommand): Promise<void> {
    return this.publish(TOPICS.cmd, cmd);
  }

  publish(topic: string, obj: unknown): Promise<void> {
    const broker = this.broker;
    if (!broker) return Promise.reject(new Error('브로커가 아직 준비되지 않았습니다'));
    return new Promise((resolve, reject) => {
      broker.publish(
        { cmd: 'publish', topic, payload: Buffer.from(JSON.stringify(obj)), qos: 1, retain: false, dup: false },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    await new Promise<void>((r) => (this.broker ? this.broker.close(() => r()) : r()));
  }
}
