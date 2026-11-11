import { z } from 'zod';

const DEV_DEFAULT_CORS_ORIGIN = 'http://localhost:3000';

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CORS_ORIGINS: z.string().optional(),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'postgresql:// 형식이어야 한다'),
});

export type Env = {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  CORS_ORIGINS: string[];
  DATABASE_URL: string;
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
  const listed = (CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (listed.length === 0 && rest.NODE_ENV !== 'development') {
    throw new EnvValidationError(['CORS_ORIGINS: development 밖에서는 필수다']);
  }
  return { ...rest, CORS_ORIGINS: listed.length > 0 ? listed : [DEV_DEFAULT_CORS_ORIGIN] };
}
