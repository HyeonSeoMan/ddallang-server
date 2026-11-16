import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId, newInviteCode } from '../../src/common/ids/ids.js';
import { applyMigrations, createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';

/**
 * BE-M1 (PD-22): v2 마이그레이션은 v1.x 데이터를 옮기지 않는다. 방이 하나라도 있으면 아무것도 바꾸지 않고 실패하고,
 * `prisma/reset-v1-data.sql`로 지운 뒤에는 적용된다.
 */
const DIR = join(process.cwd(), 'prisma', 'migrations');
const V2 = '20261116000000_v2_participant_identity';
const all = readdirSync(DIR)
  .filter((n) => /^\d{14}_/.test(n))
  .sort();
const v1 = all.filter((n) => n < V2);
const sql = (name: string) => readFileSync(join(DIR, name, 'migration.sql'), 'utf8');
const RESET = readFileSync(join(process.cwd(), 'prisma', 'reset-v1-data.sql'), 'utf8');

const tables = async (db: IsolatedDb) =>
  (
    await db.query<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`,
      [db.schema],
    )
  ).map((r) => r.t);

/** v1.x 스키마에 방·RoomMember·참여자·거래·멱등 기록·임대가 있는 상태 */
async function seedV1(db: IsolatedDb): Promise<void> {
  const room = newId();
  const member = newId();
  const [a, b] = [newId(), newId()];
  await db.query(`INSERT INTO "Room" ("id","name","unit","inviteCode") VALUES ($1,'R','원',$2)`, [
    room,
    newInviteCode(),
  ]);
  await db.query(
    `INSERT INTO "RoomMember" ("id","roomId","nickname","nicknameKey","isHost","identityKeyHash") VALUES ($1,$2,'Host','host',true,$3)`,
    [member, room, 'a'.repeat(64)],
  );
  await db.query(
    `INSERT INTO "Participant" ("id","roomId","nickname","nicknameKey","order") VALUES ($1,$3,'A','a',1),($2,$3,'B','b',2)`,
    [a, b, room],
  );
  await db.query(
    `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","authorId","originalAmount","createdAt","updatedAt") VALUES ($1,$2,1,$3,$4,100,$5,100,now(),now())`,
    [newId(), room, a, b, member],
  );
  await db.query(
    `INSERT INTO "IdempotencyRecord" ("id","roomId","memberId","key","operation","fingerprint","firstAttemptAt","expiresAt","statusCode","responseBody") VALUES ($1,$2,$3,'k-0123456789abcdef','CREATE',$4,now(),now() + interval '1 day',201,'{}')`,
    [newId(), room, member, 'b'.repeat(64)],
  );
  await db.query(
    `INSERT INTO "StreamLease" ("id","roomId","memberId","instanceId","expiresAt") VALUES ($1,$2,$3,'i',now() + interval '15 seconds')`,
    [newId(), room, member],
  );
}

describe('v2 마이그레이션 적용 조건 (BE-M1, PD-22)', () => {
  let db: IsolatedDb | undefined;
  afterEach(async () => {
    await db?.drop();
    db = undefined;
  });

  it('빈 DB에 처음부터 모든 마이그레이션을 적용할 수 있다', async () => {
    db = await createIsolatedDb();
    const applied = await applyMigrations(db);
    expect(applied).toEqual(all);
    expect(applied.at(-1)).toBe(V2);
    expect(await tables(db)).not.toContain('RoomMember');
    expect(await tables(db)).toEqual(
      expect.arrayContaining(['ClaimRequest', 'RevokedIdentity', 'Participant']),
    );
  });

  it('데이터가 없는 v1.x 스키마에 적용할 수 있다', async () => {
    db = await createIsolatedDb();
    for (const name of v1) await db.fixtures(sql(name));
    expect(await tables(db)).toContain('RoomMember');
    await db.fixtures(sql(V2));
    expect(await tables(db)).not.toContain('RoomMember');
  });

  it('v1.x 데이터가 있으면 실패하고 아무것도 바꾸지 않는다(데이터를 옮기지 않는다)', async () => {
    db = await createIsolatedDb();
    for (const name of v1) await db.fixtures(sql(name));
    await seedV1(db);
    const before = await tables(db);
    await expect(db.fixtures(sql(V2))).rejects.toThrow(/PD-22/);
    expect(await tables(db)).toEqual(before);
    for (const t of ['Room', 'RoomMember', 'Participant', 'Transaction', 'IdempotencyRecord']) {
      const [r] = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${t}"`);
      expect(Number(r!.n), t).toBeGreaterThan(0);
    }
    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'IdempotencyRecord'`,
      [db.schema],
    );
    expect(cols.map((c) => c.column_name)).toContain('memberId'); // 이름 바꾸기도 롤백됐다
  });

  it('reset-v1-data.sql로 지운 뒤에는 적용된다(스키마는 바꾸지 않는다)', async () => {
    db = await createIsolatedDb();
    for (const name of v1) await db.fixtures(sql(name));
    await seedV1(db);
    const before = await tables(db);
    await db.fixtures(RESET);
    expect(await tables(db)).toEqual(before);
    for (const t of before.filter((t) => t !== '_prisma_migrations')) {
      const [r] = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${t}"`);
      expect(Number(r!.n), t).toBe(0);
    }
    await db.fixtures(sql(V2));
    expect(await tables(db)).not.toContain('RoomMember');
  });
});
