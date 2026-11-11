import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  STRICT_TEXT_MAX,
  STRICT_TEXT_RAW_MAX,
  nicknameKey,
  validateNickname,
  validateRoomName,
  validateStrictText,
  validateUnit,
  type ValidationReason,
} from '../../src/common/validation/index.js';

const reasonsOf = (input: unknown): ValidationReason[] | 'ok' => {
  const r = validateStrictText(input);
  return r.ok ? 'ok' : r.reasons;
};

// 조합형 "한글"과 분해형(초성·중성·종성 조합용 자모)
const DECOMPOSED = '한글'; // 한글
const COMPOSED = '한글';

describe('validateStrictText (S1 §3.2)', () => {
  it('0번: 없음·null·빈 문자열은 REQUIRED, 문자열이 아니면 INVALID_TYPE', () => {
    for (const v of [undefined, null, '']) expect(reasonsOf(v)).toEqual(['REQUIRED']);
    for (const v of [0, 123, true, {}, [], ['a']]) expect(reasonsOf(v)).toEqual(['INVALID_TYPE']);
  });

  it('허용: 영문·숫자·한글·호환 자모·중간 공백 한 칸', () => {
    for (const v of [
      'Friday 7',
      'a',
      'abc123',
      '한글',
      'ㅎㅏㄴ',
      'ㄱㅏ',
      'A b C',
      '가나다라마바사아자차카타',
    ]) {
      expect(reasonsOf(v)).toBe('ok');
    }
  });

  it('길이 경계: 12는 허용, 13은 LENGTH_OUT_OF_RANGE', () => {
    expect(reasonsOf('a'.repeat(12))).toBe('ok');
    expect(reasonsOf('a'.repeat(13))).toEqual(['LENGTH_OUT_OF_RANGE']);
    expect(reasonsOf('가'.repeat(12))).toBe('ok');
    expect(reasonsOf('가'.repeat(13))).toEqual(['LENGTH_OUT_OF_RANGE']);
  });

  it('64 코드 포인트 상한: 넘으면 정규화 없이 LENGTH_OUT_OF_RANGE 하나만(다른 사유를 모으지 않는다)', () => {
    expect(STRICT_TEXT_RAW_MAX).toBe(64);
    expect(reasonsOf('!'.repeat(64))).toEqual(['LENGTH_OUT_OF_RANGE', 'INVALID_CHARACTER']);
    expect(reasonsOf('!'.repeat(65))).toEqual(['LENGTH_OUT_OF_RANGE']);
    // 분해형 한글 12자(36 코드 포인트)는 정상 입력이다.
    expect(reasonsOf('한'.repeat(12))).toBe('ok');
  });

  it('NFC 정규화: 조합형·분해형이 같은 값과 같은 길이로 판정되고 저장값은 정규화본이다', () => {
    const a = validateStrictText(COMPOSED);
    const b = validateStrictText(DECOMPOSED);
    expect(a).toEqual({ ok: true, value: COMPOSED });
    expect(b).toEqual({ ok: true, value: COMPOSED });
    // 분해형 7글자(21 코드 포인트)는 정규화하면 7자라 12 이하다
    expect(reasonsOf('한'.repeat(7))).toBe('ok');
    // 분해형 13글자는 정규화 후 13자라 거부
    expect(reasonsOf('한'.repeat(13))).toEqual(['LENGTH_OUT_OF_RANGE']);
  });

  it('허용 문자 밖: 제어·탭·NBSP·영문 외 라틴·전각·이모지·특수문자', () => {
    for (const v of [
      'a\nb',
      'a\tb',
      'a b',
      'é',
      'Ａ',
      '😀',
      'a!',
      'a-b',
      'a_b',
      'a.b',
      '한글!',
      'a\u0000b',
      'a​b',
    ]) {
      expect(reasonsOf(v)).toEqual(['INVALID_CHARACTER']);
    }
  });

  it('허용 한글 범위의 경계', () => {
    expect(reasonsOf('ㄱ')).toBe('ok'); // ㄱ (호환 자모 시작)
    expect(reasonsOf('ㅣ')).toBe('ok'); // ㅣ (호환 자모 끝)
    expect(reasonsOf('가')).toBe('ok'); // 가
    expect(reasonsOf('힣')).toBe('ok'); // 힣
    for (const cp of [
      0x3130, 0x3164, 0x3165, 0x318e, 0x318f, 0xa960, 0xa97f, 0xd7a4, 0xd7b0, 0xd7ff, 0x1100,
      0x11ff,
    ]) {
      expect(reasonsOf(`a${String.fromCodePoint(cp)}`), `U+${cp.toString(16)}`).toEqual([
        'INVALID_CHARACTER',
      ]);
    }
  });

  it('NFC로 합쳐지지 않고 남은 조합용 자모(U+1100~U+11FF)는 거부한다', () => {
    expect(reasonsOf('ᄀ')).toEqual(['INVALID_CHARACTER']); // 초성 단독
    expect(reasonsOf('ᅡ')).toEqual(['INVALID_CHARACTER']); // 중성 단독
    expect(reasonsOf('가')).toBe('ok'); // 합쳐져 가
  });

  it('공백 규칙: 앞뒤 공백, 연속 공백, 공백만', () => {
    expect(reasonsOf(' a')).toEqual(['LEADING_OR_TRAILING_SPACE']);
    expect(reasonsOf('a ')).toEqual(['LEADING_OR_TRAILING_SPACE']);
    expect(reasonsOf('Friday  7')).toEqual(['CONSECUTIVE_SPACES']);
    expect(reasonsOf(' ')).toEqual(['LEADING_OR_TRAILING_SPACE']);
    expect(reasonsOf('  ')).toEqual(['LEADING_OR_TRAILING_SPACE', 'CONSECUTIVE_SPACES']);
    expect(reasonsOf('Friday 7')).toBe('ok');
  });

  it('사유 코드 전수: 2~4의 위반을 독립적으로 모아 검사 순서(길이, 문자, 앞뒤 공백, 연속 공백)로 반환한다', () => {
    expect(reasonsOf(` ${'a'.repeat(13)}!  `)).toEqual([
      'LENGTH_OUT_OF_RANGE',
      'INVALID_CHARACTER',
      'LEADING_OR_TRAILING_SPACE',
      'CONSECUTIVE_SPACES',
    ]);
    expect(reasonsOf('a'.repeat(13) + '!')).toEqual(['LENGTH_OUT_OF_RANGE', 'INVALID_CHARACTER']);
    expect(reasonsOf(' !')).toEqual(['INVALID_CHARACTER', 'LEADING_OR_TRAILING_SPACE']);
    expect(reasonsOf('a  b!')).toEqual(['INVALID_CHARACTER', 'CONSECUTIVE_SPACES']);
    const seen = new Set<string>();
    for (const v of [undefined, 1, 'a'.repeat(13), 'a!', ' a', 'a  b']) {
      const r = validateStrictText(v);
      if (!r.ok) r.reasons.forEach((x) => seen.add(x));
    }
    expect([...seen].sort()).toEqual(
      [
        'CONSECUTIVE_SPACES',
        'INVALID_CHARACTER',
        'INVALID_TYPE',
        'LEADING_OR_TRAILING_SPACE',
        'LENGTH_OUT_OF_RANGE',
        'REQUIRED',
      ].sort(),
    );
  });

  it('자동 공백 제거를 하지 않는다', () => {
    expect(validateStrictText('a b')).toEqual({ ok: true, value: 'a b' });
    expect(reasonsOf(' a ')).toEqual(['LEADING_OR_TRAILING_SPACE']);
  });

  it('방 이름·정산 단위·닉네임은 같은 규칙이다', () => {
    for (const fn of [validateRoomName, validateUnit, validateNickname]) {
      expect(fn('Friday 7')).toEqual({ ok: true, value: 'Friday 7' });
      expect(fn('a'.repeat(13))).toEqual({ ok: false, reasons: ['LENGTH_OUT_OF_RANGE'] });
    }
  });
});

