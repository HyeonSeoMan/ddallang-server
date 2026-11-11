import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, newInviteCode } from '../../src/common/ids/ids.js';
import { ac, expectApiError } from '../helpers/contract.js';
import {
  addParticipant,
  auth,
  bootS2,
  count,
  createRoom,
  endRoom,
  join,
  newKey,
  postTx,
  revision,
  setupRoom,
  validBody,
  type S2Env,
} from './s2-helpers.js';

let s: S2Env;
beforeAll(async () => {
  s = await bootS2();
});
afterAll(() => s?.close());

const txCount = (roomId: string) =>
  s.db
    .query<{ n: string }>(`SELECT count(*)::text AS n FROM "Transaction" WHERE "roomId"=$1`, [
      roomId,
    ])
    .then((r) => Number(r[0]!.n));

describe('POST /rooms/{roomId}/transactions (S2 §4.1)', () => {
  it(
    ac(
      ['AC-TXN-001-1', 'AC-TXN-001-4', 'AC-TXN-003-1'],
      'S2 §4.1',
      '유효 입력 → 201, authorId는 요청자(비방장 멤버도 가능), createdAt은 서버 시각',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const member = await join(s.http, r.c.inviteCode, 'Kim');
      const before = Date.now();
      const res = await postTx(
        s.http,
        r.c.roomId,
        member.key,
        validBody(r, { reason: '점심', round: '1R' }),
      );
      expect(res.status).toBe(201);
      const t = res.body.transaction;
      expect(t).toMatchObject({
        payerId: r.p.a,
        payeeId: r.p.b,
        amount: 1000,
        reason: '점심',
        round: '1R',
        authorId: member.res.body.me.id,
      });
      expect(t.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(t.createdAt).toBe(t.updatedAt); // 생성 시 같다
      expect(Math.abs(Date.parse(t.createdAt) - before)).toBeLessThan(10_000);
      // 서버 내부 값은 응답에 없다
      for (const k of ['originalAmount', 'deletedAt', 'seq', 'originalReason'])
        expect(t).not.toHaveProperty(k);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
    },
  );

  it(
    ac(['AC-TXN-001-2'], 'S2 §3.2', '사유·라운드 없이(생략·null·"") → 201, 둘 다 null'),
    async () => {
      const r = await setupRoom(s.http);
      for (const extra of [{}, { reason: null, round: null }, { reason: '', round: '' }]) {
        const res = await postTx(s.http, r.c.roomId, r.c.key, validBody(r, extra));
        expect(res.status).toBe(201);
        expect(res.body.transaction.reason).toBeNull();
        expect(res.body.transaction.round).toBeNull();
      }
    },
  );

  it(
    ac(['AC-TXN-001-3'], 'S2 §3.4', '지급자·수취자·금액 누락 → 422 REQUIRED, 거래가 생기지 않는다'),
    async () => {
      const r = await setupRoom(s.http);
      const res = await postTx(s.http, r.c.roomId, r.c.key, {});
      expectApiError(res, 422, 'VALIDATION_FAILED', [
        { field: 'payerId', code: 'REQUIRED' },
        { field: 'payeeId', code: 'REQUIRED' },
        { field: 'amount', code: 'REQUIRED' },
      ]);
      expect(await txCount(r.c.roomId)).toBe(0);
      expect(await revision(s.db, r.c.roomId)).toBe(3); // 참여자 등록 3회뿐
    },
  );

  it(
    ac(['AC-TXN-001-5'], 'S2 §4.4', '일괄 등록 경로는 404 ROUTE_NOT_FOUND, 본문 배열은 거부한다'),
    async () => {
      const r = await setupRoom(s.http);
      expectApiError(
        await s.http
          .post(`/rooms/${r.c.roomId}/transactions/batch`)
          .set(auth(r.c.key))
          .send([validBody(r)]),
        404,
        'ROUTE_NOT_FOUND',
      );
      const arr = await postTx(s.http, r.c.roomId, r.c.key, [validBody(r), validBody(r)]);
      expect(arr.status).toBe(422);
      expect(await txCount(r.c.roomId)).toBe(0);
    },
  );

  it(
    ac(
      ['AC-TXN-001-6'],
      'S2 §3.2',
      '사유 50자·라운드 12자 허용, 51·13 거부, 제어·서식 문자·앞뒤 공백 거부, 내부 공백·이모지·기호 허용, trim 없음',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const ok = await postTx(
        s.http,
        r.c.roomId,
        r.c.key,
        validBody(r, { reason: '가'.repeat(50), round: 'r'.repeat(12) }),
      );
      expect(ok.status).toBe(201);
      const spaced = await postTx(
        s.http,
        r.c.roomId,
        r.c.key,
        validBody(r, { reason: 'a  b 😀 !?', round: 'R 1' }),
      );
      expect(spaced.body.transaction.reason).toBe('a  b 😀 !?');
      expectApiError(
        await postTx(s.http, r.c.roomId, r.c.key, validBody(r, { reason: 'x'.repeat(51) })),
        422,
        'VALIDATION_FAILED',
        [{ field: 'reason', code: 'LENGTH_OUT_OF_RANGE' }],
      );
      expectApiError(
        await postTx(s.http, r.c.roomId, r.c.key, validBody(r, { round: 'r'.repeat(13) })),
        422,
        'VALIDATION_FAILED',
        [{ field: 'round', code: 'LENGTH_OUT_OF_RANGE' }],
      );
      for (const bad of ['a\nb', 'a\tb', 'a​b', 'a\u0000b', 'a‮b']) {
        expectApiError(
          await postTx(s.http, r.c.roomId, r.c.key, validBody(r, { reason: bad })),
          422,
          'VALIDATION_FAILED',
          [{ field: 'reason', code: 'INVALID_CHARACTER' }],
        );
      }
      expectApiError(
        await postTx(s.http, r.c.roomId, r.c.key, validBody(r, { reason: ' a' })),
        422,
        'VALIDATION_FAILED',
        [{ field: 'reason', code: 'LEADING_OR_TRAILING_SPACE' }],
      );
      expectApiError(
        await postTx(s.http, r.c.roomId, r.c.key, validBody(r, { reason: 123 })),
        422,
        'VALIDATION_FAILED',
        [{ field: 'reason', code: 'INVALID_TYPE' }],
      );
    },
  );

  it(
    ac(
      ['AC-TXN-002-1', 'AC-TXN-002-5'],
      'S2 §3.3',
      '금액 1·999,999,999 허용(정산 단위 원·점수·칩 모두 같은 상한)',
    ),
    async () => {
      for (const unit of ['원', '점수', '칩']) {
        const c = await createRoom(s.http, { unit });
        const ids: string[] = [];
        for (const n of ['A1', 'B1'])
          ids.push((await addParticipant(s.http, c, n)).body.participant.id);
        for (const amount of [1, 999_999_999]) {
          expect(
            (await postTx(s.http, c.roomId, c.key, { payerId: ids[0], payeeId: ids[1], amount }))
              .status,
            `${unit} ${amount}`,
          ).toBe(201);
        }
        expect(
          (
            await postTx(s.http, c.roomId, c.key, {
              payerId: ids[0],
              payeeId: ids[1],
              amount: 1_000_000_000,
            })
          ).status,
        ).toBe(422);
      }
    },
  );

  it(
    ac(['AC-TXN-002-2'], 'S2 §3.3', '금액 0·-1·1.5·"abc"·"100"·1,000,000,000·null 거부(코드 구분)'),
    async () => {
      const r = await setupRoom(s.http);
      const cases: [unknown, string][] = [
        [0, 'OUT_OF_RANGE'],
        [-1, 'OUT_OF_RANGE'],
        [1_000_000_000, 'OUT_OF_RANGE'],
        [1.5, 'INVALID_VALUE'],
        ['abc', 'INVALID_TYPE'],
        ['100', 'INVALID_TYPE'],
        [null, 'REQUIRED'],
        [true, 'INVALID_TYPE'],
      ];
      for (const [amount, code] of cases) {
        expectApiError(
          await postTx(s.http, r.c.roomId, r.c.key, validBody(r, { amount })),
          422,
          'VALIDATION_FAILED',
          [{ field: 'amount', code }],
        );
      }
      expect(await txCount(r.c.roomId)).toBe(0);
    },
  );

  it(
    ac(
      ['AC-TXN-002-3', 'AC-TXN-002-4'],
      'S2 §3.3',
      '지급자 = 수취자 → 422 SAME_AS_PAYER, 거래가 생기지 않는다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const res = await postTx(s.http, r.c.roomId, r.c.key, validBody(r, { payeeId: r.p.a }));
      expectApiError(res, 422, 'VALIDATION_FAILED', [{ field: 'payeeId', code: 'SAME_AS_PAYER' }]);
      expect(await txCount(r.c.roomId)).toBe(0);
    },
  );

  it(
    ac(['AC-TXN-003-2'], 'S2 §3.1', '비멤버는 404, 키 없음은 401이며 거래가 생기지 않는다'),
    async () => {
      const r = await setupRoom(s.http);
      expectApiError(
        await postTx(s.http, r.c.roomId, newKey(), validBody(r)),
        404,
        'ROOM_NOT_FOUND',
      );
      expectApiError(
        await s.http.post(`/rooms/${r.c.roomId}/transactions`).send(validBody(r)),
        401,
        'UNAUTHENTICATED',
      );
      expect(await txCount(r.c.roomId)).toBe(0);
    },
  );

  it(
    ac(
      ['AC-TXN-003-3'],
      'S2 §3.5',
      '본문의 authorId·createdAt 등 허용 밖 필드 → 422 NOT_ALLOWED_FIELD, 작성자는 요청자',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const res = await postTx(
        s.http,
        r.c.roomId,
        r.c.key,
        validBody(r, {
          authorId: 'someone-else',
          createdAt: '2020-01-01T00:00:00.000Z',
          id: 'x',
          seq: 9,
        }),
      );
      expect(res.status).toBe(422);
      const codes = res.body.error.details
        .map((d: { field: string; code: string }) => `${d.field}:${d.code}`)
        .sort();
      expect(codes).toEqual([
        'authorId:NOT_ALLOWED_FIELD',
        'createdAt:NOT_ALLOWED_FIELD',
        'id:NOT_ALLOWED_FIELD',
        'seq:NOT_ALLOWED_FIELD',
      ]);
      expect(await txCount(r.c.roomId)).toBe(0);
      const ok = await postTx(s.http, r.c.roomId, r.c.key, validBody(r));
      expect(ok.body.transaction.authorId).toBe(r.c.hostId);
    },
  );

  it(
    ac(
      ['AC-ROOM-004-1', 'AC-ROOM-004-2'],
      'S2 §6.1',
      '참여자와 무관한 RoomMember가 거래를 쓸 수 있고, 접속자 없는 참여자가 당사자가 될 수 있다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const unrelated = await join(s.http, r.c.inviteCode, 'Zed'); // 어떤 Participant와도 무관
      const res = await postTx(s.http, r.c.roomId, unrelated.key, validBody(r));
      expect(res.status).toBe(201);
      expect(res.body.transaction.authorId).toBe(unrelated.res.body.me.id);
      expect(await count(s.db, 'RoomMember', r.c.roomId)).toBe(2); // 방장 + Zed: 등록으로 멤버가 늘지 않는다
    },
  );

  it(
    ac(
      ['AC-SYS-003-8'],
      'S2 §3.4',
      '다른 방의 Participant ID와 없는 ID → 422 PARTICIPANT_NOT_FOUND(구별되지 않는다)',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const other = await setupRoom(s.http);
      const foreign = await postTx(
        s.http,
        r.c.roomId,
        r.c.key,
        validBody(r, { payerId: other.p.a }),
      );
      const missing = await postTx(
        s.http,
        r.c.roomId,
        r.c.key,
        validBody(r, { payerId: 'does-not-exist' }),
      );
      expectApiError(foreign, 422, 'VALIDATION_FAILED', [
        { field: 'payerId', code: 'PARTICIPANT_NOT_FOUND' },
      ]);
      expect(foreign.body).toEqual(missing.body);
      expect(await txCount(r.c.roomId)).toBe(0);
    },
  );

  it(
    ac(
      ['AC-PART-002-3', 'AC-SYS-003-3'],
      'S2 §6.1',
      '비활성 참여자를 당사자로 한 신규 거래는 409 PARTICIPANT_INACTIVE(필드 표시), 기록하지 않는다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      await s.http
        .patch(`/rooms/${r.c.roomId}/participants/${r.p.b}`)
        .set(auth(r.c.key))
        .send({ status: 'INACTIVE' });
      const res = await postTx(s.http, r.c.roomId, r.c.key, validBody(r)); // payee B가 비활성
      expectApiError(res, 409, 'PARTICIPANT_INACTIVE', [{ field: 'payeeId' }]);
      const both = await postTx(
        s.http,
        r.c.roomId,
        r.c.key,
        validBody(r, { payerId: r.p.b, payeeId: r.p.b === r.p.a ? r.p.c : r.p.c }),
      );
      expectApiError(both, 409, 'PARTICIPANT_INACTIVE', [{ field: 'payerId' }]);
      expect(await txCount(r.c.roomId)).toBe(0);
    },
  );

  it(
    ac(['AC-PART-002-4'], 'S2 §6.1', '재활성화 뒤에는 같은 참여자가 다시 당사자가 될 수 있다'),
    async () => {
      const r = await setupRoom(s.http);
      const patch = (status: string) =>
        s.http
          .patch(`/rooms/${r.c.roomId}/participants/${r.p.b}`)
          .set(auth(r.c.key))
          .send({ status });
      await patch('INACTIVE');
      expect((await postTx(s.http, r.c.roomId, r.c.key, validBody(r))).status).toBe(409);
      await patch('ACTIVE');
      expect((await postTx(s.http, r.c.roomId, r.c.key, validBody(r))).status).toBe(201);
    },
  );

  it(
    ac(
      ['AC-ROOM-008-3'],
      'S2 §6.4',
      '삭제된 거래를 포함해 1,000건이면 1,001번째 새 생성 요청은 409 TRANSACTION_LIMIT_EXCEEDED(details.limit), 거래 수는 1,000을 넘지 않는다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      // 999건을 DB에 직접 채운다(그중 일부는 삭제 표시 행). seq는 방 카운터와 맞춘다.
      await s.db.query(
        `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","authorId","originalAmount","createdAt","updatedAt","deletedAt","deletedById")
       SELECT 'seed' || g, $1, g, $2, $3, 100, $4, 100, clock_timestamp(), clock_timestamp(),
              CASE WHEN g % 10 = 0 THEN clock_timestamp() END, CASE WHEN g % 10 = 0 THEN $4 END
       FROM generate_series(1, 999) g`,
        [r.c.roomId, r.p.a, r.p.b, r.c.hostId],
      );
      await s.db.query(`UPDATE "Room" SET "nextTxnSeq"=1000 WHERE "id"=$1`, [r.c.roomId]);
      const last = await postTx(s.http, r.c.roomId, r.c.key, validBody(r));
      expect(last.status).toBe(201); // 1,000번째
      const over = await postTx(s.http, r.c.roomId, r.c.key, validBody(r));
      expectApiError(over, 409, 'TRANSACTION_LIMIT_EXCEEDED', [{ limit: 1000 }]);
      expect(await txCount(r.c.roomId)).toBe(1000);
    },
  );

  it(
    ac(
      ['AC-ROOM-008-9'],
      'S2 §6.3',
      '삭제한 거래도 1,000건 한도에 센다: 삭제는 슬롯을 돌려주지 않는다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      await s.db.query(
        `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","authorId","originalAmount","createdAt","updatedAt")
         SELECT 'del' || g, $1, g, $2, $3, 100, $4, 100, clock_timestamp(), clock_timestamp() FROM generate_series(1, 999) g`,
        [r.c.roomId, r.p.a, r.p.b, r.c.hostId],
      );
      await s.db.query(`UPDATE "Room" SET "nextTxnSeq"=1000 WHERE "id"=$1`, [r.c.roomId]);
      const last = await postTx(s.http, r.c.roomId, r.c.key, validBody(r));
      expect(last.status).toBe(201);
      const del = await s.http
        .delete(`/rooms/${r.c.roomId}/transactions/${last.body.transaction.id}`)
        .set(auth(r.c.key))
        .set('Idempotency-Key', 'd'.repeat(22))
        .set('Idempotency-First-Attempt-At', new Date().toISOString());
      expect(del.status).toBe(200);
      expectApiError(
        await postTx(s.http, r.c.roomId, r.c.key, validBody(r)),
        409,
        'TRANSACTION_LIMIT_EXCEEDED',
        [{ limit: 1000 }],
      );
      expect(await txCount(r.c.roomId)).toBe(1000);
    },
  );

  it('seq는 1부터 방 안에서 증가하고 createdAt은 비감소이며 revision은 거래마다 1 오른다', async () => {
    const r = await setupRoom(s.http);
    const base = await revision(s.db, r.c.roomId);
    for (let i = 0; i < 5; i++)
      await postTx(s.http, r.c.roomId, r.c.key, validBody(r, { amount: i + 1 }));
    const rows = await s.db.query<{ seq: number; createdAt: Date }>(
      `SELECT "seq","createdAt" FROM "Transaction" WHERE "roomId"=$1 ORDER BY "seq"`,
      [r.c.roomId],
    );
    expect(rows.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(rows[i - 1]!.createdAt.getTime());
    expect(await revision(s.db, r.c.roomId)).toBe(base + 5);
    const [room] = await s.db.query<{ nextTxnSeq: number }>(
      `SELECT "nextTxnSeq" FROM "Room" WHERE "id"=$1`,
      [r.c.roomId],
    );
    expect(room!.nextTxnSeq).toBe(6);
  });

  it('원본 값(originalAmount·Reason·Round)을 보존한다', async () => {
    const r = await setupRoom(s.http);
    const res = await postTx(
      s.http,
      r.c.roomId,
      r.c.key,
      validBody(r, { amount: 777, reason: '원본', round: 'R1' }),
    );
    const [row] = await s.db.query<{
      originalAmount: string;
      originalReason: string;
      originalRound: string;
    }>(
      `SELECT "originalAmount"::text,"originalReason","originalRound" FROM "Transaction" WHERE "id"=$1`,
      [res.body.transaction.id],
    );
    expect(row).toEqual({ originalAmount: '777', originalReason: '원본', originalRound: 'R1' });
  });

  it('NFC 정규화: 분해형 사유는 정규화한 값으로 저장·응답한다', async () => {
    const r = await setupRoom(s.http);
    const res = await postTx(
      s.http,
      r.c.roomId,
      r.c.key,
      validBody(r, { reason: '한글'.normalize('NFD') }),
    );
    expect(res.body.transaction.reason).toBe('한글');
  });

  it('검사 순서: 종료된 방에서는 본문이 틀려도 GAME_ENDED, 헤더 오류는 그보다 앞선다(422)', async () => {
    const r = await setupRoom(s.http);
    await endRoom(s.db, r.c.roomId);
    expectApiError(await postTx(s.http, r.c.roomId, r.c.key, {}), 409, 'GAME_ENDED');
    expectApiError(await postTx(s.http, r.c.roomId, r.c.key, validBody(r)), 409, 'GAME_ENDED');
    const noHeaders = await postTx(s.http, r.c.roomId, r.c.key, validBody(r), false);
    expect(noHeaders.status).toBe(422);
    expect(noHeaders.body.error.details.map((d: { field: string }) => d.field)).toEqual([
      'idempotencyKey',
      'firstAttemptAt',
    ]);
  });

  it('본문이 JSON이 아니면 422이고 거래가 생기지 않는다', async () => {
    const r = await setupRoom(s.http);
    const res = await s.http
      .post(`/rooms/${r.c.roomId}/transactions`)
      .set(auth(r.c.key))
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', 'k'.repeat(22))
      .set('Idempotency-First-Attempt-At', new Date().toISOString())
      .send('{"payerId":');
    expectApiError(res, 422, 'VALIDATION_FAILED', [{ field: 'body', code: 'INVALID_VALUE' }]);
    expect(await txCount(r.c.roomId)).toBe(0);
  });

  it('검증 위반은 모아서 반환한다(여러 필드)', async () => {
    const r = await setupRoom(s.http);
    const res = await postTx(s.http, r.c.roomId, r.c.key, {
      payerId: 5,
      payeeId: 'nope',
      amount: 0,
      reason: 'x'.repeat(60),
      extra: 1,
    });
    expect(res.status).toBe(422);
    const flat = res.body.error.details.map(
      (d: { field: string; code: string }) => `${d.field}:${d.code}`,
    );
    expect(flat).toEqual(
      expect.arrayContaining([
        'payerId:INVALID_TYPE',
        'payeeId:PARTICIPANT_NOT_FOUND',
        'amount:OUT_OF_RANGE',
        'reason:LENGTH_OUT_OF_RANGE',
        'extra:NOT_ALLOWED_FIELD',
      ]),
    );
  });
});

void newId;
void newInviteCode;
