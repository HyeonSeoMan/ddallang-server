import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { expectApiError } from './helpers/contract.js';
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
    expect(Object.keys(json.body.paths)).toContain('/health');
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
    expectApiError(await http.get('/api-docs-yaml'), 404, 'ROUTE_NOT_FOUND');
  });

  it.each(['test', 'production'] as const)('%s에서는 등록되지 않는다', async (nodeEnv) => {
    const http = await boot(nodeEnv);
    for (const path of ['/api-docs', '/api-docs-json', '/api-docs-yaml']) {
      expectApiError(await http.get(path), 404, 'ROUTE_NOT_FOUND');
    }
  });
});

describe('Swagger 문서 내용 (PD-19, 비권위 참고용)', () => {
  it('구현된 모든 엔드포인트가 응답 스키마와 인증 방식을 갖는다', async () => {
    const http = await boot('development');
    const { body } = await http.get('/api-docs-json');
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const ops: { path: string; method: string; op: any }[] = [];
    for (const [path, item] of Object.entries<any>(body.paths)) {
      for (const [method, op] of Object.entries<any>(item)) ops.push({ path, method, op });
    }
    const keys = ops.map((o) => `${o.method.toUpperCase()} ${o.path}`).sort();
    expect(keys).toEqual(
      expect.arrayContaining([
        'GET /health',
        'POST /rooms',
        'GET /rooms/{roomId}',
        'GET /invites/{inviteCode}',
        'POST /invites/{inviteCode}/members',
        'GET /rooms/{roomId}/participants',
        'POST /rooms/{roomId}/participants',
        'PATCH /rooms/{roomId}/participants/{participantId}',
        'POST /rooms/{roomId}/transactions',
        'GET /rooms/{roomId}/transactions',
        'PUT /rooms/{roomId}/transactions/{transactionId}',
        'DELETE /rooms/{roomId}/transactions/{transactionId}',
        'GET /rooms/{roomId}/balances',
      ]),
    );
    for (const { path, method, op } of ops.filter((o) => o.path !== '/health')) {
      const label = `${method.toUpperCase()} ${path}`;
      expect(op.summary, label).toBeTruthy();
      expect(
        op.security?.[0]?.['identity-key'] ?? op.security?.some((s: object) => 'identity-key' in s),
        label,
      ).toBeTruthy();
      const success = Object.entries<any>(op.responses).filter(([code]) => code.startsWith('2'));
      expect(success.length, label).toBeGreaterThan(0);
      for (const [, r] of success)
        expect(r.content?.['application/json']?.schema, label).toBeDefined();
      const errors = Object.entries<any>(op.responses).filter(([code]) => !code.startsWith('2'));
      for (const [code, r] of errors)
        expect(
          r.content?.['application/json']?.schema?.properties?.error,
          `${label} ${code}`,
        ).toBeDefined();
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const create = body.paths['/rooms/{roomId}/transactions'].post;
    const names = create.parameters.map((p: { name: string }) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(['Idempotency-Key', 'Idempotency-First-Attempt-At']),
    );
    const list = body.paths['/rooms/{roomId}/transactions'].get;
    expect(list.parameters.map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining(['participantId', 'cursor']),
    );
  });
});
