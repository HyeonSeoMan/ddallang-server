import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * BE-F2 시험 전용 최소 도우미. 시험마다 임시 스키마를 만들고 시험용 "Room" 테이블을 둔다.
 * 실제 `Room` 테이블은 BE-S1-1 소유이므로 여기서 마이그레이션으로 만들지 않는다.
 * BE-F8의 시험 기반(스키마 격리·하네스)이 이 도우미를 대체한다.
 */
export interface TestSchema {
  schema: string;
  databaseUrl: string;
  drop(): Promise<void>;
}

const HINT =
  'PostgreSQL에 연결할 수 없다. `docker compose up -d`로 DB를 띄우고 .env(DATABASE_URL)를 확인한 뒤 다시 실행하라.';

function resolveDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile('.env');
    } catch {
      // .env가 없으면 아래에서 안내와 함께 실패한다.
    }
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`DATABASE_URL이 없다. .env.example을 복사해 .env를 만들어라. ${HINT}`);
  return url;
}

export async function createTestSchema(): Promise<TestSchema> {
  const databaseUrl = resolveDatabaseUrl();
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (cause) {
    throw new Error(HINT, { cause });
  }
  const schema = `f2_${randomBytes(6).toString('hex')}`;
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(
    `CREATE TABLE "${schema}"."Room" ("id" text PRIMARY KEY, "revision" integer NOT NULL DEFAULT 0)`,
  );
  return {
    schema,
    databaseUrl,
    async drop() {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    },
  };
}

/** Prisma가 감싼 오류에서 PostgreSQL SQLSTATE(5자)를 찾는다. */
export function sqlState(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | undefined => {
    if (!v || typeof v !== 'object' || seen.has(v)) return undefined;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (typeof o.originalCode === 'string') return o.originalCode;
    if (typeof o.code === 'string' && /^[0-9A-Z]{5}$/.test(o.code) && !/^P\d{4}$/.test(o.code)) {
      return o.code;
    }
    for (const k of Object.keys(o)) {
      const r = walk(o[k]);
      if (r) return r;
    }
    return undefined;
  };
  return walk(err);
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
