import {
  codePointLength,
  fail,
  ok,
  type ValidationReason,
  type ValidationResult,
} from './types.js';

export interface FreeTextLimits {
  /** NFC 정규화 뒤 허용하는 최대 코드 포인트 수 */
  max: number;
  /** 정규화 전 원본의 상한. 넘으면 정규화 없이 `LENGTH_OUT_OF_RANGE` */
  rawMax: number;
}

/** S2 §3.2 T-5: 사유 50자(원본 200), 라운드 12자(원본 48). */
export const REASON_LIMITS: FreeTextLimits = { max: 50, rawMax: 200 };
export const ROUND_LIMITS: FreeTextLimits = { max: 12, rawMax: 48 };

/** 한글 채움 문자: U+115F, U+1160, U+3164, U+FFA0 */
const FILLERS = new Set([0x115f, 0x1160, 0x3164, 0xffa0]);
/** 제어(Cc)·서식(Cf)·서로게이트(Cs)·사용자 정의(Co)·미할당(Cn)·줄/문단 구분자(Zl, Zp)·공백 구분자(Zs) */
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function isForbidden(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if (cp === 0x20) return false; // U+0020은 허용한다(그 밖의 Zs는 거부)
  return FILLERS.has(cp) || FORBIDDEN.test(ch);
}

/**
 * S2 §3.2 선택 문자열 검증(`reason`, `round`). 없음(`undefined`·`null`·`""`)은 `null`로 저장한다.
 * 문자열이 아니면 `INVALID_TYPE`. 자동 공백 제거는 하지 않으며 연속 공백은 허용한다.
 */
export function validateFreeText(
  input: unknown,
  limits: FreeTextLimits,
): ValidationResult<string | null> {
  if (input === undefined || input === null || input === '') return ok(null);
  if (typeof input !== 'string') return fail('INVALID_TYPE');
  if (codePointLength(input) > limits.rawMax) return fail('LENGTH_OUT_OF_RANGE');

  const value = input.normalize('NFC');
  const reasons: ValidationReason[] = [];
  if (codePointLength(value) > limits.max) reasons.push('LENGTH_OUT_OF_RANGE');
  if (Array.from(value).some(isForbidden)) reasons.push('INVALID_CHARACTER');
  if (value.startsWith(' ') || value.endsWith(' ')) reasons.push('LEADING_OR_TRAILING_SPACE');

  return reasons.length === 0 ? ok(value) : { ok: false, reasons };
}

export const validateReason = (input: unknown) => validateFreeText(input, REASON_LIMITS);
export const validateRound = (input: unknown) => validateFreeText(input, ROUND_LIMITS);
