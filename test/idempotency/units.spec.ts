import { describe, expect, it } from 'vitest';
import { canonicalJson, fingerprint } from '../../src/idempotency/fingerprint.js';
import { parseIdempotencyHeaders } from '../../src/idempotency/headers.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');
const KEY = 'K'.repeat(22);
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const ok = (key: string | undefined, firstAttemptAt: string | undefined) =>
  parseIdempotencyHeaders(
    { 'idempotency-key': key, 'idempotency-first-attempt-at': firstAttemptAt },
    NOW,
  );
const details = (key: string | undefined, firstAttemptAt: string | undefined) => {
  try {
    ok(key, firstAttemptAt);
    return undefined;
  } catch (e) {
    return (e as { details: unknown[] }).details;
  }
};

describe('parseIdempotencyHeaders (S2 §5.1)', () => {
  it('유효한 헤더를 읽는다', () => {
    const r = ok(KEY, '2026-11-11T11:59:00.000Z');
    expect(r.key).toBe(KEY);
    expect(r.firstAttemptAt.toISOString()).toBe('2026-11-11T11:59:00.000Z');
  });

  it('키 형식: 16~64자 [A-Za-z0-9_-]', () => {
    expect(ok('a'.repeat(16), at(0)).key).toHaveLength(16);
    expect(ok('a'.repeat(64), at(0)).key).toHaveLength(64);
    expect(ok('a-b_C0'.repeat(3), at(0)).key).toBe('a-b_C0a-b_C0a-b_C0');
    for (const bad of [
      'a'.repeat(15),
      'a'.repeat(65),
      'a'.repeat(15) + ' ',
      'a'.repeat(15) + '+',
      'a'.repeat(15) + '=',
      '한글'.repeat(10),
      'a'.repeat(15) + '/',
    ]) {
      expect(details(bad, at(0)), bad).toEqual([
        { field: 'idempotencyKey', code: 'INVALID_VALUE' },
      ]);
    }
  });

  it('누락은 REQUIRED이고 두 헤더의 오류를 함께 반환한다', () => {
    expect(details(undefined, undefined)).toEqual([
      { field: 'idempotencyKey', code: 'REQUIRED' },
      { field: 'firstAttemptAt', code: 'REQUIRED' },
    ]);
    expect(details(KEY, undefined)).toEqual([{ field: 'firstAttemptAt', code: 'REQUIRED' }]);
    expect(details('', at(0))).toEqual([{ field: 'idempotencyKey', code: 'REQUIRED' }]);
  });

  it('시각 형식: RFC 3339 UTC 밀리초만 허용한다', () => {
    for (const bad of [
      '2026-11-11T11:59:00Z',
      '2026-11-11T11:59:00.12Z',
      '2026-11-11T11:59:00.123+09:00',
      '2026-11-11 11:59:00.123Z',
      '2026-11-11T11:59:00.123z',
      '1731326400000',
      '2026-02-30T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      'yesterday',
    ]) {
      expect(details(KEY, bad), bad).toEqual([{ field: 'firstAttemptAt', code: 'INVALID_VALUE' }]);
    }
  });

  it('미래 시각: 5분까지 허용(보낸 그대로), 5분 초과는 INVALID_VALUE + serverTime', () => {
    expect(ok(KEY, at(5 * 60 * 1000)).firstAttemptAt.toISOString()).toBe(at(5 * 60 * 1000)); // 경계 포함, 낮추지 않는다
    expect(ok(KEY, at(4 * 60 * 1000)).firstAttemptAt.toISOString()).toBe(at(4 * 60 * 1000));
    expect(details(KEY, at(5 * 60 * 1000 + 1))).toEqual([
      { field: 'firstAttemptAt', code: 'INVALID_VALUE', serverTime: NOW.toISOString() },
    ]);
    expect(details(KEY, at(10 * 60 * 1000))).toEqual([
      { field: 'firstAttemptAt', code: 'INVALID_VALUE', serverTime: NOW.toISOString() },
    ]);
  });

  it('아주 오래된 과거 값은 형식상 허용한다(만료는 잠금 안에서 판정)', () => {
    expect(ok(KEY, '2000-01-01T00:00:00.000Z').firstAttemptAt.getUTCFullYear()).toBe(2000);
  });

  it('헤더가 배열로 중복되면 거부한다', () => {
    expect(() =>
      parseIdempotencyHeaders(
        { 'idempotency-key': [KEY, KEY], 'idempotency-first-attempt-at': at(0) },
        NOW,
      ),
    ).toThrow();
  });
});

