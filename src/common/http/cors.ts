import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js';
import type { Env } from '../config/env.js';

/** PD-15: 허용 헤더·노출 헤더. 허용 출처는 환경 설정이다. */
export const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'Idempotency-First-Attempt-At',
] as const;
export const CORS_EXPOSED_HEADERS = ['Date', 'Idempotent-Replayed', 'Retry-After'] as const;

export function corsOptions(env: Pick<Env, 'CORS_ORIGINS'>): CorsOptions {
  return {
    origin: env.CORS_ORIGINS,
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
  };
}
