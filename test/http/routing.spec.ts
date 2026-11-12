import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectApiError } from '../helpers/contract.js';
import { bootFixtureApp, type FixtureApp } from '../helpers/fixture-app.js';
import { compilePattern, decodePath } from '../../src/common/routing/route-registry.js';
import { RoomsShapeFixture } from '../fixtures/http-fixtures.js';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';
const call = (
  t: FixtureApp,
  method: Method,
  path: string,
  headers: Record<string, string> = {},
) => {
  let r = t.http[method](path);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r;
};

describe('라우트 단계 (PD-9, PD-20, S1 §3.3 0번·§4.8)', () => {
  let t: FixtureApp;
  beforeAll(async () => {
    t = await bootFixtureApp([RoomsShapeFixture]);
  });
  afterAll(() => t?.close());

  describe('경로는 있으나 메서드가 없으면 405 NOT_SUPPORTED + Allow', () => {
    it.each([
      ['patch', '/rooms/r1', 'GET'],
      ['put', '/rooms/r1', 'GET'],
      ['delete', '/rooms/r1', 'GET'],
      ['put', '/rooms/r1/participants/p1', 'PATCH'],
      ['delete', '/rooms/r1/participants/p1', 'PATCH'],
      ['post', '/rooms/r1/participants/p1', 'PATCH'],
      ['put', '/rooms/r1/participants', 'GET, POST'],
      ['patch', '/rooms/r1/participants', 'GET, POST'],
      ['delete', '/rooms/r1/participants', 'GET, POST'],
    ] as const)('%s %s → 405 Allow: %s', async (method, path, allow) => {
      const res = await call(t, method, path);
      expectApiError(res, 405, 'NOT_SUPPORTED');
      expect(res.headers.allow).toBe(allow);
    });

    it('HEAD는 GET 경로에서도 지원하지 않는 메서드로 판정한다(405 + Allow)', async () => {
      const res = await call(t, 'head', '/rooms/r1');
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('GET');
    });
  });

  describe('정의되지 않은 경로는 404 ROUTE_NOT_FOUND', () => {
    it.each([
      '/',
      '/nope',
      '/room',
      '/rooms/r1/members/m1',
      '/rooms/r1/transfer-host',
      '/invites/abc/regenerate',
      '/rooms/r1/participants/p1/extra',
      '/rooms/r1/participants/p1/transactions',
    ])('GET %s', async (path) => {
      expectApiError(await call(t, 'get', path), 404, 'ROUTE_NOT_FOUND');
    });

    it('어떤 메서드든 정의되지 않은 경로는 405가 아니라 404다', async () => {
      for (const m of ['post', 'put', 'patch', 'delete'] as const) {
        expectApiError(await call(t, m, '/rooms/r1/transfer-host'), 404, 'ROUTE_NOT_FOUND');
      }
    });
  });

  describe('인증·방 존재와 무관하게 같은 응답 (정보 노출 없음)', () => {
    it.each([
      ['patch', '/rooms/r1', 405],
      ['delete', '/rooms/does-not-exist', 405],
      ['get', '/rooms/r1/transfer-host', 404],
    ] as const)('%s %s는 인증이 있든 없든 같다', async (method, path, status) => {
      const without = await call(t, method, path);
      const withAuth = await call(t, method, path, {
        Authorization: 'Bearer ' + 'a'.repeat(43),
        'x-test-auth': '1',
      });
      const otherRoom = await call(t, method, path.replace(/r1|does-not-exist/, 'another'));
      for (const res of [without, withAuth, otherRoom]) {
        expect(res.status).toBe(status);
      }
      expect(withAuth.body).toEqual(without.body);
      expect(otherRoom.body).toEqual(without.body);
      expect(withAuth.headers.allow).toBe(without.headers.allow);
    });
  });

  describe('라우트 판정은 인증보다 앞이다', () => {
    it('정의된 경로·메서드는 인증 가드가 401을 낸다', async () => {
      expectApiError(await call(t, 'get', '/rooms/r1'), 401, 'UNAUTHENTICATED');
      expect((await call(t, 'get', '/rooms/r1', { 'x-test-auth': '1' })).status).toBe(200);
    });

    it('정의되지 않은 경로·메서드는 인증 없이도 401이 아니라 404·405다', async () => {
      expectApiError(await call(t, 'get', '/rooms/r1/transfer-host'), 404, 'ROUTE_NOT_FOUND');
      expectApiError(await call(t, 'patch', '/rooms/r1'), 405, 'NOT_SUPPORTED');
    });
  });

  describe('Express와 같은 경로 규칙(대소문자 무시, 끝 슬래시 허용)', () => {
    it('끝 슬래시·대소문자 차이는 같은 경로로 본다', async () => {
      expect((await call(t, 'get', '/health/')).status).toBe(200);
      expect((await call(t, 'get', '/Health')).status).toBe(200);
      expectApiError(await call(t, 'post', '/Health/'), 405, 'NOT_SUPPORTED');
    });

    it('쿼리 문자열은 경로 판정에 영향이 없다', async () => {
      expect((await call(t, 'get', '/health?x=1')).status).toBe(200);
      expectApiError(await call(t, 'get', '/nope?x=1'), 404, 'ROUTE_NOT_FOUND');
    });
  });

  describe('GET /health (PD-20, 비-Spec 항목)', () => {
    it('GET만 허용한다. POST·HEAD·그 밖은 405 + Allow: GET', async () => {
      expect((await call(t, 'get', '/health')).status).toBe(200);
      for (const m of ['post', 'put', 'patch', 'delete', 'head'] as const) {
        const res = await call(t, m, '/health');
        expect(res.status, m).toBe(405);
        expect(res.headers.allow, m).toBe('GET');
        if (m !== 'head') expectApiError(res, 405, 'NOT_SUPPORTED');
      }
    });

    it('그 밖의 미정의 경로는 계속 404다', async () => {
      expectApiError(await call(t, 'get', '/healthz'), 404, 'ROUTE_NOT_FOUND');
      expectApiError(await call(t, 'get', '/health/extra'), 404, 'ROUTE_NOT_FOUND');
    });
  });
});

