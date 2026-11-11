import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Env } from './config/env.js';
import { ENV } from './config/env.token.js';
import { DbModule } from './db/db.module.js';
import { ApiExceptionFilter } from './errors/api-exception.filter.js';
import { HealthController } from './health/health.controller.js';
import { RouteRegistry } from './routing/route-registry.js';
import { buildLoggerParams } from './logging/logger.options.js';

@Global()
@Module({})
export class CommonModule {
  static register(env: Env, logStream?: DestinationStream): DynamicModule {
    return {
      module: CommonModule,
      imports: [LoggerModule.forRoot(buildLoggerParams(env, logStream)), DbModule],
      controllers: [HealthController],
      providers: [
        { provide: ENV, useValue: env },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        RouteRegistry,
      ],
      exports: [ENV, DbModule, RouteRegistry],
    };
  }
}
