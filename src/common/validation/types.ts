/** S1 §3.4·S2 §3.6의 `details[].code` 중 문자열·금액 검증이 만드는 사유 코드. */
export type ValidationReason =
  | 'REQUIRED'
  | 'INVALID_TYPE'
  | 'INVALID_VALUE'
  | 'OUT_OF_RANGE'
  | 'LENGTH_OUT_OF_RANGE'
  | 'INVALID_CHARACTER'
  | 'LEADING_OR_TRAILING_SPACE'
  | 'CONSECUTIVE_SPACES';

/**
 * 검증 결과. 거부일 때 `reasons`는 Spec이 정한 검사 순서대로 모은 위반 전체다(비어 있지 않다).
 * 호출자(서비스)가 `field`를 붙여 `details`로 옮긴다.
 */
export type ValidationResult<T> =
  { ok: true; value: T } | { ok: false; reasons: ValidationReason[] };

export const ok = <T>(value: T): ValidationResult<T> => ({ ok: true, value });
export const fail = (...reasons: ValidationReason[]): ValidationResult<never> => ({
  ok: false,
  reasons,
});

/** 코드 포인트 수(서로게이트 쌍은 1). */
export const codePointLength = (s: string): number => Array.from(s).length;
