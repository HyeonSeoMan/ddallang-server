import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newInviteCode } from '../../src/common/ids/ids.js';
import { applyMigrations, createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';

/**
 * 운영 DB(Supabase)의 Data API가 표를 공개하지 않도록 모든 표에 RLS를 켠다(`20261118000000_enable_rls`).
 * 앱은 표 소유자로 연결하므로 그대로 읽고 쓰고, 소유자가 아닌 역할은 권한이 있어도 행에 접근하지 못한다.
 * 역할을 만들고 `SET ROLE`로 바꾸므로 시험 DB 계정이 superuser(로컬 docker-compose의 기본 계정)라고 전제한다.
 */
let db: IsolatedDb;
beforeAll(async () => {
  db = await createIsolatedDb();
  // `prisma migrate deploy`가 만드는 이력 표가 있는 운영과 같은 상태로 만든다.
  await db.query(`CREATE TABLE "_prisma_migrations" ("id" TEXT PRIMARY KEY)`);
  await applyMigrations(db);
});
afterAll(() => db?.drop());

describe('RLS (Supabase rls_disabled_in_public)', () => {
  it('스키마의 모든 표에 RLS가 켜져 있고 FORCE는 아니다(새 표도 RLS를 켜야 이 시험이 통과한다)', async () => {
    const rows = await db.query<{ t: string; rls: boolean; force: boolean }>(
      `SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY 1`,
      [db.schema],
    );
    expect(rows.map((r) => r.t)).toEqual(
      expect.arrayContaining(['Room', 'Participant', 'Transaction', '_prisma_migrations']),
    );
    expect(rows.filter((r) => !r.rls).map((r) => r.t)).toEqual([]);
    expect(rows.filter((r) => r.force).map((r) => r.t)).toEqual([]);
  });

  it('표 소유자(앱 연결)는 RLS와 무관하게 읽고 쓴다', async () => {
    const id = newId();
    await db.query(`INSERT INTO "Room" ("id","name","unit","inviteCode") VALUES ($1,'R','원',$2)`, [
      id,
      newInviteCode(),
    ]);
    expect(await db.query(`SELECT "id" FROM "Room" WHERE "id" = $1`, [id])).toHaveLength(1);
  });

  it('소유자가 아닌 역할은 SELECT·INSERT 권한이 있어도 행을 읽거나 쓰지 못한다', async () => {
    const role = `rls_probe_${randomBytes(4).toString('hex')}`;
    await db.query(`CREATE ROLE "${role}" NOLOGIN`);
    try {
      await db.query(`GRANT USAGE ON SCHEMA "${db.schema}" TO "${role}"`);
      await db.query(`GRANT SELECT, INSERT ON "Room" TO "${role}"`);
      expect((await db.query(`SELECT count(*)::int AS n FROM "Room"`))[0]).toEqual({ n: 1 });
      await db.query(`SET ROLE "${role}"`);
      try {
        expect((await db.query(`SELECT count(*)::int AS n FROM "Room"`))[0]).toEqual({ n: 0 });
        await expect(
          db.query(`INSERT INTO "Room" ("id","name","unit","inviteCode") VALUES ($1,'R','원',$2)`, [
            newId(),
            newInviteCode(),
          ]),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await db.query('RESET ROLE');
      }
    } finally {
      await db.query(`REVOKE ALL ON "Room" FROM "${role}"`);
      await db.query(`REVOKE ALL ON SCHEMA "${db.schema}" FROM "${role}"`);
      await db.query(`DROP ROLE "${role}"`);
    }
  });

  it('Supabase 역할(anon, authenticated)이 있으면 지금 표와 앞으로 만들 표의 권한을 회수한다(역할 생성은 트랜잭션 안에서 되돌린다)', async (ctx) => {
    const exists = await db.query(`SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`);
    // Supabase처럼 역할이 이미 있는 DB에서는 이 시험이 역할을 만들 수 없으므로 건너뜀으로 표시한다.
    if (exists.length > 0) ctx.skip();
    const sql = readFileSync(
      join(process.cwd(), 'prisma', 'migrations', '20261118000000_enable_rls', 'migration.sql'),
      'utf8',
    );
    await db.query('BEGIN');
    try {
      await db.query('CREATE ROLE anon NOLOGIN');
      await db.query('CREATE ROLE authenticated NOLOGIN');
      await db.query(`GRANT ALL ON ALL TABLES IN SCHEMA "${db.schema}" TO anon, authenticated`);
      // Supabase처럼 새 표에도 권한이 자동으로 열리는 기본 권한을 둔다.
      await db.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA "${db.schema}" GRANT ALL ON TABLES TO anon, authenticated`,
      );
      const can = async () =>
        (
          await db.query<{ a: boolean; b: boolean }>(
            `SELECT has_table_privilege('anon', '"Room"', 'SELECT') AS a,
                    has_table_privilege('authenticated', '"Transaction"', 'DELETE') AS b`,
          )
        )[0];
      expect(await can()).toEqual({ a: true, b: true });
      await db.fixtures(sql); // 다시 적용해도 실패하지 않는다
      expect(await can()).toEqual({ a: false, b: false });
      await db.query(`CREATE TABLE "RlsProbeNewTable" ("id" TEXT PRIMARY KEY)`);
      expect(
        (
          await db.query<{ a: boolean; b: boolean }>(
            `SELECT has_table_privilege('anon', '"RlsProbeNewTable"', 'SELECT') AS a,
                    has_table_privilege('authenticated', '"RlsProbeNewTable"', 'INSERT') AS b`,
          )
        )[0],
      ).toEqual({ a: false, b: false });
    } finally {
      await db.query('ROLLBACK');
    }
    expect(await db.query(`SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)).toEqual(
      [],
    );
  });
});
