import { expect } from 'vitest';

const AC_ID = /^AC-[A-Z]+-\d{3}-\d+$/;
const SPEC_REF = /^S[1-5] §\d+(\.\d+)*/;

/**
 * 시험 제목에 AC 태그와 Spec 절을 붙인다. 형식: `[AC-…][AC-…] 제목 (S1 §3.2)`.
 * 검사 스크립트(`scripts/ac-check.mjs`)는 제목의 `[AC-…]` 태그만 읽는다.
 */
export function ac(ids: string | string[], specRef: string, title: string): string {
  const list = Array.isArray(ids) ? ids : [ids];
  if (list.length === 0) throw new Error('AC ID가 하나 이상 필요하다');
  for (const id of list) {
    if (!AC_ID.test(id)) throw new Error(`AC ID 형식 오류: ${id}`);
  }
  if (!SPEC_REF.test(specRef)) throw new Error(`Spec 절 표기 오류(예: "S1 §3.2"): ${specRef}`);
  return `${list.map((i) => `[${i}]`).join('')} ${title} (${specRef})`;
}

/** 공통 오류 형식 `{ error: { code, message, details[] } }` 검증(S1 §3.4). 형식을 만드는 쪽은 BE-F3 소유다. */
export function expectApiError(
  res: { status: number; body: unknown },
  status: number,
  code: string,
  details?: unknown[],
): void {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({
    error: { code, message: expect.any(String), details: expect.any(Array) },
  });
  if (details !== undefined) {
    expect((res.body as { error: { details: unknown[] } }).error.details).toEqual(details);
  }
}
