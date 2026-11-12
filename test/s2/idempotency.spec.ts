import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { PrismaService } from '../../src/common/db/prisma.service.js';
import { IdempotencyService } from '../../src/idempotency/idempotency.service.js';
import { ac, expectApiError } from '../helpers/contract.js';
import {
  auth,
  bootS2,
  delTx,
  endRoom,
  fresh,
  join,
  postTx,
  putTx,
  revision,
  setupRoom,
  validBody,
  type Idem,
  type S2Env,
  type Setup,
} from './s2-helpers.js';

let s: S2Env;
beforeAll(async () => {
  s = await bootS2();
});
afterAll(() => s?.close());

const HOUR = 3_600_000;
const txRows = (roomId: string) =>
  s.db
    .query<{ n: string }>(`SELECT count(*)::text AS n FROM "Transaction" WHERE "roomId"=$1`, [
      roomId,
    ])
    .then((r) => Number(r[0]!.n));
const records = (roomId: string) =>
  s.db
    .query<{ n: string }>(`SELECT count(*)::text AS n FROM "IdempotencyRecord" WHERE "roomId"=$1`, [
      roomId,
    ])
    .then((r) => Number(r[0]!.n));
const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
const same = (a: { status: number; body: unknown }, b: { status: number; body: unknown }) => {
  expect(b.status).toBe(a.status);
  expect(b.body).toEqual(a.body);
};

async function seed(r: Setup, extra: Record<string, unknown> = {}) {
  const res = await postTx(s.http, r.c.roomId, r.c.key, validBody(r, extra));
  expect(res.status).toBe(201);
  return res.body.transaction as { id: string };
}

