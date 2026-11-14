import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { LiveModule } from '../live/live.module';
import { ProductionModule } from '../production/production.module';
import { AuditService } from './audit.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

/**
 * 로그인·역할·감사 기록 (P9). 전역 모듈: 다른 모듈은 import 없이 AuditService·AuthService를 주입받는다.
 * 권한 검사는 처리기에 @Perm('...')을 붙이면 AuthGuard(APP_GUARD)가 한다. 인증은 AUTH=on|off (server/.env, 기본 on)
 */
@Global()
@Module({
  imports: [LiveModule, ProductionModule],
  controllers: [AuthController],
  providers: [AuditService, AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuditService, AuthService],
})
export class AuthModule {}
