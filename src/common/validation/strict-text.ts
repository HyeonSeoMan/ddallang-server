import {
  codePointLength,
  fail,
  ok,
  type ValidationReason,
  type ValidationResult,
} from './types.js';

/** S1 §3.2: 방 이름·정산 단위·RoomMember 닉네임·Participant 닉네임에 공통인 길이 상한. */
export const STRICT_TEXT_MAX = 12;
/** 정규화 전 원본의 상한. 분해형 한글 12자는 최대 36 코드 포인트라 정상 입력을 막지 않는다. */
export const STRICT_TEXT_RAW_MAX = 64;

function isAllowedCodePoint(cp: number): boolean {
  return (
    (cp >= 0xac00 && cp <= 0xd7a3) || // 한글 완성형 음절
    (cp >= 0x3131 && cp <= 0x3163) || // 한글 호환 자모(U+3164 채움 문자는 제외)
    (cp >= 0x41 && cp <= 0x5a) || // A-Z
    (cp >= 0x61 && cp <= 0x7a) || // a-z
    (cp >= 0x30 && cp <= 0x39) || // 0-9
    cp === 0x20 // 공백
  );
}

/**
 * S1 §3.2 문자열 검증(방 이름, 정산 단위, 닉네임). 자동 공백 제거는 하지 않는다.
 * 0. 없음·빈 문자열 `REQUIRED`, 문자열이 아니면 `INVALID_TYPE`, 원본이 64 코드 포인트를 넘으면 정규화 없이 `LENGTH_OUT_OF_RANGE`
 * 1. NFC 정규화 2. 길이(12 이하) 3. 허용 문자 4. 공백 규칙. 2~4의 위반은 모아서 반환한다.
 */
export function validateStrictText(input: unknown): ValidationResult<string> {
  if (input === undefined || input === null || input === '') return fail('REQUIRED');
  if (typeof input !== 'string') return fail('INVALID_TYPE');
  if (codePointLength(input) > STRICT_TEXT_RAW_MAX) return fail('LENGTH_OUT_OF_RANGE');

  const value = input.normalize('NFC');
  const points = Array.from(value);
  const reasons: ValidationReason[] = [];

  if (points.length > STRICT_TEXT_MAX) reasons.push('LENGTH_OUT_OF_RANGE');
  if (points.some((ch) => !isAllowedCodePoint(ch.codePointAt(0)!)))
    reasons.push('INVALID_CHARACTER');
  if (value.startsWith(' ') || value.endsWith(' ')) reasons.push('LEADING_OR_TRAILING_SPACE');
  if (value.includes('  ')) reasons.push('CONSECUTIVE_SPACES');

  return reasons.length === 0 ? ok(value) : { ok: false, reasons };
}

/** 방 이름·정산 단위·닉네임은 같은 규칙이다(S1 §3.2). 호출 지점의 의도를 드러내는 별칭이다. */
export const validateRoomName = validateStrictText;
export const validateUnit = validateStrictText;
export const validateNickname = validateStrictText;

/**
 * 닉네임 비교 키(S1 §3.2): 정규화한 문자열의 `A-Z`만 소문자로 바꾼다.
 * 한글·호환 자모·숫자·공백은 그대로이고 호환 자모 낱자 나열과 완성형 음절은 서로 다르다.
 * 입력은 `validateStrictText`를 통과한(NFC 정규화된) 값이어야 한다.
 */
export function nicknameKey(normalized: string): string {
  return normalized.replace(/[A-Z]/g, (c) => c.toLowerCase());
}
