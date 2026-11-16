import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { ActorInfo, WhatIfApplyResult } from '@lumitwin/shared';
import { clientIp } from '../access/access';
import { AuditService } from '../auth/audit.service';
import { Actor, Perm } from '../auth/perm.decorator';
import { WhatIfService } from './whatif.service';

/**
 * What-if 계획 시뮬레이션 API (P11).
 * 계산 요청(POST /whatif/runs)은 저장한 실행을 바로 돌려주고 시뮬레이터는 뒤에서 돈다. 화면은 GET /whatif/runs/:id로 진행률·결과를 본다.
 * 보기 전용(공개 링크) 접속은 POST가 막히므로 저장된 결과만 본다
 */
@Controller('whatif')
export class WhatIfController {
  constructor(
    private readonly whatif: WhatIfService,
    private readonly audit: AuditService,
  ) {}

  /** 지금 기준 상태 미리 보기 (source = live 기본 · clean) */
  @Get('base')
  base(@Query('source') source?: string) {
    return this.whatif.preview(source);
  }

  @Post('runs')
  @Perm('whatif.run')
  async create(@Body() body: unknown, @Actor() who: ActorInfo, @Req() req: Request) {
    const view = await this.whatif.create(body, who);
    const r = view.request;
    await this.audit.log(who, 'whatif.run', `What-if #${view.id}`, { base: r.base, horizonH: r.horizonH, reps: r.reps, scenarios: r.scenarios.map((s) => s.name) }, clientIp(req));
    return view;
  }

  @Get('runs')
  list(@Query('limit') limit?: string) {
    return this.whatif.list(limit ? Number(limit) : 10);
  }

  @Get('runs/:id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.whatif.detail(id);
  }

  /** 계획 하나의 라인 작업지시 순서를 MES 대기 순서에 반영 (작업지시 관리 권한) */
  @Post('runs/:id/apply')
  @HttpCode(200)
  @Perm('wo.manage')
  async apply(@Param('id', ParseIntPipe) id: number, @Body() body: unknown, @Actor() who: ActorInfo, @Req() req: Request): Promise<WhatIfApplyResult> {
    const ip = clientIp(req);
    const { scenarioName, ...out } = await this.whatif.apply(id, body, who, ip);
    await this.audit.log(who, 'whatif.apply', `What-if #${id}`, { scenario: scenarioName, ...out }, ip);
    return out;
  }
}
