import type { Params } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Env } from '../config/env.js';

/** Authorization 헤더(신원 키 Bearer)와 신원 키 필드는 어느 위치에 나와도 가린다. */
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
