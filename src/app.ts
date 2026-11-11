import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { AppModule } from './app.module.js';
import type { Env } from './common/config/env.js';
import { corsOptions } from './common/http/cors.js';
import { jsonBodyParser } from './common/http/json-body.js';
import { RouteRegistry } from './common/routing/route-registry.js';
import { setupSwagger } from './swagger.js';

/**
 * HTTP 계층의 공통 설정. 등록 순서가 계약이다:
 * CORS(사전 요청) → 라우트 레지스트리(0번, 인증·Swagger·라우터보다 앞) → JSON 본문 파서(실패는 표시만) → Swagger.
 * 시험이 같은 순서로 앱을 꾸밀 수 있도록 따로 둔다.
 */
export function configureApp(app: NestExpressApplication, env: Env): void {
  app.enableCors(corsOptions(env));
  app.use(app.get(RouteRegistry).middleware());
  app.use(jsonBodyParser());
  setupSwagger(app, env);
}

/** 앱을 만들되 listen하지 않는다(시험에서도 같은 경로를 쓴다). */
export async function createApp(
  env: Env,
  options: { logStream?: DestinationStream } = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(env, options.logStream),
    { bufferLogs: true, bodyParser: false },
  );
  app.useLogger(app.get(Logger));
  configureApp(app, env);
  return app;
}
