import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import type { Env } from '../../src/common/config/env.js';
import { testEnv, quietLog } from './env.js';

export interface TestApp {
  app: NestExpressApplication;
  /** `supertest(app.getHttpServer())`. 인증·검증은 하지 않는 순수 요청 도우미다. */
  http: ReturnType<typeof request>;
  close(): Promise<void>;
}

/** 운영과 같은 `createApp` 경로로 앱을 만들고(listen 없음) 요청 도우미를 붙인다. */
export async function bootTestApp(
  overrides: Partial<Env> = {},
  nodeEnv: Env['NODE_ENV'] = 'test',
): Promise<TestApp> {
  const app = await createApp({ ...testEnv(nodeEnv), ...overrides }, { logStream: quietLog });
  await app.init();
  return {
    app,
    http: request(app.getHttpServer()),
    close: () => app.close(),
  };
}
