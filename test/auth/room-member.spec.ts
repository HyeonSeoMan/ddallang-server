import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashIdentityKey, parseIdentityKey } from '../../src/common/auth/identity-key.js';
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
async function member(roomId: string, key: string, o: { host?: boolean; nick?: string } = {}) {
  const id = newId();
  const nick = o.nick ?? `n${id.slice(0, 5)}`;
  await db.query(
    `INSERT INTO "RoomMember" ("id","roomId","nickname","nicknameKey","isHost","identityKeyHash") VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, roomId, nick, nick.toLowerCase(), o.host ?? false, hashIdentityKey(key)],
  );
  return id;
}

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

describe('RoomMemberGuard (S1 §3.3 1~3번)', () => {
  it('멤버는 요청자 컨텍스트(memberId·roomId·nickname·isHost)를 받는다', async () => {
    const roomId = await room();
    const hostKey = newKey();
    const memberKey = newKey();
    const hostId = await member(roomId, hostKey, { host: true, nick: 'Host' });
    const memberId = await member(roomId, memberKey, { nick: 'Kim' });
    const h = await t.http
      .get(`/__auth/rooms/${roomId}/whoami`)
      .set('Authorization', bearer(hostKey));
    expect(h.status).toBe(200);
    expect(h.body).toEqual({ memberId: hostId, roomId, nickname: 'Host', isHost: true });
    const m = await t.http
      .get(`/__auth/rooms/${roomId}/whoami`)
      .set('Authorization', bearer(memberKey));
    expect(m.body).toEqual({ memberId, roomId, nickname: 'Kim', isHost: false });
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

  it('비멤버와 없는 방은 구별할 수 없는 같은 404 ROOM_NOT_FOUND다', async () => {
    const roomId = await room();
    await member(roomId, newKey(), { host: true });
    const stranger = bearer(newKey());
    const nonMember = await t.http
      .get(`/__auth/rooms/${roomId}/whoami`)
      .set('Authorization', stranger);
    const noRoom = await t.http
      .get('/__auth/rooms/does-not-exist/whoami')
      .set('Authorization', stranger);
    expectApiError(nonMember, 404, 'ROOM_NOT_FOUND');
    expectApiError(noRoom, 404, 'ROOM_NOT_FOUND');
    expect(nonMember.body).toEqual(noRoom.body);
    expect(nonMember.headers['content-type']).toBe(noRoom.headers['content-type']);
  });

  it('다른 방에 등록된 키(방장 키 포함)는 이 방에서 아무 권한이 없다: 404 (방 단위 권한)', async () => {
    const a = await room();
    const b = await room();
    const hostA = newKey();
    await member(a, hostA, { host: true, nick: 'HostA' });
    await member(b, newKey(), { host: true, nick: 'HostB' });
    expectApiError(
      await t.http.get(`/__auth/rooms/${b}/whoami`).set('Authorization', bearer(hostA)),
      404,
      'ROOM_NOT_FOUND',
    );
    expect(
      (await t.http.get(`/__auth/rooms/${a}/whoami`).set('Authorization', bearer(hostA))).status,
    ).toBe(200);
  });

  it('같은 키를 다른 방에 등록하면 방마다 별개의 신원이다', async () => {
    const a = await room();
    const b = await room();
    const key = newKey();
    const ma = await member(a, key, { nick: 'Han' });
    const mb = await member(b, key, { nick: 'Han' });
    const ra = await t.http.get(`/__auth/rooms/${a}/whoami`).set('Authorization', bearer(key));
    const rb = await t.http.get(`/__auth/rooms/${b}/whoami`).set('Authorization', bearer(key));
    expect(ra.body.memberId).toBe(ma);
    expect(rb.body.memberId).toBe(mb);
    expect(ma).not.toBe(mb);
  });

  it('요청 본문·쿼리의 값이 아니라 Authorization 헤더만 신원으로 쓴다', async () => {
    const roomId = await room();
    const key = newKey();
    await member(roomId, key);
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

  it('응답과 로그에 신원 키가 나오지 않는다', async () => {
    const roomId = await room();
    const key = newKey();
    const wrong = newKey();
    await member(roomId, key);
    const responses = [
      await t.http.get(`/__auth/rooms/${roomId}/whoami`).set('Authorization', bearer(key)),
      await t.http.get(`/__auth/rooms/${roomId}/whoami`).set('Authorization', bearer(wrong)),
      await t.http.get(`/__auth/rooms/nope/whoami`).set('Authorization', bearer(wrong)),
      await t.http.get(`/__auth/rooms/${roomId}/whoami`).set('Authorization', `Bearer ${key}!`),
    ];
    for (const r of responses) {
      expect(JSON.stringify(r.body)).not.toContain(key);
      expect(JSON.stringify(r.body)).not.toContain(wrong);
      expect(JSON.stringify(r.headers)).not.toContain(key);
    }
    await new Promise((r) => setImmediate(r));
    const logs = logLines.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(key);
    expect(logs).not.toContain(wrong);
  });
});

describe('IdentityKeyGuard (입장·방 생성처럼 아직 멤버가 아닌 요청)', () => {
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
