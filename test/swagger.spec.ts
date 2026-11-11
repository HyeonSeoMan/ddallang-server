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

async function boot(nodeEnv: 'development' | 'test' | 'production') {
  app = await createApp(testEnv(nodeEnv), { logStream: quietLog });
  await app.init();
  return request(app.getHttpServer());
}

describe('Swagger 부트스트랩 (PD-19)', () => {
  it('development에서 /api-docs(UI)와 /api-docs-json이 열린다', async () => {
    const http = await boot('development');
    const ui = await http.get('/api-docs');
    expect(ui.status).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');
    const json = await http.get('/api-docs-json');
    expect(json.status).toBe(200);
    expect(Object.keys(json.body.paths)).toEqual(['/health']);
  });

  it('Bearer 인증과 Idempotency-* 헤더를 입력할 수 있게 정의한다', async () => {
    const http = await boot('development');
    const { body } = await http.get('/api-docs-json');
    expect(body.components.securitySchemes['identity-key']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    const names = body.paths['/health'].get.parameters.map((p: { name: string }) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(['Idempotency-Key', 'Idempotency-First-Attempt-At']),
    );
  });

  it('기본 YAML 경로는 만들지 않는다', async () => {
    const http = await boot('development');
    expect((await http.get('/api-docs-yaml')).status).toBe(404);
  });

  it.each(['test', 'production'] as const)('%s에서는 등록되지 않는다', async (nodeEnv) => {
    const http = await boot(nodeEnv);
    for (const path of ['/api-docs', '/api-docs-json', '/api-docs-yaml']) {
      expect((await http.get(path)).status).toBe(404);
    }
  });
});
