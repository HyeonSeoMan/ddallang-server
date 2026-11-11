import { createHash } from 'node:crypto';

export type Operation = 'CREATE' | 'UPDATE' | 'DELETE' | 'END';

/** `reason`·`round`의 원본 상한(S2 §3.2): 넘으면 정규화하지 않고 보낸 그대로 정규형에 넣는다. */
const RAW_LIMITS: Record<string, number> = { reason: 200, round: 48 };
const KNOWN = ['payerId', 'payeeId', 'amount', 'reason', 'round'];

/** 값을 키 정렬한 canonical JSON으로 직렬화한다(객체 키 순서와 무관). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function normalizeOptionalText(field: string, v: unknown): unknown {
  if (v === undefined || v === null || v === '') return null; // 없음·null·""는 같은 "입력 없음"
  if (typeof v !== 'string') return v; // 잘못된 타입은 보낸 그대로
  return Array.from(v).length > (RAW_LIMITS[field] ?? Infinity) ? v : v.normalize('NFC');
}

/**
 * 본문 정규형. 알려진 필드(payerId, payeeId, amount, reason, round)는 위 규칙으로, 그 밖의 필드(허용되지 않은 필드)와
 * 객체가 아닌 본문은 보낸 그대로 포함한다. 본문 검증 통과 여부와 무관하다(S2 §5.2).
 */
export function normalizeBody(body: unknown, parseFailed: boolean): unknown {
  if (parseFailed) return { $unparseable: true };
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { $nonObject: body ?? null };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = k === 'reason' || k === 'round' ? normalizeOptionalText(k, v) : v;
  }
  for (const k of ['reason', 'round']) if (!(k in out) && KNOWN.includes(k)) out[k] = null;
  return out;
}

/** 지문: 연산 종류 + 대상 거래 ID(수정·삭제) + 본문 정규형의 SHA-256(소문자 hex). */
export function fingerprint(args: {
  operation: Operation;
  targetId?: string;
  body: unknown;
  parseFailed: boolean;
}): string {
  const canonical = canonicalJson({
    operation: args.operation,
    targetId: args.targetId ?? null,
    body: normalizeBody(args.body, args.parseFailed),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
