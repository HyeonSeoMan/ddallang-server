import { ApiError } from '../common/errors/api-error.js';
import { FUTURE_SKEW_MS } from './idempotency.constants.js';

const KEY = /^[A-Za-z0-9_-]{16,64}$/;
/** RFC 3339 UTC 밀리초: 2026-11-08T03:21:45.123Z */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface IdempotencyHeaders {
  key: string;
  firstAttemptAt: Date;
}

/** 존재하지 않는 날짜(2026-02-30, 월 13)를 거른다. 잘못된 값은 Date가 NaN이거나 다시 직렬화하면 달라진다. */
function isExactInstant(raw: string): boolean {
  const d = new Date(raw);
  return !Number.isNaN(d.getTime()) && d.toISOString() === raw;
}

type Detail = { field: string; code: 'REQUIRED' | 'INVALID_VALUE'; serverTime?: string };

/**
 * S2 §5.1·§3.4 3번: `Idempotency-Key`와 `Idempotency-First-Attempt-At`를 검증한다. 누락·형식 위반은 422
 * (`field`: idempotencyKey | firstAttemptAt)이며 기록하지 않는다. 서버 수신 시각보다 5분을 넘는 미래 값은
 * 같은 422이고 `serverTime`을 싣는다(5분 이내의 값은 보낸 그대로 쓴다).
 */
export function parseIdempotencyHeaders(
  headers: Record<string, string | string[] | undefined>,
  receivedAt: Date,
): IdempotencyHeaders {
  const details: Detail[] = [];
  const rawKey = headers['idempotency-key'];
  const rawAt = headers['idempotency-first-attempt-at'];
  let key: string | undefined;
  let firstAttemptAt: Date | undefined;

  if (rawKey === undefined || rawKey === '')
    details.push({ field: 'idempotencyKey', code: 'REQUIRED' });
  else if (typeof rawKey !== 'string' || !KEY.test(rawKey))
    details.push({ field: 'idempotencyKey', code: 'INVALID_VALUE' });
  else key = rawKey;

  if (rawAt === undefined || rawAt === '')
    details.push({ field: 'firstAttemptAt', code: 'REQUIRED' });
  else if (typeof rawAt !== 'string' || !INSTANT.test(rawAt) || !isExactInstant(rawAt)) {
    details.push({ field: 'firstAttemptAt', code: 'INVALID_VALUE' });
  } else {
    const at = new Date(rawAt);
    if (at.getTime() - receivedAt.getTime() > FUTURE_SKEW_MS) {
      details.push({
        field: 'firstAttemptAt',
        code: 'INVALID_VALUE',
        serverTime: receivedAt.toISOString(),
      });
    } else {
      firstAttemptAt = at;
    }
  }

  if (details.length > 0 || key === undefined || firstAttemptAt === undefined) {
    throw new ApiError('VALIDATION_FAILED', { details });
  }
  return { key, firstAttemptAt };
}
