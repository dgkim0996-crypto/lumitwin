import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import type { AssistantChatRequest, AssistantEvent } from '@lumitwin/shared';
import { clientIp } from '../access/access';
import { AssistantService } from './assistant.service';
import { StandardsIndex } from './standards.index';
import { SttService } from './stt.service';

/** multer가 메모리에 올린 파일 (필요한 필드만) */
interface UploadedAudio {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

/**
 * AI 현장 비서 API.
 * POST /assistant/chat 은 NDJSON(한 줄에 이벤트 하나)으로 흘려보낸다: 도구 호출이 일어나는 대로 화면에 보이게.
 */
@Controller('assistant')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly standards: StandardsIndex,
    private readonly stt: SttService,
  ) {}

  @Get('info')
  info() {
    return this.assistant.info();
  }

  @Post('chat')
  async chat(@Body() body: AssistantChatRequest, @Req() req: Request, @Res() res: Response) {
    if (!body || typeof body.message !== 'string') throw new BadRequestException('message가 필요합니다');
    const abort = new AbortController();
    // 사용자가 창을 닫거나 멈춤을 누르면 모델 호출도 끊는다
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    let opened = false;
    const emit = (e: AssistantEvent) => {
      if (res.writableEnded) return;
      if (!opened) {
        opened = true;
        res.status(200);
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
      }
      res.write(`${JSON.stringify(e)}\n`);
    };
    // 첫 이벤트 전에 난 오류(이미 답하는 중 등)는 보통 HTTP 오류로 돌려준다
    await this.assistant.chat(body, emit, abort.signal, clientIp(req));
    if (!res.writableEnded) res.end();
  }

  @Get('standards')
  standardList() {
    return this.standards.list();
  }

  @Get('standards/:id')
  standard(@Param('id') id: string) {
    return this.standards.get(id);
  }

  @Post('transcribe')
  @HttpCode(200) // 만드는 것이 없으니 201이 아니라 200
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 10 * 1024 * 1024 } }))
  transcribe(@UploadedFile() file?: UploadedAudio) {
    if (!file?.buffer?.length) throw new BadRequestException('audio 파일이 필요합니다');
    return this.stt.transcribe(file.buffer, file.mimetype, file.originalname || 'speech.webm');
  }
}