describe('Swagger 경로와 레지스트리 (PD-19, PD-20)', () => {
  describe('development', () => {
    let t: FixtureApp;
    beforeAll(async () => {
      t = await bootFixtureApp([], 'development');
    });
    afterAll(() => t?.close());

    it('GET은 열린다: /api-docs, /api-docs-json, UI 자원', async () => {
      expect((await call(t, 'get', '/api-docs')).status).toBe(200);
      expect((await call(t, 'get', '/api-docs-json')).status).toBe(200);
      expect((await call(t, 'get', '/api-docs/swagger-ui-init.js')).status).toBe(200);
    });

    it('레지스트리가 Swagger 라우트보다 먼저다: GET 밖의 메서드는 405 + Allow: GET', async () => {
      for (const path of ['/api-docs', '/api-docs-json', '/api-docs/swagger-ui-init.js']) {
        for (const m of ['post', 'put', 'delete', 'head'] as const) {
          const res = await call(t, m, path);
          expect(res.status, `${m} ${path}`).toBe(405);
          expect(res.headers.allow, `${m} ${path}`).toBe('GET');
        }
      }
      expectApiError(await call(t, 'post', '/api-docs'), 405, 'NOT_SUPPORTED');
    });

    it('기본 YAML 경로는 ROUTE_NOT_FOUND다', async () => {
      expectApiError(await call(t, 'get', '/api-docs-yaml'), 404, 'ROUTE_NOT_FOUND');
    });
  });

  describe.each(['test', 'production'] as const)('%s', (env) => {
    let t: FixtureApp;
    beforeAll(async () => {
      t = await bootFixtureApp([], env);
    });
    afterAll(() => t?.close());

    it('정상 기동해도 /api-docs*는 일반 미정의 경로와 같이 404 ROUTE_NOT_FOUND다(405가 아니다)', async () => {
      for (const path of [
        '/api-docs',
        '/api-docs/',
        '/api-docs-json',
        '/api-docs-yaml',
        '/api-docs/swagger-ui-init.js',
      ]) {
        expectApiError(await call(t, 'get', path), 404, 'ROUTE_NOT_FOUND');
        expectApiError(await call(t, 'post', path), 404, 'ROUTE_NOT_FOUND');
      }
    });
  });
});

describe('경로 디코딩 (PD-9)', () => {
  const pattern = compilePattern('/rooms/:roomId/transactions/:transactionId');
  const id = 'ABCDEFGHIJKLMNOPQRSTUV'; // 22자
  it('퍼센트 인코딩된 거래 ID도 같은 라우트로 판정한다', () => {
    const encoded = `/rooms/r1/transactions/%41${id.slice(1)}`;
    expect(pattern.test(encoded)).toBe(false); // 디코딩 없이는 22자 제약에 걸린다
    expect(pattern.test(decodePath(encoded))).toBe(true);
  });
  it('%2F와 잘못된 인코딩은 원문을 유지한다', () => {
    expect(decodePath('/rooms/a%2Fb/x')).toBe('/rooms/a%2Fb/x');
    expect(decodePath('/rooms/%E0%A4%A/x')).toBe('/rooms/%E0%A4%A/x');
  });
});

describe('잘못된 퍼센트 인코딩 (PD-9)', () => {
  let t: FixtureApp;
  beforeAll(async () => {
    t = await bootFixtureApp([RoomsShapeFixture]);
  });
  afterAll(() => t?.close());
  it('디코딩할 수 없는 경로는 500이 아니라 클라이언트 오류로 응답한다', async () => {
    expectApiError(await t.http.get('/rooms/%E0%A4%A'), 404, 'ROUTE_NOT_FOUND');
    expectApiError(await t.http.post('/rooms/r1/participants/%'), 404, 'ROUTE_NOT_FOUND');
  });
});
