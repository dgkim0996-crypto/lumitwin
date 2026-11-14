import {
  type ArgumentsHost,
  BadRequestException,
  Body,
  type CallHandler,
  Catch,
  Controller,
  type ExceptionFilter,
  type ExecutionContext,
  Get,
  Injectable,
  type NestInterceptor,
  Param,
  ParseIntPipe,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { LINES, TBM_AUDIO_MAX_BYTES, type ActorInfo, type LineCode, type TbmFollowUpInput } from '@lumitwin/shared';
import { clientIp } from '../access/access';
import { AuditService } from '../auth/audit.service';
import { Actor, Perm } from '../auth/perm.decorator';
import { TbmService, type TbmUpload } from './tbm.service';

function line(v: unknown): LineCode {
  if (typeof v === 'string' && LINES.some((l) => l.code === v)) return v as LineCode;
  throw new BadRequestException('라인(HL·EM·OSM)을 골라 주세요');
}

/** multipart 머리·글 칸 몫 (assumed: 실제로는 1KB 안팎) */
const FORM_OVERHEAD = 64 * 1024;

/**
 * 본문을 읽기 전에 Content-Length로 크기를 본다. multer는 한도를 넘어도 요청 본문이 끝나기를 기다린 뒤 답하므로,
 * 앞단 프록시(Next rewrites, 26MB)가 본문을 자르면 끝이 오지 않아 30초 뒤 500이 난다. 머리만 보고 바로 413으로 끊는다
 */
@Injectable()
export class TbmSizeCheck implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const len = Number(ctx.switchToHttp().getRequest<Request>().headers['content-length']);
    if (Number.isFinite(len) && len > TBM_AUDIO_MAX_BYTES + FORM_OVERHEAD) throw new PayloadTooLargeException();
    return next.handle();
  }
}

/** 한도를 넘은 파일은 Nest 기본 문구("File too large") 대신 한국어로 알린다 */
@Catch(PayloadTooLargeException)
export class TbmTooLargeFilter implements ExceptionFilter {
  catch(_e: PayloadTooLargeException, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(413)
      .json({ statusCode: 413, error: 'Payload Too Large', message: `음성 파일은 ${TBM_AUDIO_MAX_BYTES / 1024 / 1024}MB 이하여야 합니다 (받아쓰기 서버 한도). 녹음을 나눠 올려 주세요` });
  }
}

/**
 * TBM 회의 체크리스트 대조 API.
 * 올리기(POST /tbm/meetings)는 회의 기록을 바로 돌려주고 받아쓰기·대조는 뒤에서 한다. 화면은 GET /tbm/meetings/:id로 상태를 본다
 */
@Controller('tbm')
export class TbmController {
  constructor(
    private readonly tbm: TbmService,
    private readonly audit: AuditService,
  ) {}

  /** 그 라인의 체크리스트 (원청·안전팀 고정 항목 + 지금 MES 상태 자동 항목) */
  @Get('checklist')
  checklist(@Query('line') l?: string) {
    return this.tbm.checklist(line(l));
  }

  /** 예시 대화록 (파일 없이 기능을 볼 때) */
  @Get('sample')
  sample(@Query('line') l?: string) {
    return this.tbm.sample(line(l));
  }

  @Get('meetings')
  meetings(@Query('line') l?: string, @Query('limit') limit?: string) {
    return this.tbm.list(l || undefined, limit ? Number(limit) : 20);
  }

  @Get('meetings/:id')
  meeting(@Param('id', ParseIntPipe) id: number) {
    return this.tbm.detail(id);
  }

  /** 회의 올리기: multipart(file + line + shift) 또는 대화록 글(text) */
  @Post('meetings')
  @Perm('tbm.record')
  @UseFilters(TbmTooLargeFilter)
  @UseInterceptors(TbmSizeCheck, FileInterceptor('file', { limits: { fileSize: TBM_AUDIO_MAX_BYTES + 1024 } }))
  async upload(@Body() body: Record<string, unknown>, @Actor() who: ActorInfo, @Req() req: Request, @UploadedFile() file?: TbmUpload) {
    const view = await this.tbm.create(body ?? {}, file, who);
    await this.audit.log(who, 'tbm.upload', `TBM #${view.id}`, { line: view.line, shift: view.shift, input: view.input, fileName: view.fileName, bytes: file?.size ?? null, mode: view.mode }, clientIp(req));
    return view;
  }

  /** 조장 후속 조치: 빠진 항목 보완 전달·확인 */
  @Post('meetings/:id/follow-ups')
  @Perm('tbm.confirm')
  async followUp(@Param('id', ParseIntPipe) id: number, @Body() body: TbmFollowUpInput, @Actor() who: ActorInfo, @Req() req: Request) {
    const out = await this.tbm.followUp(id, body, who);
    await this.audit.log(who, 'tbm.followup', `TBM #${id}`, { line: out.detail.line, code: out.followUp.code, title: out.title, kind: out.followUp.kind, note: out.followUp.note }, clientIp(req));
    return out.detail;
  }
}
