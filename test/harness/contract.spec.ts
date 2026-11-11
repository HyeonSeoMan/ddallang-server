import { describe, expect, it } from 'vitest';
import { ac, expectApiError } from '../helpers/contract.js';

describe('계약 시험 도우미 (BE-F8)', () => {
  it('제목에 AC 태그와 Spec 절을 붙인다', () => {
    expect(ac('AC-ROOM-001-2', 'S1 §3.2', '빈 name은 422')).toBe(
      '[AC-ROOM-001-2] 빈 name은 422 (S1 §3.2)',
    );
    expect(ac(['AC-ROOM-001-2', 'AC-ROOM-001-3'], 'S1 §4.1.2', '여러 AC')).toBe(
      '[AC-ROOM-001-2][AC-ROOM-001-3] 여러 AC (S1 §4.1.2)',
    );
  });

  it.each([
    [[], 'S1 §3.2'],
    [['AC-ROOM-1'], 'S1 §3.2'],
    [['ac-room-001-1'], 'S1 §3.2'],
    [['AC-ROOM-001-1'], 'S9 §3.2'],
    [['AC-ROOM-001-1'], '§3.2'],
  ])('잘못된 형식은 거부한다: %j %s', (ids, ref) => {
    expect(() => ac(ids, ref, '제목')).toThrow();
  });

  it('공통 오류 형식을 검증한다', () => {
    const ok = {
      status: 422,
      body: { error: { code: 'VALIDATION_FAILED', message: 'x', details: [] } },
    };
    expect(() => expectApiError(ok, 422, 'VALIDATION_FAILED')).not.toThrow();
    expect(() => expectApiError(ok, 422, 'VALIDATION_FAILED', [])).not.toThrow();
  });

  it('상태·코드·형식·details가 어긋나면 실패한다', () => {
    const body = { error: { code: 'X', message: 'm', details: [{ field: 'a' }] } };
    expect(() => expectApiError({ status: 400, body }, 422, 'X')).toThrow();
    expect(() => expectApiError({ status: 422, body }, 422, 'Y')).toThrow();
    expect(() => expectApiError({ status: 422, body }, 422, 'X', [])).toThrow();
    expect(() =>
      expectApiError({ status: 422, body: { error: { code: 'X' } } }, 422, 'X'),
    ).toThrow();
    expect(() =>
      expectApiError(
        { status: 422, body: { error: { code: 'X', message: 'm', details: 'no' } } },
        422,
        'X',
      ),
    ).toThrow();
    expect(() => expectApiError({ status: 422, body: {} }, 422, 'X')).toThrow();
  });
});
