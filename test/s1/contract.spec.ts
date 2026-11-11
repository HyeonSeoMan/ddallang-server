import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ac, expectApiError } from '../helpers/contract.js';
import {
  addParticipant,
  auth,
  bootS1,
  count,
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

type Method = 'put' | 'patch' | 'delete' | 'post' | 'get';
const call = (m: Method, path: string, key?: string) => {
  const r = s.http[m](path);
  return key ? r.set(auth(key)) : r;
};

describe('S1 §4.8 존재하지 않는 동작', () => {
  it(
    ac(
      ['AC-ROOM-003-2'],
      'S1 §4.8',
      'PATCH/PUT/DELETE /rooms/{roomId}는 방장·비방장, 진행·종료 모든 조합에서 405 NOT_SUPPORTED + Allow: GET',
    ),
    async () => {
      const c = await createRoom(s.http);
      const member = await join(s.http, c.inviteCode, 'Kim');
      for (const ended of [false, true]) {
        if (ended) await endRoom(s.db, c.roomId);
        for (const key of [c.key, member.key, undefined]) {
          for (const m of ['patch', 'put', 'delete'] as const) {
            const res = await call(m, `/rooms/${c.roomId}`, key).send({ name: 'x', unit: 'y' });
            expectApiError(res, 405, 'NOT_SUPPORTED');
            expect(res.headers.allow).toBe('GET');
          }
        }
      }
      // 이름·단위는 그대로다
      const room = await s.http.get(`/rooms/${c.roomId}`).set(auth(c.key));
      expect(room.body.room).toMatchObject({ name: 'Friday 7', unit: '원' });
    },
  );

  it(
    ac(
      ['AC-PART-003-1', 'AC-PART-003-2'],
      'S1 §4.8',
      '참여자 수정·삭제 경로: PUT/DELETE/POST는 405 Allow: PATCH (이름 변경·거래 이전 경로 없음)',
    ),
    async () => {
      const c = await createRoom(s.http);
      const p = (await addParticipant(s.http, c, 'Kim')).body.participant;
      for (const m of ['put', 'delete', 'post'] as const) {
        const res = await call(m, `/rooms/${c.roomId}/participants/${p.id}`, c.key).send({});
        expectApiError(res, 405, 'NOT_SUPPORTED');
        expect(res.headers.allow).toBe('PATCH');
      }
      // 거래 일괄 이전 경로는 없다
      for (const path of [
        `/rooms/${c.roomId}/participants/${p.id}/transactions`,
        `/rooms/${c.roomId}/participants/${p.id}/transfer`,
      ]) {
        expectApiError(await call('post', path, c.key).send({}), 404, 'ROUTE_NOT_FOUND');
      }
      expect(
        (await s.http.get(`/rooms/${c.roomId}/participants`).set(auth(c.key))).body.participants[0]
          .nickname,
      ).toBe('Kim');
    },
  );

  it('참여자 목록·등록 경로의 다른 메서드는 405 Allow: GET, POST', async () => {
    const c = await createRoom(s.http);
    for (const m of ['put', 'patch', 'delete'] as const) {
      const res = await call(m, `/rooms/${c.roomId}/participants`, c.key).send({});
      expectApiError(res, 405, 'NOT_SUPPORTED');
      expect(res.headers.allow).toBe('GET, POST');
    }
  });

  it(
    ac(
      ['AC-ROOM-007-3', 'AC-ROOM-004-5'],
      'S1 §4.8',
      'RoomMember 수정·삭제·강제 퇴장, 방장 이전, 초대 링크 재발급, RoomMember–Participant 연결·해제 경로는 404 ROUTE_NOT_FOUND',
    ),
    async () => {
      const c = await createRoom(s.http);
      const member = await join(s.http, c.inviteCode, 'Kim');
      const p = (await addParticipant(s.http, c, 'P')).body.participant;
      const undefinedRoutes: [Method, string][] = [
        ['patch', `/rooms/${c.roomId}/members/${member.res.body.me.id}`],
        ['delete', `/rooms/${c.roomId}/members/${member.res.body.me.id}`],
        ['get', `/rooms/${c.roomId}/members`],
        ['post', `/rooms/${c.roomId}/members/${member.res.body.me.id}/kick`],
        ['post', `/rooms/${c.roomId}/transfer-host`],
        ['put', `/rooms/${c.roomId}/host`],
        ['post', `/rooms/${c.roomId}/invite`],
        ['post', `/rooms/${c.roomId}/invite/regenerate`],
        ['post', `/invites/${c.inviteCode}/regenerate`],
        ['put', `/invites/${c.inviteCode}`],
        ['post', `/rooms/${c.roomId}/participants/${p.id}/link`],
        ['delete', `/rooms/${c.roomId}/participants/${p.id}/link`],
        ['post', `/rooms/${c.roomId}/members/${member.res.body.me.id}/participant`],
      ];
      for (const [m, path] of undefinedRoutes) {
        for (const key of [c.key, member.key, undefined]) {
          // `/invites/{code}`의 PUT은 경로가 있어 405이므로 여기서 제외한다(위 목록의 404 대상이 아니다)
          if (path === `/invites/${c.inviteCode}` && m === 'put') continue;
          const res = await call(m, path, key).send({});
          expectApiError(res, 404, 'ROUTE_NOT_FOUND');
        }
      }
      expect((await call('put', `/invites/${c.inviteCode}`).send({})).status).toBe(405);
    },
  );

  it('라우트 판정은 방·참여자 존재와 인증 여부와 무관하게 같은 응답이다', async () => {
    const c = await createRoom(s.http);
    const bodies = new Set<string>();
    for (const roomId of [c.roomId, 'no-such-room']) {
      for (const key of [c.key, newKey(), undefined]) {
        const res = await call('delete', `/rooms/${roomId}`, key);
        expect(res.status).toBe(405);
        bodies.add(JSON.stringify(res.body));
        const nf = await call('post', `/rooms/${roomId}/transfer-host`, key).send({});
        expect(nf.status).toBe(404);
        bodies.add(JSON.stringify(nf.body));
      }
    }
    expect(bodies.size).toBe(2);
  });
});

describe('S1 불변식 (계약 시험)', () => {
  it(
    ac(['AC-ROOM-004-3'], 'S1 §6.1', '입장은 Participant를 만들지 않는다(참여자 수 불변)'),
    async () => {
      const c = await createRoom(s.http);
      await addParticipant(s.http, c, 'P1');
      const before = await count(s.db, 'Participant', c.roomId);
      await join(s.http, c.inviteCode, 'Kim');
      await join(s.http, c.inviteCode, 'Lee');
      expect(await count(s.db, 'Participant', c.roomId)).toBe(before);
    },
  );

  it(
    ac(['AC-ROOM-004-4'], 'S1 §6.1', '참여자 등록은 RoomMember를 만들지 않는다(멤버 수 불변)'),
    async () => {
      const c = await createRoom(s.http);
      await join(s.http, c.inviteCode, 'Kim');
      const before = await count(s.db, 'RoomMember', c.roomId);
      await addParticipant(s.http, c, 'P1');
      await addParticipant(s.http, c, 'P2');
      expect(await count(s.db, 'RoomMember', c.roomId)).toBe(before);
    },
  );

  it(
    ac(
      ['AC-PART-003-3'],
      'S1 §5.3',
      '오입력 참여자를 비활성화한 뒤 다른 닉네임으로 새 참여자를 등록할 수 있다(옛 닉네임은 계속 점유)',
    ),
    async () => {
      const c = await createRoom(s.http);
      const typo = (await addParticipant(s.http, c, 'Kimm')).body.participant;
      await s.http
        .patch(`/rooms/${c.roomId}/participants/${typo.id}`)
        .set(auth(c.key))
        .send({ status: 'INACTIVE' });
      const fixed = await addParticipant(s.http, c, 'Kim');
      expect(fixed.status).toBe(201);
      expect(fixed.body.participant.order).toBe(2);
      expectApiError(await addParticipant(s.http, c, 'kimm'), 409, 'NICKNAME_TAKEN'); // 비활성도 점유
      const list = (await s.http.get(`/rooms/${c.roomId}/participants`).set(auth(c.key))).body
        .participants;
      expect(
        list.map((p: { nickname: string; status: string }) => `${p.nickname}:${p.status}`),
      ).toEqual(['Kimm:INACTIVE', 'Kim:ACTIVE']);
    },
  );

  it('방장은 방 생성자뿐이다: 입장자는 어떤 순서로 들어와도 isHost=false이고 방장 변경 경로가 없다', async () => {
    const c = await createRoom(s.http);
    for (let i = 0; i < 4; i++)
      expect((await join(s.http, c.inviteCode, `m${i}`)).res.body.me.isHost).toBe(false);
    const hosts = await s.db.query(`SELECT "id" FROM "RoomMember" WHERE "roomId"=$1 AND "isHost"`, [
      c.roomId,
    ]);
    expect(hosts).toEqual([{ id: c.hostId }]);
  });
});