describe('같은 키·같은 내용 재전송 (S2 §5.3)', () => {
  it(
    ac(
      ['AC-TXN-007-2', 'AC-TXN-007-5'],
      'S2 §5.3',
      '생성: 같은 키·내용 N회 → 거래 1건, 같은 결과(201·본문), 재전송은 Idempotent-Replayed: true',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const idem = fresh();
      const first = await postTx(
        s.http,
        r.c.roomId,
        r.c.key,
        validBody(r, { reason: '재전송' }),
        idem,
      );
      expect(first.status).toBe(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      const base = await revision(s.db, r.c.roomId);
      for (let i = 0; i < 4; i++) {
        const again = await postTx(
          s.http,
          r.c.roomId,
          r.c.key,
          validBody(r, { reason: '재전송' }),
          idem,
        );
        same(first, again);
        expect(again.headers['idempotent-replayed']).toBe('true');
      }
      expect(await txRows(r.c.roomId)).toBe(1);
      expect(await revision(s.db, r.c.roomId)).toBe(base); // 재전송은 revision을 소비하지 않는다
    },
  );

  it(
    ac(
      ['AC-TXN-007-2'],
      'S2 §5.3',
      '수정·삭제도 같은 키 재전송은 부작용이 한 번이다(저장된 최초 결과)',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const t = await seed(r);
      const u = fresh();
      const upd = await putTx(s.http, r.c.roomId, r.c.key, t.id, { amount: 5 }, u);
      const base = await revision(s.db, r.c.roomId);
      same(upd, await putTx(s.http, r.c.roomId, r.c.key, t.id, { amount: 5 }, u));
      expect(await revision(s.db, r.c.roomId)).toBe(base);
      const d = fresh();
      const del = await delTx(s.http, r.c.roomId, r.c.key, t.id, d);
      const base2 = await revision(s.db, r.c.roomId);
      same(del, await delTx(s.http, r.c.roomId, r.c.key, t.id, d)); // 삭제된 뒤에도 최초 결과(200)
      expect(await revision(s.db, r.c.roomId)).toBe(base2);
    },
  );

  it(ac(['AC-TXN-007-3'], 'S2 §4.1', '내용이 같아도 키가 다르면 별개의 거래다'), async () => {
    const r = await setupRoom(s.http);
    const a = await postTx(s.http, r.c.roomId, r.c.key, validBody(r), fresh());
    const b = await postTx(s.http, r.c.roomId, r.c.key, validBody(r), fresh());
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.transaction.id).not.toBe(b.body.transaction.id);
    expect(await txRows(r.c.roomId)).toBe(2);
  });

  it(
    ac(
      ['AC-TXN-007-4'],
      'S2 §5.3',
      '기록된 키로 다른 내용 → 409 IDEMPOTENCY_CONFLICT, 데이터 불변(허용 밖 필드 추가·연산 종류·대상이 다른 경우 포함)',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const idem = fresh();
      const first = await postTx(s.http, r.c.roomId, r.c.key, validBody(r), idem);
      expect(first.status).toBe(201);
      for (const body of [
        validBody(r, { amount: 1001 }),
        validBody(r, { reason: 'x' }),
        validBody(r, { authorId: 'evil' }),
        validBody(r, { payeeId: r.p.c }),
      ]) {
        expectApiError(
          await postTx(s.http, r.c.roomId, r.c.key, body, idem),
          409,
          'IDEMPOTENCY_CONFLICT',
        );
      }
      const id = first.body.transaction.id;
      expectApiError(
        await putTx(s.http, r.c.roomId, r.c.key, id, { amount: 1000 }, idem),
        409,
        'IDEMPOTENCY_CONFLICT',
      );
      expectApiError(
        await delTx(s.http, r.c.roomId, r.c.key, id, idem),
        409,
        'IDEMPOTENCY_CONFLICT',
      );
      expect(await txRows(r.c.roomId)).toBe(1);
      const [row] = await s.db.query<{ amount: string }>(
        `SELECT "amount"::text FROM "Transaction" WHERE "id"=$1`,
        [id],
      );
      expect(row!.amount).toBe('1000');
    },
  );

  it('reason·round의 없음·null·""와 NFC·NFD 차이는 같은 내용이다(재전송으로 처리)', async () => {
    const r = await setupRoom(s.http);
    const idem = fresh();
    const first = await postTx(s.http, r.c.roomId, r.c.key, validBody(r, { reason: '한글' }), idem);
    const again = await postTx(
      s.http,
      r.c.roomId,
      r.c.key,
      validBody(r, { reason: '한글'.normalize('NFD'), round: '' }),
      idem,
    );
    same(first, again);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(await txRows(r.c.roomId)).toBe(1);
  });

  it(
    ac(['AC-TXN-007-7'], 'S2 §5.1', '다른 방·다른 RoomMember의 같은 키 값은 별개의 요청이다'),
    async () => {
      const a = await setupRoom(s.http);
      const b = await setupRoom(s.http);
      const idem = fresh();
      const ra = await postTx(s.http, a.c.roomId, a.c.key, validBody(a), idem);
      const rb = await postTx(s.http, b.c.roomId, b.c.key, validBody(b), idem); // 다른 방, 같은 키
      expect([ra.status, rb.status]).toEqual([201, 201]);
      expect(rb.headers['idempotent-replayed']).toBeUndefined();
      const member = await join(s.http, a.c.inviteCode, 'Other');
      const rm = await postTx(s.http, a.c.roomId, member.key, validBody(a), idem); // 같은 방, 다른 멤버
      expect(rm.status).toBe(201);
      expect(rm.body.transaction.id).not.toBe(ra.body.transaction.id);
      expect(await txRows(a.c.roomId)).toBe(2);
    },
  );
});

