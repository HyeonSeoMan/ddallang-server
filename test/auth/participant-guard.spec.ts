import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashIdentityKey, parseIdentityKey } from '../../src/common/auth/identity-key.js';
import { IdentityInvariantError, resolveIdentity } from '../../src/common/auth/identity.js';
import { PrismaService } from '../../src/common/db/prisma.service.js';
import { newId, newInviteCode } from '../../src/common/ids/ids.js';
import { AuthFixture } from '../fixtures/auth-fixtures.js';
import { expectApiError } from '../helpers/contract.js';
import { bootFixtureApp, type FixtureApp } from '../helpers/fixture-app.js';
import { createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';

const newKey = () => randomBytes(32).toString('base64url'); // 43자
const bearer = (key: string) => `Bearer ${key}`;

let db: IsolatedDb;
let t: FixtureApp;
const logLines: string[] = [];

async function room(): Promise<string> {
  const id = newId();
  await db.query(`INSERT INTO "Room" ("id","name","unit","inviteCode") VALUES ($1,'R','원',$2)`, [
    id,
    newInviteCode(),
  ]);
  return id;
}
let order = 0;
/** 참여자 하나. `key`를 주면 그 키에 연결하고(LINKED), `null`이면 신원 없는 참여자(직접 추가)다. */
async function participant(
  roomId: string,
  key: string | null,
  o: { host?: boolean; nick?: string; status?: 'ACTIVE' | 'INACTIVE' } = {},
) {
  const id = newId();
  const nick = o.nick ?? `n${id.slice(0, 5)}`;
  await db.query(
    `INSERT INTO "Participant" ("id","roomId","nickname","nicknameKey","status","order","isHost","identityKeyHash") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      roomId,
      nick,
      nick.toLowerCase(),
      o.status ?? 'ACTIVE',
      ++order,
      o.host ?? false,
      key === null ? null : hashIdentityKey(key),
    ],
  );
  return id;
}
async function pendingClaim(roomId: string, targetId: string, key: string) {
  const id = newId();
  await db.query(
    `INSERT INTO "ClaimRequest" ("id","roomId","participantId","requesterKeyHash") VALUES ($1,$2,$3,$4)`,
    [id, roomId, targetId, hashIdentityKey(key)],
  );
  return id;
}
async function revoke(roomId: string, targetId: string, key: string) {
  await db.query(
    `INSERT INTO "RevokedIdentity" ("roomId","keyHash","participantId") VALUES ($1,$2,$3)`,
    [roomId, hashIdentityKey(key), targetId],
  );
}
const whoami = (roomId: string, key: string) =>
  t.http.get(`/__auth/rooms/${roomId}/whoami`).set('Authorization', bearer(key));

beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
  t = await bootFixtureApp(
    [AuthFixture],
    'test',
    { DATABASE_URL: db.databaseUrl },
    { write: (s: string) => void logLines.push(s) },
  );
});
afterAll(async () => {
  await t?.close();
  await db?.drop();
});

describe('parseIdentityKey·hashIdentityKey (S1 §3.1, PD-14)', () => {
  it('Bearer + 43자 base64url만 받는다', () => {
    const key = newKey();
    expect(key).toHaveLength(43);
    expect(parseIdentityKey(`Bearer ${key}`)).toBe(key);
    expect(parseIdentityKey(`bearer ${key}`)).toBe(key); // 인증 스킴은 대소문자를 구분하지 않는다
  });

  it.each([
    ['누락', undefined],
    ['빈 값', ''],
    ['다른 스킴', 'Basic ' + 'a'.repeat(43)],
    ['스킴만', 'Bearer'],
    ['스킴+공백만', 'Bearer '],
    ['키 없음', 'Bearer  '],
    ['42자', 'Bearer ' + 'a'.repeat(42)],
    ['44자', 'Bearer ' + 'a'.repeat(44)],
    ['패딩', 'Bearer ' + 'a'.repeat(42) + '='],
    ['표준 base64 문자', 'Bearer ' + 'a'.repeat(41) + '+/'],
    ['공백이 낀 키', 'Bearer ' + 'a'.repeat(20) + ' ' + 'a'.repeat(22)],
    ['토큰이 둘', `Bearer ${'a'.repeat(43)} ${'b'.repeat(43)}`],
    ['키만(스킴 없음)', 'a'.repeat(43)],
    ['배열 헤더', ['Bearer ' + 'a'.repeat(43)]],
  ] as const)('형식 오류는 401: %s', (_name, header) => {
    expect(() => parseIdentityKey(header as string | undefined)).toThrow(
      expect.objectContaining({ code: 'UNAUTHENTICATED' }),
    );
  });

  it('해시는 SHA-256 소문자 hex 64자이고 DB CHECK 형식과 같다', () => {
    expect(hashIdentityKey('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hashIdentityKey(newKey())).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIdentityKey('a')).not.toBe(hashIdentityKey('b'));
  });
});

describe('resolveIdentity (PD-23, S1 §2.2): 한 질의로 상태 4가지', () => {
  let prisma: PrismaService;
  beforeAll(() => {
    prisma = new PrismaService({ DATABASE_URL: db.databaseUrl, DB_POOL_MAX: 2 });
  });
  afterAll(() => prisma?.onModuleDestroy());
  const resolve = (roomId: string, key: string) =>
    resolveIdentity(prisma.client, roomId, hashIdentityKey(key));

  it('LINKED: 연결된 참여자(활성·비활성)를 돌려준다. 키 해시는 담지 않는다', async () => {
    const roomId = await room();
    const key = newKey();
    const id = await participant(roomId, key, { nick: 'Kim', status: 'INACTIVE' });
    const state = await resolve(roomId, key);
    expect(state).toMatchObject({
      kind: 'LINKED',
      participant: { id, roomId, nickname: 'Kim', status: 'INACTIVE', isHost: false },
    });
    expect(JSON.stringify(state)).not.toContain(hashIdentityKey(key));
  });

  it('REVOKED·PENDING·NONE', async () => {
    const roomId = await room();
    const target = await participant(roomId, null, { nick: 'Target' });
    const revoked = newKey();
    await revoke(roomId, target, revoked);
    const pending = newKey();
    const claimId = await pendingClaim(roomId, target, pending);
    expect(await resolve(roomId, revoked)).toEqual({ kind: 'REVOKED' });
    expect(await resolve(roomId, pending)).toEqual({ kind: 'PENDING', claimId });
    expect(await resolve(roomId, newKey())).toEqual({ kind: 'NONE' });
  });

  it('끝난 요청(거절·취소)만 있는 키는 NONE이다', async () => {
    const roomId = await room();
    const target = await participant(roomId, null);
    const key = newKey();
    const claimId = await pendingClaim(roomId, target, key);
    await db.query(
      `UPDATE "ClaimRequest" SET "status"='CANCELED', "resolvedAt"=clock_timestamp() WHERE "id"=$1`,
      [claimId],
    );
    expect(await resolve(roomId, key)).toEqual({ kind: 'NONE' });
  });

  it('상태는 방 단위다: 다른 방에서 연결·대기·접근 상실인 키는 이 방에서 NONE', async () => {
    const a = await room();
    const b = await room();
    const key = newKey();
    const t1 = await participant(a, key);
    await pendingClaim(b, await participant(b, null), key);
    const c = await room();
    await revoke(c, await participant(c, null), key);
    expect((await resolve(a, key)).kind).toBe('LINKED');
    expect((await resolve(b, key)).kind).toBe('PENDING');
    expect((await resolve(c, key)).kind).toBe('REVOKED');
    expect(await resolve(await room(), key)).toEqual({ kind: 'NONE' });
    void t1;
  });

  it('LINKED와 PENDING이 함께 해당하면 LINKED다(Spec이 정한 경합 결과, AC-ROOM-009-14)', async () => {
    const roomId = await room();
    const key = newKey();
    const linked = await participant(roomId, key);
    await pendingClaim(roomId, await participant(roomId, null), key);
    expect(await resolve(roomId, key)).toMatchObject({
      kind: 'LINKED',
      participant: { id: linked },
    });
  });

  it('불변식 위반(LINKED+REVOKED, REVOKED+PENDING)은 하나를 고르지 않고 실패한다(BE-C4)', async () => {
    const roomId = await room();
    const k1 = newKey();
    const p1 = await participant(roomId, k1);
    await revoke(roomId, p1, k1);
    await expect(resolve(roomId, k1)).rejects.toBeInstanceOf(IdentityInvariantError);
    const k2 = newKey();
    const p2 = await participant(roomId, null);
    await revoke(roomId, p2, k2);
    await pendingClaim(roomId, p2, k2);
    await expect(resolve(roomId, k2)).rejects.toBeInstanceOf(IdentityInvariantError);
    // 오류 메시지에 키 해시가 없다
    await resolve(roomId, k2).catch((e: Error) =>
      expect(e.message).not.toContain(hashIdentityKey(k2)),
    );
  });
});

describe('ParticipantGuard (BE-M2, S1 §3.3 1~3번)', () => {
  it('연결된 참여자(방장·일반·비활성)는 요청자 컨텍스트를 받는다', async () => {
    const roomId = await room();
    const hostKey = newKey();
    const memberKey = newKey();
    const inactiveKey = newKey();
    const hostId = await participant(roomId, hostKey, { host: true, nick: 'Host' });
    const memberId = await participant(roomId, memberKey, { nick: 'Kim' });
    const inactiveId = await participant(roomId, inactiveKey, { nick: 'Lee', status: 'INACTIVE' });
    const h = await whoami(roomId, hostKey);
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ id: hostId, roomId, nickname: 'Host', isHost: true });
    const m = await whoami(roomId, memberKey);
    expect(m.body).toMatchObject({ id: memberId, roomId, nickname: 'Kim', isHost: false });
    const i = await whoami(roomId, inactiveKey);
    expect(i.body).toMatchObject({ id: inactiveId, status: 'INACTIVE' });
  });

  it('키 누락·형식 오류는 401이며 방이 있든 없든 같다(1번이 2~3번보다 앞)', async () => {
    const roomId = await room();
    const cases: (string | undefined)[] = [undefined, 'Bearer short', 'Basic abc'];
    for (const header of cases) {
      for (const id of [roomId, 'no-such-room']) {
        let r = t.http.get(`/__auth/rooms/${id}/whoami`);
        if (header) r = r.set('Authorization', header);
        expectApiError(await r, 401, 'UNAUTHENTICATED');
      }
    }
  });

  it('[AC-TXN-003-2] 신원 없음·이어받기 대기 키와 없는 방은 구별할 수 없는 같은 404 ROOM_NOT_FOUND다', async () => {
    const roomId = await room();
    await participant(roomId, newKey(), { host: true });
    const target = await participant(roomId, null, { nick: 'Direct' });
    const pending = newKey();
    await pendingClaim(roomId, target, pending);
    const stranger = newKey();
    const nonParticipant = await whoami(roomId, stranger);
    const waiting = await whoami(roomId, pending);
    const noRoom = await whoami('does-not-exist', stranger);
    for (const r of [nonParticipant, waiting, noRoom]) expectApiError(r, 404, 'ROOM_NOT_FOUND');
    expect(nonParticipant.body).toEqual(noRoom.body);
    expect(waiting.body).toEqual(noRoom.body);
    expect(nonParticipant.headers['content-type']).toBe(noRoom.headers['content-type']);
  });

  it('[AC-SYS-003-6] 접근을 잃은 키는 401 IDENTITY_REVOKED다(REST 쪽). 다른 방에서는 그 키가 무관하다', async () => {
    const roomId = await room();
    const target = await participant(roomId, null);
    const old = newKey();
    await revoke(roomId, target, old);
    expectApiError(await whoami(roomId, old), 401, 'IDENTITY_REVOKED');
    expectApiError(await whoami(await room(), old), 404, 'ROOM_NOT_FOUND');
  });

  it('불변식 위반 상태의 키는 500 INTERNAL_ERROR(조용히 통과시키지 않는다)', async () => {
    const roomId = await room();
    const key = newKey();
    const p = await participant(roomId, key);
    await revoke(roomId, p, key);
    expectApiError(await whoami(roomId, key), 500, 'INTERNAL_ERROR');
  });

  it('[AC-SYS-003-6] 다른 방에 연결된 키(방장 키 포함)는 이 방에서 아무 권한이 없다: 404 (방 단위 권한)', async () => {
    const a = await room();
    const b = await room();
    const hostA = newKey();
    await participant(a, hostA, { host: true, nick: 'HostA' });
    await participant(b, newKey(), { host: true, nick: 'HostB' });
    expectApiError(await whoami(b, hostA), 404, 'ROOM_NOT_FOUND');
    expect((await whoami(a, hostA)).status).toBe(200);
  });

  it('같은 키를 다른 방에 연결하면 방마다 별개의 신원이다', async () => {
    const a = await room();
    const b = await room();
    const key = newKey();
    const pa = await participant(a, key, { nick: 'Han' });
    const pb = await participant(b, key, { nick: 'Han' });
    expect((await whoami(a, key)).body.id).toBe(pa);
    expect((await whoami(b, key)).body.id).toBe(pb);
    expect(pa).not.toBe(pb);
  });

  it('요청 본문·쿼리의 값이 아니라 Authorization 헤더만 신원으로 쓴다', async () => {
    const roomId = await room();
    const key = newKey();
    await participant(roomId, key);
    expectApiError(
      await t.http.get(`/__auth/rooms/${roomId}/whoami?key=${key}`),
      401,
      'UNAUTHENTICATED',
    );
  });

  it('라우트 판정(404·405)은 인증보다 앞이다', async () => {
    const roomId = await room();
    expectApiError(await t.http.get(`/__auth/rooms/${roomId}/nope`), 404, 'ROUTE_NOT_FOUND');
    const res = await t.http.patch(`/__auth/rooms/${roomId}/whoami`);
    expectApiError(res, 405, 'NOT_SUPPORTED');
    expect(res.headers.allow).toBe('GET');
  });

  it('응답과 로그에 신원 키·키 해시가 나오지 않는다', async () => {
    const roomId = await room();
    const key = newKey();
    const wrong = newKey();
    const old = newKey();
    const p = await participant(roomId, key);
    await revoke(roomId, p, old);
    const responses = [
      await whoami(roomId, key),
      await whoami(roomId, wrong),
      await whoami(roomId, old),
      await whoami('nope', wrong),
      await t.http.get(`/__auth/rooms/${roomId}/whoami`).set('Authorization', `Bearer ${key}!`),
    ];
    for (const r of responses) {
      for (const secret of [key, wrong, old, hashIdentityKey(key), hashIdentityKey(old)]) {
        expect(JSON.stringify(r.body)).not.toContain(secret);
        expect(JSON.stringify(r.headers)).not.toContain(secret);
      }
    }
    await new Promise((r) => setImmediate(r));
    const logs = logLines.join('');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [key, wrong, old, hashIdentityKey(key), hashIdentityKey(old)])
      expect(logs).not.toContain(secret);
  });
});

describe('IdentityKeyGuard (방 생성·입장·이어받기처럼 아직 연결되지 않은 요청)', () => {
  it('형식이 맞는 키는 통과하고 서버는 해시만 안다', async () => {
    const key = newKey();
    const res = await t.http.post('/__auth/identity').set('Authorization', bearer(key));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ hash: hashIdentityKey(key) });
    expect(JSON.stringify(res.body)).not.toContain(key);
  });

  it('키 누락·형식 오류는 401이다', async () => {
    expectApiError(await t.http.post('/__auth/identity'), 401, 'UNAUTHENTICATED');
    expectApiError(
      await t.http.post('/__auth/identity').set('Authorization', 'Bearer x'),
      401,
      'UNAUTHENTICATED',
    );
  });
});
