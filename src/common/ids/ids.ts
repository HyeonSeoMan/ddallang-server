import { randomBytes } from 'node:crypto';

/**
 * PD-14: 서버가 만드는 ID·초대 코드는 128비트 이상 난수의 base64url 불투명 문자열이다.
 * 클라이언트는 형식을 가정하지 않는다(S1 §2.1). 16바이트 = 128비트 = 패딩 없는 22자.
 */
const ID_BYTES = 16;

export function newId(): string {
  return randomBytes(ID_BYTES).toString('base64url');
}

/** 초대 코드: 128비트 URL-safe 난수(추측으로 방을 찾을 수 없다). */
export function newInviteCode(): string {
  return randomBytes(ID_BYTES).toString('base64url');
}
