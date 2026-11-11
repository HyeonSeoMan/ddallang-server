import { createHash } from 'node:crypto';
import { ApiError } from '../errors/api-error.js';

/** S1 §3.1: 신원 키는 32바이트 난수를 패딩 없이 base64url로 인코딩한 43자다. */
const IDENTITY_KEY = /^[A-Za-z0-9_-]{43}$/;

/**
 * `Authorization: Bearer <신원 키>`에서 키를 꺼낸다. 헤더 누락·형식 오류는 `401 UNAUTHENTICATED`다(S1 §3.3 1번).
 * 오류 응답에도 받은 값을 싣지 않는다.
 */
export function parseIdentityKey(header: string | string[] | undefined): string {
  if (typeof header !== 'string') throw new ApiError('UNAUTHENTICATED');
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  const key = match?.[1];
  if (!key || !IDENTITY_KEY.test(key)) throw new ApiError('UNAUTHENTICATED');
  return key;
}

/** 서버는 신원 키의 SHA-256 해시(소문자 hex)만 저장한다(PD-14). */
export function hashIdentityKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
