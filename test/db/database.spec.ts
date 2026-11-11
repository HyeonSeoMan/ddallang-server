import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService, RoomNotFoundError } from '../../src/common/db/database.service.js';
import { PrismaService } from '../../src/common/db/prisma.service.js';
import {
  createTestSchema,
  deferred,
  sleep,
  sqlState,
  type TestSchema,
} from '../helpers/test-db.js';

let ts: TestSchema;
let prisma: PrismaService;
let db: DatabaseService;

function makeDb(overrides: Partial<ConstructorParameters<typeof DatabaseService>[1]> = {}) {
  return new DatabaseService(prisma, {
    DB_LOCK_TIMEOUT_MS: 5_000,
    DB_STATEMENT_TIMEOUT_MS: 10_000,
    REQUEST_TIMEOUT_MS: 30_000,
    ...overrides,
  });
}

beforeAll(async () => {
  ts = await createTestSchema();
  prisma = new PrismaService(
    { DATABASE_URL: ts.databaseUrl, DB_POOL_MAX: 10 },
    { schema: ts.schema },
  );
  db = makeDb();
});
afterAll(async () => {
  await prisma?.onModuleDestroy();
  await ts?.drop();
});
beforeEach(async () => {
  await prisma.client.$executeRawUnsafe(`TRUNCATE "Room"`);
  await prisma.client.$executeRawUnsafe(`INSERT INTO "Room" ("id") VALUES ('a'), ('b')`);
});

const revision = async (id: string) =>
  (
    await prisma.client.$queryRawUnsafe<{ revision: number }[]>(
      `SELECT "revision" FROM "Room" WHERE "id" = '${id}'`,
    )
  )[0]!.revision;

