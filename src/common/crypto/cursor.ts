import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** 커서가 담는 값(S3 §4.1.2): 마지막 항목의 위치, 발급 때의 필터, 방 ID 해시. */
export interface CursorPayload {
  /** 마지막 항목의 createdAt(밀리초 UTC ISO) */
  c: string;
  /** 마지막 항목의 seq(서버 내부 순번, 평문으로 노출하지 않는다) */
  s: number;
  /** 발급 때의 participantId 필터(없으면 null) */
  f: string | null;
  /** 방 ID의 해시 */
  r: string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

export const roomHash = (roomId: string): string =>
  createHash('sha256').update(roomId, 'utf8').digest('hex').slice(0, 32);

/**
 * 커서 AEAD 암호화(AES-256-GCM, PD-12). 토큰은 base64url(IV ‖ 암호문 ‖ 태그)이며 IV가 매번 달라 같은
 * 위치라도 토큰이 다르다. `seq`는 평문으로 나타나지 않는다(S3 §2.3.1 4).
 */
export function encryptCursor(key: Buffer, payload: CursorPayload): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}

/** 복호·인증·형식 검증에 실패하면(변조, 다른 키, 잘린 토큰 포함) `undefined`다. */
export function decryptCursor(key: Buffer, token: string): CursorPayload | undefined {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < IV_BYTES + TAG_BYTES + 1 || raw.toString('base64url') !== token)
      return undefined;
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    const v = JSON.parse(json) as Partial<CursorPayload>;
    if (
      typeof v.c !== 'string' ||
      Number.isNaN(Date.parse(v.c)) ||
      !Number.isSafeInteger(v.s) ||
      (v.f !== null && typeof v.f !== 'string') ||
      typeof v.r !== 'string'
    ) {
      return undefined;
    }
    return { c: v.c, s: v.s as number, f: v.f, r: v.r };
  } catch {
    return undefined;
  }
}
