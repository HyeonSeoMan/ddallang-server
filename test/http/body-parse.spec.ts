import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectApiError } from '../helpers/contract.js';
import { bootFixtureApp, type FixtureApp } from '../helpers/fixture-app.js';
import { OrderFixture, RoomsShapeFixture } from '../fixtures/http-fixtures.js';

describe('본문 파싱 실패와 검사 순서 (PD-8, S1 §3.3 7번)', () => {
  let t: FixtureApp;
  beforeAll(async () => {
    t = await bootFixtureApp([OrderFixture, RoomsShapeFixture]);
  });
  afterAll(() => t?.close());

  const BAD_JSON = '{"nickname": ';
  const post = (
    headers: Record<string, string>,
    body: string | object = BAD_JSON,
    type = 'application/json',
  ) => {
    let r = t.http.post('/__fixture/orders/o1').set('Content-Type', type);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(typeof body === 'string' ? body : JSON.stringify(body));
  };

  it('잘못된 JSON + 무인증이면 401 UNAUTHENTICATED (파서가 먼저 응답하지 않는다)', async () => {
    expectApiError(await post({}), 401, 'UNAUTHENTICATED');
  });

  it('잘못된 JSON + 비방장이면 403 HOST_ONLY', async () => {
    expectApiError(await post({ 'x-test-auth': '1', 'x-test-role': 'member' }), 403, 'HOST_ONLY');
  });

  it('잘못된 JSON + 종료된 방이면 409 GAME_ENDED', async () => {
    expectApiError(
      await post({ 'x-test-auth': '1', 'x-test-role': 'host', 'x-test-state': 'ended' }),
      409,
      'GAME_ENDED',
    );
  });

  it('잘못된 JSON + 멤버·방장이 정상일 때만 422 VALIDATION_FAILED', async () => {
    const res = await post({ 'x-test-auth': '1', 'x-test-role': 'host' });
    expectApiError(res, 422, 'VALIDATION_FAILED', [{ field: 'body', code: 'INVALID_VALUE' }]);
  });

  it('유효한 JSON은 본문이 서비스에 전달된다', async () => {
    const res = await post({ 'x-test-auth': '1', 'x-test-role': 'host' }, { nickname: 'a' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, body: { nickname: 'a' } });
  });

  it('JSON 본문이 비어 있으면 파싱 실패가 아니라 빈 객체다(검증은 서비스가 한다)', async () => {
    const res = await t.http
      .post('/__fixture/orders/o1')
      .set({ 'x-test-auth': '1', 'x-test-role': 'host' })
      .set('Content-Type', 'application/json')
      .send('');
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({});
  });

  it('JSON이 아닌 Content-Type은 파서가 건너뛰어 본문 없음이다(실패 표시 없음)', async () => {
    const res = await post(
      { 'x-test-auth': '1', 'x-test-role': 'host' },
      'plain text',
      'text/plain',
    );
    expect(res.status).toBe(200);
    expect(res.body.body ?? null).toBeNull();
  });

  it('본문이 너무 커서 파서가 거부해도 413이 아니라 같은 검사 순서의 422다', async () => {
    const huge = JSON.stringify({ nickname: 'a'.repeat(200_000) });
    const ok = await post({ 'x-test-auth': '1', 'x-test-role': 'host' }, huge);
    expectApiError(ok, 422, 'VALIDATION_FAILED');
    expectApiError(await post({}, huge), 401, 'UNAUTHENTICATED');
  });

  it('라우트 단계가 본문 파싱보다 앞서 정의되지 않은 경로·메서드는 404·405다', async () => {
    const bad404 = await t.http
      .post('/__fixture/nope')
      .set('Content-Type', 'application/json')
      .send(BAD_JSON);
    expectApiError(bad404, 404, 'ROUTE_NOT_FOUND');
    const bad405 = await t.http
      .put('/__fixture/orders/o1')
      .set('Content-Type', 'application/json')
      .send(BAD_JSON);
    expectApiError(bad405, 405, 'NOT_SUPPORTED');
  });

  it('파싱 실패 표시는 요청마다 따로다(앞 요청의 실패가 뒤 요청에 새지 않는다)', async () => {
    const headers = { 'x-test-auth': '1', 'x-test-role': 'host' };
    expectApiError(await post(headers), 422, 'VALIDATION_FAILED');
    const good = await post(headers, { a: 1 });
    expect(good.status).toBe(200);
  });
});
