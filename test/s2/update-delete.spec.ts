import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ac, expectApiError } from '../helpers/contract.js';
import { sleep } from '../helpers/util.js';
import {
  auth,
  bootS2,
  delTx,
  endRoom,
  join,
  newKey,
  postTx,
  putTx,
  revision,
  setupRoom,
  validBody,
  type S2Env,
  type Setup,
} from './s2-helpers.js';

let s: S2Env;
beforeAll(async () => {
  s = await bootS2();
});
afterAll(() => s?.close());

async function seed(r: Setup, key = r.c.key, extra: Record<string, unknown> = {}) {
  const res = await postTx(
    s.http,
    r.c.roomId,
    key,
    validBody(r, { reason: '원래', round: 'R1', ...extra }),
  );
  expect(res.status).toBe(201);
  return res.body.transaction as {
    id: string;
    amount: number;
    reason: string | null;
    round: string | null;
    createdAt: string;
    updatedAt: string;
    authorId: string;
  };
}
const row = (id: string) =>
  s.db
    .query<Record<string, unknown>>(`SELECT * FROM "Transaction" WHERE "id"=$1`, [id])
    .then((r) => r[0]!);

describe('PUT /rooms/{roomId}/transactions/{id} (S2 §4.2)', () => {
  it(
    ac(
      ['AC-TXN-004-1', 'AC-TXN-002-1', 'AC-TXN-002-5'],
      'S2 §4.2',
      '작성자는 자기 거래를 수정한다(통째 교체, updatedAt 갱신, 불변 필드 유지)',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const member = await join(s.http, r.c.inviteCode, 'Kim');
      const t = await seed(r, member.key);
      await sleep(15);
      const res = await putTx(s.http, r.c.roomId, member.key, t.id, {
        amount: 999_999_999,
        reason: '바뀜',
        round: 'R2',
      });
      expect(res.status).toBe(200);
      expect(res.body.transaction).toMatchObject({
        id: t.id,
        amount: 999_999_999,
        reason: '바뀜',
        round: 'R2',
        payerId: r.p.a,
        payeeId: r.p.b,
        authorId: t.authorId,
        createdAt: t.createdAt,
      });
      expect(Date.parse(res.body.transaction.updatedAt)).toBeGreaterThan(Date.parse(t.updatedAt));
      expect(
        (await putTx(s.http, r.c.roomId, member.key, t.id, { amount: 1 })).body.transaction.amount,
      ).toBe(1);
    },
  );

  it(ac(['AC-TXN-004-2'], 'S2 §3.1', '방장은 타인의 거래도 수정·삭제한다'), async () => {
    const r = await setupRoom(s.http);
    const member = await join(s.http, r.c.inviteCode, 'Kim');
    const t1 = await seed(r, member.key);
    const t2 = await seed(r, member.key);
    expect((await putTx(s.http, r.c.roomId, r.c.key, t1.id, { amount: 5 })).status).toBe(200);
    expect((await delTx(s.http, r.c.roomId, r.c.key, t2.id)).status).toBe(200);
  });

  it(
    ac(
      ['AC-TXN-004-3', 'AC-TXN-004-4', 'AC-ROOM-007-2'],
      'S2 §3.1',
      '작성자도 방장도 아닌 멤버 → 403 NOT_AUTHOR_OR_HOST(UI 우회 요청 포함), 데이터 불변·기록 없음',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const owner = await join(s.http, r.c.inviteCode, 'Own');
      const third = await join(s.http, r.c.inviteCode, 'Third');
      const t = await seed(r, owner.key);
      const before = await row(t.id);
      const revBefore = await revision(s.db, r.c.roomId);
      expectApiError(
        await putTx(s.http, r.c.roomId, third.key, t.id, { amount: 2 }),
        403,
        'NOT_AUTHOR_OR_HOST',
      );
      expectApiError(await delTx(s.http, r.c.roomId, third.key, t.id), 403, 'NOT_AUTHOR_OR_HOST');
      expect(await row(t.id)).toEqual(before);
      expect(await revision(s.db, r.c.roomId)).toBe(revBefore);
      const records = await s.db.query(`SELECT 1 FROM "IdempotencyRecord" WHERE "memberId"=$1`, [
        third.res.body.me.id,
      ]);
      expect(records).toHaveLength(0); // 403은 기록하지 않는다
    },
  );

  it('값이 모두 같으면 변경 없이 200, updatedAt·revision·이벤트 불변(no-op)', async () => {
    const r = await setupRoom(s.http);
    const t = await seed(r);
    const revBefore = await revision(s.db, r.c.roomId);
    const res = await putTx(s.http, r.c.roomId, r.c.key, t.id, {
      amount: 1000,
      reason: '원래',
      round: 'R1',
    });
    expect(res.status).toBe(200);
    expect(res.body.transaction.updatedAt).toBe(t.updatedAt);
    expect(await revision(s.db, r.c.roomId)).toBe(revBefore);
    // 생략한 reason·round는 null로 지우는 변경이다(통째 교체)
    const cleared = await putTx(s.http, r.c.roomId, r.c.key, t.id, { amount: 1000 });
    expect(cleared.body.transaction).toMatchObject({ reason: null, round: null });
    expect(await revision(s.db, r.c.roomId)).toBe(revBefore + 1);
  });

  it(
    ac(
      ['AC-TXN-005-6'],
      'S2 §3.5',
      '수정 본문의 payerId·payeeId·id·authorId·createdAt → 422 NOT_ALLOWED_FIELD, 아무것도 바꾸지 않는다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const t = await seed(r);
      const before = await row(t.id);
      const res = await putTx(s.http, r.c.roomId, r.c.key, t.id, {
        amount: 5,
        payerId: r.p.c,
        payeeId: r.p.c,
        id: 'x',
        authorId: 'y',
        createdAt: '2020-01-01T00:00:00.000Z',
      });
      expect(res.status).toBe(422);
      expect(
        res.body.error.details
          .map((d: { field: string; code: string }) => `${d.field}:${d.code}`)
          .sort(),
      ).toEqual([
        'authorId:NOT_ALLOWED_FIELD',
        'createdAt:NOT_ALLOWED_FIELD',
        'id:NOT_ALLOWED_FIELD',
        'payeeId:NOT_ALLOWED_FIELD',
        'payerId:NOT_ALLOWED_FIELD',
      ]);
      expect(await row(t.id)).toEqual(before);
    },
  );

  it(
    ac(
      ['AC-TXN-002-2', 'AC-TXN-002-3', 'AC-TXN-002-4', 'AC-TXN-001-6'],
      'S2 §3.3',
      '수정에도 같은 금액·문자열 검증이 적용되고 거부되면 거래가 바뀌지 않는다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const t = await seed(r);
      const before = await row(t.id);
      for (const [body, field, code] of [
        [{ amount: 0 }, 'amount', 'OUT_OF_RANGE'],
        [{ amount: 1.5 }, 'amount', 'INVALID_VALUE'],
        [{ amount: '100' }, 'amount', 'INVALID_TYPE'],
        [{}, 'amount', 'REQUIRED'],
        [{ amount: 5, reason: 'x'.repeat(51) }, 'reason', 'LENGTH_OUT_OF_RANGE'],
        [{ amount: 5, round: 'r'.repeat(13) }, 'round', 'LENGTH_OUT_OF_RANGE'],
        [{ amount: 5, reason: 'a\nb' }, 'reason', 'INVALID_CHARACTER'],
        [{ amount: 5, reason: ' a' }, 'reason', 'LEADING_OR_TRAILING_SPACE'],
      ] as const) {
        expectApiError(
          await putTx(s.http, r.c.roomId, r.c.key, t.id, body),
          422,
          'VALIDATION_FAILED',
          [{ field, code }],
        );
      }
      expect(await row(t.id)).toEqual(before);
      expect(
        (
          await putTx(s.http, r.c.roomId, r.c.key, t.id, {
            amount: 5,
            reason: '가'.repeat(50),
            round: 'r'.repeat(12),
          })
        ).status,
      ).toBe(200);
    },
  );

  it(
    ac(['AC-TXN-006-2'], 'S2 §3.4', '삭제된 거래의 수정(새 키) → 409 TRANSACTION_DELETED'),
    async () => {
      const r = await setupRoom(s.http);
      const t = await seed(r);
      await delTx(s.http, r.c.roomId, r.c.key, t.id);
      expectApiError(
        await putTx(s.http, r.c.roomId, r.c.key, t.id, { amount: 5 }),
        409,
        'TRANSACTION_DELETED',
      );
    },
  );

  it(
    ac(
      ['AC-PART-002-7'],
      'S2 §6.2',
      '비활성 참여자가 당사자인 거래도 수정할 수 있다(당사자는 그대로)',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const t = await seed(r);
      await s.http
        .patch(`/rooms/${r.c.roomId}/participants/${r.p.b}`)
        .set(auth(r.c.key))
        .send({ status: 'INACTIVE' });
      const res = await putTx(s.http, r.c.roomId, r.c.key, t.id, {
        amount: 77,
        reason: '비활성 포함',
      });
      expect(res.status).toBe(200);
      expect(res.body.transaction).toMatchObject({ amount: 77, payeeId: r.p.b });
    },
  );

  it(
    ac(
      ['AC-ROOM-005-2'],
      'S1 §6.1',
      '같은 키로 복원된 멤버는 이전에 쓴 거래를 수정·삭제할 수 있다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const member = await join(s.http, r.c.inviteCode, 'Kim');
      const t1 = await seed(r, member.key);
      const t2 = await seed(r, member.key);
      const restored = await join(s.http, r.c.inviteCode, 'ignored', member.key); // 200 복원
      expect(restored.res.status).toBe(200);
      expect((await putTx(s.http, r.c.roomId, member.key, t1.id, { amount: 9 })).status).toBe(200);
      expect((await delTx(s.http, r.c.roomId, member.key, t2.id)).status).toBe(200);
      // 키를 잃은 새 신원은 이전 작성자로 인식되지 않는다
      const stranger = await join(s.http, r.c.inviteCode, 'Fresh');
      expectApiError(
        await putTx(s.http, r.c.roomId, stranger.key, t1.id, { amount: 1 }),
        403,
        'NOT_AUTHOR_OR_HOST',
      );
    },
  );

  it(
    ac(
      ['AC-SYS-003-4', 'AC-SYS-003-8'],
      'S2 §3.4',
      '다른 방의 거래 ID와 없는 ID는 같은 404 TRANSACTION_NOT_FOUND이고 아무것도 바뀌지 않는다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const other = await setupRoom(s.http);
      const foreign = await seed(other);
      const before = await row(foreign.id);
      for (const [method, id] of [
        ['put', foreign.id],
        ['put', 'A'.repeat(22)],
        ['delete', foreign.id],
        ['delete', 'A'.repeat(22)],
      ] as const) {
        const res =
          method === 'put'
            ? await putTx(s.http, r.c.roomId, r.c.key, id, { amount: 5 })
            : await delTx(s.http, r.c.roomId, r.c.key, id);
        expectApiError(res, 404, 'TRANSACTION_NOT_FOUND');
      }
      expect(await row(foreign.id)).toEqual(before);
    },
  );

  it('인증·헤더: 키 없음 401, 비멤버 404, 멱등 헤더 누락은 422(대상 확인 전)', async () => {
    const r = await setupRoom(s.http);
    const t = await seed(r);
    expectApiError(
      await s.http.put(`/rooms/${r.c.roomId}/transactions/${t.id}`).send({ amount: 1 }),
      401,
      'UNAUTHENTICATED',
    );
    expectApiError(
      await putTx(s.http, r.c.roomId, newKey(), t.id, { amount: 1 }),
      404,
      'ROOM_NOT_FOUND',
    );
    expectApiError(
      await putTx(s.http, r.c.roomId, r.c.key, 'A'.repeat(22), { amount: 1 }, false),
      422,
      'VALIDATION_FAILED',
      [
        { field: 'idempotencyKey', code: 'REQUIRED' },
        { field: 'firstAttemptAt', code: 'REQUIRED' },
      ],
    );
  });
});

