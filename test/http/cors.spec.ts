import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { CORS_ALLOWED_HEADERS, CORS_EXPOSED_HEADERS } from '../../src/common/http/cors.js';
import { quietLog, testEnv } from '../helpers/env.js';
import type { NestExpressApplication } from '@nestjs/platform-express';

const ORIGIN = 'http://localhost:3000';
let app: NestExpressApplication;
let http: ReturnType<typeof request>;
beforeAll(async () => {
  app = await createApp(
    { ...testEnv(), CORS_ORIGINS: [ORIGIN, 'https://app.example'] },
    { logStream: quietLog },
  );
  await app.init();
  http = request(app.getHttpServer());
});
afterAll(() => app?.close());

describe('CORS (PD-15)', () => {
  it('허용·노출 헤더 목록은 PD-15와 같다', () => {
    expect([...CORS_ALLOWED_HEADERS]).toEqual([
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'Idempotency-First-Attempt-At',
    ]);
    expect([...CORS_EXPOSED_HEADERS]).toEqual(['Date', 'Idempotent-Replayed', 'Retry-After']);
  });

  it('허용 출처의 사전 요청은 204와 허용 헤더 4개를 돌려준다', async () => {
    const res = await http
      .options('/health')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'authorization,content-type,idempotency-key,idempotency-first-attempt-at',
      );
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    const allowed = String(res.headers['access-control-allow-headers'])
      .toLowerCase()
      .split(',')
      .map((s) => s.trim());
    for (const h of CORS_ALLOWED_HEADERS) expect(allowed).toContain(h.toLowerCase());
    expect(res.headers.vary).toContain('Origin');
  });

  it('설정에 둘 이상의 출처가 있으면 요청한 출처만 그대로 돌려준다', async () => {
    const res = await http
      .options('/health')
      .set('Origin', 'https://app.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example');
  });

  it('허용하지 않은 출처에는 Access-Control-Allow-Origin을 주지 않는다', async () => {
    const pre = await http
      .options('/health')
      .set('Origin', 'http://evil.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    const actual = await http.get('/health').set('Origin', 'http://evil.example');
    expect(actual.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('실제 응답은 노출 헤더 목록을 알린다', async () => {
    const res = await http.get('/health').set('Origin', ORIGIN);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    const exposed = String(res.headers['access-control-expose-headers'])
      .toLowerCase()
      .split(',')
      .map((s) => s.trim());
    for (const h of CORS_EXPOSED_HEADERS) expect(exposed).toContain(h.toLowerCase());
  });

  it('라우트 판정이 만든 오류 응답에도 CORS 헤더가 붙는다(브라우저가 오류를 읽을 수 있다)', async () => {
    const res = await http.post('/health').set('Origin', ORIGIN);
    expect(res.status).toBe(405);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    const nf = await http.get('/nope').set('Origin', ORIGIN);
    expect(nf.status).toBe(404);
    expect(nf.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('사전 요청이 아닌 OPTIONS(Origin·Access-Control-Request-Method 없음)는 CORS가 끝내지 않고 레지스트리 판정(404·405+Allow)을 받는다', async () => {
    const missing = await http.options('/no-such-path');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ROUTE_NOT_FOUND');
    const known = await http.options('/health'); // /health는 GET 전용
    expect(known.status).toBe(405);
    expect(known.headers.allow).toBe('GET');
    const originOnly = await http.options('/health').set('Origin', ORIGIN);
    expect(originOnly.status).toBe(405);
    expect(originOnly.headers['access-control-allow-origin']).toBe(ORIGIN);
  });
});
