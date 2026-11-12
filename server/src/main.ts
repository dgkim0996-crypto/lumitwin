import 'dotenv/config';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { readOnlyGuard } from './access/access';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 종료 신호에 브로커·소켓·DB 기록 큐를 정리하고 나간다 (기동 때는 LiveRestoreService가 실시간 집계를 DB에서 되살린다)
  app.enableShutdownHooks();
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5180').split(','), credentials: true });
  // 앞에 같은 서버의 프록시(Caddy·Next)가 있을 때만 X-Forwarded-For를 믿는다 (AI 비서 질문 한도를 사용자 IP별로 센다)
  app.set('trust proxy', 'loopback');
  // 공개 링크(Cloudflare Tunnel)로 들어온 방문자는 보기 전용: 설비·시뮬레이터를 바꾸는 요청을 막는다 (READ_ONLY·CONTROL_KEY)
  app.use(readOnlyGuard());
  const port = Number(process.env.API_PORT ?? 8790);
  // API_HOST=127.0.0.1 이면 같은 서버의 프록시만 받는다 (배포). 기본은 모든 주소
  const host = process.env.API_HOST || undefined;
  if (host) await app.listen(port, host);
  else await app.listen(port);
  new Logger('MES').log(`API http://${host ?? 'localhost'}:${port}/api/v1 · 실시간 socket.io 같은 포트${process.env.NODE_ENV === 'production' ? ' · 운영 모드' : ''}`);
}
void bootstrap();
