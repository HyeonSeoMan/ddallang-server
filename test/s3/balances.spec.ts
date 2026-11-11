import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ac, expectApiError } from '../helpers/contract.js';
import {
  addParticipant,
  auth,
  bootS2,
  delTx,
  endRoom,
  join,
  newKey,
  postTx,
  putTx,
  setupRoom,
  validBody,
  type S2Env,
  type Setup,
} from '../s2/s2-helpers.js';
import { seedTransactions } from './s3-helpers.js';

let s: S2Env;
beforeAll(async () => {
  s = await bootS2();
});
afterAll(() => s?.close());

const get = (r: Setup, key = r.c.key, qs = '') =>
  s.http.get(`/rooms/${r.c.roomId}/balances${qs}`).set(auth(key));
const bal = async (r: Setup) => {
  const res = await get(r);
  expect(res.status).toBe(200);
  return res.body.balances as {
    participantId: string;
    nickname: string;
    status: string;
    order: number;
    balance: number;
  }[];
};
const pay = (r: Setup, payer: string, payee: string, amount: number) =>
  postTx(s.http, r.c.roomId, r.c.key, { payerId: payer, payeeId: payee, amount });

describe('GET /rooms/{roomId}/balances (S3 §4.2, §6.1)', () => {
  it(ac(['AC-SET-002-1'], 'S3 §6.1', 'A→B 100 → A −100, B +100'), async () => {
    const r = await setupRoom(s.http);
    await pay(r, r.p.a, r.p.b, 100);
    const b = Object.fromEntries((await bal(r)).map((x) => [x.participantId, x.balance]));
    expect(b).toEqual({ [r.p.a]: -100, [r.p.b]: 100, [r.p.c]: 0 });
  });

  it(
    ac(
      ['AC-VIEW-002-1', 'AC-VIEW-001-2'],
      'S3 §4.2',
      '+300, +100, −400 순서이고 응답에는 참여자별 값만 있다(거래 항목 없음)',
    ),
    async () => {
      const r = await setupRoom(s.http);
      await pay(r, r.p.c, r.p.a, 300);
      await pay(r, r.p.c, r.p.b, 100);
      const res = await get(r);
      expect(res.body.balances.map((x: { balance: number }) => x.balance)).toEqual([
        300, 100, -400,
      ]);
      expect(res.body.balances.map((x: { participantId: string }) => x.participantId)).toEqual([
        r.p.a,
        r.p.b,
        r.p.c,
      ]);
      expect(Object.keys(res.body)).toEqual(['balances']);
      for (const x of res.body.balances)
        expect(Object.keys(x).sort()).toEqual([
          'balance',
          'nickname',
          'order',
          'participantId',
          'status',
        ]);
      expect(JSON.stringify(res.body)).not.toMatch(/transaction|amount|reason|round|authorId/);
    },
  );

  it(
    ac(
      ['AC-VIEW-002-2', 'AC-VIEW-002-3'],
      'S3 §6.2',
      '같은 순손익은 order가 앞선 참여자가 먼저, 거래 없는 참여자(0)는 규칙대로 가운데에 놓인다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const d = (await addParticipant(s.http, r.c, 'Dd')).body.participant.id as string; // order 4, 거래 없음
      await pay(r, r.p.c, r.p.b, 100); // B +100 (order 2)
      await pay(r, r.p.c, r.p.a, 100); // A +100 (order 1)
      await pay(r, r.p.c, r.p.c === r.p.a ? r.p.b : r.p.b, 0 + 100); // C -300 total
      const rows = await bal(r);
      expect(rows.map((x) => [x.participantId, x.balance])).toEqual(
        [
          [r.p.a, 100],
          [r.p.b, 200],
          [r.p.c, -300],
          [d, 0],
        ]
          .sort((a, b) => (b[1] as number) - (a[1] as number))
          .map((x) => x),
      );
      // 동률 확인: A와 B를 +100으로 맞춘 새 방
      const r2 = await setupRoom(s.http);
      const d2 = (await addParticipant(s.http, r2.c, 'Dd')).body.participant.id as string;
      await pay(r2, r2.p.c, r2.p.b, 100);
      await pay(r2, r2.p.c, r2.p.a, 100);
      const rows2 = await bal(r2);
      expect(rows2.map((x) => [x.participantId, x.balance])).toEqual([
        [r2.p.a, 100],
        [r2.p.b, 100],
        [d2, 0],
        [r2.p.c, -200],
      ]); // 동률은 order(A=1, B=2), 0이 가운데
    },
  );

  it(ac(['AC-SET-002-3', 'AC-TXN-005-3'], 'S3 §6.1', '삭제된 거래는 제외한다'), async () => {
    const r = await setupRoom(s.http);
    const t = (await pay(r, r.p.a, r.p.b, 500)).body.transaction;
    await pay(r, r.p.a, r.p.b, 50);
    await delTx(s.http, r.c.roomId, r.c.key, t.id);
    expect((await bal(r)).find((x) => x.participantId === r.p.b)!.balance).toBe(50);
  });

  it(
    ac(['AC-SET-002-4', 'AC-TXN-005-5'], 'S3 §6.1', '수정 후에는 수정된 금액으로 계산한다'),
    async () => {
      const r = await setupRoom(s.http);
      const t = (await pay(r, r.p.a, r.p.b, 500)).body.transaction;
      await putTx(s.http, r.c.roomId, r.c.key, t.id, { amount: 120 });
      const rows = await bal(r);
      expect(rows.find((x) => x.participantId === r.p.a)!.balance).toBe(-120);
      expect(rows.find((x) => x.participantId === r.p.b)!.balance).toBe(120);
    },
  );

  it(
    ac(
      ['AC-SET-002-5', 'AC-PART-002-2', 'AC-PART-002-6'],
      'S3 §6.1',
      '비활성 참여자도 포함하고 합 0에 기여하며, 비활성화·재활성화는 값을 바꾸지 않는다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      await pay(r, r.p.a, r.p.b, 700);
      const before = await bal(r);
      const patch = (status: string) =>
        s.http
          .patch(`/rooms/${r.c.roomId}/participants/${r.p.b}`)
          .set(auth(r.c.key))
          .send({ status });
      await patch('INACTIVE');
      const during = await bal(r);
      expect(during.find((x) => x.participantId === r.p.b)).toMatchObject({
        status: 'INACTIVE',
        balance: 700,
      });
      expect(during.map((x) => x.balance).reduce((a, b) => a + b, 0)).toBe(0);
      expect(during.map((x) => [x.participantId, x.balance])).toEqual(
        before.map((x) => [x.participantId, x.balance]),
      );
      await patch('ACTIVE');
      expect((await bal(r)).map((x) => [x.participantId, x.balance])).toEqual(
        before.map((x) => [x.participantId, x.balance]),
      );
    },
  );

  it('참여자가 없거나 거래가 없으면 모두 0이거나 빈 목록이다', async () => {
    const c = await (await import('../s1/s1-helpers.js')).createRoom(s.http);
    const empty = await s.http.get(`/rooms/${c.roomId}/balances`).set(auth(c.key));
    expect(empty.body).toEqual({ balances: [] });
    const r = await setupRoom(s.http);
    expect((await bal(r)).map((x) => x.balance)).toEqual([0, 0, 0]);
  });

  it(
    ac(
      ['AC-VIEW-004-7'],
      'S3 §3.3',
      'balances는 어떤 쿼리 매개변수도 허용하지 않고(NOT_ALLOWED_FIELD), 목록 필터 요청 전후 값이 같다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      await pay(r, r.p.a, r.p.b, 100);
      const before = await bal(r);
      for (const qs of ['?participantId=' + r.p.a, '?cursor=x', '?foo=1', '?limit=5']) {
        const res = await get(r, r.c.key, qs);
        const name = qs.slice(1).split('=')[0]!;
        expectApiError(res, 422, 'VALIDATION_FAILED', [{ field: name, code: 'NOT_ALLOWED_FIELD' }]);
      }
      expectApiError(await get(r, r.c.key, '?a=1&b=2'), 422, 'VALIDATION_FAILED', [
        { field: 'a', code: 'NOT_ALLOWED_FIELD' },
        { field: 'b', code: 'NOT_ALLOWED_FIELD' },
      ]);
      await s.http
        .get(`/rooms/${r.c.roomId}/transactions?participantId=${r.p.a}`)
        .set(auth(r.c.key));
      expect(await bal(r)).toEqual(before);
    },
  );

  it('권한과 상태: 비멤버 404, 키 없음 401, 일반 멤버·종료된 방도 조회 가능', async () => {
    const r = await setupRoom(s.http);
    const member = await join(s.http, r.c.inviteCode, 'Kim');
    expectApiError(await get(r, newKey()), 404, 'ROOM_NOT_FOUND');
    expectApiError(await s.http.get(`/rooms/${r.c.roomId}/balances`), 401, 'UNAUTHENTICATED');
    expect((await get(r, member.key)).status).toBe(200);
    await endRoom(s.db, r.c.roomId);
    expect((await get(r, member.key)).status).toBe(200);
  });

  it('405: POST·PUT·PATCH·DELETE는 NOT_SUPPORTED + Allow: GET', async () => {
    const r = await setupRoom(s.http);
    for (const m of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await s.http[m](`/rooms/${r.c.roomId}/balances`).set(auth(r.c.key)).send({});
      expectApiError(res, 405, 'NOT_SUPPORTED');
      expect(res.headers.allow).toBe('GET');
    }
  });

  it(
    ac(['AC-SET-002-2'], 'S3 §6.1', '최대 금액 1,000건에서도 정수로 정확하다(NFR-009: 약 10¹²)'),
    async () => {
      const r = await setupRoom(s.http);
      await seedTransactions(s.db, r, {
        count: 1000,
        payer: r.p.a,
        payee: r.p.b,
        amount: 999_999_999,
      });
      const rows = await bal(r);
      expect(rows.find((x) => x.participantId === r.p.b)!.balance).toBe(999_999_999_000);
      expect(rows.find((x) => x.participantId === r.p.a)!.balance).toBe(-999_999_999_000);
      expect(rows.map((x) => x.balance).reduce((a, b) => a + b, 0)).toBe(0);
      expect(Number.isSafeInteger(rows[0]!.balance)).toBe(true);
    },
  );
});

