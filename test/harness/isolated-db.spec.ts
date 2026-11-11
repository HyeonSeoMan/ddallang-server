import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/common/db/prisma.service.js';
import {
  DB_HINT,
  applyMigrations,
  baseDatabaseUrl,
  createIsolatedDb,
  sweepStaleSchemas,
  type IsolatedDb,
} from '../helpers/isolated-db.js';

const opened: IsolatedDb[] = [];
const tmpDirs: string[] = [];
async function open(options?: Parameters<typeof createIsolatedDb>[0]) {
  const db = await createIsolatedDb(options);
  opened.push(db);
  return db;
}
afterAll(async () => {
  await Promise.allSettled(opened.map((d) => d.drop()));
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'f8-migrations-'));
  tmpDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'migration.sql'), sql);
  }
  return dir;
}

describe('시험 DB 격리 (BE-F8)', () => {
  it('스키마마다 테이블이 서로 보이지 않는다', async () => {
    const a = await open();
    const b = await open();
    await a.fixtures('CREATE TABLE "Only_A" (id int)');
    expect((await a.query(`SELECT to_regclass('"Only_A"') AS t`))[0]).toEqual({ t: '"Only_A"' });
    expect((await b.query(`SELECT to_regclass('"Only_A"') AS t`))[0]).toEqual({ t: null });
  });

  it('databaseUrl의 search_path가 연결(Prisma 어댑터 포함)에 적용된다', async () => {
    const db = await open();
    const client = new pg.Client({ connectionString: db.databaseUrl });
    await client.connect();
    const viaPg = (await client.query('SELECT current_schema() AS s')).rows[0];
    await client.end();
    expect(viaPg).toEqual({ s: db.schema });

    const prisma = new PrismaService({ DATABASE_URL: db.databaseUrl, DB_POOL_MAX: 2 });
    try {
      const viaPrisma = await prisma.client.$queryRaw<
        { s: string }[]
      >`SELECT current_schema() AS s`;
      expect(viaPrisma[0]).toEqual({ s: db.schema });
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  it('drop하면 스키마가 사라진다', async () => {
    const db = await createIsolatedDb();
    const admin = new pg.Client({ connectionString: baseDatabaseUrl() });
    await admin.connect();
    try {
      const exists = () =>
        admin
          .query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [db.schema])
          .then((r) => r.rowCount);
      expect(await exists()).toBe(1);
      await db.drop();
      expect(await exists()).toBe(0);
    } finally {
      await admin.end();
    }
  });

  it('마이그레이션 SQL을 이름 순으로 적용하고 디렉터리가 아닌 항목은 무시한다', async () => {
    const dir = migrationsDir({
      '20260102_b': 'ALTER TABLE "T" ADD COLUMN "b" int',
      '20260101_a': 'CREATE TABLE "T" ("a" int)',
    });
    writeFileSync(join(dir, 'migration_lock.toml'), 'provider = "postgresql"');
    const db = await open();
    const applied = await applyMigrations(db, dir);
    expect(applied).toEqual(['20260101_a', '20260102_b']);
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'T' ORDER BY column_name`,
      [db.schema],
    );
    expect(cols.map((c) => c.column_name)).toEqual(['a', 'b']);
  });

  it('마이그레이션이 실패하면 이름을 담아 던지고 만든 스키마를 정리한다', async () => {
    const marker = `marker_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const dir = migrationsDir({
      '20260101_ok': `CREATE TABLE "${marker}" ("a" int)`,
      '20260102_bad': 'THIS IS NOT SQL',
    });
    await expect(createIsolatedDb({ migrations: dir })).rejects.toThrow(/20260102_bad/);
    const admin = new pg.Client({ connectionString: baseDatabaseUrl() });
    await admin.connect();
    try {
      // 첫 마이그레이션이 만든 테이블이 어느 스키마에도 남아 있지 않아야 한다(스키마째 삭제됨).
      const left = await admin.query(
        'SELECT 1 FROM information_schema.tables WHERE table_name = $1',
        [marker],
      );
      expect(left.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  });

  it('migrations: true이고 마이그레이션 디렉터리가 비어 있으면 아무것도 적용하지 않는다', async () => {
    const db = await open({ migrations: true });
    expect(db.schema).toMatch(/^t_[0-9a-f]{12}$/);
  });

  it('오래된 t_ 스키마만 정리하고 최근 것·다른 이름은 건드리지 않는다', async () => {
    const admin = new pg.Client({ connectionString: baseDatabaseUrl() });
    await admin.connect();
    // 이 시험이 만든 스키마만 다룬다: 실행마다 고유한 이름이라 선행 삭제도, 다른 실행과의 충돌도 없다.
    const hex = randomBytes(6).toString('hex');
    const old = `t_${hex}`;
    const odd = `t_notatest_${hex}`;
    try {
      await admin.query(`CREATE SCHEMA "${old}"`);
      await admin.query(
        `COMMENT ON SCHEMA "${old}" IS 'f8-test-schema created=${Date.now() - 2 * 60 * 60 * 1000}'`,
      );
      await admin.query(`CREATE SCHEMA "${odd}"`);
      const fresh = await open();

      const dropped = await sweepStaleSchemas();
      expect(dropped).toContain(old);
      expect(dropped).not.toContain(fresh.schema);
      expect(dropped).not.toContain(odd);
      const rows = await admin.query('SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)', [
        [old, odd, fresh.schema, 'public'],
      ]);
      expect(rows.rows.map((r) => r.nspname).sort()).toEqual([fresh.schema, odd, 'public'].sort());
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${old}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${odd}" CASCADE`);
      await admin.end();
    }
  });

  it('DB에 연결할 수 없으면 docker compose up -d 안내와 함께 실패한다', async () => {
    const saved = process.env.DATABASE_URL;
    baseDatabaseUrl();
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/none';
    try {
      await expect(createIsolatedDb()).rejects.toThrow(/docker compose up -d/);
    } finally {
      process.env.DATABASE_URL = saved;
    }
    expect(DB_HINT).toContain('docker compose up -d');
  });
});