describe('종료·삭제 뒤의 재전송 (S2 §5.3)', () => {
  it(
    ac(
      ['AC-TXN-007-8', 'AC-TXN-008-4'],
      'S2 §6.5',
      '성공 뒤 종료돼도 같은 키 재전송은 최초 성공 결과(거래 1건), 새 키는 GAME_ENDED',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const idem = fresh();
      const first = await postTx(s.http, r.c.roomId, r.c.key, validBody(r), idem);
      await endRoom(s.db, r.c.roomId);
      same(first, await postTx(s.http, r.c.roomId, r.c.key, validBody(r), idem));
      expectApiError(
        await postTx(s.http, r.c.roomId, r.c.key, validBody(r), fresh()),
        409,
        'GAME_ENDED',
      );
      expect(await txRows(r.c.roomId)).toBe(1); // 확정 거부된 저장은 반영되지 않는다
    },
  );

  it(
    ac(
      ['AC-TXN-007-9'],
      'S2 §5.3',
      '수정·삭제가 성공한 뒤 거래가 삭제됐거나 방이 종료돼도 같은 키 재전송은 최초 결과이고 추가 변경이 없다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const t = await seed(r);
      const u = fresh();
      const upd = await putTx(s.http, r.c.roomId, r.c.key, t.id, { amount: 7 }, u);
      const d = fresh();
      const del = await delTx(s.http, r.c.roomId, r.c.key, t.id, d); // 이제 거래는 삭제된 상태
      const base = await revision(s.db, r.c.roomId);
      same(upd, await putTx(s.http, r.c.roomId, r.c.key, t.id, { amount: 7 }, u)); // 삭제됐어도 최초 200
      await endRoom(s.db, r.c.roomId);
      same(del, await delTx(s.http, r.c.roomId, r.c.key, t.id, d)); // 종료됐어도 최초 200
      expect(await revision(s.db, r.c.roomId)).toBe(base);
    },
  );

  it(
    ac(
      ['AC-TXN-007-10'],
      'S2 §5.2',
      '영구 거부(삭제됨·종료)는 기록되고 같은 키 재전송은 같은 거부이며 데이터가 불변이다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const t = await seed(r);
      await delTx(s.http, r.c.roomId, r.c.key, t.id);
      const k1 = fresh();
      const deleted = await putTx(s.http, r.c.roomId, r.c.key, t.id, { amount: 3 }, k1);
      expectApiError(deleted, 409, 'TRANSACTION_DELETED');
      same(deleted, await putTx(s.http, r.c.roomId, r.c.key, t.id, { amount: 3 }, k1));
      await endRoom(s.db, r.c.roomId);
      const k2 = fresh();
      const ended = await postTx(s.http, r.c.roomId, r.c.key, validBody(r), k2);
      expectApiError(ended, 409, 'GAME_ENDED');
      const rec = await s.db.query<{ statusCode: number; operation: string }>(
        `SELECT "statusCode","operation" FROM "IdempotencyRecord" WHERE "key" IN ($1,$2) ORDER BY "operation"`,
        [k1.key, k2.key],
      );
      expect(rec).toEqual([
        { statusCode: 409, operation: 'CREATE' },
        { statusCode: 409, operation: 'UPDATE' },
      ]);
      same(ended, await postTx(s.http, r.c.roomId, r.c.key, validBody(r), k2));
    },
  );

  it(
    ac(
      ['AC-TXN-007-10', 'AC-ROOM-008-10'],
      'S2 §6.4',
      '한도 거부는 기록되고, 마지막 슬롯 성공 뒤 같은 키 재전송은 최초 결과(1,000건 유지)다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      await s.db.query(
        `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","authorId","originalAmount","createdAt","updatedAt")
       SELECT 'lim' || g, $1, g, $2, $3, 100, $4, 100, clock_timestamp(), clock_timestamp() FROM generate_series(1, 999) g`,
        [r.c.roomId, r.p.a, r.p.b, r.c.hostId],
      );
      await s.db.query(`UPDATE "Room" SET "nextTxnSeq"=1000 WHERE "id"=$1`, [r.c.roomId]);
      const lastKey = fresh();
      const last = await postTx(s.http, r.c.roomId, r.c.key, validBody(r), lastKey);
      expect(last.status).toBe(201);
      same(last, await postTx(s.http, r.c.roomId, r.c.key, validBody(r), lastKey)); // 마지막 슬롯 성공 뒤 재전송
      expect(await txRows(r.c.roomId)).toBe(1000);
      const overKey = fresh();
      const over = await postTx(s.http, r.c.roomId, r.c.key, validBody(r), overKey);
      expectApiError(over, 409, 'TRANSACTION_LIMIT_EXCEEDED', [{ limit: 1000 }]);
      same(over, await postTx(s.http, r.c.roomId, r.c.key, validBody(r), overKey));
      expect(await txRows(r.c.roomId)).toBe(1000);
    },
  );

  it(
    ac(
      ['AC-TXN-007-11'],
      'S2 §5.3',
      '기록 없는 키가 종료 뒤 처음 도착하면 거부된다. 기록 없이 유효 기간 안이면 새 요청이다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const lost = fresh(); // 요청이 서버에 도달하지 못했던 키
      await endRoom(s.db, r.c.roomId);
      expectApiError(
        await postTx(s.http, r.c.roomId, r.c.key, validBody(r), lost),
        409,
        'GAME_ENDED',
      );
      const r2 = await setupRoom(s.http);
      const lost2 = fresh(-3 * HOUR); // 3시간 전에 처음 시도했고 서버에는 기록이 없다
      expect((await postTx(s.http, r2.c.roomId, r2.c.key, validBody(r2), lost2)).status).toBe(201); // 새 요청으로 처리
    },
  );
});

