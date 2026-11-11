import type { Params } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Env } from '../config/env.js';

/**
 * 알려진 위치만 가린다: 요청 헤더의 Authorization·cookie와, 최상위 또는 한 단계 중첩된
 * authorization·identityKey 필드. 신원 키를 더 깊은 객체에 담아 로그에 남기지 않는다.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'authorization',
  '*.authorization',
  '*.headers.authorization',
  'identityKey',
  '*.identityKey',
];

export function buildLoggerParams(env: Env, stream?: DestinationStream): Params {
  return {
    pinoHttp: {
      level: env.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      ...(stream ? { stream, level: 'info' } : {}),
    },
  };
}