describe('fingerprint (S2 §5.2)', () => {
  const base = { operation: 'CREATE' as const, parseFailed: false };
  const fp = (
    body: unknown,
    o: Partial<{ operation: 'CREATE' | 'UPDATE' | 'DELETE'; targetId: string }> = {},
  ) => fingerprint({ ...base, ...o, body });

  it('SHA-256 소문자 hex 64자이고 키 순서와 무관하다', () => {
    const a = fp({ payerId: 'a', payeeId: 'b', amount: 1 });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fp({ amount: 1, payeeId: 'b', payerId: 'a' })).toBe(a);
  });

  it('reason·round: 없음·null·""는 같고, 분해형·조합형 한글은 NFC로 같다', () => {
    const none = fp({ payerId: 'a', payeeId: 'b', amount: 1 });
    expect(fp({ payerId: 'a', payeeId: 'b', amount: 1, reason: null, round: null })).toBe(none);
    expect(fp({ payerId: 'a', payeeId: 'b', amount: 1, reason: '', round: '' })).toBe(none);
    const composed = fp({ payerId: 'a', payeeId: 'b', amount: 1, reason: '한글' });
    expect(fp({ payerId: 'a', payeeId: 'b', amount: 1, reason: '한글'.normalize('NFD') })).toBe(
      composed,
    );
    expect(fp({ payerId: 'a', payeeId: 'b', amount: 1, reason: '한글!' })).not.toBe(composed);
  });

  it('허용 필드 밖의 필드·잘못된 타입은 보낸 그대로 포함해 다른 내용이 된다', () => {
    const plain = fp({ payerId: 'a', payeeId: 'b', amount: 1 });
    expect(fp({ payerId: 'a', payeeId: 'b', amount: 1, authorId: 'x' })).not.toBe(plain);
    expect(fp({ payerId: 'a', payeeId: 'b', amount: '1' })).not.toBe(plain);
    expect(fp({ payerId: 'a', payeeId: 'b', amount: 1, reason: {} })).not.toBe(plain);
    expect(fp({ payerId: 'a', payeeId: 'b', amount: 1, reason: [] })).not.toBe(plain);
    expect(fp({ payerId: 'a', payeeId: 'b', amount: 1, authorId: 'x' })).toBe(
      fp({ amount: 1, authorId: 'x', payeeId: 'b', payerId: 'a' }),
    );
  });

  it('길이 초과로 정규화하지 않은 값은 보낸 그대로 비교한다(원본 상한 200·48)', () => {
    const composed = '가'.repeat(150);
    const nfd = composed.normalize('NFD'); // 원본 450 코드 포인트 > 200 → 정규화하지 않는다
    expect(fp({ amount: 1, reason: nfd })).not.toBe(fp({ amount: 1, reason: composed }));
    const short = '가'.repeat(30);
    expect(fp({ amount: 1, reason: short.normalize('NFD') })).toBe(
      fp({ amount: 1, reason: short }),
    ); // 상한 안이면 NFC로 같다
    const round = '가'.repeat(30);
    expect(fp({ amount: 1, round: round.normalize('NFD') })).not.toBe(fp({ amount: 1, round })); // round 원본 상한 48 초과(NFD 60 코드 포인트)
  });

  it('연산 종류와 대상 거래 ID가 지문에 들어간다', () => {
    const body = { amount: 1 };
    expect(fp(body, { operation: 'UPDATE', targetId: 't1' })).not.toBe(
      fp(body, { operation: 'CREATE' }),
    );
    expect(fp(body, { operation: 'UPDATE', targetId: 't1' })).not.toBe(
      fp(body, { operation: 'UPDATE', targetId: 't2' }),
    );
    expect(fp(body, { operation: 'UPDATE', targetId: 't1' })).not.toBe(
      fp(body, { operation: 'DELETE', targetId: 't1' }),
    );
    expect(fp({}, { operation: 'DELETE', targetId: 't1' })).toBe(
      fp({}, { operation: 'DELETE', targetId: 't1' }),
    );
  });

  it('파싱 실패·객체가 아닌 본문도 지문이 있고 서로 구별된다', () => {
    const failed = fingerprint({ ...base, body: undefined, parseFailed: true });
    expect(failed).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint({ ...base, body: [1, 2], parseFailed: false })).not.toBe(failed);
    expect(fingerprint({ ...base, body: [1, 2], parseFailed: false })).not.toBe(
      fingerprint({ ...base, body: [2, 1], parseFailed: false }),
    );
    expect(fingerprint({ ...base, body: 'text', parseFailed: false })).not.toBe(
      fingerprint({ ...base, body: null, parseFailed: false }),
    );
  });

  it('canonicalJson은 키를 정렬하고 중첩도 정규화한다', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
    expect(canonicalJson({ a: undefined })).toBe('{"a":null}');
  });
});
