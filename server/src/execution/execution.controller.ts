import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { ActorInfo, HoldCreate, HoldReleaseInput, NcrDisposeInput, WorkOrderCreate, WorkOrderPatch, WorkOrderReorder } from '@lumitwin/shared';
import { clientIp } from '../access/access';
import { Actor, Perm } from '../auth/perm.decorator';
import { ExecutionService } from './execution.service';

/** 감사 기록용 접속 IP (공개 링크·Cloudflare 경로에서도 실제 접속 IP) */
const Ip = createParamDecorator((_: unknown, ctx: ExecutionContext): string => clientIp(ctx.switchToHttp().getRequest<Request>()));

/**
 * 실행 MES API: 작업지시·생산 계획, 불량 처리(NCR), Hold, 인터록 기록, 라인 실행 요약.
 * 조회는 열려 있고, 상태를 바꾸는 요청은 권한(@Perm)이 필요하며 감사 기록을 남긴다
 */
@Controller()
export class ExecutionController {
  constructor(private readonly exec: ExecutionService) {}

  // ── 작업지시 ──

  @Get('orders')
  orders(@Query('line') line?: string, @Query('status') status?: string) {
    return this.exec.orders(line || undefined, status || undefined);
  }

  @Post('orders')
  @Perm('wo.manage')
  createOrder(@Body() body: WorkOrderCreate, @Actor() who: ActorInfo, @Ip() ip: string) {
    return this.exec.createOrder(body, who, ip);
  }

  @Post('orders/reorder')
  @HttpCode(200)
  @Perm('wo.manage')
  reorder(@Body() body: WorkOrderReorder, @Actor() who: ActorInfo, @Ip() ip: string) {
    return this.exec.reorderOrders(body, who, ip);
  }

  @Patch('orders/:id')
  @Perm('wo.manage')
  updateOrder(@Param('id', ParseIntPipe) id: number, @Body() body: WorkOrderPatch, @Actor() who: ActorInfo, @Ip() ip: string) {
    return this.exec.updateOrder(id, body, who, ip);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  @Perm('wo.manage')
  cancelOrder(@Param('id', ParseIntPipe) id: number, @Actor() who: ActorInfo, @Ip() ip: string) {
    return this.exec.cancelOrder(id, who, ip);
  }

  // ── 불량 처리 (NCR) ──

  @Get('ncr')
  ncrList(@Query('status') status?: string, @Query('line') line?: string) {
    return this.exec.ncrList(status || undefined, line || undefined);
  }

  @Get('ncr/:id')
  ncr(@Param('id', ParseIntPipe) id: number) {
    return this.exec.ncrDetail(id);
  }

  @Post('ncr/:id/disposition')
  @HttpCode(200)
  @Perm('ncr.dispose')
  dispose(@Param('id', ParseIntPipe) id: number, @Body() body: NcrDisposeInput, @Actor() who: ActorInfo, @Ip() ip: string) {
    return this.exec.disposeNcr(id, body, who, ip);
  }

  // ── Hold ──

  @Get('holds')
  holds(@Query('status') status?: string) {
    return this.exec.holdList(status || undefined);
  }

  @Get('holds/:id')
  hold(@Param('id', ParseIntPipe) id: number) {
    return this.exec.holdDetail(id);
  }

  @Post('holds')
  @Perm('hold.create')
  createHold(@Body() body: HoldCreate, @Actor() who: ActorInfo, @Ip() ip: string) {
    return this.exec.createHold(body, who, ip);
  }

  @Post('holds/:id/release')
  @HttpCode(200)
  @Perm('hold.release')
  releaseHold(@Param('id', ParseIntPipe) id: number, @Body() body: HoldReleaseInput, @Actor() who: ActorInfo, @Ip() ip: string) {
    return this.exec.releaseHold(id, body, who, ip);
  }

  // ── 인터록·요약 ──

  @Get('interlock')
  interlock(@Query('line') line?: string, @Query('station') station?: string) {
    return this.exec.interlock(line || undefined, station || undefined);
  }

  @Get('execution/summary')
  summary() {
    return this.exec.summary();
  }
}
