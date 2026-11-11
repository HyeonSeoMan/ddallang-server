import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newInviteCode } from '../../src/common/ids/ids.js';
import { createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';

let db: IsolatedDb;
beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
});
afterAll(() => db?.drop());

async function reject(sql: string, params: unknown[] = []) {
  try {
    await db.query(sql, params);
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

async function world() {
  const roomId = newId();
  await db.query(`INSERT INTO "Room" ("id","name","unit","inviteCode") VALUES ($1,'R','원',$2)`, [
    roomId,
    newInviteCode(),
  ]);
  const member = newId();
  await db.query(
    `INSERT INTO "RoomMember" ("id","roomId","nickname","nicknameKey","isHost","identityKeyHash") VALUES ($1,$2,'H','h',true,$3)`,
    [member, roomId, 'a'.repeat(64)],
  );
  const [pa, pb] = [newId(), newId()];
  await db.query(
    `INSERT INTO "Participant" ("id","roomId","nickname","nicknameKey","order") VALUES ($1,$2,'A','a',1),($3,$2,'B','b',2)`,
    [pa, roomId, pb],
  );
  return { roomId, member, pa, pb };
}

const insertTx = (w: Awaited<ReturnType<typeof world>>, o: Record<string, unknown> = {}) =>
  db.query(
    `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","reason","round","authorId","originalAmount","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$6,clock_timestamp(),clock_timestamp())`,
    [
      o.id ?? newId(),
      w.roomId,
      o.seq ?? 1,
      o.payer ?? w.pa,
      o.payee ?? w.pb,
      o.amount ?? 1000,
      o.reason ?? null,
      o.round ?? null,
      w.member,
    ],
  );

describe('Transaction 제약 (BE-S2-1)', () => {
  it('금액은 1..999,999,999만 허용한다(경계)', async () => {
    const w = await world();
    await insertTx(w, { seq: 1, amount: 1 });
    await insertTx(w, { seq: 2, amount: 999_999_999 });
    for (const [i, amount] of [0, -1, 1_000_000_000].entries()) {
      expect(
        await reject(
          `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","authorId","originalAmount","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,1,now(),now())`,
          [newId(), w.roomId, 10 + i, w.pa, w.pb, amount, w.member],
        ),
        String(amount),
      ).toBe('23514');
    }
  });

  it('지급자와 수취자는 다르다', async () => {
    const w = await world();
    expect(
      await reject(
        `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","authorId","originalAmount","createdAt","updatedAt") VALUES ($1,$2,1,$3,$3,10,$4,10,now(),now())`,
        [newId(), w.roomId, w.pa, w.member],
      ),
    ).toBe('23514');
  });

  it('방 안에서 seq는 유일하고 다른 방과는 독립이다', async () => {
    const a = await world();
    const b = await world();
    await insertTx(a, { seq: 1 });
    expect(
      await reject(
        `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","authorId","originalAmount","createdAt","updatedAt") VALUES ($1,$2,1,$3,$4,10,$5,10,now(),now())`,
        [newId(), a.roomId, a.pa, a.pb, a.member],
      ),
    ).toBe('23505');
    await insertTx(b, { seq: 1 });
  });

  it('사유·라운드 길이(1~50, 1~12)와 null', async () => {
    const w = await world();
    await insertTx(w, { seq: 1, reason: 'a'.repeat(50), round: 'b'.repeat(12) });
    await insertTx(w, { seq: 2, reason: null, round: null });
    expect(
      await reject(
        `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","reason","authorId","originalAmount","createdAt","updatedAt") VALUES ($1,$2,3,$3,$4,10,$5,$6,10,now(),now())`,
        [newId(), w.roomId, w.pa, w.pb, 'x'.repeat(51), w.member],
      ),
    ).toBe('23514');
    expect(
      await reject(
        `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","round","authorId","originalAmount","createdAt","updatedAt") VALUES ($1,$2,4,$3,$4,10,$5,$6,10,now(),now())`,
        [newId(), w.roomId, w.pa, w.pb, 'x'.repeat(13), w.member],
      ),
    ).toBe('23514');
    expect(
      await reject(
        `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","reason","authorId","originalAmount","createdAt","updatedAt") VALUES ($1,$2,5,$3,$4,10,'',$5,10,now(),now())`,
        [newId(), w.roomId, w.pa, w.pb, w.member],
      ),
    ).toBe('23514'); // 빈 문자열은 null로 저장해야 한다
  });

  it('참여자·작성자·방은 존재해야 한다(FK)', async () => {
    const w = await world();
    expect(
      await reject(
        `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","authorId","originalAmount","createdAt","updatedAt") VALUES ($1,$2,1,'nope',$3,10,$4,10,now(),now())`,
        [newId(), w.roomId, w.pb, w.member],
      ),
    ).toBe('23503');
    expect(
      await reject(
        `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","authorId","originalAmount","createdAt","updatedAt") VALUES ($1,$2,1,$3,$4,10,'nope',10,now(),now())`,
        [newId(), w.roomId, w.pa, w.pb],
      ),
    ).toBe('23503');
  });

  it('삭제는 행을 지우지 않고 표시만 하며 deletedAt·deletedById는 한 쌍이다', async () => {
    const w = await world();
    const id = newId();
    await insertTx(w, { id, seq: 1 });
    expect(await reject(`UPDATE "Transaction" SET "deletedAt"=now() WHERE "id"=$1`, [id])).toBe(
      '23514',
    ); // deletedById 없이 안 됨
    await db.query(
      `UPDATE "Transaction" SET "deletedAt"=clock_timestamp(), "deletedById"=$2 WHERE "id"=$1`,
      [id, w.member],
    );
    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "Transaction" WHERE "id"=$1`,
      [id],
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('유효 거래 부분 인덱스가 있다', async () => {
    const rows = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='Transaction_roomId_valid_idx'`,
      [db.schema],
    );
    expect(rows[0]!.indexdef).toMatch(/WHERE .*"deletedAt" IS NULL/);
  });

  it('Room에 nextTxnSeq(기본 1)와 lastTxnCreatedAt(null 가능)이 있다', async () => {
    const w = await world();
    const [r] = await db.query<{ nextTxnSeq: number; lastTxnCreatedAt: Date | null }>(
      `SELECT "nextTxnSeq","lastTxnCreatedAt" FROM "Room" WHERE "id"=$1`,
      [w.roomId],
    );
    expect(r).toEqual({ nextTxnSeq: 1, lastTxnCreatedAt: null });
    expect(await reject(`UPDATE "Room" SET "nextTxnSeq"=0 WHERE "id"=$1`, [w.roomId])).toBe(
      '23514',
    );
  });
});

describe('IdempotencyRecord 제약 (BE-F6)', () => {
  const insert = (w: Awaited<ReturnType<typeof world>>, o: Record<string, unknown> = {}) =>
    db.query(
      `INSERT INTO "IdempotencyRecord" ("id","roomId","memberId","key","operation","fingerprint","firstAttemptAt","expiresAt","statusCode","responseBody")
       VALUES ($1,$2,$3,$4,$5,$6,now(),now() + interval '24 hours',$7,'{}'::jsonb)`,
      [
        newId(),
        w.roomId,
        w.member,
        o.key ?? 'k'.repeat(22),
        o.op ?? 'CREATE',
        o.fp ?? 'a'.repeat(64),
        o.status ?? 201,
      ],
    );

  it('(방, RoomMember, 키)는 유일하고 다른 방·다른 멤버의 같은 키는 별개다', async () => {
    const a = await world();
    const b = await world();
    await insert(a, { key: 'u'.repeat(22) });
    expect(
      await reject(
        `INSERT INTO "IdempotencyRecord" ("id","roomId","memberId","key","operation","fingerprint","firstAttemptAt","expiresAt","statusCode","responseBody") VALUES ($1,$2,$3,$4,'CREATE',$5,now(),now()+interval '1 day',201,'{}')`,
        [newId(), a.roomId, a.member, 'u'.repeat(22), 'a'.repeat(64)],
      ),
    ).toBe('23505');
    await insert(b, { key: 'u'.repeat(22) }); // 다른 방
    const other = newId();
    await db.query(
      `INSERT INTO "RoomMember" ("id","roomId","nickname","nicknameKey","isHost","identityKeyHash") VALUES ($1,$2,'M','m',false,$3)`,
      [other, a.roomId, 'b'.repeat(64)],
    );
    await db.query(
      `INSERT INTO "IdempotencyRecord" ("id","roomId","memberId","key","operation","fingerprint","firstAttemptAt","expiresAt","statusCode","responseBody") VALUES ($1,$2,$3,$4,'CREATE',$5,now(),now()+interval '1 day',201,'{}')`,
      [newId(), a.roomId, other, 'u'.repeat(22), 'a'.repeat(64)],
    ); // 같은 방 다른 멤버
  });

  it('연산 종류·지문(SHA-256 hex)·키 형식·만료 순서를 DB가 강제한다', async () => {
    const w = await world();
    expect(
      await reject(
        `INSERT INTO "IdempotencyRecord" ("id","roomId","memberId","key","operation","fingerprint","firstAttemptAt","expiresAt","statusCode","responseBody") VALUES ($1,$2,$3,$4,'PATCH',$5,now(),now()+interval '1 day',201,'{}')`,
        [newId(), w.roomId, w.member, 'k'.repeat(22), 'a'.repeat(64)],
      ),
    ).toBe('23514');
    for (const fp of ['A'.repeat(64), 'a'.repeat(63), 'z'.repeat(64)]) {
      expect(
        await reject(
          `INSERT INTO "IdempotencyRecord" ("id","roomId","memberId","key","operation","fingerprint","firstAttemptAt","expiresAt","statusCode","responseBody") VALUES ($1,$2,$3,$4,'CREATE',$5,now(),now()+interval '1 day',201,'{}')`,
          [newId(), w.roomId, w.member, 'k'.repeat(22), fp],
        ),
      ).toBe('23514');
    }
    for (const key of ['short', 'k'.repeat(65), 'has space 12345678', 'bad+key/123456789012']) {
      expect(
        await reject(
          `INSERT INTO "IdempotencyRecord" ("id","roomId","memberId","key","operation","fingerprint","firstAttemptAt","expiresAt","statusCode","responseBody") VALUES ($1,$2,$3,$4,'CREATE',$5,now(),now()+interval '1 day',201,'{}')`,
          [newId(), w.roomId, w.member, key, 'a'.repeat(64)],
        ),
        key,
      ).toBe('23514');
    }
    expect(
      await reject(
        `INSERT INTO "IdempotencyRecord" ("id","roomId","memberId","key","operation","fingerprint","firstAttemptAt","expiresAt","statusCode","responseBody") VALUES ($1,$2,$3,$4,'CREATE',$5,now(),now()-interval '1 day',201,'{}')`,
        [newId(), w.roomId, w.member, 'k'.repeat(22), 'a'.repeat(64)],
      ),
    ).toBe('23514');
  });
});
