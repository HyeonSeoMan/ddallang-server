import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ac, expectApiError } from '../helpers/contract.js';
import { sleep } from '../helpers/util.js';
import {
  auth,
  bootS2,
  delTx,
  endRoom,
  fresh,
  join,
  newKey,
  postTx,
  putTx,
  setupRoom,
  validBody,
  type S2Env,
} from './s2-helpers.js';

let s: S2Env;
beforeAll(async () => {
  s = await bootS2();
});
afterAll(() => s?.close());

const ID = 'A'.repeat(22); // 거래 ID 모양(22자 base64url)
const row = (id: string) =>
  s.db
    .query<Record<string, unknown>>(`SELECT * FROM "Transaction" WHERE "id"=$1`, [id])
    .then((r) => r[0]!);

describe('S2 §4.4 존재하지 않는 동작', () => {
  it('거래 단건 경로의 GET·PATCH·POST는 405 Allow: PUT, DELETE', async () => {
    const r = await setupRoom(s.http);
    for (const m of ['get', 'patch', 'post'] as const) {
      const res = await s.http[m](`/rooms/${r.c.roomId}/transactions/${ID}`)
        .set(auth(r.c.key))
        .send({});
      expectApiError(res, 405, 'NOT_SUPPORTED');
      expect(res.headers.allow).toBe('DELETE, PUT');
    }
  });

  it('거래 컬렉션 경로의 PUT·PATCH·DELETE는 405 Allow: POST(목록은 S3가 추가하면 GET, POST)', async () => {
    const r = await setupRoom(s.http);
    for (const m of ['put', 'patch', 'delete'] as const) {
      const res = await s.http[m](`/rooms/${r.c.roomId}/transactions`).set(auth(r.c.key)).send({});
      expectApiError(res, 405, 'NOT_SUPPORTED');
      expect(res.headers.allow).toBe('POST');
    }
  });

  it(
    ac(
      ['AC-TXN-001-5', 'AC-TXN-009-4'],
      'S2 §4.4',
      '일괄 등록·당사자 변경·거래 이전·종료 후 정정·변경 이력·감사 조회 경로는 404 ROUTE_NOT_FOUND',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const undefinedRoutes: [string, string][] = [
        ['post', `/rooms/${r.c.roomId}/transactions/batch`],
        ['put', `/rooms/${r.c.roomId}/transactions/batch`],
        ['post', `/rooms/${r.c.roomId}/transactions/bulk`],
        ['post', `/rooms/${r.c.roomId}/transactions/import`],
        ['patch', `/rooms/${r.c.roomId}/transactions/${ID}/parties`],
        ['put', `/rooms/${r.c.roomId}/transactions/${ID}/payer`],
        ['post', `/rooms/${r.c.roomId}/transactions/${ID}/transfer`],
        ['get', `/rooms/${r.c.roomId}/transactions/${ID}/history`],
        ['get', `/rooms/${r.c.roomId}/audit`],
        ['get', `/rooms/${r.c.roomId}/transactions/audit`],
        ['post', `/rooms/${r.c.roomId}/corrections`],
        ['post', `/rooms/${r.c.roomId}/transactions/corrections`],
      ];
      for (const [m, path] of undefinedRoutes) {
        for (const key of [r.c.key, newKey(), undefined]) {
          const req = (
            s.http as unknown as Record<
              string,
              (p: string) => {
                set: (h: object) => {
                  send: (b: object) => Promise<{ status: number; body: unknown }>;
                };
                send: (b: object) => Promise<{ status: number; body: unknown }>;
              }
            >
          )[m]!(path);
          const res = await (key ? req.set(auth(key)).send({}) : req.send({}));
          expectApiError(res as { status: number; body: unknown }, 404, 'ROUTE_NOT_FOUND');
        }
      }
    },
  );

  it('라우트 판정은 방·거래 존재와 인증 여부와 무관하게 같다', async () => {
    const r = await setupRoom(s.http);
    const bodies = new Set<string>();
    for (const roomId of [r.c.roomId, 'no-such-room']) {
      for (const key of [r.c.key, newKey(), undefined]) {
        const req = s.http.patch(`/rooms/${roomId}/transactions/${ID}`);
        const res = await (key ? req.set(auth(key)) : req).send({});
        expect(res.status).toBe(405);
        bodies.add(JSON.stringify(res.body));
      }
    }
    expect(bodies.size).toBe(1);
  });
});

