import { Module } from '@nestjs/common';
import { LiveController } from './live.controller';
import { LiveGateway } from './live.gateway';
import { LiveService } from './live.service';

@Module({ controllers: [LiveController], providers: [LiveService, LiveGateway], exports: [LiveService] })
export class LiveModule {}
