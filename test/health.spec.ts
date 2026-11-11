import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { quietLog, testEnv } from './helpers/env.js';

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health (PD-20)', () => {
  it.each(['development', 'test', 'production'] as const)(
    '%s에서 인증 없이 200 {"status":"ok"}',
    async (nodeEnv) => {
      app = await createApp(testEnv(nodeEnv), { logStream: quietLog });
      await app.init();
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    },
  );
});
