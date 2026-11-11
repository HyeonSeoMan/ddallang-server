import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AMOUNT_MAX,
  AMOUNT_MIN,
  validateAmount,
  type ValidationReason,
} from '../../src/common/validation/index.js';

const reason = (v: unknown): ValidationReason | 'ok' => {
  const r = validateAmount(v);
  return r.ok ? 'ok' : r.reasons[0]!;
};

describe('validateAmount (S2 §3.3)', () => {
  it('경계: 1과 999,999,999는 허용, 0과 1,000,000,000은 OUT_OF_RANGE', () => {
    expect([AMOUNT_MIN, AMOUNT_MAX]).toEqual([1, 999_999_999]);
    expect(validateAmount(1)).toEqual({ ok: true, value: 1 });
    expect(validateAmount(999_999_999)).toEqual({ ok: true, value: 999_999_999 });
    expect(reason(0)).toBe('OUT_OF_RANGE');
    expect(reason(1_000_000_000)).toBe('OUT_OF_RANGE');
    expect(reason(-1)).toBe('OUT_OF_RANGE');
    expect(reason(-0)).toBe('OUT_OF_RANGE');
    expect(reason(Number.MAX_SAFE_INTEGER)).toBe('OUT_OF_RANGE');
    expect(reason(1e21)).toBe('OUT_OF_RANGE');
  });

  it('소수는 INVALID_VALUE(범위 안팎 모두)', () => {
    for (const v of [1.5, 0.5, 100.01, 999_999_999.5, 1_000_000_000.5, -0.5, 1e-9]) {
      expect(reason(v), String(v)).toBe('INVALID_VALUE');
    }
    expect(validateAmount(100.0)).toEqual({ ok: true, value: 100 });
  });

  it('누락·null은 REQUIRED', () => {
    expect(reason(undefined)).toBe('REQUIRED');
    expect(reason(null)).toBe('REQUIRED');
  });

  it('숫자가 아닌 값은 INVALID_TYPE(문자열 "100" 포함)', () => {
    for (const v of ['100', '', '1', true, false, {}, [], [100], NaN, 10n]) {
      expect(reason(v), String(typeof v)).toBe('INVALID_TYPE');
    }
  });

  it('무한대는 정수가 아니므로 INVALID_VALUE이며 예외가 없다', () => {
    expect(reason(Infinity)).toBe('INVALID_VALUE');
    expect(reason(-Infinity)).toBe('INVALID_VALUE');
  });

  it('속성: 1~999,999,999의 모든 정수는 통과한다', () => {
    fc.assert(
      fc.property(fc.integer({ min: AMOUNT_MIN, max: AMOUNT_MAX }), (n) => {
        expect(validateAmount(n)).toEqual({ ok: true, value: n });
      }),
    );
  });

  it('속성: 범위 밖 정수는 OUT_OF_RANGE', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -1_000_000_000, max: 0 }),
          fc.integer({ min: 1_000_000_000, max: Number.MAX_SAFE_INTEGER }),
        ),
        (n) => {
          expect(reason(n)).toBe('OUT_OF_RANGE');
        },
      ),
    );
  });

  it('속성: 정수가 아닌 유한 수는 INVALID_VALUE', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true }).filter((d) => !Number.isInteger(d)),
        (d) => {
          expect(reason(d)).toBe('INVALID_VALUE');
        },
      ),
    );
  });

  it('속성: 숫자가 아닌 임의 값은 INVALID_TYPE(null·undefined 제외)', () => {
    fc.assert(
      fc.property(
        fc.anything().filter((v) => typeof v !== 'number' && v !== null && v !== undefined),
        (v) => {
          expect(reason(v)).toBe('INVALID_TYPE');
        },
      ),
    );
  });
});
