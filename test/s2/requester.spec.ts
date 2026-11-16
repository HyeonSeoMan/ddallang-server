import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashIdentityKey } from '../../src/common/auth/identity-key.js';
import { ac, expectApiError } from '../helpers/contract.js';
import { pendingClaimFixture } from '../s1/s1-helpers.js';
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
  revision,
  setupRoom,
  validBody,
  type S2Env,
  type Setup,
} from './s2-helpers.js';

/**
 * BE-M5: 거래·종료·조회의 요청자는 이 방에 연결된 참여자다(S2 §3.1, §3.4 2·5a, §5.1, S3 §3.1, S4 §3.1).
 * 비활성 참여자는 조회만 하고, 접근을 잃은 키는 재전송 판정보다 먼저 401이다.
 */
let s: S2Env;
beforeAll(async () => {
  s = await bootS2();
});
afterAll(() => s?.close());

const txRows = (roomId: string) =>
  s.db
    .query<{ n: string }>(`SELECT count(*)::text AS n FROM "Transaction" WHERE "roomId"=$1`, [
      roomId,
    ])
    .then((r) => Number(r[0]!.n));
const records = (roomId: string, participantId?: string) =>
  s.db
    .query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "IdempotencyRecord" WHERE "roomId"=$1 ${participantId ? `AND "participantId"='${participantId}'` : ''}`,
      [roomId],
    )
    .then((r) => Number(r[0]!.n));
const setStatus = (r: Setup, id: string, status: 'ACTIVE' | 'INACTIVE') =>
  s.http.patch(`/rooms/${r.c.roomId}/participants/${id}`).set(auth(r.c.key)).send({ status });
const endReq = (r: Setup, key: string, h = fresh()) =>
  s.http
    .post(`/rooms/${r.c.roomId}/end`)
    .set(auth(key))
    .set('Idempotency-Key', h.key)
    .set('Idempotency-First-Attempt-At', h.at);
const reads = (r: Setup, key: string) =>
  Promise.all(
    ['', '/participants', '/transactions', '/balances', '/settlement'].map((p) =>
      s.http.get(`/rooms/${r.c.roomId}${p}`).set(auth(key)),
    ),
  );
/** 이어받기 승인(API): 대상 닉네임을 새 키로 요청하고 방장이 승인한다. */
async function takeOver(r: Setup, nickname: string): Promise<string> {
  const key = newKey();
  const claim = await s.http
    .post(`/invites/${r.c.inviteCode}/claims`)
    .set(auth(key))
    .send({ nickname });
  expect(claim.status).toBe(201);
  const ok = await s.http
    .post(`/rooms/${r.c.roomId}/claims/${claim.body.claim.id}/approve`)
    .set(auth(r.c.key));
  expect(ok.status).toBe(200);
  return key;
}
/** 입장한 활성 참여자 Kim(키 있음)이 있는 방 */
async function withKim() {
  const r = await setupRoom(s.http);
  const kim = await join(s.http, r.c.inviteCode, 'Kim');
  return { r, kim: { key: kim.key, id: kim.res.body.me.id as string } };
}

describe('거래 요청자 (S2 §3.1)', () => {
  it(
    ac(
      ['AC-TXN-003-1', 'AC-ROOM-004-2'],
      'S2 §3.1, §6.1',
      '비방장 활성 참여자가 자기가 당사자가 아닌 두 활성 참여자(직접 추가, 신원 없음) 사이의 거래 → 201, 작성자는 요청자 참여자',
    ),
    async () => {
      const { r, kim } = await withKim();
      const res = await postTx(s.http, r.c.roomId, kim.key, validBody(r));
      expect(res.status).toBe(201);
      expect(res.body.transaction).toMatchObject({
        payerId: r.p.a,
        payeeId: r.p.b,
        authorId: kim.id,
      });
      // 거래 요청자 자신이 당사자인 거래도 된다
      const self = await postTx(s.http, r.c.roomId, kim.key, validBody(r, { payerId: kim.id }));
      expect(self.status).toBe(201);
    },
  );

  it(
    ac(
      ['AC-TXN-003-2'],
      'S2 §3.4 2',
      '키 없음 401, 입장하지 않은 키·이어받기 대기 키 404, 접근 상실 키 401 IDENTITY_REVOKED. 모두 거래·기록 없음',
    ),
    async () => {
      const { r } = await withKim();
      const waiting = newKey();
      await pendingClaimFixture(s.db, r.c.roomId, r.p.c, waiting);
      const leeKey = (await join(s.http, r.c.inviteCode, 'Lee')).key;
      await takeOver(r, 'Lee'); // Lee의 이전 키는 접근을 잃는다
      expectApiError(
        await s.http.post(`/rooms/${r.c.roomId}/transactions`).send(validBody(r)),
        401,
        'UNAUTHENTICATED',
      );
      expectApiError(
        await postTx(s.http, r.c.roomId, newKey(), validBody(r)),
        404,
        'ROOM_NOT_FOUND',
      );
      expectApiError(
        await postTx(s.http, r.c.roomId, waiting, validBody(r)),
        404,
        'ROOM_NOT_FOUND',
      );
      expectApiError(
        await postTx(s.http, r.c.roomId, leeKey, validBody(r)),
        401,
        'IDENTITY_REVOKED',
      );
      expect(await txRows(r.c.roomId)).toBe(0);
      expect(await records(r.c.roomId)).toBe(0);
    },
  );

  it(
    ac(
      ['AC-TXN-003-4', 'AC-PART-002-11'],
      'S2 §3.4 5a',
      '비활성 참여자 키의 생성·수정·삭제(자기 거래 포함) → 403 REQUESTER_INACTIVE, 거래 불변·키 미기록. 종료된 방·없는 거래·잘못된 본문보다 앞',
    ),
    async () => {
      const { r, kim } = await withKim();
      const own = (await postTx(s.http, r.c.roomId, kim.key, validBody(r))).body.transaction;
      expect((await setStatus(r, kim.id, 'INACTIVE')).status).toBe(200);
      const rows = await txRows(r.c.roomId);
      const rev = await revision(s.db, r.c.roomId);
      const recs = await records(r.c.roomId);
      for (const res of [
        await postTx(s.http, r.c.roomId, kim.key, validBody(r)),
        await postTx(s.http, r.c.roomId, kim.key, { bad: true }), // 본문 검증(10)보다 앞
        await putTx(s.http, r.c.roomId, kim.key, own.id, { amount: 7 }),
        await delTx(s.http, r.c.roomId, kim.key, own.id),
        await putTx(s.http, r.c.roomId, kim.key, 'x'.repeat(22), { amount: 7 }), // 대상 존재(6)보다 앞
      ])
        expectApiError(res, 403, 'REQUESTER_INACTIVE');
      await endRoom(s.db, r.c.roomId);
      expectApiError(
        await postTx(s.http, r.c.roomId, kim.key, validBody(r)),
        403,
        'REQUESTER_INACTIVE',
      ); // 종료(8)보다 앞(AC-TXN-009-1)
      expect(await txRows(r.c.roomId)).toBe(rows);
      expect(await revision(s.db, r.c.roomId)).toBe(rev);
      expect(await records(r.c.roomId)).toBe(recs);
    },
  );

  it(
    ac(
      ['AC-PART-002-11', 'AC-SET-008-1', 'AC-SET-005-1'],
      'S1 §4.4, §4.5, S3 §3.1, S4 §3.1',
      '비활성 참여자 키로 방·참여자·거래 목록·손익·정산 조회 200(진행 중 EXPECTED, 종료 뒤 FINAL)',
    ),
    async () => {
      const { r, kim } = await withKim();
      await postTx(s.http, r.c.roomId, r.c.key, validBody(r));
      await setStatus(r, kim.id, 'INACTIVE');
      const during = await reads(r, kim.key);
      for (const res of during) expect(res.status).toBe(200);
      expect(during[0]!.body.me).toMatchObject({ id: kim.id, status: 'INACTIVE' });
      expect(during[4]!.body.settlement.kind).toBe('EXPECTED');
      await endReq(r, r.c.key);
      const after = await reads(r, kim.key);
      for (const res of after) expect(res.status).toBe(200);
      expect(after[4]!.body.settlement.kind).toBe('FINAL');
    },
  );

  it(
    ac(
      ['AC-PART-002-11', 'AC-TXN-007-13'],
      'S2 §3.1, §5.3',
      '비활성화 전에 기록된 요청의 같은 키 재전송은 5a보다 앞서 최초 결과(Idempotent-Replayed). 비활성 중 거부된 키는 기록이 없어 재활성화 뒤 같은 키로 성공(거래 1건)',
    ),
    async () => {
      const { r, kim } = await withKim();
      const h = fresh();
      const first = await postTx(s.http, r.c.roomId, kim.key, validBody(r), h);
      expect(first.status).toBe(201);
      await setStatus(r, kim.id, 'INACTIVE');
      const replay = await postTx(s.http, r.c.roomId, kim.key, validBody(r), h);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      const h2 = fresh();
      expectApiError(
        await postTx(s.http, r.c.roomId, kim.key, validBody(r, { amount: 2 }), h2),
        403,
        'REQUESTER_INACTIVE',
      );
      expect(await records(r.c.roomId, kim.id)).toBe(1);
      await setStatus(r, kim.id, 'ACTIVE');
      const later = await postTx(s.http, r.c.roomId, kim.key, validBody(r, { amount: 2 }), h2);
      expect(later.status).toBe(201);
      expect(later.headers['idempotent-replayed']).toBeUndefined();
      expect(await txRows(r.c.roomId)).toBe(2);
    },
  );

  it(
    ac(
      ['AC-PART-002-12', 'AC-ROOM-005-2'],
      'S2 §3.1',
      '재활성화 뒤 거래 등록·자기 작성 거래 수정·삭제 성공. 복원(같은 키 재입장)한 활성 참여자도 이전 작성 거래를 수정·삭제',
    ),
    async () => {
      const { r, kim } = await withKim();
      const own = (await postTx(s.http, r.c.roomId, kim.key, validBody(r))).body.transaction;
      await setStatus(r, kim.id, 'INACTIVE');
      await setStatus(r, kim.id, 'ACTIVE');
      expect((await join(s.http, r.c.inviteCode, 'x', kim.key)).res.status).toBe(200); // 복원
      expect((await postTx(s.http, r.c.roomId, kim.key, validBody(r))).status).toBe(201);
      expect((await putTx(s.http, r.c.roomId, kim.key, own.id, { amount: 9 })).status).toBe(200);
      expect((await delTx(s.http, r.c.roomId, kim.key, own.id)).status).toBe(200);
    },
  );

  it(
    ac(
      ['AC-TXN-004-3', 'AC-PART-002-7'],
      'S2 §3.1, §3.4 5a·7',
      '비활성 작성자 → 403 REQUESTER_INACTIVE, 제3의 활성 참여자 → 403 NOT_AUTHOR_OR_HOST, 데이터 불변. 방장은 비활성 참여자의 거래와 비활성 당사자 거래를 수정·삭제',
    ),
    async () => {
      const { r, kim } = await withKim();
      const lee = await join(s.http, r.c.inviteCode, 'Lee');
      const t1 = (await postTx(s.http, r.c.roomId, kim.key, validBody(r))).body.transaction;
      const t2 = (await postTx(s.http, r.c.roomId, kim.key, validBody(r, { amount: 3 }))).body
        .transaction;
      await setStatus(r, kim.id, 'INACTIVE');
      await setStatus(r, r.p.a, 'INACTIVE'); // 당사자도 비활성
      const rev = await revision(s.db, r.c.roomId);
      expectApiError(
        await putTx(s.http, r.c.roomId, kim.key, t1.id, { amount: 5 }),
        403,
        'REQUESTER_INACTIVE',
      );
      expectApiError(
        await putTx(s.http, r.c.roomId, lee.key, t1.id, { amount: 5 }),
        403,
        'NOT_AUTHOR_OR_HOST',
      );
      expect(await revision(s.db, r.c.roomId)).toBe(rev);
      const byHost = await putTx(s.http, r.c.roomId, r.c.key, t1.id, { amount: 5 });
      expect(byHost.status).toBe(200);
      expect(byHost.body.transaction).toMatchObject({ amount: 5, authorId: kim.id }); // 작성자는 그대로
      expect((await delTx(s.http, r.c.roomId, r.c.key, t2.id)).status).toBe(200);
    },
  );

  it(
    ac(
      ['AC-PART-002-3'],
      'S2 §6.1',
      '비활성 참여자를 당사자로 지정한 새 거래 → 409 PARTICIPANT_INACTIVE(기록 없음)',
    ),
    async () => {
      const { r, kim } = await withKim();
      await setStatus(r, r.p.b, 'INACTIVE');
      const h = fresh();
      const res = await postTx(s.http, r.c.roomId, kim.key, validBody(r), h);
      expectApiError(res, 409, 'PARTICIPANT_INACTIVE', [{ field: 'payeeId' }]);
      expect(await records(r.c.roomId)).toBe(0);
    },
  );

  it(
    ac(
      ['AC-TXN-009-1', 'AC-SET-001-3'],
      'S2 §6.5',
      '종료 뒤 새 키: 방장·작성자 GAME_ENDED, 권한 없는 활성 참여자의 수정·삭제 NOT_AUTHOR_OR_HOST, 비활성 참여자 REQUESTER_INACTIVE, 참여자 등록·상태 변경 GAME_ENDED. 거래 불변',
    ),
    async () => {
      const { r, kim } = await withKim();
      const lee = await join(s.http, r.c.inviteCode, 'Lee');
      const park = await join(s.http, r.c.inviteCode, 'Park');
      const t = (await postTx(s.http, r.c.roomId, kim.key, validBody(r))).body.transaction;
      await setStatus(r, park.res.body.me.id, 'INACTIVE');
      expect((await endReq(r, r.c.key)).status).toBe(200);
      const rows = await txRows(r.c.roomId);
      expectApiError(await postTx(s.http, r.c.roomId, r.c.key, validBody(r)), 409, 'GAME_ENDED');
      expectApiError(await postTx(s.http, r.c.roomId, kim.key, validBody(r)), 409, 'GAME_ENDED');
      expectApiError(
        await putTx(s.http, r.c.roomId, kim.key, t.id, { amount: 2 }),
        409,
        'GAME_ENDED',
      );
      expectApiError(await delTx(s.http, r.c.roomId, lee.key, t.id), 403, 'NOT_AUTHOR_OR_HOST');
      expectApiError(
        await postTx(s.http, r.c.roomId, park.key, validBody(r)),
        403,
        'REQUESTER_INACTIVE',
      );
      expectApiError(
        await s.http
          .post(`/rooms/${r.c.roomId}/participants`)
          .set(auth(r.c.key))
          .send({ nickname: 'New' }),
        409,
        'GAME_ENDED',
      );
      expectApiError(await setStatus(r, r.p.a, 'INACTIVE'), 409, 'GAME_ENDED');
      expect(await txRows(r.c.roomId)).toBe(rows);
    },
  );
});

describe('멱등 범위 (방, 참여자) (S2 §5.1, D-1)', () => {
  it(
    ac(['AC-TXN-007-7'], 'S2 §5.1', '같은 키 값을 다른 참여자·다른 방이 쓰면 별개의 요청이다'),
    async () => {
      const { r, kim } = await withKim();
      const other = await setupRoom(s.http);
      const h = fresh();
      const a = await postTx(s.http, r.c.roomId, kim.key, validBody(r), h);
      const b = await postTx(s.http, r.c.roomId, r.c.key, validBody(r, { amount: 2 }), h); // 다른 참여자, 다른 내용
      const c = await postTx(s.http, other.c.roomId, other.c.key, validBody(other), h); // 다른 방
      expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
      expect(b.headers['idempotent-replayed']).toBeUndefined();
      expect(new Set([a.body.transaction.id, b.body.transaction.id]).size).toBe(2);
      const keys = await s.db.query<{ participantId: string }>(
        `SELECT "participantId" FROM "IdempotencyRecord" WHERE "key"=$1 AND "roomId"=$2 ORDER BY "createdAt"`,
        [h.key, r.c.roomId],
      );
      expect(keys.map((k) => k.participantId)).toEqual([kim.id, r.c.hostId]); // 기록 단위는 참여자
    },
  );
});

describe('이어받기와 거래 (S1 §6.1, S2 §3.1, §5.1)', () => {
  it(
    ac(
      ['AC-ROOM-009-5'],
      'S2 §3.4 2',
      '승인 뒤 이전 키의 거래 생성·수정·삭제와 같은 키 재전송은 모두 401 IDENTITY_REVOKED(재전송 판정보다 앞), 데이터 불변',
    ),
    async () => {
      const { r, kim } = await withKim();
      const h = fresh();
      const t = (await postTx(s.http, r.c.roomId, kim.key, validBody(r), h)).body.transaction;
      await takeOver(r, 'Kim');
      const rows = await txRows(r.c.roomId);
      const rev = await revision(s.db, r.c.roomId);
      for (const res of [
        await postTx(s.http, r.c.roomId, kim.key, validBody(r), h), // 같은 키·같은 내용 재전송
        await postTx(s.http, r.c.roomId, kim.key, validBody(r)),
        await putTx(s.http, r.c.roomId, kim.key, t.id, { amount: 3 }),
        await delTx(s.http, r.c.roomId, kim.key, t.id),
        await endReq(r, kim.key),
        ...(await reads(r, kim.key)),
      ])
        expectApiError(res, 401, 'IDENTITY_REVOKED');
      expect(await txRows(r.c.roomId)).toBe(rows);
      expect(await revision(s.db, r.c.roomId)).toBe(rev);
    },
  );

  it(
    ac(
      ['AC-TXN-004-1', 'AC-ROOM-009-6'],
      'S2 §3.1, §5.1',
      '이어받은 새 키로 그 참여자가 작성한 거래를 수정·삭제(작성자 ID 불변). 이전 키의 멱등 키 값을 새 키가 쓰면 같은 참여자 범위의 재전송이다(D-1). 손익·정산 불변',
    ),
    async () => {
      const { r, kim } = await withKim();
      const h = fresh();
      const t = (await postTx(s.http, r.c.roomId, kim.key, validBody(r), h)).body.transaction;
      const balances = (await s.http.get(`/rooms/${r.c.roomId}/balances`).set(auth(r.c.key))).body;
      const settle = (await s.http.get(`/rooms/${r.c.roomId}/settlement`).set(auth(r.c.key))).body;
      const fresher = await takeOver(r, 'Kim');
      expect((await s.http.get(`/rooms/${r.c.roomId}/balances`).set(auth(r.c.key))).body).toEqual(
        balances,
      );
      expect((await s.http.get(`/rooms/${r.c.roomId}/settlement`).set(auth(r.c.key))).body).toEqual(
        settle,
      );
      // 같은 참여자 범위: 새 키가 같은 키 값·같은 내용을 보내면 저장된 결과를 받는다(Spec이 정한 귀결)
      const replay = await postTx(s.http, r.c.roomId, fresher, validBody(r), h);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.transaction.id).toBe(t.id);
      const upd = await putTx(s.http, r.c.roomId, fresher, t.id, { amount: 77 });
      expect(upd.status).toBe(200);
      expect(upd.body.transaction).toMatchObject({ amount: 77, authorId: kim.id });
      expect((await delTx(s.http, r.c.roomId, fresher, t.id)).status).toBe(200);
      const [row] = await s.db.query<{ deletedById: string }>(
        `SELECT "deletedById" FROM "Transaction" WHERE "id"=$1`,
        [t.id],
      );
      expect(row!.deletedById).toBe(kim.id); // 삭제자도 참여자 ID
      expect(JSON.stringify(upd.body)).not.toContain(hashIdentityKey(fresher));
    },
  );

  it(
    ac(
      ['AC-ROOM-009-10', 'AC-SET-005-1'],
      'S4 §3.1',
      '종료 뒤 이어받기로 연결된 참여자가 FINAL 정산을 조회한다. 대기 키는 404, 접근 상실 키는 401',
    ),
    async () => {
      const { r, kim } = await withKim();
      await postTx(s.http, r.c.roomId, r.c.key, validBody(r));
      expect((await endReq(r, r.c.key)).status).toBe(200);
      const before = (await s.http.get(`/rooms/${r.c.roomId}/settlement`).set(auth(r.c.key))).body;
      const waiting = newKey();
      await s.http
        .post(`/invites/${r.c.inviteCode}/claims`)
        .set(auth(waiting))
        .send({ nickname: 'Aa' });
      const fresher = await takeOver(r, 'Kim');
      const res = await s.http.get(`/rooms/${r.c.roomId}/settlement`).set(auth(fresher));
      expect(res.status).toBe(200);
      expect(res.body).toEqual(before);
      expect(res.body.settlement.kind).toBe('FINAL');
      expectApiError(
        await s.http.get(`/rooms/${r.c.roomId}/settlement`).set(auth(waiting)),
        404,
        'ROOM_NOT_FOUND',
      );
      expectApiError(
        await s.http.get(`/rooms/${r.c.roomId}/settlement`).set(auth(kim.key)),
        401,
        'IDENTITY_REVOKED',
      );
    },
  );

  it('종료의 요청자도 잠금 안에서 다시 판정한다: 비방장 참여자는 HOST_ONLY(기록 없음), 비활성 참여자도 HOST_ONLY', async () => {
    const { r, kim } = await withKim();
    expectApiError(await endReq(r, kim.key), 403, 'HOST_ONLY');
    await setStatus(r, kim.id, 'INACTIVE');
    expectApiError(await endReq(r, kim.key), 403, 'HOST_ONLY');
    expect(await records(r.c.roomId)).toBe(0);
  });
});
