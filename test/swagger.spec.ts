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

  it('Bearer 인증과 Idempotency-* 헤더를 입력할 수 있게 정의한다(헤더는 쓰는 엔드포인트에만)', async () => {
    const http = await boot('development');
    const { body } = await http.get('/api-docs-json');
    expect(body.components.securitySchemes['identity-key']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    const names = body.paths['/rooms/{roomId}/transactions'].post.parameters.map(
      (p: { name: string }) => p.name,
    );
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

describe('Swagger 문서 검수 항목 (회귀 방지)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  async function doc(): Promise<any> {
    const http = await boot('development');
    return (await http.get('/api-docs-json')).body;
  }

  it('경로의 모든 {매개변수}가 path 매개변수로 선언되어 있다(Try it out이 동작한다)', async () => {
    const d = await doc();
    for (const [path, item] of Object.entries<any>(d.paths)) {
      const needed = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const [method, op] of Object.entries<any>(item)) {
        const declared = (op.parameters ?? [])
          .filter((p: any) => p.in === 'path')
          .map((p: any) => p.name);
        expect(declared.sort(), `${method.toUpperCase()} ${path}`).toEqual([...needed].sort());
      }
    }
  });

  it('멱등 헤더는 거래 생성·수정·삭제에만 필수로 있고 다른 엔드포인트에는 없다', async () => {
    const d = await doc();
    const withHeaders = new Set([
      'POST /rooms/{roomId}/transactions',
      'PUT /rooms/{roomId}/transactions/{transactionId}',
      'DELETE /rooms/{roomId}/transactions/{transactionId}',
    ]);
    for (const [path, item] of Object.entries<any>(d.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        const key = `${method.toUpperCase()} ${path}`;
        const headers = (op.parameters ?? [])
          .filter((p: any) => p.in === 'header')
          .map((p: any) => p.name);
        if (withHeaders.has(key)) {
          expect(headers.sort(), key).toEqual(['Idempotency-First-Attempt-At', 'Idempotency-Key']);
          for (const p of op.parameters.filter((x: any) => x.in === 'header'))
            expect(p.required, `${key} ${p.name}`).toBe(true);
          const ok = Object.entries<any>(op.responses).find(([c]) => c.startsWith('2'))![1];
          expect(ok.headers?.['Idempotent-Replayed'], key).toBeDefined();
        } else {
          expect(headers, key).toEqual([]);
        }
      }
    }
  });

  it('인증 스킴은 신원 키 설명을 쓰고(JWT 아님), 초대 조회는 인증이 선택이다', async () => {
    const d = await doc();
    const scheme = d.components.securitySchemes['identity-key'];
    expect(scheme.bearerFormat).not.toMatch(/JWT/i);
    expect(scheme.bearerFormat).toMatch(/43/);
    expect(d.info.description).toMatch(/Spec/);
    expect(d.paths['/invites/{inviteCode}'].get.security).toEqual([{}, { 'identity-key': [] }]);
    expect(d.paths['/health'].get.security ?? []).toEqual([]);
    for (const key of ['/rooms', '/rooms/{roomId}', '/rooms/{roomId}/balances']) {
      for (const op of Object.values<any>(d.paths[key]))
        expect(op.security).toEqual([{ 'identity-key': [] }]);
    }
  });

  it('오류 응답은 상태별로 그 엔드포인트가 돌려주는 코드를 설명한다(무관한 코드가 없다)', async () => {
    const d = await doc();
    const codesOf = (path: string, method: string, status: string): string[] =>
      [
        ...String(d.paths[path][method].responses[status]?.description ?? '').matchAll(
          /`([A-Z_]+)`/g,
        ),
      ].map((m) => m[1]!);
    expect(codesOf('/rooms/{roomId}/participants', 'post', '409').sort()).toEqual([
      'GAME_ENDED',
      'NICKNAME_TAKEN',
      'PARTICIPANT_LIMIT_EXCEEDED',
    ]);
    expect(codesOf('/rooms/{roomId}/participants', 'post', '403')).toEqual(['HOST_ONLY']);
    expect(codesOf('/rooms/{roomId}/transactions/{transactionId}', 'put', '403')).toEqual([
      'NOT_AUTHOR_OR_HOST',
    ]);
    expect(codesOf('/rooms/{roomId}/transactions', 'post', '409').sort()).toEqual([
      'GAME_ENDED',
      'IDEMPOTENCY_CONFLICT',
      'IDEMPOTENCY_KEY_EXPIRED',
      'PARTICIPANT_INACTIVE',
      'TRANSACTION_LIMIT_EXCEEDED',
    ]);
    expect(codesOf('/invites/{inviteCode}/members', 'post', '409').sort()).toEqual([
      'MEMBER_LIMIT_EXCEEDED',
      'NICKNAME_TAKEN',
    ]);
    expect(d.paths['/rooms/{roomId}/balances'].get.responses['409']).toBeUndefined(); // 조회에는 상태·한도 오류가 없다(S3 §3.3)
    expect(d.paths['/rooms/{roomId}/balances'].get.responses['403']).toBeUndefined();
    expect(d.paths['/invites/{inviteCode}'].get.responses['401']).toBeUndefined(); // 인증은 선택
  });

  it('요청 본문 예시가 있다', async () => {
    const d = await doc();
    for (const [path, method] of [
      ['/rooms', 'post'],
      ['/invites/{inviteCode}/members', 'post'],
      ['/rooms/{roomId}/participants', 'post'],
      ['/rooms/{roomId}/participants/{participantId}', 'patch'],
      ['/rooms/{roomId}/transactions', 'post'],
      ['/rooms/{roomId}/transactions/{transactionId}', 'put'],
    ] as const) {
      expect(
        d.paths[path][method].requestBody.content['application/json'].schema.example,
        `${method} ${path}`,
      ).toBeDefined();
    }
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});
