import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ac, expectApiError } from '../helpers/contract.js';
import {
  addParticipant,
  auth,
  bootS1,
  count,
  createRoom,
  newKey,
  revision,
  type S1Env,
} from './s1-helpers.js';

let s: S1Env;
beforeAll(async () => {
  s = await bootS1();
});
afterAll(() => s?.close());

// S1 API 쪽 근거. AC-SYS-003의 SSE 연결 부분은 BE-S5-2의 시험이 이어서 맡는다.
describe('권한 우회 거부 (S1 API, FR-SYS-003)', () => {
  it(
    ac(['AC-SYS-003-1'], 'S1 §3.3', '신원 키 없는 방 한정 요청은 401로 거부된다(조회·변경 모두)'),
    async () => {
      const c = await createRoom(s.http);
      const p = (await addParticipant(s.http, c, 'P')).body.participant;
      for (const [method, path] of [
        ['get', `/rooms/${c.roomId}`],
        ['get', `/rooms/${c.roomId}/participants`],
        ['post', `/rooms/${c.roomId}/participants`],
        ['patch', `/rooms/${c.roomId}/participants/${p.id}`],
      ] as const) {
        expectApiError(await s.http[method](path).send({}), 401, 'UNAUTHENTICATED');
      }
    },
  );

  it(
    ac(['AC-SYS-003-5'], 'S1 §3.4', '거부는 구분 가능한 code를 돌려주고 데이터를 바꾸지 않는다'),
    async () => {
      const c = await createRoom(s.http);
      const stranger = newKey();
      const before = {
        members: await count(s.db, 'RoomMember', c.roomId),
        parts: await count(s.db, 'Participant', c.roomId),
        rev: await revision(s.db, c.roomId),
      };
      const codes = new Set<string>();
      const reject = async (
        res: { status: number; body: unknown },
        status: number,
        code: string,
      ) => {
        expectApiError(res, status, code);
        codes.add(`${status} ${code}`);
      };
      await reject(
        await s.http.post(`/rooms/${c.roomId}/participants`).send({ nickname: 'x' }),
        401,
        'UNAUTHENTICATED',
      );
      await reject(
        await s.http
          .post(`/rooms/${c.roomId}/participants`)
          .set(auth(stranger))
          .send({ nickname: 'x' }),
        404,
        'ROOM_NOT_FOUND',
      );
      await reject(
        await s.http.post(`/rooms/${c.roomId}/participants`).set(auth(c.key)).send({}),
        422,
        'VALIDATION_FAILED',
      );
      await reject(
        await s.http.delete(`/rooms/${c.roomId}`).set(auth(c.key)),
        405,
        'NOT_SUPPORTED',
      );
      await reject(await s.http.get('/nope'), 404, 'ROUTE_NOT_FOUND');
      expect(codes.size).toBe(5);
      expect({
        members: await count(s.db, 'RoomMember', c.roomId),
        parts: await count(s.db, 'Participant', c.roomId),
        rev: await revision(s.db, c.roomId),
      }).toEqual(before);
    },
  );

  it(
    ac(
      ['AC-SYS-003-6', 'AC-SYS-003-7'],
      'S1 §3.1',
      '다른 방에 등록된 신원 키(방장 키 포함)는 이 방에서 조회·변경 모두 404이며 아무것도 바뀌지 않는다',
    ),
    async () => {
      const a = await createRoom(s.http, { nickname: 'HostA' });
      const b = await createRoom(s.http, { nickname: 'HostB' });
      const p = (await addParticipant(s.http, b, 'PB')).body.participant;
      // a의 방장 키로 b에 접근
      const hostOfA = a.key;
      for (const res of [
        await s.http.get(`/rooms/${b.roomId}`).set(auth(hostOfA)),
        await s.http.get(`/rooms/${b.roomId}/participants`).set(auth(hostOfA)),
        await s.http
          .post(`/rooms/${b.roomId}/participants`)
          .set(auth(hostOfA))
          .send({ nickname: 'Evil' }),
        await s.http
          .patch(`/rooms/${b.roomId}/participants/${p.id}`)
          .set(auth(hostOfA))
          .send({ status: 'INACTIVE' }),
      ]) {
        expectApiError(res, 404, 'ROOM_NOT_FOUND'); // 403 HOST_ONLY가 아니라 비멤버 404
      }
      expect(await count(s.db, 'Participant', b.roomId)).toBe(1);
      expect(
        (await s.http.get(`/rooms/${b.roomId}/participants`).set(auth(b.key))).body.participants[0]
          .status,
      ).toBe('ACTIVE');
    },
  );
});
