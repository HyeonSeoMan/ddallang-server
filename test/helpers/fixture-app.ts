import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/app.js';
import { AppModule } from '../../src/app.module.js';
import type { Env } from '../../src/common/config/env.js';
import type { DestinationStream } from 'pino';
import { quietLog, testEnv } from './env.js';

export interface FixtureApp {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  close(): Promise<void>;
}

/**
 * 시험 전용 컨트롤러를 얹고도 운영과 같은 순서(`configureApp`)로 HTTP 계층을 꾸민 앱.
 * 운영 `createApp`은 시험 컨트롤러를 받지 않으므로 이 도우미가 같은 설정을 재사용한다.
 */
export async function bootFixtureApp(
  controllers: Type<unknown>[] = [],
  nodeEnv: Env['NODE_ENV'] = 'test',
  overrides: Partial<Env> = {},
  logStream: DestinationStream = quietLog,
): Promise<FixtureApp> {
  const env = { ...testEnv(nodeEnv), ...overrides };
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(env, logStream)],
    controllers,
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  app.useLogger(false); // 시험 출력을 조용히 한다(운영 로깅은 createApp 경로가 시험한다)
  configureApp(app, env);
  await app.init();
  return { app, http: request(app.getHttpServer()), close: () => app.close() };
}