describe('withRoomLock (PD-3)', () => {
  it('같은 방의 두 요청은 직렬로 실행된다', async () => {
    const order: string[] = [];
    const releaseA = deferred();
    const aHolds = deferred();
    const a = db.withRoomLock('a', async () => {
      order.push('a-start');
      aHolds.resolve();
      await releaseA.promise;
      order.push('a-end');
    });
    await aHolds.promise;
    const b = db.withRoomLock('a', async () => {
      order.push('b-start');
    });
    await sleep(300); // b가 DB 잠금에서 막혀 있는 동안 진입하지 못해야 한다
    expect(order).toEqual(['a-start']);
    releaseA.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('다른 방은 서로 막지 않는다', async () => {
    const releaseA = deferred();
    const aHolds = deferred();
    const a = db.withRoomLock('a', async () => {
      aHolds.resolve();
      await releaseA.promise;
    });
    await aHolds.promise;
    const bRan = await db.withRoomLock('b', async () => 'ran');
    expect(bRan).toBe('ran');
    releaseA.resolve();
    await a;
  });

  it('잠금은 커밋까지 유지되고 뒤 요청은 커밋된 값을 본다', async () => {
    const releaseA = deferred();
    const aHolds = deferred();
    const a = db.withRoomLock('a', async (tx) => {
      await tx.$executeRaw`UPDATE "Room" SET "revision" = "revision" + 1 WHERE "id" = 'a'`;
      aHolds.resolve();
      await releaseA.promise;
    });
    await aHolds.promise;
    const b = db.withRoomLock('a', async (tx) => {
      const rows = await tx.$queryRaw<
        { revision: number }[]
      >`SELECT "revision" FROM "Room" WHERE "id" = 'a'`;
      return rows[0]!.revision;
    });
    await sleep(200);
    releaseA.resolve();
    await a;
    expect(await b).toBe(1);
  });

  it('fn이 던지면 롤백되고 잠금이 풀린다', async () => {
    await expect(
      db.withRoomLock('a', async (tx) => {
        await tx.$executeRaw`UPDATE "Room" SET "revision" = 99 WHERE "id" = 'a'`;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await revision('a')).toBe(0);
    expect(await db.withRoomLock('a', async () => 'again')).toBe('again');
  });

  it('없는 방은 RoomNotFoundError', async () => {
    await expect(db.withRoomLock('missing', async () => 1)).rejects.toBeInstanceOf(
      RoomNotFoundError,
    );
  });

  it('lock_timeout: 잠금 대기가 한도를 넘으면 55P03으로 실패한다', async () => {
    const short = makeDb({ DB_LOCK_TIMEOUT_MS: 300 });
    const releaseA = deferred();
    const aHolds = deferred();
    const a = db.withRoomLock('a', async () => {
      aHolds.resolve();
      await releaseA.promise;
    });
    await aHolds.promise;
    const started = Date.now();
    const err = await short
      .withRoomLock('a', async () => 1)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(sqlState(err)).toBe('55P03');
    expect(Date.now() - started).toBeLessThan(3_000);
    releaseA.resolve();
    await a;
  });

  it('statement_timeout: 잠금을 쥔 문장이 한도를 넘으면 57014로 실패하고 잠금이 풀린다', async () => {
    const short = makeDb({ DB_STATEMENT_TIMEOUT_MS: 300 });
    const err = await short
      .withRoomLock('a', async (tx) => tx.$queryRaw`SELECT pg_sleep(3)::text`)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(sqlState(err)).toBe('57014');
    expect(await db.withRoomLock('a', async () => 'free')).toBe('free');
  });

  it('잠금 대기 중인 요청에도 statement_timeout이 적용된다 (잠금 대기 < 문장 한도일 때 lock_timeout이 먼저)', async () => {
    const releaseA = deferred();
    const aHolds = deferred();
    const a = db.withRoomLock('a', async () => {
      aHolds.resolve();
      await releaseA.promise;
    });
    await aHolds.promise;
    // lock_timeout을 statement_timeout보다 크게 잡으면 잠금 대기 중 statement_timeout이 먼저 끊는다.
    const odd = makeDb({ DB_LOCK_TIMEOUT_MS: 5_000, DB_STATEMENT_TIMEOUT_MS: 300 });
    const err = await odd
      .withRoomLock('a', async () => 1)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(sqlState(err)).toBe('57014');
    releaseA.resolve();
    await a;
  });

  it('제한 시간은 SET LOCAL이라 트랜잭션 밖 연결에 남지 않는다', async () => {
    await db.withRoomLock('a', async () => undefined);
    const rows = await prisma.client.$queryRaw<{ lock: string; stmt: string }[]>`
      SELECT current_setting('lock_timeout') AS "lock", current_setting('statement_timeout') AS "stmt"`;
    expect(rows[0]).toEqual({ lock: '0', stmt: '0' });
  });
});

describe('readSnapshot (PD-11)', () => {
  it('REPEATABLE READ, READ ONLY이며 한 시점을 본다', async () => {
    const info = await db.readSnapshot(async (tx) => {
      const r = await tx.$queryRaw<{ iso: string; ro: string }[]>`
        SELECT current_setting('transaction_isolation') AS "iso", current_setting('transaction_read_only') AS "ro"`;
      return r[0];
    });
    expect(info).toEqual({ iso: 'repeatable read', ro: 'on' });
  });

  it('쓰기를 거부한다(25006)', async () => {
    const err = await db
      .readSnapshot(async (tx) => tx.$executeRaw`UPDATE "Room" SET "revision" = 5 WHERE "id" = 'a'`)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(sqlState(err)).toBe('25006');
    expect(await revision('a')).toBe(0);
  });

  it('방 잠금을 쓰지 않아 쓰기를 막지 않고, 스냅샷은 도중 커밋을 보지 않는다', async () => {
    const midway = deferred();
    const finish = deferred();
    const snap = db.readSnapshot(async (tx) => {
      const first = await tx.$queryRaw<
        { revision: number }[]
      >`SELECT "revision" FROM "Room" WHERE "id" = 'a'`;
      midway.resolve();
      await finish.promise;
      const second = await tx.$queryRaw<
        { revision: number }[]
      >`SELECT "revision" FROM "Room" WHERE "id" = 'a'`;
      return [first[0]!.revision, second[0]!.revision];
    });
    await midway.promise;
    await db.withRoomLock('a', async (tx) => {
      await tx.$executeRaw`UPDATE "Room" SET "revision" = "revision" + 1 WHERE "id" = 'a'`;
    }); // 스냅샷이 열려 있어도 막히지 않고 커밋된다
    finish.resolve();
    expect(await snap).toEqual([0, 0]);
    expect(await revision('a')).toBe(1);
  });
});

describe('dbNow (PD-4)', () => {
  it('clock_timestamp()라 같은 트랜잭션 안에서도 시간이 흐른다 (now()는 고정)', async () => {
    const r = await db.withRoomLock('a', async (tx) => {
      const t1 = await db.dbNow(tx);
      await tx.$queryRaw`SELECT pg_sleep(0.05)::text`;
      const t2 = await db.dbNow(tx);
      const n = await tx.$queryRaw<{ a: Date; b: Date }[]>`SELECT now() AS "a", now() AS "b"`;
      return { t1, t2, nowStable: n[0]!.a.getTime() === n[0]!.b.getTime() };
    });
    expect(r.t1).toBeInstanceOf(Date);
    expect(r.t2.getTime() - r.t1.getTime()).toBeGreaterThanOrEqual(40);
    expect(r.nowStable).toBe(true);
  });
});