describe('nicknameKey (S1 §3.2)', () => {
  it('A-Z만 소문자로 바꾼다', () => {
    expect(nicknameKey('Friday 7')).toBe('friday 7');
    expect(nicknameKey('ABC')).toBe('abc');
    expect(nicknameKey('한글 ABC 12')).toBe('한글 abc 12');
  });

  it('호환 자모 낱자 나열과 완성형 음절은 서로 다른 키다(NFC로 합쳐지지 않는다)', () => {
    expect(nicknameKey('ㅎㅏㄴ')).not.toBe(nicknameKey('한'));
  });

  it('조합형과 분해형 한글 닉네임은 정규화 후 같은 키다(AC-ROOM-006-13의 단위 근거)', () => {
    const a = validateNickname(COMPOSED);
    const b = validateNickname(DECOMPOSED);
    if (!a.ok || !b.ok) throw new Error('유효한 닉네임이어야 한다');
    expect(nicknameKey(a.value)).toBe(nicknameKey(b.value));
  });
});

describe('validateStrictText 속성 (fast-check)', () => {
  const allowedChar = fc.constantFrom(...'abcXYZ0189'.split(''), '가', '힣', 'ㄱ', 'ㅣ');

  it('허용 문자만으로 된 1~12자(공백 없음)는 항상 통과하고 값이 변하지 않는다', () => {
    fc.assert(
      fc.property(fc.array(allowedChar, { minLength: 1, maxLength: STRICT_TEXT_MAX }), (chars) => {
        const s = chars.join('');
        expect(validateStrictText(s)).toEqual({ ok: true, value: s });
      }),
    );
  });

  it('13~64자의 허용 문자열은 LENGTH_OUT_OF_RANGE 하나로 거부된다', () => {
    fc.assert(
      fc.property(fc.array(allowedChar, { minLength: 13, maxLength: 64 }), (chars) => {
        expect(validateStrictText(chars.join(''))).toEqual({
          ok: false,
          reasons: ['LENGTH_OUT_OF_RANGE'],
        });
      }),
    );
  });

  it('NFC 동치: 완성형을 분해한 입력(NFD)은 완성형과 같은 결과다', () => {
    const syllable = fc.integer({ min: 0xac00, max: 0xd7a3 }).map((cp) => String.fromCodePoint(cp));
    fc.assert(
      fc.property(fc.array(syllable, { minLength: 1, maxLength: 12 }), (syl) => {
        const composed = syl.join('');
        const decomposed = composed.normalize('NFD');
        expect(validateStrictText(decomposed)).toEqual(validateStrictText(composed));
        expect(validateStrictText(composed)).toEqual({ ok: true, value: composed });
      }),
    );
  });

  it('임의 문자열: 결과는 항상 규칙을 만족하거나 정의된 사유 목록이다(예외 없음, 성공값은 NFC·12자 이하)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (s) => {
        const r = validateStrictText(s);
        if (r.ok) {
          expect(r.value).toBe(r.value.normalize('NFC'));
          expect(Array.from(r.value).length).toBeLessThanOrEqual(12);
          expect(r.value).not.toMatch(/^ | $| {2}/);
          expect(Array.from(r.value).every((c) => /^[가-힣ㄱ-ㅣA-Za-z0-9 ]$/u.test(c))).toBe(true);
        } else {
          expect(r.reasons.length).toBeGreaterThan(0);
          expect(new Set(r.reasons).size).toBe(r.reasons.length);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('nicknameKey는 멱등이고 ASCII 대문자만 바꾼다', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (s) => {
        const k = nicknameKey(s);
        expect(nicknameKey(k)).toBe(k);
        expect(Array.from(k).length).toBe(Array.from(s).length);
        expect(k).toBe(s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)));
      }),
    );
  });
});
