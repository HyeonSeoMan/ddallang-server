import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectApiError } from '../helpers/contract.js';
import {
  addParticipant,
  auth,
  bootS1,
  createRoom,
  endRoom,
  join,
  newKey,
  type S1Env,
} from './s1-helpers.js';

let s: S1Env;
beforeAll(async () => {
  s = await bootS1();
});
afterAll(() => s?.close());

describe('GET /rooms/{roomId} (S1 §4.4)', () => {
  it('멤버(방장·일반 멤버)는 방 전체와 me를 받는다', async () => {
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
    expect(host.body.me).toMatchObject({
      id: c.hostId,
      nickname: 'Host',
      isHost: true,
      roomId: c.roomId,
    });
    const m = await s.http.get(`/rooms/${c.roomId}`).set(auth(member.key));
    expect(m.body.me).toMatchObject({ nickname: 'Kim', isHost: false });
    expect(m.body.room).not.toHaveProperty('revision');
  });

  it('비멤버·없는 방은 같은 404 ROOM_NOT_FOUND, 키 누락은 401', async () => {
    const c = await createRoom(s.http);
    const stranger = await s.http.get(`/rooms/${c.roomId}`).set(auth(newKey()));
    const missing = await s.http.get('/rooms/nope').set(auth(newKey()));
    expectApiError(stranger, 404, 'ROOM_NOT_FOUND');
    expect(stranger.body).toEqual(missing.body);
    expectApiError(await s.http.get(`/rooms/${c.roomId}`), 401, 'UNAUTHENTICATED');
  });

  it('종료 뒤에도 조회할 수 있다', async () => {
    const c = await createRoom(s.http);
    await endRoom(s.db, c.roomId);
    const res = await s.http.get(`/rooms/${c.roomId}`).set(auth(c.key));
    expect(res.status).toBe(200);
    expect(res.body.room.status).toBe('ENDED');
  });
});

describe('GET /rooms/{roomId}/participants (S1 §4.5)', () => {
  it('order 오름차순, 비활성 참여자 포함, 응답 형태', async () => {
    const c = await createRoom(s.http);
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
      'Zed',
      'Amy',
      'Max',
    ]);
    expect(res.body.participants.map((p: { order: number }) => p.order)).toEqual([1, 2, 3]);
    expect(res.body.participants[1]).toMatchObject({ status: 'INACTIVE', roomId: c.roomId });
    expect(res.body.participants[0]).toMatchObject({ id: a.body.participant.id, status: 'ACTIVE' });
    expect(res.body.participants[0]).not.toHaveProperty('nicknameKey');
  });

  it('일반 멤버도 조회할 수 있고 비멤버는 404, 키 누락은 401', async () => {
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
      (await s.http.get(`/rooms/${b.roomId}/participants`).set(auth(b.key))).body.participants,
    ).toEqual([]);
    const ended = await s.http.get(`/rooms/${a.roomId}/participants`).set(auth(a.key));
    expect(ended.body.participants).toHaveLength(1);
  });
});
