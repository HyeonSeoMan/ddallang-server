import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashIdentityKey } from '../../src/common/auth/identity-key.js';
import { ROOM_EVENTS_CHANNEL } from '../../src/common/db/database.service.js';
import { ac, expectApiError } from '../helpers/contract.js';
import { baseDatabaseUrl } from '../helpers/isolated-db.js';
import { parseNotification, sleep } from '../helpers/util.js';
import { openStream } from '../s5/sse-client.js';
import {
  addParticipant,
  auth,
  bootS1,
  count,
  createRoom,
  endRoom,
  join,
  newKey,
  revision,
  type Created,
  type S1Env,
} from './s1-helpers.js';

let s: S1Env;
let listener: pg.Client;
const notices: Record<string, unknown>[] = [];
beforeAll(async () => {
  s = await bootS1();
  listener = new pg.Client({ connectionString: baseDatabaseUrl() });
  await listener.connect();
  await listener.query(`LISTEN ${ROOM_EVENTS_CHANNEL}`);
  listener.on('notification', (m) => {
    const e = parseNotification(m.payload);
    if (e) notices.push(e);
  });
});
afterAll(async () => {
  await listener?.end();
  await s?.close();
});
const noticesOf = (roomId: string) => notices.filter((e) => e.roomId === roomId);

// ---- 요청자 쪽(/invites/{code}/claims) ----
const requestClaim = (c: Created, key: string, body: unknown) =>
  s.http
    .post(`/invites/${c.inviteCode}/claims`)
    .set(auth(key))
    .send(body as object);
const mine = (c: Created, key: string, id: string) =>
  s.http.get(`/invites/${c.inviteCode}/claims/${id}`).set(auth(key));
const cancel = (c: Created, key: string, id: string) =>
  s.http.post(`/invites/${c.inviteCode}/claims/${id}/cancel`).set(auth(key));
// ---- 방장 쪽(/rooms/{roomId}/claims) ----
const pendingList = (c: Created, key = c.key) =>
  s.http.get(`/rooms/${c.roomId}/claims`).set(auth(key));
const one = (c: Created, id: string, key = c.key) =>
  s.http.get(`/rooms/${c.roomId}/claims/${id}`).set(auth(key));
const approve = (c: Created, id: string, key = c.key) =>
  s.http.post(`/rooms/${c.roomId}/claims/${id}/approve`).set(auth(key));
const reject = (c: Created, id: string, key = c.key) =>
  s.http.post(`/rooms/${c.roomId}/claims/${id}/reject`).set(auth(key));
const invite = (c: Created, key?: string) => {
  const r = s.http.get(`/invites/${c.inviteCode}`);
  return key ? r.set(auth(key)) : r;
};
const roomAs = (c: Created, key: string) => s.http.get(`/rooms/${c.roomId}`).set(auth(key));

/** 방장, 입장한 Kim(키 있음), 직접 추가한 Direct(키 없음) */
async function setup() {
  const c = await createRoom(s.http);
  const kim = await join(s.http, c.inviteCode, 'Kim');
  const direct = (await addParticipant(s.http, c, 'Direct')).body.participant as { id: string };
  return { c, kim: { key: kim.key, id: kim.res.body.me.id as string }, direct };
}
const linkedHash = async (participantId: string) =>
  (
    await s.db.query<{ h: string | null }>(
      `SELECT "identityKeyHash" AS h FROM "Participant" WHERE "id"=$1`,
      [participantId],
    )
  )[0]!.h;

const MY_CLAIM_KEYS = ['createdAt', 'id', 'nickname', 'rejectReason', 'resolvedAt', 'status'];
const CLAIM_KEYS = [...MY_CLAIM_KEYS, 'participantId', 'resolvedById'].sort();