describe('순손익 속성 시험 (NFR-001)', () => {
  type Op =
    | { kind: 'create'; payer: number; payee: number; amount: number }
    | { kind: 'update'; target: number; amount: number }
    | { kind: 'delete'; target: number }
    | { kind: 'toggle'; who: number };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      kind: fc.constant('create' as const),
      payer: fc.nat(2),
      payee: fc.nat(2),
      amount: fc.integer({ min: 1, max: 999_999_999 }),
    }),
    fc.record({
      kind: fc.constant('update' as const),
      target: fc.nat(30),
      amount: fc.integer({ min: 1, max: 999_999_999 }),
    }),
    fc.record({ kind: fc.constant('delete' as const), target: fc.nat(30) }),
    fc.record({ kind: fc.constant('toggle' as const), who: fc.nat(2) }),
  );

  it(
    ac(
      ['AC-SET-002-2', 'AC-TXN-006-3'],
      'S3 §2.2 V-I2',
      '무작위 생성·수정·삭제·비활성화 뒤에도 순손익 합은 0이고 거래 재계산 값과 일치한다(동시 수정 포함)',
    ),
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 14 }), async (ops) => {
          const r = await setupRoom(s.http);
          const ids = [r.p.a, r.p.b, r.p.c];
          const created: string[] = [];
          for (const op of ops) {
            if (op.kind === 'create') {
              if (op.payer === op.payee) continue;
              const res = await pay(r, ids[op.payer]!, ids[op.payee]!, op.amount);
              if (res.status === 201) created.push(res.body.transaction.id);
            } else if (op.kind === 'update' && created.length) {
              const id = created[op.target % created.length]!;
              // 같은 거래를 동시에 두 번 수정(마지막 성공 저장이 최종값, 합은 어느 쪽이든 0)
              await Promise.all([
                putTx(s.http, r.c.roomId, r.c.key, id, { amount: op.amount }),
                putTx(s.http, r.c.roomId, r.c.key, id, { amount: (op.amount % 999_999_999) + 1 }),
              ]);
            } else if (op.kind === 'delete' && created.length) {
              await delTx(s.http, r.c.roomId, r.c.key, created[op.target % created.length]!);
            } else if (op.kind === 'toggle') {
              const status = (
                await s.db.query<{ status: string }>(
                  `SELECT "status" FROM "Participant" WHERE "id"=$1`,
                  [ids[op.who]],
                )
              )[0]!.status;
              await s.http
                .patch(`/rooms/${r.c.roomId}/participants/${ids[op.who]}`)
                .set(auth(r.c.key))
                .send({ status: status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
            }
          }
          const rows = await bal(r);
          expect(rows.reduce((a, x) => a + x.balance, 0)).toBe(0);
          // 재계산: DB의 유효 거래로 직접 합산
          const recomputed = await s.db.query<{ id: string; b: string }>(
            `SELECT p."id", (COALESCE(SUM(CASE WHEN t."payeeId"=p."id" THEN t."amount" ELSE -t."amount" END), 0))::text AS b
           FROM "Participant" p LEFT JOIN "Transaction" t ON t."roomId"=p."roomId" AND t."deletedAt" IS NULL AND (t."payeeId"=p."id" OR t."payerId"=p."id")
           WHERE p."roomId"=$1 GROUP BY p."id"`,
            [r.c.roomId],
          );
          const expected = new Map(recomputed.map((x) => [x.id, Number(x.b)]));
          for (const x of rows) expect(x.balance).toBe(expected.get(x.participantId));
          // 정렬 규칙
          for (let i = 1; i < rows.length; i++) {
            const [a, b] = [rows[i - 1]!, rows[i]!];
            expect(a.balance > b.balance || (a.balance === b.balance && a.order < b.order)).toBe(
              true,
            );
          }
        }),
        { numRuns: 12 },
      );
    },
  );
});

void validBody;
