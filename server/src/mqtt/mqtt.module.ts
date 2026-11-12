import { Global, Module } from '@nestjs/common';
import { MqttBrokerService } from './mqtt-broker.service';

@Global()
@Module({ providers: [MqttBrokerService], exports: [MqttBrokerService] })
export class MqttModule {}
