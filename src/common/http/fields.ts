import { ApiError } from '../errors/api-error.js';
import { validateStrictText, type ValidationReason } from '../validation/index.js';

/** S1 §3.4의 `details[]` 항목. */
export type FieldDetail = {
  field: string;
  code: ValidationReason | 'NOT_ALLOWED_FIELD';
};

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 본문이 객체가 아니면 모든 필드가 없는 것으로 본다(각 필드가 `REQUIRED`로 판정된다). */
export const asObject = (body: unknown): Record<string, unknown> =>
  isPlainObject(body) ? body : {};

/** S1 §3.2 문자열 필드를 검증하고 위반 사유를 `details`에 모은다. 통과하면 NFC 정규화한 값을 돌려준다. */
export function strictTextField(
  body: Record<string, unknown>,
  field: string,
  details: FieldDetail[],
): string | undefined {
  const result = validateStrictText(body[field]);
  if (result.ok) return result.value;
  for (const code of result.reasons) details.push({ field, code });
  return undefined;
}

/** 검증 위반이 하나라도 있으면 `422 VALIDATION_FAILED`(위반 항목 전체)로 던진다. */
export function throwIfInvalid(details: FieldDetail[]): void {
  if (details.length > 0) throw new ApiError('VALIDATION_FAILED', { details: [...details] });
}
