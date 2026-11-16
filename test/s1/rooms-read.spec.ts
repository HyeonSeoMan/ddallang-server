import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ac, expectApiError } from '../helpers/contract.js';
import {
  addParticipant,
  auth,
  bootS1,
  createRoom,
  endRoom,
  join,
  newKey,
  pendingClaimFixture,
  revokeFixture,
  type S1Env,
} from './s1-helpers.js';

let s: S1Env;
beforeAll(async () => {
  s = await bootS1();
});
afterAll(() => s?.close());

describe('GET /rooms/{roomId} (S1 §4.4)', () => {
  it('참여자(방장·일반)는 방 전체와 me(Participant)를 받는다', async () => {
    const c = await createRoom(s.http, { name: 'Read', unit: '점수' });
    const member = await join(s.http, c.inviteCode, 'Kim');
    const host = await s.http.get(`/rooms/${c.roomId}`).set(auth(c.key));
    expect(host.status).toBe(200);
    expect(host.body.room).toMatchObject({
      id: c.roomId,
      name: 'Read',
      unit: '점수',
      status: 'IN_PROGRESS',
      inviteCode: c.inviteCode,
    });
    expect(host.body.me).toEqual({
      id: c.hostId,
      roomId: c.roomId,
      nickname: 'Host',
      status: 'ACTIVE',
      order: 1,
      isHost: true,
      createdAt: expect.any(String),
    });
    const m = await s.http.get(`/rooms/${c.roomId}`).set(auth(member.key));
    expect(m.body.me).toEqual(member.res.body.me);
    expect(m.body.room).not.toHaveProperty('revision');
  });

  it(
    ac(
      ['AC-ROOM-004-1'],
      'S1 §3.3 3',
      '신원 없음·대기 키와 없는 방은 같은 404 ROOM_NOT_FOUND(방·참여자 조회), 접근 상실은 401, 키 누락은 401',
    ),
    async () => {
      const c = await createRoom(s.http);
      const target = (await addParticipant(s.http, c, 'Direct')).body.participant.id as string;
      const waiting = newKey();
      await pendingClaimFixture(s.db, c.roomId, target, waiting);
      const old = newKey();
      await revokeFixture(s.db, c.roomId, target, old);
      for (const path of [`/rooms/${c.roomId}`, `/rooms/${c.roomId}/participants`]) {
        const stranger = await s.http.get(path).set(auth(newKey()));
        const pending = await s.http.get(path).set(auth(waiting));
        const missing = await s.http.get(path.replace(c.roomId, 'nope')).set(auth(newKey()));
        expectApiError(stranger, 404, 'ROOM_NOT_FOUND');
        expectApiError(pending, 404, 'ROOM_NOT_FOUND');
        expect(stranger.body).toEqual(missing.body);
        expect(pending.body).toEqual(missing.body);
        expectApiError(await s.http.get(path).set(auth(old)), 401, 'IDENTITY_REVOKED');
        expectApiError(await s.http.get(path), 401, 'UNAUTHENTICATED');
      }
    },
  );

  it('종료 뒤에도 조회할 수 있다', async () => {
    const c = await createRoom(s.http);
    await endRoom(s.db, c.roomId);
    const res = await s.http.get(`/rooms/${c.roomId}`).set(auth(c.key));
    expect(res.status).toBe(200);
    expect(res.body.room.status).toBe('ENDED');
  });
});

describe('GET /rooms/{roomId}/participants (S1 §4.5)', () => {
  it('order 오름차순(방장 1), 비활성·직접 추가·입장 참여자 포함, 응답 형태', async () => {
    const c = await createRoom(s.http);
    const kim = await join(s.http, c.inviteCode, 'Kim');
    const a = await addParticipant(s.http, c, 'Zed');
    const b = await addParticipant(s.http, c, 'Amy');
    await addParticipant(s.http, c, 'Max');
    await s.http
      .patch(`/rooms/${c.roomId}/participants/${b.body.participant.id}`)
      .set(auth(c.key))
      .send({ status: 'INACTIVE' });
    const res = await s.http.get(`/rooms/${c.roomId}/participants`).set(auth(c.key));
    expect(res.status).toBe(200);
    expect(res.body.participants.map((p: { nickname: string }) => p.nickname)).toEqual([
      'Host',
      'Kim',
      'Zed',
      'Amy',
      'Max',
    ]);
    expect(res.body.participants.map((p: { order: number }) => p.order)).toEqual([1, 2, 3, 4, 5]);
    expect(res.body.participants.map((p: { isHost: boolean }) => p.isHost)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(res.body.participants[3]).toMatchObject({ status: 'INACTIVE', roomId: c.roomId });
    expect(res.body.participants[2]).toMatchObject({ id: a.body.participant.id, status: 'ACTIVE' });
    expect(res.body.participants[1]).toEqual(kim.res.body.me);
    for (const p of res.body.participants) {
      expect(Object.keys(p).sort()).toEqual(
        ['createdAt', 'id', 'isHost', 'nickname', 'order', 'roomId', 'status'].sort(),
      ); // 신원 연결 여부·해시·비교 키 없음(S1-C6)
    }
  });

  it('일반 참여자도 조회할 수 있고 비참여자는 404, 키 누락은 401', async () => {
    const c = await createRoom(s.http);
    const member = await join(s.http, c.inviteCode, 'Kim');
    expect((await s.http.get(`/rooms/${c.roomId}/participants`).set(auth(member.key))).status).toBe(
      200,
    );
    expectApiError(
      await s.http.get(`/rooms/${c.roomId}/participants`).set(auth(newKey())),
      404,
      'ROOM_NOT_FOUND',
    );
    expectApiError(await s.http.get(`/rooms/${c.roomId}/participants`), 401, 'UNAUTHENTICATED');
  });

  it('다른 방의 참여자는 보이지 않고, 종료 뒤에도 조회된다', async () => {
    const a = await createRoom(s.http);
    const b = await createRoom(s.http);
    await addParticipant(s.http, a, 'OnlyA');
    await endRoom(s.db, a.roomId);
    expect(
      (await s.http.get(`/rooms/${b.roomId}/participants`).set(auth(b.key))).body.participants.map(
        (p: { id: string }) => p.id,
      ),
    ).toEqual([b.hostId]);
    const ended = await s.http.get(`/rooms/${a.roomId}/participants`).set(auth(a.key));
    expect(ended.body.participants).toHaveLength(2); // 방장 + OnlyA
  });
});
