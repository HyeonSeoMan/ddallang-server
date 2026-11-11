import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, errorBody } from '../../src/common/errors/api-error.js';
import { ERROR_CODES, type ErrorCode } from '../../src/common/errors/error-codes.js';
import { ErrorFixture } from '../fixtures/http-fixtures.js';
import { bootFixtureApp, type FixtureApp } from '../helpers/fixture-app.js';
import { expectApiError } from '../helpers/contract.js';

// Spec의 오류 코드 표를 그대로 옮긴 기대값: S1 §3.4, S2 §3.6, S5 §3.3.
const SPEC_TABLE: Record<string, number> = {
  UNAUTHENTICATED: 401,
  HOST_ONLY: 403,
  ROOM_NOT_FOUND: 404,
  INVITE_NOT_FOUND: 404,
  PARTICIPANT_NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  NOT_SUPPORTED: 405,
  GAME_ENDED: 409,
  NICKNAME_TAKEN: 409,
  MEMBER_LIMIT_EXCEEDED: 409,
  PARTICIPANT_LIMIT_EXCEEDED: 409,
  VALIDATION_FAILED: 422,
  NOT_AUTHOR_OR_HOST: 403,
  TRANSACTION_NOT_FOUND: 404,
  TRANSACTION_DELETED: 409,
  PARTICIPANT_INACTIVE: 409,
  TRANSACTION_LIMIT_EXCEEDED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_KEY_EXPIRED: 409,
  CONNECTION_LIMIT_EXCEEDED: 429,
};

describe('오류 코드 레지스트리 (S1 §3.4, S2 §3.6, S5 §3.3)', () => {
  it('Spec 표의 모든 코드가 같은 HTTP 상태로 등록되어 있고 그 밖의 코드는 INTERNAL_ERROR 하나뿐이다', () => {
    const { INTERNAL_ERROR, ...specCodes } = ERROR_CODES;
    expect(Object.fromEntries(Object.entries(specCodes).map(([k, v]) => [k, v.status]))).toEqual(
      SPEC_TABLE,
    );
    expect(INTERNAL_ERROR.status).toBe(500);
  });

  it('모든 코드에 한국어 기본 문구가 있다', () => {
    for (const [code, def] of Object.entries(ERROR_CODES)) {
      expect(def.message, code).toMatch(/[가-힣]/);
    }
  });

  it('ApiError는 공통 형식 본문을 만들고 details 기본값은 빈 배열이다', () => {
    const err = new ApiError('HOST_ONLY');
    expect(err.status).toBe(403);
    expect(err.toBody()).toEqual({
      error: { code: 'HOST_ONLY', message: ERROR_CODES.HOST_ONLY.message, details: [] },
    });
    const custom = errorBody('VALIDATION_FAILED', {
      message: '문구',
      details: [{ field: 'nickname', code: 'REQUIRED' }],
    });
    expect(custom).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: '문구',
        details: [{ field: 'nickname', code: 'REQUIRED' }],
      },
    });
  });

  it('코드 이름은 타입으로 제한된다', () => {
    const code: ErrorCode = 'ROOM_NOT_FOUND';
    expect(new ApiError(code).code).toBe('ROOM_NOT_FOUND');
  });
});

describe('전역 예외 필터', () => {
  let t: FixtureApp;
  beforeAll(async () => {
    t = await bootFixtureApp([ErrorFixture]);
  });
  afterAll(() => t?.close());

  it('ApiError를 공통 형식과 헤더(Retry-After)로 응답한다', async () => {
    const res = await t.http.get('/__errors/api');
    expectApiError(res, 429, 'CONNECTION_LIMIT_EXCEEDED', [{ limit: 5 }]);
    expect(res.headers['retry-after']).toBe('30');
  });

  it('호출자가 정한 문구와 details를 그대로 싣는다', async () => {
    const res = await t.http.get('/__errors/message');
    expectApiError(res, 422, 'VALIDATION_FAILED', [
      { field: 'nickname', code: 'CONSECUTIVE_SPACES' },
    ]);
    expect(res.body.error.message).toBe('직접 정한 문구');
  });

  it('예상하지 못한 예외는 500 INTERNAL_ERROR이고 내부 정보를 응답에 싣지 않는다', async () => {
    const res = await t.http.get('/__errors/boom');
    expectApiError(res, 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('secret-internal-detail');
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });

  it('프레임워크의 404는 ROUTE_NOT_FOUND 형식으로 맞춘다(원문을 싣지 않는다)', async () => {
    const res = await t.http.get('/__errors/http404');
    expectApiError(res, 404, 'ROUTE_NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toContain('some framework message');
  });
});
