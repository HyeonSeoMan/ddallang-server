import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  REASON_LIMITS,
  ROUND_LIMITS,
  validateReason,
  validateRound,
  type ValidationReason,
} from '../../src/common/validation/index.js';

const reasons = (r: ReturnType<typeof validateReason>): ValidationReason[] | 'ok' =>
  r.ok ? 'ok' : r.reasons;

describe('validateReason·validateRound (S2 §3.2 T-5)', () => {
  it('상한: 사유 50(원본 200), 라운드 12(원본 48)', () => {
    expect(REASON_LIMITS).toEqual({ max: 50, rawMax: 200 });
    expect(ROUND_LIMITS).toEqual({ max: 12, rawMax: 48 });
  });

  it('0번: 없음·null·빈 문자열은 입력 없음(null), 문자열이 아니면 INVALID_TYPE', () => {
    for (const v of [undefined, null, '']) {
      expect(validateReason(v)).toEqual({ ok: true, value: null });
      expect(validateRound(v)).toEqual({ ok: true, value: null });
    }
    for (const v of [0, 12, true, {}, [], ['a']]) {
      expect(reasons(validateReason(v))).toEqual(['INVALID_TYPE']);
      expect(reasons(validateRound(v))).toEqual(['INVALID_TYPE']);
    }
  });

  it('길이 경계(AC-TXN-001-6의 단위 근거): 50·12 허용, 51·13 거부', () => {
    expect(reasons(validateReason('가'.repeat(50)))).toBe('ok');
    expect(reasons(validateReason('가'.repeat(51)))).toEqual(['LENGTH_OUT_OF_RANGE']);
    expect(reasons(validateRound('가'.repeat(12)))).toBe('ok');
    expect(reasons(validateRound('가'.repeat(13)))).toEqual(['LENGTH_OUT_OF_RANGE']);
  });

  it('원본 상한: 200·48을 넘으면 정규화 없이 LENGTH_OUT_OF_RANGE 하나만', () => {
    expect(reasons(validateReason('\u0000'.repeat(201)))).toEqual(['LENGTH_OUT_OF_RANGE']);
    expect(reasons(validateReason('\u0000'.repeat(200)))).toEqual([
      'LENGTH_OUT_OF_RANGE',
      'INVALID_CHARACTER',
    ]);
    expect(reasons(validateRound('\u0000'.repeat(49)))).toEqual(['LENGTH_OUT_OF_RANGE']);
    // 분해형 한글 50자(150 코드 포인트)는 정상 입력이다
    expect(reasons(validateReason('한'.repeat(50)))).toBe('ok');
  });

  it('NFC 정규화: 길이는 정규화 후 코드 포인트 수로 센다', () => {
    const r = validateReason('한글');
    expect(r).toEqual({ ok: true, value: '한글' });
  });

  it('허용: 구두점·기호·이모지(단일 코드 포인트)·결합 문자·연속 공백·한글·영문·숫자', () => {
    for (const v of [
      '점심값!',
      'A  B',
      'a-b_c.d,e?',
      '😀',
      '가나다 123',
      'é',
      'é',
      '©',
      '₩1,000',
      '１２３',
    ]) {
      expect(reasons(validateReason(v)), JSON.stringify(v)).toBe('ok');
    }
  });

  it('거부 문자 범주: Cc(줄바꿈·탭 포함), Cf, 채움 문자, Cs, Co, Cn, Zl, Zp, U+0020 외 Zs', () => {
    const forbidden = [
      '\n',
      '\t',
      '\r',
      '\u0000',
      '\u007f',
      '\u0085', // Cc
      '​',
      '‍',
      '‎',
      '‮',
      '﻿',
      '­', // Cf (ZWSP, ZWJ, LRM, RLO, BOM, soft hyphen)
      'ᅟ',
      'ᅠ',
      'ㅤ',
      'ﾠ', // 한글 채움 문자
      '\ud800',
      '\udfff', // 서로게이트 단독(Cs)
      '', // Co
      '͸', // Cn (미할당)
      ' ',
      ' ', // Zl, Zp
      ' ',
      ' ',
      '　',
      ' ',
      ' ', // Zs
    ];
    for (const ch of forbidden) {
      expect(reasons(validateReason(`a${ch}b`)), `U+${ch.codePointAt(0)!.toString(16)}`).toEqual([
        'INVALID_CHARACTER',
      ]);
    }
  });

  it('공백 규칙: 앞뒤 공백·공백만은 LEADING_OR_TRAILING_SPACE, 연속 공백은 허용', () => {
    expect(reasons(validateReason(' a'))).toEqual(['LEADING_OR_TRAILING_SPACE']);
    expect(reasons(validateReason('a '))).toEqual(['LEADING_OR_TRAILING_SPACE']);
    expect(reasons(validateReason('   '))).toEqual(['LEADING_OR_TRAILING_SPACE']);
    expect(reasons(validateReason('a   b'))).toBe('ok');
  });

  it('사유 코드를 모아 검사 순서(길이, 문자, 앞뒤 공백)로 반환한다', () => {
    expect(reasons(validateRound(` ${'a'.repeat(13)}\n `))).toEqual([
      'LENGTH_OUT_OF_RANGE',
      'INVALID_CHARACTER',
      'LEADING_OR_TRAILING_SPACE',
    ]);
  });

  it('자동 공백 제거를 하지 않는다', () => {
    expect(validateReason('a b')).toEqual({ ok: true, value: 'a b' });
  });

  it('속성: 허용 문자 50자 이하는 통과하고 값이 변하지 않는다. 51~200자는 LENGTH 하나로 거부된다', () => {
    const ch = fc.constantFrom(...Array.from('가나다abcXYZ0189!?.,😀'));
    fc.assert(
      fc.property(fc.array(ch, { minLength: 1, maxLength: 50 }), (cs) => {
        const s = cs.join('');
        expect(validateReason(s)).toEqual({ ok: true, value: s });
      }),
    );
    fc.assert(
      fc.property(fc.array(ch, { minLength: 51, maxLength: 200 }), (cs) => {
        expect(reasons(validateReason(cs.join('')))).toEqual(['LENGTH_OUT_OF_RANGE']);
      }),
    );
  });

  it('속성: NFD 입력은 같은 NFC 입력과 같은 결과다', () => {
    const syllable = fc.integer({ min: 0xac00, max: 0xd7a3 }).map((cp) => String.fromCodePoint(cp));
    fc.assert(
      fc.property(fc.array(syllable, { minLength: 1, maxLength: 50 }), (syl) => {
        const composed = syl.join('');
        expect(validateReason(composed.normalize('NFD'))).toEqual(validateReason(composed));
      }),
    );
  });

  it('속성: 임의 문자열에서 예외 없이 성공값은 NFC·길이·공백 규칙을 만족한다', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 120 }), (s) => {
        const r = validateReason(s);
        if (r.ok && r.value !== null) {
          expect(r.value).toBe(r.value.normalize('NFC'));
          expect(Array.from(r.value).length).toBeLessThanOrEqual(50);
          expect(r.value.startsWith(' ') || r.value.endsWith(' ')).toBe(false);
          expect(r.value).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
        }
        if (!r.ok) expect(r.reasons.length).toBeGreaterThan(0);
      }),
      { numRuns: 500 },
    );
  });
});
