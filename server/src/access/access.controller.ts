import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessInfo } from '@lumitwin/shared';
import { accessOf } from './access';

@Controller('access')
export class AccessController {
  /** 화면이 조작 버튼을 막을지 정할 때 묻는다 (제어 키를 머리글에 실으면 그 키로 판단) */
  @Get()
  info(@Req() req: Request): AccessInfo {
    return accessOf(req);
  }
}
