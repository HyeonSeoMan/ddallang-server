import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from '../src/common/config/env.js';

const valid = {
  NODE_ENV: 'development',
  CORS_ORIGINS: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://u:secret-pw@localhost:5432/db',
};

describe('loadEnv (PD-18)', () => {
  it('정상 값이면 PORT 기본값 3001을 채우고 출처를 나눈다', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(3001);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000']);
  });

  it('CORS_ORIGINS는 쉼표로 나눈다', () => {
    const env = loadEnv({ ...valid, CORS_ORIGINS: 'https://a.example, https://b.example' });
    expect(env.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it.each(['NODE_ENV', 'DATABASE_URL', 'CORS_ORIGINS'])('%s 누락이면 실패한다', (key) => {
    const raw: Record<string, string | undefined> = { ...valid };
    delete raw[key];
    expect(() => loadEnv(raw)).toThrow(EnvValidationError);
  });

  it.each([undefined, '', 'staging', 'Development', 'prod'])(
    'NODE_ENV=%j는 허용 밖이라 실패한다',
    (nodeEnv) => {
      expect(() => loadEnv({ ...valid, NODE_ENV: nodeEnv })).toThrow(EnvValidationError);
    },
  );

  it.each(['development', 'test', 'production'])(
    '%s에서도 CORS_ORIGINS 누락·빈 값은 실패한다',
    (nodeEnv) => {
      const { CORS_ORIGINS: _omit, ...rest } = valid;
      void _omit;
      for (const bad of [undefined, '', ' , ']) {
        expect(() => loadEnv({ ...rest, NODE_ENV: nodeEnv, CORS_ORIGINS: bad })).toThrow(
          /CORS_ORIGINS/,
        );
      }
    },
  );

  it('PORT가 숫자 범위 밖이면 실패한다', () => {
    expect(() => loadEnv({ ...valid, PORT: '70000' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...valid, PORT: 'abc' })).toThrow(EnvValidationError);
  });

  it('DATABASE_URL이 postgres URL이 아니면 실패하고 오류에 값이 나오지 않는다', () => {
    try {
      loadEnv({ ...valid, DATABASE_URL: 'mysql://u:secret-pw@h/db' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      expect((e as Error).message).not.toContain('secret-pw');
    }
  });
});
