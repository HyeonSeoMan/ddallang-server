import { DynamicModule, Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Env } from './config/env.js';
import { ENV } from './config/env.token.js';
import { HealthController } from './health/health.controller.js';
import { buildLoggerParams } from './logging/logger.options.js';

@Global()
@Module({})
export class CommonModule {
  static register(env: Env, logStream?: DestinationStream): DynamicModule {
    return {
      module: CommonModule,
      imports: [LoggerModule.forRoot(buildLoggerParams(env, logStream))],
      controllers: [HealthController],
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