describe('기록하지 않는 거부 (S2 §5.2)', () => {
  it(
    ac(
      ['AC-TXN-007-13'],
      'S2 §5.2',
      '비활성 참여자·검증 실패 거부는 기록되지 않아 고친 뒤 같은 키 재전송이 성공하고 거래는 최대 1건이다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const patch = (status: string) =>
        s.http
          .patch(`/rooms/${r.c.roomId}/participants/${r.p.b}`)
          .set(auth(r.c.key))
          .send({ status });
      await patch('INACTIVE');
      const idem = fresh();
      expectApiError(
        await postTx(s.http, r.c.roomId, r.c.key, validBody(r), idem),
        409,
        'PARTICIPANT_INACTIVE',
      );
      expect(await records(r.c.roomId)).toBe(0);
      await patch('ACTIVE');
      const ok = await postTx(s.http, r.c.roomId, r.c.key, validBody(r), idem); // 같은 키·같은 내용
      expect(ok.status).toBe(201);
      expect(ok.headers['idempotent-replayed']).toBeUndefined();
      expect(await txRows(r.c.roomId)).toBe(1);
      // 검증 실패도 기록하지 않는다: 같은 키로 내용을 고쳐 보내도 충돌이 아니라 새 요청이다
      const idem2 = fresh();
      expect(
        (await postTx(s.http, r.c.roomId, r.c.key, validBody(r, { amount: 0 }), idem2)).status,
      ).toBe(422);
      const fixed = await postTx(s.http, r.c.roomId, r.c.key, validBody(r, { amount: 5 }), idem2);
      expect(fixed.status).toBe(201);
      expect(await txRows(r.c.roomId)).toBe(2);
    },
  );

  it('403·404 거부도 기록하지 않는다', async () => {
    const r = await setupRoom(s.http);
    const owner = await join(s.http, r.c.inviteCode, 'Own');
    const third = await join(s.http, r.c.inviteCode, 'Third');
    const t = (await postTx(s.http, r.c.roomId, owner.key, validBody(r))).body.transaction;
    const before = await records(r.c.roomId);
    expectApiError(
      await putTx(s.http, r.c.roomId, third.key, t.id, { amount: 1 }),
      403,
      'NOT_AUTHOR_OR_HOST',
    );
    expectApiError(
      await putTx(s.http, r.c.roomId, owner.key, 'A'.repeat(22), { amount: 1 }),
      404,
      'TRANSACTION_NOT_FOUND',
    );
    expect(await records(r.c.roomId)).toBe(before);
  });
});