describe('S2 §3.4 검사 순서', () => {
  it(
    ac(
      ['AC-TXN-009-1', 'AC-SYS-003-2'],
      'S2 §6.5',
      '종료 뒤 생성·수정·삭제(새 키): 권한 있는 요청자·방장은 GAME_ENDED, 권한 없는 멤버의 수정·삭제는 NOT_AUTHOR_OR_HOST, 거래는 바뀌지 않는다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const owner = await join(s.http, r.c.inviteCode, 'Own');
      const third = await join(s.http, r.c.inviteCode, 'Third');
      const t = (await postTx(s.http, r.c.roomId, owner.key, validBody(r))).body.transaction;
      const before = await row(t.id);
      await endRoom(s.db, r.c.roomId);
      // 생성: 모든 멤버가 GAME_ENDED
      for (const key of [r.c.key, owner.key, third.key])
        expectApiError(await postTx(s.http, r.c.roomId, key, validBody(r)), 409, 'GAME_ENDED');
      // 수정·삭제: 작성자·방장은 GAME_ENDED, 권한 없는 멤버는 NOT_AUTHOR_OR_HOST
      for (const key of [owner.key, r.c.key]) {
        expectApiError(
          await putTx(s.http, r.c.roomId, key, t.id, { amount: 5 }),
          409,
          'GAME_ENDED',
        );
        expectApiError(await delTx(s.http, r.c.roomId, key, t.id), 409, 'GAME_ENDED');
      }
      expectApiError(
        await putTx(s.http, r.c.roomId, third.key, t.id, { amount: 5 }),
        403,
        'NOT_AUTHOR_OR_HOST',
      );
      expectApiError(await delTx(s.http, r.c.roomId, third.key, t.id), 403, 'NOT_AUTHOR_OR_HOST');
      expect(await row(t.id)).toEqual(before);
      const [{ n }] = (await s.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "Transaction" WHERE "roomId"=$1`,
        [r.c.roomId],
      )) as [{ n: string }];
      expect(n).toBe('1');
    },
  );

  it('종료된 방에서 틀린 본문은 GAME_ENDED(8번이 10번보다 앞)이고 삭제된 거래는 TRANSACTION_DELETED(9번이 10번보다 앞)', async () => {
    const r = await setupRoom(s.http);
    const t = (await postTx(s.http, r.c.roomId, r.c.key, validBody(r))).body.transaction;
    const gone = (await postTx(s.http, r.c.roomId, r.c.key, validBody(r))).body.transaction;
    await delTx(s.http, r.c.roomId, r.c.key, gone.id);
    expectApiError(
      await putTx(s.http, r.c.roomId, r.c.key, gone.id, {}),
      409,
      'TRANSACTION_DELETED',
    ); // 틀린 본문이어도
    await endRoom(s.db, r.c.roomId);
    expectApiError(
      await putTx(s.http, r.c.roomId, r.c.key, t.id, { amount: 'bad' }),
      409,
      'GAME_ENDED',
    );
    expectApiError(await postTx(s.http, r.c.roomId, r.c.key, { amount: 'bad' }), 409, 'GAME_ENDED');
  });

  it('3번(헤더)은 잠금 전 검증이라 대상 존재·권한보다 앞이고, 4번(만료)·5번(충돌)은 6번(대상 없음)보다 앞이다', async () => {
    const r = await setupRoom(s.http);
    const owner = await join(s.http, r.c.inviteCode, 'Own');
    const third = await join(s.http, r.c.inviteCode, 'Third');
    const t = (await postTx(s.http, r.c.roomId, owner.key, validBody(r))).body.transaction;
    expect((await putTx(s.http, r.c.roomId, third.key, t.id, { amount: 1 }, false)).status).toBe(
      422,
    ); // 헤더가 없으면 403이 아니라 422
    const old = { key: fresh().key, at: new Date(Date.now() - 25 * 3_600_000).toISOString() };
    expectApiError(
      await putTx(s.http, r.c.roomId, owner.key, 'B'.repeat(22), { amount: 1 }, old),
      409,
      'IDEMPOTENCY_KEY_EXPIRED',
    ); // 없는 거래여도 만료 먼저
    const idem = fresh();
    await postTx(s.http, r.c.roomId, owner.key, validBody(r), idem);
    expectApiError(
      await putTx(s.http, r.c.roomId, owner.key, 'B'.repeat(22), { amount: 1 }, idem),
      409,
      'IDEMPOTENCY_CONFLICT',
    ); // 충돌이 404보다 앞
    expectApiError(
      await putTx(s.http, r.c.roomId, owner.key, 'B'.repeat(22), { amount: 1 }),
      404,
      'TRANSACTION_NOT_FOUND',
    );
  });

  it('인증이 멱등 헤더 검증보다 앞이다(401·404가 422보다 앞)', async () => {
    const r = await setupRoom(s.http);
    expectApiError(
      await s.http.post(`/rooms/${r.c.roomId}/transactions`).send(validBody(r)),
      401,
      'UNAUTHENTICATED',
    );
    expectApiError(
      await postTx(s.http, r.c.roomId, newKey(), validBody(r), false),
      404,
      'ROOM_NOT_FOUND',
    );
  });

  it(
    ac(
      ['AC-TXN-009-2'],
      'S2 §7 2',
      '종료 직전에 시작한 요청이 종료 뒤에 처리 차례를 얻으면 GAME_ENDED로 거부된다(거래가 생기지 않는다)',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const holder = new pg.Client({ connectionString: s.db.databaseUrl });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT "id" FROM "Room" WHERE "id"=$1 FOR UPDATE`, [r.c.roomId]); // 종료 트랜잭션이 방 잠금을 쥔 상태
        const pending = postTx(s.http, r.c.roomId, r.c.key, validBody(r)).then((x) => x); // 이 요청은 잠금을 기다린다
        await sleep(400);
        await holder.query(`UPDATE "Room" SET "status"='ENDED' WHERE "id"=$1`, [r.c.roomId]);
        await holder.query('COMMIT');
        expectApiError(await pending, 409, 'GAME_ENDED');
      } finally {
        await holder.end();
      }
      const [{ n }] = (await s.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "Transaction" WHERE "roomId"=$1`,
        [r.c.roomId],
      )) as [{ n: string }];
      expect(n).toBe('0');
    },
  );
});
