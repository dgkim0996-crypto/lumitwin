import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { SOCKET } from '@lumitwin/shared';
import type { Server, Socket } from 'socket.io';
import { LiveService } from './live.service';

const TICK_MS = 500;
/** 가공 결과는 배속이 높으면 초당 수십 건이라, 모아서 한 번에 보낸다 */
const UNIT_FLUSH_MS = 250;

/**
 * 실시간 화면 연결. 접속하면 전체 스냅샷을 한 번 주고, 이후 0.5초마다 상태(tick)를 보낸다.
 * 가공 결과·알람·시뮬레이터 이벤트는 생길 때 보낸다.
 */
@WebSocketGateway({ cors: { origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5180').split(','), credentials: true } })
export class LiveGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Socket');
  @WebSocketServer() server: Server;
  private timers: NodeJS.Timeout[] = [];
  private units: unknown[] = [];

  constructor(private readonly live: LiveService) {}

  onModuleInit(): void {
    this.live.events.on('unit', (u) => this.units.push(u));
    this.live.events.on('alarm', (a) => this.server?.emit(SOCKET.alarm, a));
    this.live.events.on('event', (e) => this.server?.emit(SOCKET.event, e));
    this.timers.push(
      setInterval(() => {
        if (this.server && this.server.engine.clientsCount > 0) this.server.emit(SOCKET.tick, this.live.tick());
      }, TICK_MS),
      setInterval(() => {
        if (!this.units.length) return;
        const batch = this.units;
        this.units = [];
        if (this.server && this.server.engine.clientsCount > 0) this.server.emit(SOCKET.unit, batch);
      }, UNIT_FLUSH_MS),
    );
  }

  handleConnection(client: Socket): void {
    client.emit(SOCKET.snapshot, this.live.snapshot());
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
    this.logger.log('실시간 연결 종료');
  }
}
