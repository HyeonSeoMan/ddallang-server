import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOM_EVENTS_CHANNEL } from '../../src/common/db/database.service.js';
import { ac, expectApiError } from '../helpers/contract.js';
import { baseDatabaseUrl } from '../helpers/isolated-db.js';
import { parseNotification, sleep } from '../helpers/util.js';
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
  type S1Env,
} from './s1-helpers.js';

let s: S1Env;
let listener: pg.Client;
const events: Record<string, unknown>[] = [];
beforeAll(async () => {
  s = await bootS1();
  listener = new pg.Client({ connectionString: baseDatabaseUrl() });
  await listener.connect();
  await listener.query(`LISTEN ${ROOM_EVENTS_CHANNEL}`);
  listener.on('notification', (m) => {
    const e = parseNotification(m.payload);
    if (e) events.push(e);
  });
});
afterAll(async () => {
  await listener?.end();
  await s?.close();
});
const eventsOf = (roomId: string) => events.filter((e) => e.roomId === roomId);

describe('POST /rooms/{roomId}/participants (S1 §4.6)', () => {
  it(
    ac(
      ['AC-PART-001-1', 'AC-PART-001-2', 'AC-PART-001-4'],
      'S1 §4.6',
      '방장 등록 → 201 ACTIVE, order 부여(1부터 순서대로), 이후 불변',
    ),
    async () => {
      const c = await createRoom(s.http);
      const a = await addParticipant(s.http, c, 'Amy');
      const b = await addParticipant(s.http, c, 'Bob');
      expect(a.status).toBe(201);
      expect(a.body.participant).toMatchObject({
        roomId: c.roomId,
        nickname: 'Amy',
        status: 'ACTIVE',
        order: 1,
      });
      expect(b.body.participant.order).toBe(2);
      const list = await s.http.get(`/rooms/${c.roomId}/participants`).set(auth(c.key));
      expect(list.body.participants.map((p: { order: number }) => p.order)).toEqual([1, 2]);
    },
  );

  it(
    ac(
      ['AC-PART-001-3', 'AC-ROOM-007-2'],
      'S1 §5.1',
      '비방장의 등록 → 403 HOST_ONLY, 방 상태·본문 오류보다 앞선다',
    ),
    async () => {
      const c = await createRoom(s.http);
      const member = await join(s.http, c.inviteCode, 'Kim');
      const asMember = (body: object | string) =>
        s.http
          .post(`/rooms/${c.roomId}/participants`)
          .set(auth(member.key))
          .set('Content-Type', 'application/json')
          .send(body);
      expectApiError(await asMember({ nickname: 'P' }), 403, 'HOST_ONLY');
      expectApiError(await asMember('{"bad'), 403, 'HOST_ONLY'); // 잘못된 JSON이어도 403
      expectApiError(await asMember({}), 403, 'HOST_ONLY'); // 본문이 틀려도 403
      await endRoom(s.db, c.roomId);
      expectApiError(await asMember({ nickname: 'P' }), 403, 'HOST_ONLY'); // 종료된 방이어도 403
      expect(await count(s.db, 'Participant', c.roomId)).toBe(0);
    },
  );

  it('검사 순서: 401 → 404(비멤버) → 403 → 409 GAME_ENDED → 422 → 409 NICKNAME_TAKEN → 한도', async () => {
    const c = await createRoom(s.http);
    const url = `/rooms/${c.roomId}/participants`;
    expectApiError(await s.http.post(url).send({ nickname: 'x' }), 401, 'UNAUTHENTICATED');
    expectApiError(
      await s.http.post(url).set(auth(newKey())).send({ nickname: 'x' }),
      404,
      'ROOM_NOT_FOUND',
    );
    await endRoom(s.db, c.roomId);
    // 종료된 방: 본문이 틀려도 GAME_ENDED가 먼저다
    expectApiError(await s.http.post(url).set(auth(c.key)).send({}), 409, 'GAME_ENDED');
    expectApiError(
      await s.http.post(url).set(auth(c.key)).set('Content-Type', 'application/json').send('{"bad'),
      409,
      'GAME_ENDED',
    );
  });

  it(
    ac(['AC-PART-001-6'], 'S1 §6.5', '같은 닉네임 재등록(대소문자 무시) → 409 NICKNAME_TAKEN'),
    async () => {
      const c = await createRoom(s.http);
      await addParticipant(s.http, c, 'Kim');
      expectApiError(await addParticipant(s.http, c, 'kim'), 409, 'NICKNAME_TAKEN');
      expectApiError(await addParticipant(s.http, c, 'KIM'), 409, 'NICKNAME_TAKEN');
      expect(await count(s.db, 'Participant', c.roomId)).toBe(1);
    },
  );

  describe('닉네임 규칙(Participant 쪽)', () => {
    it(ac(['AC-ROOM-006-1', 'AC-ROOM-006-9'], 'S1 §3.2', '길이 1·12 허용, 0·13 거부'), async () => {
      const c = await createRoom(s.http);
      expect((await addParticipant(s.http, c, 'a')).status).toBe(201);
      expect((await addParticipant(s.http, c, 'b'.repeat(12))).status).toBe(201);
      expectApiError(await addParticipant(s.http, c, 'c'.repeat(13)), 422, 'VALIDATION_FAILED', [
        { field: 'nickname', code: 'LENGTH_OUT_OF_RANGE' },
      ]);
      expectApiError(await addParticipant(s.http, c, ''), 422, 'VALIDATION_FAILED', [
        { field: 'nickname', code: 'REQUIRED' },
      ]);
    });
    it(ac(['AC-ROOM-006-2'], 'S1 §3.2', '한글·단독 자모·영문·숫자·"Kim Min" 허용'), async () => {
      const c = await createRoom(s.http);
      for (const nick of ['김민', 'ㅋㅋ', 'Kim', '123', 'Kim Min'])
        expect((await addParticipant(s.http, c, nick)).status, nick).toBe(201);
    });
    it(ac(['AC-ROOM-006-3', 'AC-ROOM-006-12'], 'S1 §3.2', '앞뒤·연속 공백 거부'), async () => {
      const c = await createRoom(s.http);
      expectApiError(await addParticipant(s.http, c, ' Kim'), 422, 'VALIDATION_FAILED', [
        { field: 'nickname', code: 'LEADING_OR_TRAILING_SPACE' },
      ]);
      expectApiError(await addParticipant(s.http, c, 'Kim  Min'), 422, 'VALIDATION_FAILED', [
        { field: 'nickname', code: 'CONSECUTIVE_SPACES' },
      ]);
    });
    it(
      ac(['AC-ROOM-006-4'], 'S1 §3.2', '특수문자·이모지·U+3164·미결합 조합용 자모 거부'),
      async () => {
        const c = await createRoom(s.http);
        for (const nick of ['a!', 'a_b', 'a-b', '😀', 'aㅤ', 'aᄀ']) {
          expectApiError(await addParticipant(s.http, c, nick), 422, 'VALIDATION_FAILED', [
            { field: 'nickname', code: 'INVALID_CHARACTER' },
          ]);
        }
      },
    );
    it(
      ac(['AC-ROOM-006-5'], 'S1 §3.2', '"Kim" 사용 중 → "kim"·"KIM" 거부(Participant 유형)'),
      async () => {
        const c = await createRoom(s.http);
        await addParticipant(s.http, c, 'Kim');
        for (const nick of ['kim', 'KIM'])
          expectApiError(await addParticipant(s.http, c, nick), 409, 'NICKNAME_TAKEN');
      },
    );
    it(
      ac(['AC-ROOM-006-6'], 'S1 §2.2', 'Participant "Kim"은 RoomMember "Kim"과 공존한다'),
      async () => {
        const c = await createRoom(s.http);
        await join(s.http, c.inviteCode, 'Kim');
        expect((await addParticipant(s.http, c, 'Kim')).status).toBe(201);
      },
    );
    it(
      ac(['AC-ROOM-006-7'], 'S1 §2.2', '다른 방에서는 같은 참여자 닉네임을 쓸 수 있다'),
      async () => {
        const a = await createRoom(s.http);
        const b = await createRoom(s.http);
        expect((await addParticipant(s.http, a, 'Kim')).status).toBe(201);
        expect((await addParticipant(s.http, b, 'Kim')).status).toBe(201);
      },
    );
    it(
      ac(['AC-ROOM-006-10'], 'S1 §6.2', '비활성 참여자와 대소문자 무시 같은 닉네임 → 409'),
      async () => {
        const c = await createRoom(s.http);
        const p = await addParticipant(s.http, c, 'Kim');
        await s.http
          .patch(`/rooms/${c.roomId}/participants/${p.body.participant.id}`)
          .set(auth(c.key))
          .send({ status: 'INACTIVE' });
        expectApiError(await addParticipant(s.http, c, 'KIM'), 409, 'NICKNAME_TAKEN');
      },
    );
    it(
      ac(
        ['AC-ROOM-006-13'],
        'S1 §3.2',
        '조합형·분해형 한글은 서로 중복이고 호환 자모 나열은 다른 값',
      ),
      async () => {
        const c = await createRoom(s.http);
        expect((await addParticipant(s.http, c, '한글')).status).toBe(201);
        expectApiError(
          await addParticipant(s.http, c, '한글'.normalize('NFD')),
          409,
          'NICKNAME_TAKEN',
        );
        expect((await addParticipant(s.http, c, 'ㅎㅏㄴ')).status).toBe(201);
      },
    );
  });

  describe('한도(Participant 10명)', () => {
    it(
      ac(
        ['AC-ROOM-008-1', 'AC-ROOM-008-11'],
        'S1 §6.4',
        '10번째 성공, 11번째 409 PARTICIPANT_LIMIT_EXCEEDED, 부분 저장 없음',
      ),
      async () => {
        const c = await createRoom(s.http);
        for (let i = 1; i <= 10; i++)
          expect((await addParticipant(s.http, c, `p${i}`)).status, `p${i}`).toBe(201);
        expectApiError(await addParticipant(s.http, c, 'p11'), 409, 'PARTICIPANT_LIMIT_EXCEEDED', [
          { limit: 10 },
        ]);
        expect(await count(s.db, 'Participant', c.roomId)).toBe(10);
        // 기존 신원(방장) 접근은 한도와 무관하다
        expect((await s.http.get(`/rooms/${c.roomId}/participants`).set(auth(c.key))).status).toBe(
          200,
        );
      },
    );
  });

  it('입력 검증: 본문이 JSON이 아니면 422이고 아무것도 저장하지 않는다', async () => {
    const c = await createRoom(s.http);
    const res = await s.http
      .post(`/rooms/${c.roomId}/participants`)
      .set(auth(c.key))
      .set('Content-Type', 'application/json')
      .send('{"nick');
    expectApiError(res, 422, 'VALIDATION_FAILED', [{ field: 'body', code: 'INVALID_VALUE' }]);
    expect(await count(s.db, 'Participant', c.roomId)).toBe(0);
    expect(await revision(s.db, c.roomId)).toBe(0);
  });

  it('등록은 revision을 1 올리고 participant.created 이벤트를 한 번 낸다(거부된 요청은 소비하지 않는다)', async () => {
    const c = await createRoom(s.http);
    await addParticipant(s.http, c, 'Amy');
    await addParticipant(s.http, c, 'amy'); // 409
    await addParticipant(s.http, c, '!!'); // 422
    await sleep(300);
    expect(await revision(s.db, c.roomId)).toBe(1);
    const evs = eventsOf(c.roomId);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ event: 'participant.created', revision: 1 });
    expect(evs[0]).toHaveProperty('participantId');
    expect(JSON.stringify(evs[0])).not.toContain('Amy'); // 내용을 싣지 않는다
  });

  it('등록은 RoomMember를 만들지 않는다(S1 §6.1)', async () => {
    const c = await createRoom(s.http);
    await addParticipant(s.http, c, 'Amy');
    expect(await count(s.db, 'RoomMember', c.roomId)).toBe(1);
  });
});

