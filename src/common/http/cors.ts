import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface.js';
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

/**
 * 실제 사전 요청(`Origin`과 `Access-Control-Request-Method`가 있는 OPTIONS)만 CORS가 끝낸다. 그 밖의 OPTIONS는
 * 헤더만 붙이고 라우트 레지스트리로 넘겨 404 또는 405+`Allow`를 받는다(PD-9).
 */
export function corsDelegate(env: Pick<Env, 'CORS_ORIGINS'>): CorsOptionsDelegate<{
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  const base = corsOptions(env);
  return (req, callback) => {
    const preflight =
      req.method === 'OPTIONS' &&
      req.headers['origin'] !== undefined &&
      req.headers['access-control-request-method'] !== undefined;
    callback(null, { ...base, preflightContinue: !preflight });
  };
}