describe('POST /invites/{inviteCode}/claims (S1 §4.9)', () => {
  it(
    ac(
      ['AC-ROOM-009-1', 'AC-ROOM-004-5'],
      'S1 §4.2, §4.9',
      '신원 없는 키의 요청 → 201 PENDING(MyClaim: 참여자 ID·처리자 ID·키 없음). 대기 키는 방·참여자 조회 404, 초대 조회 PENDING·후보 빈 배열. 참여자·연결은 생기지 않는다',
    ),
    async () => {
      const { c, direct } = await setup();
      const key = newKey();
      const before = await count(s.db, 'Participant', c.roomId);
      const res = await requestClaim(c, key, { nickname: 'direct' }); // 비교 키(대소문자 무시)로 찾는다
      expect(res.status).toBe(201);
      expect(Object.keys(res.body.claim).sort()).toEqual(MY_CLAIM_KEYS);
      expect(res.body.claim).toMatchObject({
        nickname: 'Direct',
        status: 'PENDING',
        rejectReason: null,
        resolvedAt: null,
      });
      const text = JSON.stringify(res.body);
      for (const secret of [direct.id, c.hostId, key, hashIdentityKey(key), c.roomId])
        expect(text).not.toContain(secret);
      // 대기 키는 방 비참여자다
      expectApiError(await roomAs(c, key), 404, 'ROOM_NOT_FOUND');
      expectApiError(
        await s.http.get(`/rooms/${c.roomId}/participants`).set(auth(key)),
        404,
        'ROOM_NOT_FOUND',
      );
      expect((await invite(c, key)).body).toMatchObject({
        identity: 'PENDING',
        claim: { id: res.body.claim.id, status: 'PENDING' },
        claimableNicknames: [],
      });
      expect(await count(s.db, 'Participant', c.roomId)).toBe(before);
      expect(await linkedHash(direct.id)).toBeNull();
      // 서버는 요청 키를 해시로 따로 보관한다(AC-ROOM-004-5)
      const [row] = await s.db.query<{ participantId: string; requesterKeyHash: string }>(
        `SELECT "participantId","requesterKeyHash" FROM "ClaimRequest" WHERE "id"=$1`,
        [res.body.claim.id],
      );
      expect(row).toEqual({ participantId: direct.id, requesterKeyHash: hashIdentityKey(key) });
    },
  );

  it(
    ac(
      ['AC-ROOM-009-2', 'AC-ROOM-009-13'],
      'S1 §4.9 1',
      '연결된 키(활성·비활성·방장)의 요청 → 409 ALREADY_PARTICIPANT, 데이터 불변',
    ),
    async () => {
      const { c, kim } = await setup();
      const inactive = await join(s.http, c.inviteCode, 'Lee');
      await s.http
        .patch(`/rooms/${c.roomId}/participants/${inactive.res.body.me.id}`)
        .set(auth(c.key))
        .send({ status: 'INACTIVE' });
      const rev = await revision(s.db, c.roomId);
      for (const key of [kim.key, inactive.key, c.key])
        expectApiError(
          await requestClaim(c, key, { nickname: 'Direct' }),
          409,
          'ALREADY_PARTICIPANT',
        );
      expect(await count(s.db, 'ClaimRequest', c.roomId)).toBe(0);
      expect(await revision(s.db, c.roomId)).toBe(rev);
    },
  );

  it(
    ac(
      ['AC-ROOM-009-3', 'AC-ROOM-005-4', 'AC-ROOM-009-13'],
      'S1 §4.9 3, S1-C7',
      '방장 닉네임·없는 닉네임 → 같은 404 PARTICIPANT_NOT_FOUND, 후보 목록에 방장 없음',
    ),
    async () => {
      const c = await createRoom(s.http, { nickname: 'Boss' });
      await addParticipant(s.http, c, 'Direct');
      const key = newKey(); // 방장 키를 잃은 이전 방장의 새 키
      expect((await invite(c, key)).body.claimableNicknames).toEqual(['Direct']);
      const host = await requestClaim(c, key, { nickname: 'boss' });
      const none = await requestClaim(c, key, { nickname: 'Nobody' });
      expectApiError(host, 404, 'PARTICIPANT_NOT_FOUND');
      expect(host.body).toEqual(none.body);
      expect(await count(s.db, 'ClaimRequest', c.roomId)).toBe(0);
      // 새로 입장해도 방장이 아니다
      expect((await join(s.http, c.inviteCode, 'Boss2', key)).res.body.me.isHost).toBe(false);
    },
  );

  it('검사 순서: 401 → 404 초대 → 신원 상태(3) → 422(7, 없음·문자열 아님만) → 404 대상(6)', async () => {
    const { c } = await setup();
    expectApiError(
      await s.http.post(`/invites/nope/claims`).send({ nickname: 'x' }),
      401,
      'UNAUTHENTICATED',
    );
    expectApiError(
      await s.http.post(`/invites/nope/claims`).set(auth(newKey())).send({}),
      404,
      'INVITE_NOT_FOUND',
    );
    expectApiError(await requestClaim(c, c.key, {}), 409, 'ALREADY_PARTICIPANT'); // 3번이 7번보다 앞
    for (const nickname of [undefined, null, ''])
      expectApiError(await requestClaim(c, newKey(), { nickname }), 422, 'VALIDATION_FAILED', [
        { field: 'nickname', code: 'REQUIRED' },
      ]);
    expectApiError(await requestClaim(c, newKey(), { nickname: 7 }), 422, 'VALIDATION_FAILED', [
      { field: 'nickname', code: 'INVALID_TYPE' },
    ]);
    // 문자 규칙은 보지 않는다: 일치하는 참여자가 없으면 404
    expectApiError(
      await requestClaim(c, newKey(), { nickname: ' bad!! ' }),
      404,
      'PARTICIPANT_NOT_FOUND',
    );
    // 분해형 한글은 NFC로 맞춘 뒤 찾는다
    const h = await addParticipant(s.http, c, '한글');
    const nfd = await requestClaim(c, newKey(), { nickname: '한글'.normalize('NFD') });
    expect(nfd.status).toBe(201);
    expect(nfd.body.claim.nickname).toBe('한글');
    void h;
  });

  it(
    ac(
      ['AC-ROOM-002-5', 'AC-ROOM-008-11', 'AC-ROOM-009-12'],
      'S1 §4.9 4, §6.4',
      '종료된 방·10명 방에서도 요청 201(한도·게임 상태 무관), 대상의 활성 상태와 무관. 만료 필드가 없다',
    ),
    async () => {
      const { c, kim, direct } = await setup();
      for (let i = 4; i <= 10; i++) await addParticipant(s.http, c, `p${i}`);
      expect(await count(s.db, 'Participant', c.roomId)).toBe(10);
      await s.http
        .patch(`/rooms/${c.roomId}/participants/${direct.id}`)
        .set(auth(c.key))
        .send({ status: 'INACTIVE' });
      await endRoom(s.db, c.roomId);
      const a = await requestClaim(c, newKey(), { nickname: 'Direct' });
      const b = await requestClaim(c, newKey(), { nickname: 'Kim' }); // 신원이 연결된 대상도 된다(P-1)
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(await count(s.db, 'Participant', c.roomId)).toBe(10); // 요청은 세지 않는다
      const cols = await s.db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='ClaimRequest'`,
        [s.db.schema],
      );
      expect(cols.map((x) => x.column_name)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/expire/i)]),
      );
      void kim;
    },
  );

  it(
    ac(
      ['AC-ROOM-009-9'],
      'S1 §4.3, §4.9, §4.11',
      '대기 키의 두 번째 요청·입장 → 409 CLAIM_PENDING, 취소 뒤 입장 201. 다른 키로 취소 → 404 CLAIM_NOT_FOUND',
    ),
    async () => {
      const { c } = await setup();
      const key = newKey();
      const first = (await requestClaim(c, key, { nickname: 'Direct' })).body.claim;
      expectApiError(await requestClaim(c, key, { nickname: 'Kim' }), 409, 'CLAIM_PENDING');
      expectApiError((await join(s.http, c.inviteCode, 'Fresh', key)).res, 409, 'CLAIM_PENDING');
      expectApiError(await cancel(c, newKey(), first.id), 404, 'CLAIM_NOT_FOUND');
      expectApiError(await cancel(c, c.key, first.id), 404, 'CLAIM_NOT_FOUND'); // 방장 키도 남의 요청은 취소하지 못한다
      expect((await mine(c, key, first.id)).body.claim.status).toBe('PENDING');
      const canceled = await cancel(c, key, first.id);
      expect(canceled.status).toBe(200);
      expect(canceled.body.claim).toMatchObject({ id: first.id, status: 'CANCELED' });
      expect(canceled.body.claim.resolvedAt).toEqual(expect.any(String));
      expect((await join(s.http, c.inviteCode, 'Fresh', key)).res.status).toBe(201);
    },
  );
});

describe('GET /invites/{inviteCode}/claims/{claimId} (S1 §4.10)', () => {
  it('그 요청을 만든 키만 조회한다(다른 키·다른 방·없는 ID는 같은 404). 승인되어 연결된 뒤에도 조회된다', async () => {
    const { c } = await setup();
    const other = await createRoom(s.http);
    const key = newKey();
    const claim = (await requestClaim(c, key, { nickname: 'Direct' })).body.claim;
    const ok = await mine(c, key, claim.id);
    expect(ok.status).toBe(200);
    expect(ok.body.claim).toEqual(claim);
    const wrongKey = await mine(c, newKey(), claim.id);
    const missing = await mine(c, key, 'nope');
    expectApiError(wrongKey, 404, 'CLAIM_NOT_FOUND');
    expect(wrongKey.body).toEqual(missing.body);
    expectApiError(await mine(other, key, claim.id), 404, 'CLAIM_NOT_FOUND'); // 다른 방의 초대 코드
    expectApiError(
      await s.http.get(`/invites/nope/claims/${claim.id}`).set(auth(key)),
      404,
      'INVITE_NOT_FOUND',
    );
    expectApiError(
      await s.http.get(`/invites/${c.inviteCode}/claims/${claim.id}`),
      401,
      'UNAUTHENTICATED',
    );
    expect((await approve(c, claim.id)).status).toBe(200);
    const after = await mine(c, key, claim.id);
    expect(after.body.claim).toMatchObject({ status: 'APPROVED', rejectReason: null });
    expect(Object.keys(after.body.claim).sort()).toEqual(MY_CLAIM_KEYS); // 처리자 ID 없음
  });
});

describe('방장 쪽 목록·단건 (S1 §4.12, §4.15)', () => {
  it(
    ac(
      ['AC-ROOM-009-4', 'AC-ROOM-004-5'],
      'S1 §4.12',
      '방장 대기 목록: PENDING만 요청 순서대로, 대상 participantId·닉네임을 담고 요청 키는 없다',
    ),
    async () => {
      const { c, kim, direct } = await setup();
      const k1 = newKey();
      const k2 = newKey();
      const k3 = newKey();
      const a = (await requestClaim(c, k1, { nickname: 'Direct' })).body.claim;
      const b = (await requestClaim(c, k2, { nickname: 'Kim' })).body.claim;
      const x = (await requestClaim(c, k3, { nickname: 'Direct' })).body.claim;
      await cancel(c, k3, x.id);
      const res = await pendingList(c);
      expect(res.status).toBe(200);
      expect(res.body.claims.map((v: { id: string }) => v.id)).toEqual([a.id, b.id]);
      expect(res.body.claims[0]).toEqual({
        ...a,
        participantId: direct.id,
        resolvedById: null,
      });
      expect(res.body.claims[1]).toMatchObject({ participantId: kim.id, nickname: 'Kim' });
      for (const v of res.body.claims) expect(Object.keys(v).sort()).toEqual(CLAIM_KEYS);
      for (const k of [k1, k2, hashIdentityKey(k1), hashIdentityKey(k2)])
        expect(JSON.stringify(res.body)).not.toContain(k);
    },
  );

  it('단건 조회는 끝난 요청도 돌려주고 다른 방의 요청 ID는 404 CLAIM_NOT_FOUND다', async () => {
    const { c } = await setup();
    const other = await setup();
    const key = newKey();
    const claim = (await requestClaim(c, key, { nickname: 'Direct' })).body.claim;
    await cancel(c, key, claim.id);
    const res = await one(c, claim.id);
    expect(res.body.claim).toMatchObject({ id: claim.id, status: 'CANCELED', resolvedById: null }); // 취소는 처리자 없음
    expectApiError(await one(other.c, claim.id), 404, 'CLAIM_NOT_FOUND');
    expectApiError(await approve(other.c, claim.id), 404, 'CLAIM_NOT_FOUND');
    expectApiError(await reject(other.c, claim.id), 404, 'CLAIM_NOT_FOUND');
  });

  it(
    ac(
      ['AC-ROOM-009-11', 'AC-ROOM-007-2', 'AC-ROOM-009-13'],
      'S1 §4.12~§4.15, §5.1',
      '비방장 참여자의 목록·단건·승인·거절 → 403 HOST_ONLY(대상이 없어도), 요청 상태 불변. 비참여자는 404',
    ),
    async () => {
      const { c, kim } = await setup();
      const key = newKey();
      const claim = (await requestClaim(c, key, { nickname: 'Direct' })).body.claim;
      const rev = await revision(s.db, c.roomId);
      for (const res of [
        await pendingList(c, kim.key),
        await one(c, claim.id, kim.key),
        await approve(c, claim.id, kim.key),
        await reject(c, claim.id, kim.key),
        await approve(c, 'nope', kim.key),
      ])
        expectApiError(res, 403, 'HOST_ONLY');
      for (const res of [
        await pendingList(c, key), // 대기 키는 비참여자
        await approve(c, claim.id, newKey()),
      ])
        expectApiError(res, 404, 'ROOM_NOT_FOUND');
      expect((await one(c, claim.id)).body.claim.status).toBe('PENDING');
      expect(await revision(s.db, c.roomId)).toBe(rev);
    },
  );
});

describe('POST /rooms/{roomId}/claims/{claimId}/approve (S1 §4.13)', () => {
  it(
    ac(
      [
        'AC-ROOM-009-5',
        'AC-ROOM-004-3',
        'AC-ROOM-005-8',
        'AC-ROOM-004-1',
        'AC-ROOM-004-5',
        'AC-ROOM-007-1',
      ],
      'S1 §4.13 4~6, §6.1',
      '승인 → 요청 키로 방 조회 200(me.id = 대상, isHost false), 이전 키는 방 조회·참여자·입장 401 IDENTITY_REVOKED·초대 조회 REVOKED, 대상의 연결 키는 하나, 참여자 수 불변, resolvedById = 방장',
    ),
    async () => {
      const { c, kim } = await setup();
      const fresh = newKey();
      const claim = (await requestClaim(c, fresh, { nickname: 'Kim' })).body.claim;
      const before = await count(s.db, 'Participant', c.roomId);
      const res = await approve(c, claim.id);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.claim).sort()).toEqual(CLAIM_KEYS);
      expect(res.body.claim).toMatchObject({
        id: claim.id,
        participantId: kim.id,
        status: 'APPROVED',
        rejectReason: null,
        resolvedById: c.hostId,
      });
      expect(res.body.claim.resolvedAt).toEqual(expect.any(String));
      expect(res.body.participant).toMatchObject({ id: kim.id, nickname: 'Kim', isHost: false });
      const me = await roomAs(c, fresh);
      expect(me.status).toBe(200);
      expect(me.body.me).toMatchObject({ id: kim.id, isHost: false });
      // 이전 키는 접근을 잃는다
      expectApiError(await roomAs(c, kim.key), 401, 'IDENTITY_REVOKED');
      expectApiError(
        await s.http.get(`/rooms/${c.roomId}/participants`).set(auth(kim.key)),
        401,
        'IDENTITY_REVOKED',
      );
      expectApiError(
        (await join(s.http, c.inviteCode, 'Again', kim.key)).res,
        401,
        'IDENTITY_REVOKED',
      );
      expect((await invite(c, kim.key)).body.identity).toBe('REVOKED');
      expect(await linkedHash(kim.id)).toBe(hashIdentityKey(fresh)); // 대상에 연결된 키는 하나
      expect(await count(s.db, 'Participant', c.roomId)).toBe(before);
      expect((await one(c, claim.id)).body.claim.resolvedById).toBe(c.hostId);
      // 이전 브라우저는 새 키로 다시 입장하거나 요청할 수 있다
      expect((await join(s.http, c.inviteCode, 'KimNew', newKey())).res.status).toBe(201);
    },
  );

  it(
    ac(
      ['AC-ROOM-009-6', 'AC-ROOM-006-8', 'AC-PART-001-4'],
      'S1 §2.3 I8, §4.13',
      '승인 전후 대상의 닉네임·상태·order·isHost 동일(비활성 대상도 승인되며 비활성 그대로), 신원 없던 대상도 연결된다',
    ),
    async () => {
      const { c, direct } = await setup();
      await s.http
        .patch(`/rooms/${c.roomId}/participants/${direct.id}`)
        .set(auth(c.key))
        .send({ status: 'INACTIVE' });
      const listBefore = (await s.http.get(`/rooms/${c.roomId}/participants`).set(auth(c.key))).body
        .participants;
      const key = newKey();
      const claim = (await requestClaim(c, key, { nickname: 'Direct' })).body.claim;
      const res = await approve(c, claim.id);
      expect(res.status).toBe(200);
      const listAfter = (await s.http.get(`/rooms/${c.roomId}/participants`).set(auth(c.key))).body
        .participants;
      expect(listAfter).toEqual(listBefore);
      expect(res.body.participant).toEqual(
        listBefore.find((p: { id: string }) => p.id === direct.id),
      );
      expect((await roomAs(c, key)).body.me).toMatchObject({ id: direct.id, status: 'INACTIVE' });
      expect(
        await s.db.query(`SELECT 1 FROM "RevokedIdentity" WHERE "participantId"=$1`, [direct.id]),
      ).toHaveLength(0); // 이전 키가 없었으면 접근 상실 기록도 없다
    },
  );

  it(
    ac(
      ['AC-ROOM-009-8', 'AC-ROOM-009-12', 'AC-ROOM-009-13'],
      'S1 §4.13 7, §7 5',
      '같은 대상 요청 2건 중 1건 승인 → 다른 건 REJECTED/TARGET_CLAIMED(같은 resolvedById), 그 건 승인·거절·취소 → 409 CLAIM_ALREADY_RESOLVED, 다른 대상의 요청은 그대로',
    ),
    async () => {
      const { c, direct } = await setup();
      const [k1, k2, k3] = [newKey(), newKey(), newKey()];
      const a = (await requestClaim(c, k1, { nickname: 'Direct' })).body.claim;
      const b = (await requestClaim(c, k2, { nickname: 'Direct' })).body.claim;
      const other = (await requestClaim(c, k3, { nickname: 'Kim' })).body.claim;
      expect((await approve(c, a.id)).status).toBe(200);
      const lost = (await one(c, b.id)).body.claim;
      expect(lost).toMatchObject({
        status: 'REJECTED',
        rejectReason: 'TARGET_CLAIMED',
        resolvedById: c.hostId,
        participantId: direct.id,
      });
      expect((await mine(c, k2, b.id)).body.claim.rejectReason).toBe('TARGET_CLAIMED');
      expectApiError(await approve(c, b.id), 409, 'CLAIM_ALREADY_RESOLVED');
      expectApiError(await reject(c, b.id), 409, 'CLAIM_ALREADY_RESOLVED');
      expectApiError(await cancel(c, k2, b.id), 409, 'CLAIM_ALREADY_RESOLVED');
      expectApiError(await approve(c, a.id), 409, 'CLAIM_ALREADY_RESOLVED'); // 승인된 요청도 끝났다
      expect((await one(c, other.id)).body.claim.status).toBe('PENDING');
      expect(await linkedHash(direct.id)).toBe(hashIdentityKey(k1));
      // 거절된 키는 신원 없음으로 돌아가 다시 요청할 수 있다
      expect((await invite(c, k2)).body.identity).toBe('NONE');
    },
  );

  it(
    ac(
      ['AC-ROOM-009-14'],
      'S1 §4.13 3, §2.3 I9 (픽스처로 재현)',
      '요청 키가 이미 다른 참여자에 연결된 상태에서 승인 → 409 CLAIM_REQUESTER_LINKED, 요청 REJECTED/REQUESTER_LINKED(커밋됨), 대상 연결 불변, revision +1·claim.resolved 1건',
    ),
    async () => {
      const { c, kim, direct } = await setup();
      const key = newKey();
      const claim = (await requestClaim(c, key, { nickname: 'Direct' })).body.claim;
      // 정상 흐름에서는 대기 키의 입장이 CLAIM_PENDING으로 막히므로 경합·우회 결과를 픽스처로 만든다
      const linkedTo = (await addParticipant(s.http, c, 'Other')).body.participant.id as string;
      await s.db.query(`UPDATE "Participant" SET "identityKeyHash"=$1 WHERE "id"=$2`, [
        hashIdentityKey(key),
        linkedTo,
      ]);
      const rev = await revision(s.db, c.roomId);
      const from = noticesOf(c.roomId).length;
      const res = await approve(c, claim.id);
      expectApiError(res, 409, 'CLAIM_REQUESTER_LINKED');
      expect((await one(c, claim.id)).body.claim).toMatchObject({
        status: 'REJECTED',
        rejectReason: 'REQUESTER_LINKED',
        resolvedById: c.hostId,
      });
      expect(await linkedHash(direct.id)).toBeNull(); // 대상 연결 불변
      expect(await linkedHash(linkedTo)).toBe(hashIdentityKey(key));
      expect(await revision(s.db, c.roomId)).toBe(rev + 1);
      await sleep(300);
      const evs = noticesOf(c.roomId).slice(from);
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({
        event: 'claim.resolved',
        claimId: claim.id,
        revision: rev + 1,
      });
      expect(evs[0]).not.toHaveProperty('revokedParticipantId');
      void kim;
    },
  );

  it(
    ac(
      ['AC-ROOM-009-10', 'AC-ROOM-008-11'],
      'S1 §5.3',
      'ENDED 방·10명 방에서 요청·취소·승인·거절 모두 성공, 승인된 참여자는 종료 방을 조회한다',
    ),
    async () => {
      const { c } = await setup();
      for (let i = 4; i <= 10; i++) await addParticipant(s.http, c, `p${i}`);
      await endRoom(s.db, c.roomId);
      const [k1, k2, k3] = [newKey(), newKey(), newKey()];
      const a = (await requestClaim(c, k1, { nickname: 'Direct' })).body.claim;
      const b = (await requestClaim(c, k2, { nickname: 'p4' })).body.claim;
      const x = (await requestClaim(c, k3, { nickname: 'p5' })).body.claim;
      expect((await cancel(c, k3, x.id)).status).toBe(200);
      expect((await reject(c, b.id)).status).toBe(200);
      expect((await approve(c, a.id)).status).toBe(200);
      expect(await count(s.db, 'Participant', c.roomId)).toBe(10);
      const room = await roomAs(c, k1);
      expect(room.status).toBe(200);
      expect(room.body.room.status).toBe('ENDED');
    },
  );
});

describe('POST /rooms/{roomId}/claims/{claimId}/reject (S1 §4.14)', () => {
  it(
    ac(
      ['AC-ROOM-009-7'],
      'S1 §4.14, §4.2',
      '거절 → REJECTED/HOST_REJECTED, 요청 키 상태 NONE(초대 조회 claim에 결과), 같은 키로 재요청 201, 입장 201',
    ),
    async () => {
      const { c, direct } = await setup();
      const key = newKey();
      const claim = (await requestClaim(c, key, { nickname: 'Direct' })).body.claim;
      const res = await reject(c, claim.id);
      expect(res.status).toBe(200);
      expect(res.body.claim).toMatchObject({
        id: claim.id,
        status: 'REJECTED',
        rejectReason: 'HOST_REJECTED',
        resolvedById: c.hostId,
        participantId: direct.id,
      });
      expect(await linkedHash(direct.id)).toBeNull();
      const inv = await invite(c, key);
      expect(inv.body).toMatchObject({
        identity: 'NONE',
        claim: { id: claim.id, status: 'REJECTED', rejectReason: 'HOST_REJECTED' },
        claimableNicknames: ['Kim', 'Direct'],
      });
      const again = await requestClaim(c, key, { nickname: 'Direct' });
      expect(again.status).toBe(201);
      expect((await invite(c, key)).body.claim.id).toBe(again.body.claim.id); // 가장 최근 요청
      await cancel(c, key, again.body.claim.id);
      expect((await join(s.http, c.inviteCode, 'Fresh', key)).res.status).toBe(201);
    },
  );
});

describe('이어받기 이벤트 (BE-M4: claim.* 등록·직렬화·발행, S5 §4.2, PD-26)', () => {
  it('요청·취소·승인·거절은 각각 revision 하나와 claim.* 이벤트 하나. 거부는 소비하지 않는다. 이전 키가 있던 승인만 내부 필드 revokedParticipantId', async () => {
    const { c, kim, direct } = await setup();
    const rev0 = await revision(s.db, c.roomId);
    const from = noticesOf(c.roomId).length;
    const [k1, k2, k3] = [newKey(), newKey(), newKey()];
    const a = (await requestClaim(c, k1, { nickname: 'Direct' })).body.claim;
    await requestClaim(c, k1, { nickname: 'Kim' }); // 409 CLAIM_PENDING
    const b = (await requestClaim(c, k2, { nickname: 'Kim' })).body.claim;
    const x = (await requestClaim(c, k3, { nickname: 'Kim' })).body.claim;
    await cancel(c, k3, x.id);
    await cancel(c, k3, x.id); // 409
    await reject(c, a.id);
    await approve(c, b.id); // Kim의 이전 키를 끊는다
    await approve(c, b.id); // 409
    await sleep(300);
    expect(await revision(s.db, c.roomId)).toBe(rev0 + 6);
    const evs = noticesOf(c.roomId).slice(from);
    expect(evs.map((e) => [e.event, e.claimId, e.revision])).toEqual([
      ['claim.created', a.id, rev0 + 1],
      ['claim.created', b.id, rev0 + 2],
      ['claim.created', x.id, rev0 + 3],
      ['claim.canceled', x.id, rev0 + 4],
      ['claim.resolved', a.id, rev0 + 5],
      ['claim.resolved', b.id, rev0 + 6],
    ]);
    expect(evs[4]).not.toHaveProperty('revokedParticipantId');
    expect(evs[5]).toMatchObject({ revokedParticipantId: kim.id });
    for (const e of evs) {
      for (const secret of [k1, k2, k3, hashIdentityKey(k1), hashIdentityKey(k2), 'Kim', 'Direct'])
        expect(JSON.stringify(e)).not.toContain(secret);
    }
    void direct;
  });

  it('SSE data에는 claimId만 싣고 내부 필드(revokedParticipantId)는 싣지 않는다', async () => {
    const { c, kim } = await setup();
    const server = s.app.app.getHttpServer();
    if (!server.listening) await new Promise<void>((ok) => server.listen(0, ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const stream = await openStream(base, c.roomId, c.key);
    try {
      await stream.waitFor((e) => e.some((x) => x.event === 'ready'));
      const key = newKey();
      const claim = (await requestClaim(c, key, { nickname: 'Kim' })).body.claim;
      await approve(c, claim.id);
      const evs = await stream.waitFor(
        (e) => e.filter((x) => x.event.startsWith('claim.')).length >= 2,
      );
      const claimEvents = evs.filter((x) => x.event.startsWith('claim.'));
      expect(claimEvents.map((x) => x.event)).toEqual(['claim.created', 'claim.resolved']);
      for (const e of claimEvents) {
        expect(Object.keys(e.data).sort()).toEqual(['claimId', 'revision', 'roomId', 'serverTime']);
        expect(e.data.claimId).toBe(claim.id);
        expect(Number(e.id)).toBe(e.data.revision);
      }
      void kim;
    } finally {
      stream.close();
    }
  });
});

describe('§4.8 이어받기 경로의 정의되지 않은 메서드는 405 + Allow', () => {
  it('각 경로의 Allow를 돌려주고 인증·존재와 무관하다', async () => {
    const { c } = await setup();
    const cases: [string, string, string][] = [
      ['put', `/invites/${c.inviteCode}/claims`, 'POST'],
      ['get', `/invites/${c.inviteCode}/claims`, 'POST'],
      ['delete', `/invites/${c.inviteCode}/claims/x`, 'GET'],
      ['patch', `/invites/${c.inviteCode}/claims/x`, 'GET'],
      ['get', `/invites/${c.inviteCode}/claims/x/cancel`, 'POST'],
      ['post', `/rooms/${c.roomId}/claims`, 'GET'],
      ['delete', `/rooms/${c.roomId}/claims/x`, 'GET'],
      ['patch', `/rooms/${c.roomId}/claims/x`, 'GET'],
      ['get', `/rooms/${c.roomId}/claims/x/approve`, 'POST'],
      ['put', `/rooms/${c.roomId}/claims/x/reject`, 'POST'],
    ];
    for (const [m, path, allow] of cases) {
      for (const key of [c.key, undefined]) {
        const r = (s.http as unknown as Record<string, (p: string) => import('supertest').Test>)[
          m
        ]!(path);
        const res = await (key ? r.set(auth(key)) : r).send({});
        expectApiError(res, 405, 'NOT_SUPPORTED');
        expect(res.headers.allow, `${m} ${path}`).toBe(allow);
      }
    }
  });
});
