import type { Env } from '../../src/common/config/env.js';

export function testEnv(nodeEnv: Env['NODE_ENV'] = 'test'): Env {
  return {
    NODE_ENV: nodeEnv,
    PORT: 3001,
    CORS_ORIGINS: ['http://localhost:3000'],
    DATABASE_URL: 'postgresql://user:pw@localhost:5432/db',
    DB_LOCK_TIMEOUT_MS: 5_000,
    DB_STATEMENT_TIMEOUT_MS: 10_000,
    REQUEST_TIMEOUT_MS: 30_000,
    DB_POOL_MAX: 10,
  };
}

/** 시험 출력을 조용히 하려고 로그를 버린다. */
export const quietLog = { write: (): void => undefined };
