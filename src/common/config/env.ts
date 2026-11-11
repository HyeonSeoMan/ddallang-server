import { z } from 'zod';

/** 멱등 기록 보관 여유(S2 §5). 요청 제한 시간은 이보다 짧아야 한다(PD-3). */
export const IDEMPOTENCY_RETENTION_MS = 60 * 60 * 1000;

const positiveInt = (def: number) => z.coerce.number().int().min(1).default(def);

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CORS_ORIGINS: z.string().min(1),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'postgresql:// 형식이어야 한다'),
  /** 커서 AEAD 키(AES-256-GCM): 32바이트를 base64(또는 base64url)로 인코딩한 값. 교체하면 진행 중인 커서가 무효가 되어도 된다(PD-12). */
  CURSOR_KEY: z.string().min(1),
  DB_LOCK_TIMEOUT_MS: positiveInt(5_000),
  DB_STATEMENT_TIMEOUT_MS: positiveInt(10_000),
  REQUEST_TIMEOUT_MS: positiveInt(30_000),
  DB_POOL_MAX: positiveInt(10),
});

export type Env = {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  CORS_ORIGINS: string[];
  DATABASE_URL: string;
  /** 디코드한 32바이트 커서 키 */
  CURSOR_KEY: Buffer;
  DB_LOCK_TIMEOUT_MS: number;
  DB_STATEMENT_TIMEOUT_MS: number;
  /** BE-F2에서는 Prisma 트랜잭션 제한 시간으로만 쓴다. 서버의 요청 제한에는 아직 연결되지 않았다. */
  REQUEST_TIMEOUT_MS: number;
  DB_POOL_MAX: number;
};

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`환경 변수 검증 실패: ${issues.join('; ')}`);
    this.name = 'EnvValidationError';
  }
}

/** 값 자체는 오류 메시지에 넣지 않는다(비밀 노출 방지). 키 이름과 사유만 남긴다. */
export function loadEnv(raw: Record<string, string | undefined>): Env {
  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const { CORS_ORIGINS, ...rest } = parsed.data;
  const listed = CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (listed.length === 0) {
    throw new EnvValidationError(['CORS_ORIGINS: 허용 출처가 하나 이상 있어야 한다']);
  }
  const { DB_LOCK_TIMEOUT_MS: lock, DB_STATEMENT_TIMEOUT_MS: stmt, REQUEST_TIMEOUT_MS: req } = rest;
  if (!(lock < stmt && stmt < req && req < IDEMPOTENCY_RETENTION_MS)) {
    throw new EnvValidationError([
      'DB_LOCK_TIMEOUT_MS < DB_STATEMENT_TIMEOUT_MS < REQUEST_TIMEOUT_MS < 3600000(1시간)이어야 한다',
    ]);
  }
  const cursorKey = Buffer.from(rest.CURSOR_KEY, 'base64');
  if (cursorKey.length !== 32) {
    throw new EnvValidationError(['CURSOR_KEY: base64로 인코딩한 32바이트여야 한다']);
  }
  return { ...rest, CURSOR_KEY: cursorKey, CORS_ORIGINS: listed };
}
