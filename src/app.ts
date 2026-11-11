import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { AppModule } from './app.module.js';
import type { Env } from './common/config/env.js';
import { setupSwagger } from './swagger.js';

/** 앱을 만들되 listen하지 않는다(시험에서도 같은 경로를 쓴다). */
export async function createApp(
  env: Env,
  options: { logStream?: DestinationStream } = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(env, options.logStream),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  app.enableCors({
    origin: env.CORS_ORIGINS,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'Idempotency-First-Attempt-At',
    ],
    exposedHeaders: ['Date', 'Idempotent-Replayed', 'Retry-After'],
  });
  setupSwagger(app, env);
  return app;
}
