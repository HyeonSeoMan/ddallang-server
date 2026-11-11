import { fail, ok, type ValidationResult } from './types.js';

export const AMOUNT_MIN = 1;
export const AMOUNT_MAX = 999_999_999;

/**
 * S2 §3.3 금액 검증. JSON 숫자이며 정수이고 1 이상 999,999,999 이하여야 한다. 정산 단위와 무관하다.
 * 누락·`null` → `REQUIRED`, 숫자가 아닌 값(문자열 `"100"`, 불리언, NaN 포함) → `INVALID_TYPE`,
 * 소수 → `INVALID_VALUE`, 0·음수·1,000,000,000 이상 → `OUT_OF_RANGE`.
 * 소수이면서 범위 밖(예: -0.5)이면 정수 여부를 먼저 보므로 `INVALID_VALUE`다(Spec의 "파싱한 값이 정수이고 …" 순서).
 */
export function validateAmount(input: unknown): ValidationResult<number> {
  if (input === undefined || input === null) return fail('REQUIRED');
  if (typeof input !== 'number' || Number.isNaN(input)) return fail('INVALID_TYPE');
  if (!Number.isFinite(input) || !Number.isInteger(input)) return fail('INVALID_VALUE');
  if (input < AMOUNT_MIN || input > AMOUNT_MAX) return fail('OUT_OF_RANGE');
  return ok(input);
}