describe('PATCH /rooms/{roomId}/participants/{participantId} (S1 §4.7)', () => {
  const patch = (c: { roomId: string; key: string }, id: string, body: unknown) =>
    s.http
      .patch(`/rooms/${c.roomId}/participants/${id}`)
      .set(auth(c.key))
      .send(body as object);

  it(
    ac(
      ['AC-PART-002-1', 'AC-PART-002-9'],
      'S1 §4.7',
      '비활성화·재활성화가 되고 order·닉네임은 바뀌지 않는다',
    ),
    async () => {
      const c = await createRoom(s.http);
      await addParticipant(s.http, c, 'First');
      const p = (await addParticipant(s.http, c, 'Second')).body.participant;
      const off = await patch(c, p.id, { status: 'INACTIVE' });
      expect(off.status).toBe(200);
      expect(off.body.participant).toMatchObject({
        id: p.id,
        status: 'INACTIVE',
        order: 2,
        nickname: 'Second',
      });
      const on = await patch(c, p.id, { status: 'ACTIVE' });
      expect(on.body.participant).toMatchObject({ status: 'ACTIVE', order: 2, nickname: 'Second' });
    },
  );

  it(
    ac(['AC-PART-002-5', 'AC-ROOM-007-2'], 'S1 §5.1', '비방장의 상태 변경 → 403 HOST_ONLY'),
    async () => {
      const c = await createRoom(s.http);
      const member = await join(s.http, c.inviteCode, 'Kim');
      const p = (await addParticipant(s.http, c, 'P')).body.participant;
      const res = await s.http
        .patch(`/rooms/${c.roomId}/participants/${p.id}`)
        .set(auth(member.key))
        .send({ status: 'INACTIVE' });
      expectApiError(res, 403, 'HOST_ONLY');
      expect(
        (await s.http.get(`/rooms/${c.roomId}/participants`).set(auth(c.key))).body.participants[0]
          .status,
      ).toBe('ACTIVE');
    },
  );

  it('검사 순서: 403 → 409 GAME_ENDED → 404 PARTICIPANT_NOT_FOUND → 422(NOT_ALLOWED_FIELD 등)', async () => {
    const c = await createRoom(s.http);
    const member = await join(s.http, c.inviteCode, 'Kim');
    const p = (await addParticipant(s.http, c, 'P')).body.participant;
    // 비방장은 존재하지 않는 대상·잘못된 본문이어도 403
    expectApiError(
      await s.http.patch(`/rooms/${c.roomId}/participants/nope`).set(auth(member.key)).send({}),
      403,
      'HOST_ONLY',
    );
    // 진행 중: 대상 없음이 입력 검증보다 앞선다
    expectApiError(await patch(c, 'nope', {}), 404, 'PARTICIPANT_NOT_FOUND');
    expectApiError(await patch(c, p.id, {}), 422, 'VALIDATION_FAILED', [
      { field: 'status', code: 'REQUIRED' },
    ]);
    await endRoom(s.db, c.roomId);
    expectApiError(await patch(c, 'nope', {}), 409, 'GAME_ENDED'); // 종료가 대상·본문보다 앞선다
    expectApiError(await patch(c, p.id, { status: 'INACTIVE' }), 409, 'GAME_ENDED');
  });

  it('다른 방의 참여자 ID는 같은 404 PARTICIPANT_NOT_FOUND다(AC-SYS-003-8)', async () => {
    const a = await createRoom(s.http);
    const b = await createRoom(s.http);
    const other = (await addParticipant(s.http, b, 'Other')).body.participant;
    const missing = await patch(a, 'does-not-exist', { status: 'INACTIVE' });
    const foreign = await patch(a, other.id, { status: 'INACTIVE' });
    expectApiError(foreign, 404, 'PARTICIPANT_NOT_FOUND');
    expect(foreign.body).toEqual(missing.body);
    expect(
      (await s.http.get(`/rooms/${b.roomId}/participants`).set(auth(b.key))).body.participants[0]
        .status,
    ).toBe('ACTIVE');
  });

  it('status 검증: 없음 REQUIRED, 문자열 아님 INVALID_TYPE, 허용 밖 INVALID_VALUE', async () => {
    const c = await createRoom(s.http);
    const p = (await addParticipant(s.http, c, 'P')).body.participant;
    expectApiError(await patch(c, p.id, {}), 422, 'VALIDATION_FAILED', [
      { field: 'status', code: 'REQUIRED' },
    ]);
    expectApiError(await patch(c, p.id, { status: null }), 422, 'VALIDATION_FAILED', [
      { field: 'status', code: 'REQUIRED' },
    ]);
    expectApiError(await patch(c, p.id, { status: true }), 422, 'VALIDATION_FAILED', [
      { field: 'status', code: 'INVALID_TYPE' },
    ]);
    expectApiError(await patch(c, p.id, { status: 'PAUSED' }), 422, 'VALIDATION_FAILED', [
      { field: 'status', code: 'INVALID_VALUE' },
    ]);
    expectApiError(await patch(c, p.id, { status: 'active' }), 422, 'VALIDATION_FAILED', [
      { field: 'status', code: 'INVALID_VALUE' },
    ]);
  });

  it(
    ac(
      ['AC-ROOM-006-8'],
      'S1 §4.7',
      'status 외 필드(nickname 등)는 NOT_ALLOWED_FIELD로 거부하고 아무것도 바꾸지 않는다',
    ),
    async () => {
      const c = await createRoom(s.http);
      const p = (await addParticipant(s.http, c, 'Kim')).body.participant;
      const res = await patch(c, p.id, { nickname: 'Park', status: 'INACTIVE' });
      expectApiError(res, 422, 'VALIDATION_FAILED', [
        { field: 'nickname', code: 'NOT_ALLOWED_FIELD' },
      ]);
      const only = await patch(c, p.id, { nickname: 'Park' });
      expectApiError(only, 422, 'VALIDATION_FAILED', [
        { field: 'nickname', code: 'NOT_ALLOWED_FIELD' },
        { field: 'status', code: 'REQUIRED' },
      ]);
      const after = (await s.http.get(`/rooms/${c.roomId}/participants`).set(auth(c.key))).body
        .participants[0];
      expect(after).toMatchObject({ nickname: 'Kim', status: 'ACTIVE' });
      expect(await revision(s.db, c.roomId)).toBe(1); // 등록 1회뿐
    },
  );

  it('같은 값 재요청은 200으로 현재 참여자를 돌려주고 revision·이벤트를 만들지 않는다(N-4)', async () => {
    const c = await createRoom(s.http);
    const p = (await addParticipant(s.http, c, 'P')).body.participant;
    const same = await patch(c, p.id, { status: 'ACTIVE' });
    expect(same.status).toBe(200);
    expect(same.body.participant).toMatchObject({ id: p.id, status: 'ACTIVE' });
    await patch(c, p.id, { status: 'INACTIVE' });
    await patch(c, p.id, { status: 'INACTIVE' }); // 다시 같은 값
    await sleep(300);
    expect(await revision(s.db, c.roomId)).toBe(2); // 등록 1 + 실제 변경 1
    expect(eventsOf(c.roomId).map((e) => e.event)).toEqual([
      'participant.created',
      'participant.status_changed',
    ]);
  });

  it('본문이 JSON이 아니면 422(대상 존재 확인 뒤)이고 아무것도 바꾸지 않는다', async () => {
    const c = await createRoom(s.http);
    const p = (await addParticipant(s.http, c, 'P')).body.participant;
    const res = await s.http
      .patch(`/rooms/${c.roomId}/participants/${p.id}`)
      .set(auth(c.key))
      .set('Content-Type', 'application/json')
      .send('{"st');
    expectApiError(res, 422, 'VALIDATION_FAILED', [{ field: 'body', code: 'INVALID_VALUE' }]);
  });
});
