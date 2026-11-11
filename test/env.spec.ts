import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from '../src/common/config/env.js';

const valid = {
  NODE_ENV: 'development',
  CORS_ORIGINS: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://u:secret-pw@localhost:5432/db',
  CURSOR_KEY: Buffer.alloc(32, 1).toString('base64'),
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

  it.each(['NODE_ENV', 'DATABASE_URL', 'CORS_ORIGINS', 'CURSOR_KEY'])(
    '%s 누락이면 실패한다',
    (key) => {
      const raw: Record<string, string | undefined> = { ...valid };
      delete raw[key];
      expect(() => loadEnv(raw)).toThrow(EnvValidationError);
    },
  );

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

  it('DB 시간 제한 기본값은 5초·10초·30초, 풀은 10이다', () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({
      DB_LOCK_TIMEOUT_MS: 5000,
      DB_STATEMENT_TIMEOUT_MS: 10000,
      REQUEST_TIMEOUT_MS: 30000,
      DB_POOL_MAX: 10,
    });
  });

  it('값을 환경 변수로 바꿀 수 있다', () => {
    const env = loadEnv({
      ...valid,
      DB_LOCK_TIMEOUT_MS: '1000',
      DB_STATEMENT_TIMEOUT_MS: '2000',
      REQUEST_TIMEOUT_MS: '3000',
      DB_POOL_MAX: '4',
    });
    expect(env).toMatchObject({ DB_LOCK_TIMEOUT_MS: 1000, DB_POOL_MAX: 4 });
  });

  it.each([
    ['lock == statement', { DB_LOCK_TIMEOUT_MS: '10000' }],
    ['lock > statement', { DB_LOCK_TIMEOUT_MS: '20000' }],
    ['statement == request', { DB_STATEMENT_TIMEOUT_MS: '30000' }],
    ['statement > request', { DB_STATEMENT_TIMEOUT_MS: '40000' }],
    ['request == 1시간', { REQUEST_TIMEOUT_MS: '3600000' }],
    ['request > 1시간', { REQUEST_TIMEOUT_MS: '7200000' }],
  ])('시간 제한 순서를 어기면 실패한다: %s', (_n, override) => {
    expect(() => loadEnv({ ...valid, ...override })).toThrow(/DB_LOCK_TIMEOUT_MS <|DB_/);
  });

  it('요청 제한이 1시간 바로 아래(3599999)면 통과한다', () => {
    expect(loadEnv({ ...valid, REQUEST_TIMEOUT_MS: '3599999' }).REQUEST_TIMEOUT_MS).toBe(3599999);
  });

  it.each(['0', '-1', '1.5', 'abc'])('DB 설정 값 %s는 거부한다', (bad) => {
    for (const key of [
      'DB_LOCK_TIMEOUT_MS',
      'DB_STATEMENT_TIMEOUT_MS',
      'REQUEST_TIMEOUT_MS',
      'DB_POOL_MAX',
    ]) {
      expect(() => loadEnv({ ...valid, [key]: bad })).toThrow(EnvValidationError);
    }
  });

  it('CURSOR_KEY는 base64로 인코딩한 32바이트여야 하고 디코드한 Buffer로 노출한다', () => {
    const env = loadEnv(valid);
    expect(env.CURSOR_KEY).toBeInstanceOf(Buffer);
    expect(env.CURSOR_KEY).toHaveLength(32);
    for (const bad of [
      Buffer.alloc(16).toString('base64'),
      Buffer.alloc(33).toString('base64'),
      'x',
      '!!!!',
    ]) {
      expect(() => loadEnv({ ...valid, CURSOR_KEY: bad })).toThrow(/CURSOR_KEY/);
    }
  });
});
