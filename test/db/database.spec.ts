import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DatabaseService,
  RequestTimeoutError,
  RoomNotFoundError,
} from '../../src/common/db/database.service.js';
import { PrismaService } from '../../src/common/db/prisma.service.js';
import { createIsolatedDb, TEST_ROOM_DDL, type IsolatedDb } from '../helpers/isolated-db.js';
import { deferred, sleep, sqlState } from '../helpers/util.js';

let ts: IsolatedDb;
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
  ts = await createIsolatedDb();
  await ts.fixtures(TEST_ROOM_DDL);
  prisma = new PrismaService({ DATABASE_URL: ts.databaseUrl, DB_POOL_MAX: 10 });
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

describe('요청 제한 시간 (PD-3, RK-5)', () => {
  it('콜백이 제한을 넘기면 호출자는 콜백이 끝나기를 기다리지 않고 거부된다', async () => {
    const short = makeDb({ REQUEST_TIMEOUT_MS: 1_000 });
    const started = Date.now();
    const err = await short
      .withRoomLock('a', async (tx) => {
        await tx.$executeRaw`UPDATE "Room" SET "revision" = 99 WHERE "id" = 'a'`;
        await sleep(3_000);
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect((err as RequestTimeoutError).limitMs).toBe(1_000);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2_000); // 콜백이 끝나는 3초가 아니라 제한 시각에 거부된다
  });

  it('제한 시각에 롤백되어 쓴 값이 남지 않고 잠금이 풀린다', async () => {
    const short = makeDb({ REQUEST_TIMEOUT_MS: 800 });
    const slow = short
      .withRoomLock('a', async (tx) => {
        await tx.$executeRaw`UPDATE "Room" SET "revision" = 99 WHERE "id" = 'a'`;
        await sleep(2_500);
      })
      .catch((e: unknown) => e);
    await sleep(100);
    const t0 = Date.now();
    const got = await db.withRoomLock('a', async (tx) => {
      const rows = await tx.$queryRaw<
        { revision: number }[]
      >`SELECT "revision" FROM "Room" WHERE "id" = 'a'`;
      return rows[0]!.revision;
    });
    expect(got).toBe(0); // 99는 롤백됨
    expect(Date.now() - t0).toBeLessThan(1_500); // 콜백이 계속 도는 동안에도 잠금이 먼저 풀렸다
    expect(await slow).toBeInstanceOf(RequestTimeoutError);
    await sleep(2_000); // 늦게 끝난 콜백이 처리되지 않은 거부를 남기지 않는다
    expect(await revision('a')).toBe(0);
  });

  it('제한 안에 끝나면 영향이 없고 읽기 스냅샷에도 같은 제한이 적용된다', async () => {
    const short = makeDb({ REQUEST_TIMEOUT_MS: 800 });
    expect(await short.withRoomLock('a', async () => 'fast')).toBe('fast');
    await expect(short.readSnapshot(async () => sleep(2_000))).rejects.toBeInstanceOf(
      RequestTimeoutError,
    );
  });
});

describe('요청 마감은 풀 연결 대기까지 포함한 절대 시각이다 (리뷰 F05)', () => {
  it('트랜잭션 시작이 늦어도 마감 뒤에 도착한 쓰기는 커밋되지 않는다', async () => {
    // 풀 크기 1: 다른 요청이 연결을 쥐고 있는 동안 두 번째 요청은 시작을 기다린다.
    const narrow = new PrismaService({ DATABASE_URL: ts.databaseUrl, DB_POOL_MAX: 1 });
    const tight = new DatabaseService(narrow, {
      DB_LOCK_TIMEOUT_MS: 5_000,
      DB_STATEMENT_TIMEOUT_MS: 6_000,
      REQUEST_TIMEOUT_MS: 1_000,
    });
    try {
      const holderDb = new DatabaseService(narrow, {
        DB_LOCK_TIMEOUT_MS: 5_000,
        DB_STATEMENT_TIMEOUT_MS: 6_000,
        REQUEST_TIMEOUT_MS: 30_000,
      });
      const holder = holderDb.withRoomLock('b', async () => sleep(500)); // 연결을 0.5초 점유
      await sleep(50);
      const t0 = Date.now();
      const err = await tight
        .withRoomLock('a', async (tx) => {
          await sleep(700); // 시작이 ~500ms에 이뤄졌으므로 이 쓰기는 ~1200ms, 마감(1000ms) 뒤다
          await tx.$executeRaw`UPDATE "Room" SET "revision" = 99 WHERE "id" = 'a'`;
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      const elapsed = Date.now() - t0;
      await holder;
      expect(err).toBeInstanceOf(RequestTimeoutError);
      expect(elapsed).toBeLessThan(1_300); // 시작 뒤 1초가 아니라 호출 시점부터 1초
      await sleep(1_000); // 늦은 쓰기가 도착할 시간을 준다
      expect(await revision('a')).toBe(0);
    } finally {
      await narrow.onModuleDestroy();
    }
  });

  it('시작하기도 전에 마감이 지나면 콜백을 실행하지 않는다', async () => {
    const narrow = new PrismaService({ DATABASE_URL: ts.databaseUrl, DB_POOL_MAX: 1 });
    const tight = new DatabaseService(narrow, {
      DB_LOCK_TIMEOUT_MS: 5_000,
      DB_STATEMENT_TIMEOUT_MS: 6_000,
      REQUEST_TIMEOUT_MS: 300,
    });
    try {
      const holderDb = new DatabaseService(narrow, {
        DB_LOCK_TIMEOUT_MS: 5_000,
        DB_STATEMENT_TIMEOUT_MS: 6_000,
        REQUEST_TIMEOUT_MS: 30_000,
      }); // 연결을 쥐는 쪽은 한도가 길어 마감에 걸리지 않는다
      const holder = holderDb.withRoomLock('b', async () => sleep(600));
      await sleep(50);
      let ran = false;
      const err = await tight
        .withRoomLock('a', async () => {
          ran = true;
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(RequestTimeoutError);
      await holder;
      await sleep(700);
      expect(ran).toBe(false);
    } finally {
      await narrow.onModuleDestroy();
    }
  });
});

describe('마감 근처의 결과 일관성 (리뷰 M02)', () => {
  it('마감 앞뒤로 끝나는 호출은 결과와 저장 상태가 항상 일치한다(시간 초과인데 커밋되지 않는다)', async () => {
    const edge = makeDb({ REQUEST_TIMEOUT_MS: 250 });
    const durations = [150, 200, 225, 235, 240, 245, 250, 255, 260, 280];
    await prisma.client.$executeRawUnsafe(
      `INSERT INTO "Room" ("id") VALUES ${durations.map((_, i) => `('e${i}')`).join(',')}`,
    );
    const outcomes = await Promise.all(
      durations.map((ms, i) =>
        edge
          .withRoomLock(`e${i}`, async (tx) => {
            await tx.$executeRaw`UPDATE "Room" SET "revision" = 7 WHERE "id" = ${`e${i}`}`;
            await sleep(ms);
          })
          .then(
            () => 'ok' as const,
            (e: unknown) =>
              e instanceof RequestTimeoutError
                ? ('timeout' as const)
                : (`other:${String(e)}` as const),
          ),
      ),
    );
    await sleep(600); // 늦게 도착한 커밋·롤백이 모두 끝날 시간
    for (const [i, outcome] of outcomes.entries()) {
      const stored = await revision(`e${i}`);
      expect(outcome === 'ok' ? 7 : 0, `${durations[i]}ms → ${outcome}`).toBe(stored);
      expect(['ok', 'timeout']).toContain(outcome);
    }
    expect(outcomes).toContain('ok');
    expect(outcomes).toContain('timeout');
  });

  it('콜백이 마감 안에 끝났으면 커밋이 마감을 넘겨도 호출자는 시간 초과가 아니라 커밋 결과를 받는다', async () => {
    // 커밋 시점에 0.3초 걸리는 지연 제약 트리거로 느린 커밋을 만든다('slow' 방만).
    await ts.fixtures(`
      CREATE OR REPLACE FUNCTION slow_commit() RETURNS trigger AS $$
      BEGIN PERFORM pg_sleep(0.3); RETURN NULL; END $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS slow_commit_trg ON "Room";
      CREATE CONSTRAINT TRIGGER slow_commit_trg AFTER UPDATE ON "Room"
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."id" LIKE 'slow%')
        EXECUTE FUNCTION slow_commit();
      INSERT INTO "Room" ("id") VALUES ('slow1')`);
    const edge = makeDb({ REQUEST_TIMEOUT_MS: 400 });
    const t0 = Date.now();
    const out = await edge
      .withRoomLock('slow1', async (tx) => {
        await tx.$executeRaw`UPDATE "Room" SET "revision" = 7 WHERE "id" = 'slow1'`;
        await sleep(150); // 마감(400ms) 안에 끝나지만 커밋(~300ms)이 마감을 넘긴다
      })
      .then(
        () => 'ok' as const,
        (e: unknown) =>
          e instanceof RequestTimeoutError ? ('timeout' as const) : ('other' as const),
      );
    expect(Date.now() - t0).toBeGreaterThan(400); // 커밋이 마감을 넘겼다
    expect(out).toBe('ok'); // 시간 초과로 보고하면서 커밋되는 불일치가 없다
    expect(await revision('slow1')).toBe(7);
  });

  it('남은 시간이 설정보다 짧으면 문장 제한을 남은 시간으로 줄인다(마감 뒤로 늘어지지 않는다)', async () => {
    const short = makeDb({ REQUEST_TIMEOUT_MS: 400, DB_STATEMENT_TIMEOUT_MS: 10_000 });
    const t0 = Date.now();
    const err = await short
      .withRoomLock('a', async (tx) => tx.$queryRaw`SELECT pg_sleep(3)::text`)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect(Date.now() - t0).toBeLessThan(900);
    // 진행 중이던 문장이 남은 시간으로 끊겨 잠금이 곧 풀린다
    const t1 = Date.now();
    expect(await db.withRoomLock('a', async () => 'free')).toBe('free');
    expect(Date.now() - t1).toBeLessThan(1_000);
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
