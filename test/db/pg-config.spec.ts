import { describe, expect, it } from 'vitest';
import { pgConnectionConfig } from '../../src/common/db/pg-config.js';
import { loadEnv } from '../../src/common/config/env.js';

const base = 'postgresql://user:pw@db.example:5432/postgres';

describe('pgConnectionConfig (연결 TLS 설정)', () => {
  it('sslmode가 없으면 TLS 설정을 건드리지 않는다(로컬 개발)', () => {
    const c = pgConnectionConfig({ DATABASE_URL: base });
    expect(c.ssl).toBeUndefined();
    expect(c.connectionString).toBe(base);
  });

  it('sslmode=disable도 그대로 둔다', () => {
    const c = pgConnectionConfig({ DATABASE_URL: `${base}?sslmode=disable` });
    expect(c.ssl).toBeUndefined();
    expect(c.connectionString).toContain('sslmode=disable');
  });

  it('sslmode=require는 기본적으로 인증서를 검증하고 연결 문자열에서 sslmode를 뺀다', () => {
    const c = pgConnectionConfig({ DATABASE_URL: `${base}?sslmode=require` });
    expect(c.ssl).toEqual({ rejectUnauthorized: true });
    expect(c.connectionString).not.toContain('sslmode');
  });

  it('DB_SSL_REJECT_UNAUTHORIZED=false이면 암호화만 하고 서버 인증서는 검증하지 않는다', () => {
    const c = pgConnectionConfig({
      DATABASE_URL: `${base}?sslmode=require`,
      DB_SSL_REJECT_UNAUTHORIZED: false,
    });
    expect(c.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('DB_SSL_CA가 있으면 그 CA로 검증한다', () => {
    const c = pgConnectionConfig({
      DATABASE_URL: `${base}?sslmode=verify-full`,
      DB_SSL_CA: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
    });
    expect(c.ssl).toMatchObject({ rejectUnauthorized: true, ca: expect.stringContaining('BEGIN') });
  });

  it('Prisma 전용 schema는 pg 설정에서 빼고 따로 돌려준다', () => {
    const c = pgConnectionConfig({ DATABASE_URL: `${base}?schema=t1&sslmode=require` });
    expect(c.schema).toBe('t1');
    expect(c.connectionString).not.toContain('schema=');
  });
});

describe('환경 변수 DB_SSL_*', () => {
  const valid = {
    NODE_ENV: 'production',
    CORS_ORIGINS: 'http://localhost:3000',
    DATABASE_URL: base,
    CURSOR_KEY: Buffer.alloc(32, 1).toString('base64'),
  };
  it('기본값은 검증(true)이고 CA는 없다', () => {
    const env = loadEnv(valid);
    expect(env.DB_SSL_REJECT_UNAUTHORIZED).toBe(true);
    expect(env.DB_SSL_CA).toBeUndefined();
  });
  it('false를 받고, CA의 \\n 문자열은 개행으로 바꾼다', () => {
    const env = loadEnv({ ...valid, DB_SSL_REJECT_UNAUTHORIZED: 'false', DB_SSL_CA: 'a\\nb' });
    expect(env.DB_SSL_REJECT_UNAUTHORIZED).toBe(false);
    expect(env.DB_SSL_CA).toBe('a\nb');
  });
  it('true/false 외의 값은 거부한다(값은 메시지에 넣지 않는다)', () => {
    expect(() => loadEnv({ ...valid, DB_SSL_REJECT_UNAUTHORIZED: 'maybe' })).toThrow(
      /DB_SSL_REJECT_UNAUTHORIZED/,
    );
  });
});
