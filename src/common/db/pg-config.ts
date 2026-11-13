import type { ConnectionOptions } from 'node:tls';
import type { Env } from '../config/env.js';

export type PgSslEnv = Partial<Pick<Env, 'DB_SSL_REJECT_UNAUTHORIZED' | 'DB_SSL_CA'>>;

const SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

/**
 * `pg`에 넘길 연결 설정. Prisma 전용 `?schema=`는 빼고, `sslmode`가 TLS를 요구하면 연결 문자열 대신
 * 명시 `ssl` 옵션으로 바꾼다. `pg`는 `sslmode=require`를 인증서 검증(verify-full)으로 해석해서
 * Supabase 같은 자체 CA 체인을 거부하므로(`self-signed certificate in certificate chain`),
 * `DB_SSL_REJECT_UNAUTHORIZED=false`(암호화만, 서버 인증 없음)나 `DB_SSL_CA`(CA를 지정해 검증)로 조절한다.
 * 기본값은 검증이다. `sslmode`가 없거나 `disable`이면 TLS 설정을 건드리지 않는다(로컬 개발).
 */
export function pgConnectionConfig(env: Pick<Env, 'DATABASE_URL'> & PgSslEnv): {
  connectionString: string;
  schema?: string;
  ssl?: ConnectionOptions;
} {
  const url = new URL(env.DATABASE_URL);
  const schema = url.searchParams.get('schema') ?? undefined;
  url.searchParams.delete('schema');
  const mode = url.searchParams.get('sslmode');
  let ssl: ConnectionOptions | undefined;
  if (mode !== null && SSL_MODES.has(mode)) {
    url.searchParams.delete('sslmode');
    ssl = { rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED ?? true };
    if (env.DB_SSL_CA) ssl.ca = env.DB_SSL_CA;
  }
  return {
    connectionString: url.toString(),
    ...(schema ? { schema } : {}),
    ...(ssl ? { ssl } : {}),
  };
}