describe('유효 기간과 만료 (S2 §5.4)', () => {
  const seedAt = async (r: Setup, idem: Idem) => {
    const res = await postTx(s.http, r.c.roomId, r.c.key, validBody(r), idem);
    expect(res.status).toBe(201);
    return res;
  };

  it(
    ac(
      ['AC-TXN-007-12'],
      'S2 §5.4',
      '최초 시도 24시간 경과 → 409 IDEMPOTENCY_KEY_EXPIRED(serverTime 포함): 기록이 없을 때, 있을 때, 같은/다른 내용 모두',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const old = { key: fresh().key, at: at(-24 * HOUR - 60_000) };
      const noRecord = await postTx(s.http, r.c.roomId, r.c.key, validBody(r), old);
      expectApiError(noRecord, 409, 'IDEMPOTENCY_KEY_EXPIRED');
      expect(noRecord.body.error.details).toEqual([
        { serverTime: expect.stringMatching(/^\d{4}-.*\.\d{3}Z$/) },
      ]);
      expect(noRecord.body.error.message).toMatch(/유효 기간/);
      expectApiError(
        await postTx(s.http, r.c.roomId, r.c.key, validBody(r, { amount: 5 }), old),
        409,
        'IDEMPOTENCY_KEY_EXPIRED',
      ); // 다른 내용이어도 만료가 먼저
      // 기록이 있는 키: 23시간에 처리된 요청의 24시간 뒤 재시도도 만료다
      const k = fresh();
      await seedAt(r, { key: k.key, at: at(-23 * HOUR) });
      expectApiError(
        await postTx(s.http, r.c.roomId, r.c.key, validBody(r), {
          key: k.key,
          at: at(-24 * HOUR - 60_000),
        }),
        409,
        'IDEMPOTENCY_KEY_EXPIRED',
      );
      expectApiError(
        await postTx(s.http, r.c.roomId, r.c.key, validBody(r, { amount: 9 }), {
          key: k.key,
          at: at(-24 * HOUR - 60_000),
        }),
        409,
        'IDEMPOTENCY_KEY_EXPIRED',
      );
      expect(await txRows(r.c.roomId)).toBe(1); // 만료는 아무것도 바꾸지 않는다
      expect(await records(r.c.roomId)).toBe(1); // 만료는 기록하지 않는다
    },
  );

  it(
    ac(
      ['AC-TXN-007-12'],
      'S2 §5.4',
      '경계: 24시간 직전은 처리, 직후는 만료. 기록이 있어도 더 이른 firstAttemptAt으로 판정해 유효 기간을 늘릴 수 없다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const justInside = { key: fresh().key, at: at(-24 * HOUR + 60_000) };
      expect((await postTx(s.http, r.c.roomId, r.c.key, validBody(r), justInside)).status).toBe(
        201,
      );
      // 기록(-23h)이 있는 키에 더 늦은 값(-1h)으로 재시도하면 이른 값 기준이라 아직 유효하고 재전송으로 처리된다
      const k = fresh().key;
      await seedAt(r, { key: k, at: at(-23 * HOUR) });
      const replay = await postTx(s.http, r.c.roomId, r.c.key, validBody(r), {
        key: k,
        at: at(-HOUR),
      });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      // 기록의 최초 시도 시각이 24시간을 넘기면 더 늦은 재시도 값으로 연장되지 않는다
      await s.db.query(
        `UPDATE "IdempotencyRecord" SET "firstAttemptAt" = "firstAttemptAt" - interval '2 hours', "expiresAt" = "expiresAt" - interval '2 hours' WHERE "key"=$1`,
        [k],
      );
      expectApiError(
        await postTx(s.http, r.c.roomId, r.c.key, validBody(r), { key: k, at: at(-HOUR) }),
        409,
        'IDEMPOTENCY_KEY_EXPIRED',
      );
    },
  );

  it('미래 시각: 5분 이내는 처리, 5분 초과는 422(serverTime) 기록 없음', async () => {
    const r = await setupRoom(s.http);
    expect(
      (
        await postTx(s.http, r.c.roomId, r.c.key, validBody(r), {
          key: fresh().key,
          at: at(4 * 60_000),
        })
      ).status,
    ).toBe(201);
    const bad = await postTx(s.http, r.c.roomId, r.c.key, validBody(r), {
      key: fresh().key,
      at: at(10 * 60_000),
    });
    expectApiError(bad, 422, 'VALIDATION_FAILED');
    expect(bad.body.error.details).toEqual([
      { field: 'firstAttemptAt', code: 'INVALID_VALUE', serverTime: expect.any(String) },
    ]);
    expect(await records(r.c.roomId)).toBe(1);
  });

  it('보관: 만료 후 1시간이 지난 기록만 지우며 삭제는 만료 판정 결과를 바꾸지 않는다(헤더만으로 판정)', async () => {
    const r = await setupRoom(s.http);
    const prisma = new PrismaService({ DATABASE_URL: s.db.databaseUrl, DB_POOL_MAX: 2 });
    const service = new IdempotencyService(prisma);
    try {
      const old = fresh();
      await seedAt(r, old);
      const recent = fresh();
      await seedAt(r, recent);
      const mid = fresh();
      await seedAt(r, mid);
      // old: 만료 + 2시간, mid: 만료 + 30분(보관 여유 안), recent: 유효
      await s.db.query(
        `UPDATE "IdempotencyRecord" SET "firstAttemptAt"=clock_timestamp()-interval '26 hours', "expiresAt"=clock_timestamp()-interval '2 hours' WHERE "key"=$1`,
        [old.key],
      );
      await s.db.query(
        `UPDATE "IdempotencyRecord" SET "firstAttemptAt"=clock_timestamp()-interval '24 hours 30 minutes', "expiresAt"=clock_timestamp()-interval '30 minutes' WHERE "key"=$1`,
        [mid.key],
      );
      expect(await service.cleanupExpired(1)).toBeGreaterThanOrEqual(1); // 배치 크기 1로도 끝까지 지운다(앞선 시험이 남긴 만료 기록도 함께 지워질 수 있다)
      const left = await s.db.query<{ key: string }>(
        `SELECT "key" FROM "IdempotencyRecord" WHERE "roomId"=$1`,
        [r.c.roomId],
      );
      expect(left.map((x) => x.key).sort()).toEqual([mid.key, recent.key].sort());
      // 지운 뒤에도 같은 헤더의 재시도는 기록 유무와 무관하게 만료다
      expectApiError(
        await postTx(s.http, r.c.roomId, r.c.key, validBody(r), {
          key: old.key,
          at: at(-26 * HOUR),
        }),
        409,
        'IDEMPOTENCY_KEY_EXPIRED',
      );
      expect(await service.cleanupExpired()).toBe(0);
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  it('CORS: Idempotent-Replayed 헤더를 노출한다', async () => {
    const r = await setupRoom(s.http);
    const idem = fresh();
    await postTx(s.http, r.c.roomId, r.c.key, validBody(r), idem);
    const res = await s.http
      .post(`/rooms/${r.c.roomId}/transactions`)
      .set(auth(r.c.key))
      .set('Origin', 'http://localhost:3000')
      .set('Idempotency-Key', idem.key)
      .set('Idempotency-First-Attempt-At', idem.at)
      .send(validBody(r));
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(String(res.headers['access-control-expose-headers']).toLowerCase()).toContain(
      'idempotent-replayed',
    );
  });

  it(
    ac(
      ['AC-TXN-007-12'],
      'S2 §5.4',
      '잠금 대기 중에 유효 기간이 지나면 수신 때는 유효했더라도 만료로 거부한다(판정은 잠금을 얻은 시점의 DB 시각)',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const url = new URL(s.db.databaseUrl);
      url.searchParams.delete('schema');
      const holder = new pg.Client({ connectionString: url.toString() });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM "Room" WHERE "id"=$1 FOR UPDATE`, [r.c.roomId]);
        // 수신 시점에는 만료까지 약 1.5초 남은 요청
        const idem = { key: fresh().key, at: at(-24 * HOUR + 1_500) };
        const pending = postTx(s.http, r.c.roomId, r.c.key, validBody(r), idem).then((x) => x);
        // 요청이 실제로 방 잠금 앞에서 기다리는 것을 확인한 뒤 유효 기간(1.5초)이 지나도록 둔다
        await vi.waitFor(
          async () => {
            const w = await holder.query(
              `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
            );
            expect(w.rowCount).toBeGreaterThan(0);
          },
          { timeout: 10_000, interval: 50 },
        );
        await new Promise((ok) => setTimeout(ok, 2_000));
        await holder.query('COMMIT');
        const res = await pending;
        expectApiError(res, 409, 'IDEMPOTENCY_KEY_EXPIRED');
        expect(await txRows(r.c.roomId)).toBe(0);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
    },
  );
});
