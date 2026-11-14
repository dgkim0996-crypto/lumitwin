import { Injectable, Logger } from '@nestjs/common';
import type { ActorInfo } from '@lumitwin/shared';
import { Prisma } from '../generated/prisma/client';
import { LiveService } from '../live/live.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionWriter } from '../production/production.writer';

/** 로그인하지 않은 사람 (로그인 실패 기록용). 권한 판정에는 쓰지 않는다 */
export const ANONYMOUS = { login: 'anonymous', role: 'none' } as const;

/**
 * 감사 기록: 누가 언제 무엇을 바꿨나. 상태를 바꾸는 요청(설비 조작·작업지시·불량 판정·Hold·변경점·로그인)마다 남긴다.
 * 기록이 실패해도 요청 자체는 막지 않는다 (로그만 남김)
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly writer: ProductionWriter,
  ) {}

  async log(actor: ActorInfo, action: string, target?: string | null, detail?: Record<string, unknown> | null, ip?: string | null): Promise<void> {
    await this.write(actor.login, actor.role, action, target, detail, ip);
  }

  /** 로그인 전 요청 (로그인 실패 등): 사용자 칸은 anonymous */
  async logAnonymous(action: string, target?: string | null, detail?: Record<string, unknown> | null, ip?: string | null): Promise<void> {
    await this.write(ANONYMOUS.login, ANONYMOUS.role, action, target, detail, ip);
  }

  private async write(user: string, role: string, action: string, target?: string | null, detail?: Record<string, unknown> | null, ip?: string | null): Promise<void> {
    try {
      const v = this.live.virtualNow;
      await this.prisma.actionLog.create({
        data: {
          runId: this.writer.currentRunId,
          vAt: v ? new Date(v) : null,
          user,
          role,
          action,
          target: target ?? null,
          detail: detail ? (detail as Prisma.InputJsonValue) : Prisma.DbNull,
          ip: ip ?? null,
        },
      });
    } catch (e) {
      this.logger.error(`감사 기록 실패 ${action}: ${(e as Error).message}`);
    }
  }
}
