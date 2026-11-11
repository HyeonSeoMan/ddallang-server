import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * BE-F8 시험 DB 격리. 시험(파일)마다 임시 스키마를 만들고 `search_path`를 그 스키마로 고정한
 * DATABASE_URL을 준다. 같은 URL을 서버 인스턴스 자식 프로세스에도 넘기므로 운영 코드는 바뀌지 않는다.
 */
export interface IsolatedDb {
  schema: string;
  /** `options=-c search_path=<schema>`(raw SQL)와 `schema=<schema>`(Prisma 모델)가 붙은 연결 문자열 */
  databaseUrl: string;
  /** 시험 전용 DDL·시드를 이 스키마에서 실행한다(마이그레이션에 들어가지 않는 구조용). */
  fixtures(sql: string): Promise<void>;
  /** 이 스키마에서 임의 SQL을 조회한다. */
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<R[]>;
  drop(): Promise<void>;
}

export const DB_HINT =
  'PostgreSQL에 연결할 수 없다. `docker compose up -d`로 DB를 띄우고 .env(DATABASE_URL)를 확인한 뒤 다시 실행하라.';

const SCHEMA_PREFIX = 't_';
const SCHEMA_RE = /^t_[0-9a-f]{12}$/;
const STALE_AFTER_MS = 60 * 60 * 1000;
const COMMENT_TAG = 'f8-test-schema created=';

/** 시험용 DDL: BE-S1-1이 실제 `Room`을 만들기 전까지 잠금·직렬화 시험이 쓰는 최소 구조(마이그레이션 아님). */
export const TEST_ROOM_DDL = `CREATE TABLE "Room" ("id" text PRIMARY KEY, "revision" integer NOT NULL DEFAULT 0)`;

export function baseDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile('.env');
    } catch {
      // .env가 없으면 아래에서 안내와 함께 실패한다.
    }
  }
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error(`DATABASE_URL이 없다. .env.example을 복사해 .env를 만들어라. ${DB_HINT}`);
  return url;
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (cause) {
    throw new Error(DB_HINT, { cause });
  }
  return client;
}

export function withSearchPath(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.set('options', `-c search_path=${schema}`); // raw SQL
  u.searchParams.set('schema', schema); // Prisma 생성 모델이 만드는 질의(`"schema"."Table"`)
  return u.toString();
}

export interface CreateOptions {
  /** true면 `prisma/migrations` 아래 각 디렉터리의 migration.sql을 이름 순으로 적용한다. 경로를 주면 그 디렉터리를 쓴다. */
  migrations?: boolean | string;
}

export async function createIsolatedDb(options: CreateOptions = {}): Promise<IsolatedDb> {
  const base = baseDatabaseUrl();
  const client = await connect(base);
  const schema = `${SCHEMA_PREFIX}${randomBytes(6).toString('hex')}`;
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`COMMENT ON SCHEMA "${schema}" IS '${COMMENT_TAG}${Date.now()}'`);
  await client.query(`SET search_path TO "${schema}"`);
  const db: IsolatedDb = {
    schema,
    databaseUrl: withSearchPath(base, schema),
    async fixtures(sql) {
      await client.query(sql);
    },
    async query(sql, params) {
      return (await client.query(sql, params as unknown[])).rows;
    },
    async drop() {
      await client.query('SET search_path TO public');
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    },
  };
  try {
    if (options.migrations) {
      await applyMigrations(
        db,
        typeof options.migrations === 'string' ? options.migrations : undefined,
      );
    }
  } catch (err) {
    await db.drop();
    throw err;
  }
  return db;
}

/**
 * 마이그레이션 디렉터리의 각 migration.sql을 이름 순으로 이 스키마에 적용한다.
 * `_prisma_migrations` 이력·체크섬(`prisma migrate deploy`)은 검증하지 않는다.
 */
export async function applyMigrations(
  db: IsolatedDb,
  dir = join(process.cwd(), 'prisma', 'migrations'),
) {
  if (!existsSync(dir)) return [];
  const applied: string[] = [];
  const names = readdirSync(dir)
    .filter(
      (n) => statSync(join(dir, n)).isDirectory() && existsSync(join(dir, n, 'migration.sql')),
    )
    .sort();
  for (const name of names) {
    try {
      await db.fixtures(readFileSync(join(dir, name, 'migration.sql'), 'utf8'));
    } catch (cause) {
      throw new Error(`마이그레이션 ${name} 적용 실패: ${(cause as Error).message}`, { cause });
    }
    applied.push(name);
  }
  return applied;
}

/** 비정상 종료로 남은 `t_` 스키마 중 1시간 넘은 것만 지운다(실행 중인 다른 시험의 스키마는 건드리지 않는다). */
export async function sweepStaleSchemas(
  now = Date.now(),
  staleAfterMs = STALE_AFTER_MS,
): Promise<string[]> {
  const client = await connect(baseDatabaseUrl());
  const dropped: string[] = [];
  try {
    const { rows } = await client.query<{ nspname: string; comment: string | null }>(
      `SELECT nspname, obj_description(oid, 'pg_namespace') AS comment FROM pg_namespace WHERE nspname ~ '^t_[0-9a-f]{12}$'`,
    );
    for (const r of rows) {
      const created = Number(
        r.comment?.startsWith(COMMENT_TAG) ? r.comment.slice(COMMENT_TAG.length) : NaN,
      );
      if (SCHEMA_RE.test(r.nspname) && Number.isFinite(created) && now - created > staleAfterMs) {
        await client.query(`DROP SCHEMA "${r.nspname}" CASCADE`);
        dropped.push(r.nspname);
      }
    }
  } finally {
    await client.end();
  }
  return dropped;
}