describe('DELETE /rooms/{roomId}/transactions/{id} (S2 §4.3)', () => {
  it(
    ac(
      ['AC-TXN-004-1', 'AC-TXN-005-4'],
      'S2 §6.4',
      '삭제는 행을 지우지 않고 deletedAt·deletedById를 채우며 원본 값·작성자를 보존한다(조회 경로 없음)',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const member = await join(s.http, r.c.inviteCode, 'Kim');
      const t = await seed(r, member.key, { amount: 4321, reason: '원본', round: 'R9' });
      await putTx(s.http, r.c.roomId, member.key, t.id, { amount: 1, reason: '수정됨' });
      const res = await delTx(s.http, r.c.roomId, r.c.key, t.id); // 방장이 삭제
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ transactionId: t.id, deletedAt: expect.stringMatching(/Z$/) });
      const stored = await row(t.id);
      expect(stored).toMatchObject({
        id: t.id,
        authorId: member.res.body.me.id,
        deletedById: r.c.hostId,
        originalReason: '원본',
        originalRound: 'R9',
        payerId: r.p.a,
        payeeId: r.p.b,
      });
      expect(String(stored.originalAmount)).toBe('4321');
      expect(stored.deletedAt).toBeInstanceOf(Date);
      // 클라이언트가 삭제된 거래를 볼 수 있는 경로는 없다(단건 조회 GET은 405)
      expect(
        (await s.http.get(`/rooms/${r.c.roomId}/transactions/${t.id}`).set(auth(r.c.key))).status,
      ).toBe(405);
    },
  );

  it(ac(['AC-TXN-005-8'], 'S2 §4.3', '새 키의 반복 삭제 → 409 TRANSACTION_DELETED'), async () => {
    const r = await setupRoom(s.http);
    const t = await seed(r);
    expect((await delTx(s.http, r.c.roomId, r.c.key, t.id)).status).toBe(200);
    expectApiError(await delTx(s.http, r.c.roomId, r.c.key, t.id), 409, 'TRANSACTION_DELETED');
  });

  it(
    ac(
      ['AC-TXN-005-7'],
      'S2 §6.2',
      '삭제한 뒤 올바른 당사자로 새 거래를 만들면 새 id·새 createdAt, 슬롯을 하나 더 쓴다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const wrong = await seed(r);
      await delTx(s.http, r.c.roomId, r.c.key, wrong.id);
      await sleep(15);
      const right = await postTx(
        s.http,
        r.c.roomId,
        r.c.key,
        validBody(r, { payerId: r.p.a, payeeId: r.p.c }),
      );
      expect(right.status).toBe(201);
      expect(right.body.transaction.id).not.toBe(wrong.id);
      expect(Date.parse(right.body.transaction.createdAt)).toBeGreaterThan(
        Date.parse(wrong.createdAt),
      );
      const [n] = await s.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "Transaction" WHERE "roomId"=$1`,
        [r.c.roomId],
      );
      expect(n!.n).toBe('2'); // 삭제된 행도 센다
    },
  );

  it('revision은 삭제 한 번에 1 오르고 이벤트는 transaction.deleted다. 거부된 삭제는 소비하지 않는다', async () => {
    const r = await setupRoom(s.http);
    const t = await seed(r);
    const base = await revision(s.db, r.c.roomId);
    await delTx(s.http, r.c.roomId, r.c.key, t.id);
    await delTx(s.http, r.c.roomId, r.c.key, t.id); // 409
    expect(await revision(s.db, r.c.roomId)).toBe(base + 1);
  });

  it('종료된 방에서는 방장·작성자도 409 GAME_ENDED, 권한 없는 멤버는 403이다(7번이 8번보다 앞)', async () => {
    const r = await setupRoom(s.http);
    const owner = await join(s.http, r.c.inviteCode, 'Own');
    const third = await join(s.http, r.c.inviteCode, 'Third');
    const t = await seed(r, owner.key);
    await endRoom(s.db, r.c.roomId);
    expectApiError(await delTx(s.http, r.c.roomId, owner.key, t.id), 409, 'GAME_ENDED');
    expectApiError(await delTx(s.http, r.c.roomId, r.c.key, t.id), 409, 'GAME_ENDED');
    expectApiError(await putTx(s.http, r.c.roomId, r.c.key, t.id, {}), 409, 'GAME_ENDED'); // 틀린 본문이어도
    expectApiError(await delTx(s.http, r.c.roomId, third.key, t.id), 403, 'NOT_AUTHOR_OR_HOST');
    expect((await row(t.id)).deletedAt).toBeNull();
  });
});
