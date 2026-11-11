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
  revision,
  type S1Env,
} from './s1-helpers.js';

let s: S1Env;
beforeAll(async () => {
  s = await bootS1();
});
afterAll(() => s?.close());

const invite = (code: string, key?: string) => {
  const r = s.http.get(`/invites/${code}`);
  return key ? r.set(auth(key)) : r;
};

describe('GET /invites/{inviteCode} (S1 §4.2)', () => {
  it('입장 전에 공개하는 것은 이름·정산 단위·진행 상태와 isMember뿐이다', async () => {
    const c = await createRoom(s.http, { name: 'Open', unit: '칩' });
    await join(s.http, c.inviteCode, 'Kim');
    await addParticipant(s.http, c, 'P1');
    const res = await invite(c.inviteCode);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      room: { name: 'Open', unit: '칩', status: 'IN_PROGRESS' },
      isMember: false,
    });
    const text = JSON.stringify(res.body);
    for (const secret of [c.roomId, c.inviteCode, 'Host', 'Kim', 'P1'])
      expect(text).not.toContain(secret);
  });

  it(
    ac(
      ['AC-ROOM-005-1'],
      'S1 §4.2',
      '등록된 키는 isMember=true, 다른 키·키 없음·형식 오류는 false(오류 아님)',
    ),
    async () => {
      const c = await createRoom(s.http);
      expect((await invite(c.inviteCode, c.key)).body.isMember).toBe(true);
      expect((await invite(c.inviteCode, newKey())).body.isMember).toBe(false);
      expect((await invite(c.inviteCode)).body.isMember).toBe(false);
      const malformed = await s.http
        .get(`/invites/${c.inviteCode}`)
        .set('Authorization', 'Bearer not-a-key');
      expect(malformed.status).toBe(200);
      expect(malformed.body.isMember).toBe(false);
    },
  );

  it(
    ac(['AC-ROOM-002-4'], 'S1 §4.2', '없는·형식이 틀린 초대 코드 → 404 INVITE_NOT_FOUND'),
    async () => {
      for (const code of ['nope', 'x'.repeat(22), '%20', 'a'.repeat(200)]) {
        expectApiError(await invite(code), 404, 'INVITE_NOT_FOUND');
      }
    },
  );

  it(ac(['AC-ROOM-002-5'], 'S1 §4.2', 'ENDED 방에서도 초대 조회가 200이다'), async () => {
    const c = await createRoom(s.http);
    await endRoom(s.db, c.roomId);
    const res = await invite(c.inviteCode);
    expect(res.status).toBe(200);
    expect(res.body.room.status).toBe('ENDED');
  });

  it(
    ac(
      ['AC-ROOM-002-2'],
      'S1 §4.3',
      '방 코드로 입장하는 경로는 없다(초대 코드 경로만): 404 ROUTE_NOT_FOUND',
    ),
    async () => {
      const c = await createRoom(s.http);
      expectApiError(
        await s.http.post(`/rooms/${c.roomId}/members`).set(auth(newKey())).send({ nickname: 'x' }),
        404,
        'ROUTE_NOT_FOUND',
      );
      expectApiError(
        await s.http.post('/join').set(auth(newKey())).send({ code: 'x' }),
        404,
        'ROUTE_NOT_FOUND',
      );
    },
  );
});

describe('POST /invites/{inviteCode}/members (S1 §4.3)', () => {
  it(
    ac(
      ['AC-ROOM-002-1', 'AC-ROOM-007-1'],
      'S1 §4.3',
      '유효 코드+닉네임 → 201, 새 RoomMember(isHost=false), 가입·비밀번호 없음',
    ),
    async () => {
      const c = await createRoom(s.http);
      const { res } = await join(s.http, c.inviteCode, 'Kim');
      expect(res.status).toBe(201);
      expect(res.body.room).toEqual({
        id: c.roomId,
        name: 'Friday 7',
        unit: '원',
        status: 'IN_PROGRESS',
      });
      expect(res.body.me).toMatchObject({ roomId: c.roomId, nickname: 'Kim', isHost: false });
      expect(res.body.room).not.toHaveProperty('inviteCode');
    },
  );

  it(
    ac(
      ['AC-ROOM-005-1', 'AC-ROOM-005-6'],
      'S1 §6.1',
      '같은 키 재입장 → 200 같은 me.id(닉네임 무시), 방장 키도 같은 방장',
    ),
    async () => {
      const c = await createRoom(s.http);
      const first = await join(s.http, c.inviteCode, 'Kim');
      const again = await join(s.http, c.inviteCode, 'Other', first.key);
      expect(again.res.status).toBe(200);
      expect(again.res.body.me.id).toBe(first.res.body.me.id);
      expect(again.res.body.me.nickname).toBe('Kim');
      const noBody = await s.http.post(`/invites/${c.inviteCode}/members`).set(auth(first.key));
      expect(noBody.status).toBe(200);
      const host = await s.http.post(`/invites/${c.inviteCode}/members`).set(auth(c.key)).send({});
      expect(host.status).toBe(200);
      expect(host.body.me).toMatchObject({ id: c.hostId, isHost: true });
    },
  );

  it(
    ac(
      ['AC-ROOM-005-3', 'AC-ROOM-005-4', 'AC-ROOM-005-5', 'AC-ROOM-005-7'],
      'S1 §6.1',
      '키를 잃고 다른 키로 입장하면 새 RoomMember이며 방장·이전 신원으로 인식되지 않는다',
    ),
    async () => {
      const c = await createRoom(s.http);
      const lost = await join(s.http, c.inviteCode, 'Han'); // 이전 키(소실)
      const fresh = await join(s.http, c.inviteCode, 'Han2'); // 새 키
      expect(fresh.res.status).toBe(201);
      expect(fresh.res.body.me.id).not.toBe(lost.res.body.me.id);
      expect(fresh.res.body.me.isHost).toBe(false);
      // 방장 키를 잃어도 아무도 방장이 되지 않는다
      const hosts = await s.db.query(`SELECT 1 FROM "RoomMember" WHERE "roomId"=$1 AND "isHost"`, [
        c.roomId,
      ]);
      expect(hosts).toHaveLength(1);
      const newcomer = await join(s.http, c.inviteCode, 'NewHost');
      expect(newcomer.res.body.me.isHost).toBe(false);
    },
  );

  it(
    ac(['AC-ROOM-002-4'], 'S1 §4.3', '없는 초대 코드 → 404 INVITE_NOT_FOUND (인증 다음, 검증 앞)'),
    async () => {
      expectApiError((await join(s.http, 'nope', '')).res, 404, 'INVITE_NOT_FOUND'); // 닉네임이 비어도 404가 먼저다
    },
  );

  it('키 누락·형식 오류는 401이며 초대 코드 존재보다 앞이다', async () => {
    expectApiError(
      await s.http.post('/invites/nope/members').send({ nickname: 'x' }),
      401,
      'UNAUTHENTICATED',
    );
  });

  it(ac(['AC-ROOM-002-5'], 'S1 §4.3', 'ENDED 방에서도 입장·복원이 허용된다'), async () => {
    const c = await createRoom(s.http);
    const member = await join(s.http, c.inviteCode, 'Kim');
    await endRoom(s.db, c.roomId);
    expect((await join(s.http, c.inviteCode, 'Late')).res.status).toBe(201);
    expect((await join(s.http, c.inviteCode, 'x', member.key)).res.status).toBe(200);
  });

  it('입장은 revision을 소비하지 않고 Participant를 만들지 않는다(N-5)', async () => {
    const c = await createRoom(s.http);
    await join(s.http, c.inviteCode, 'Kim');
    await join(s.http, c.inviteCode, 'Lee');
    expect(await revision(s.db, c.roomId)).toBe(0);
    expect(await count(s.db, 'Participant', c.roomId)).toBe(0);
  });

  describe('닉네임 규칙(RoomMember 쪽)', () => {
    it(
      ac(
        ['AC-ROOM-006-1', 'AC-ROOM-006-9'],
        'S1 §3.2',
        '닉네임 길이 1·12 허용, 0·13 거부(우회 요청 포함)',
      ),
      async () => {
        const c = await createRoom(s.http);
        expect((await join(s.http, c.inviteCode, 'a')).res.status).toBe(201);
        expect((await join(s.http, c.inviteCode, 'b'.repeat(12))).res.status).toBe(201);
        expectApiError(
          (await join(s.http, c.inviteCode, 'c'.repeat(13))).res,
          422,
          'VALIDATION_FAILED',
          [{ field: 'nickname', code: 'LENGTH_OUT_OF_RANGE' }],
        );
        expectApiError((await join(s.http, c.inviteCode, '')).res, 422, 'VALIDATION_FAILED', [
          { field: 'nickname', code: 'REQUIRED' },
        ]);
      },
    );

    it(
      ac(['AC-ROOM-006-2'], 'S1 §3.2', '한글 음절·단독 자모("ㅋㅋ")·영문·숫자·"Kim Min" 허용'),
      async () => {
        const c = await createRoom(s.http);
        for (const nick of ['김민', 'ㅋㅋ', 'Kim', '123', 'Kim Min']) {
          expect((await join(s.http, c.inviteCode, nick)).res.status, nick).toBe(201);
        }
      },
    );

    it(
      ac(
        ['AC-ROOM-006-3', 'AC-ROOM-006-12'],
        'S1 §3.2',
        '앞뒤 공백·연속 공백 거부, 자동 제거 없음',
      ),
      async () => {
        const c = await createRoom(s.http);
        expectApiError((await join(s.http, c.inviteCode, ' Kim')).res, 422, 'VALIDATION_FAILED', [
          { field: 'nickname', code: 'LEADING_OR_TRAILING_SPACE' },
        ]);
        expectApiError(
          (await join(s.http, c.inviteCode, 'Kim  Min')).res,
          422,
          'VALIDATION_FAILED',
          [{ field: 'nickname', code: 'CONSECUTIVE_SPACES' }],
        );
        expect(await count(s.db, 'RoomMember', c.roomId)).toBe(1); // 방장만
      },
    );

    it(
      ac(['AC-ROOM-006-4'], 'S1 §3.2', '`!` `_` `-`, 이모지, U+3164, 미결합 조합용 자모 거부'),
      async () => {
        const c = await createRoom(s.http);
        for (const nick of ['a!', 'a_b', 'a-b', '😀', 'aㅤ', 'aᄀ']) {
          expectApiError((await join(s.http, c.inviteCode, nick)).res, 422, 'VALIDATION_FAILED', [
            { field: 'nickname', code: 'INVALID_CHARACTER' },
          ]);
        }
      },
    );

    it(
      ac(
        ['AC-ROOM-006-5'],
        'S1 §3.2',
        '"Kim" 사용 중 → "kim"·"KIM" 거부 NICKNAME_TAKEN(RoomMember 유형)',
      ),
      async () => {
        const c = await createRoom(s.http);
        await join(s.http, c.inviteCode, 'Kim');
        for (const nick of ['kim', 'KIM', 'Kim']) {
          expectApiError((await join(s.http, c.inviteCode, nick)).res, 409, 'NICKNAME_TAKEN');
        }
      },
    );

    it(
      ac(['AC-ROOM-006-6'], 'S1 §2.2', 'RoomMember "Kim"과 Participant "Kim"은 공존한다'),
      async () => {
        const c = await createRoom(s.http);
        await join(s.http, c.inviteCode, 'Kim');
        expect((await addParticipant(s.http, c, 'Kim')).status).toBe(201);
      },
    );

    it(ac(['AC-ROOM-006-7'], 'S1 §2.2', '다른 방에서는 같은 닉네임을 쓸 수 있다'), async () => {
      const a = await createRoom(s.http);
      const b = await createRoom(s.http);
      expect((await join(s.http, a.inviteCode, 'Kim')).res.status).toBe(201);
      expect((await join(s.http, b.inviteCode, 'Kim')).res.status).toBe(201);
    });

    it(
      ac(
        ['AC-ROOM-006-13'],
        'S1 §3.2',
        '조합형·분해형 한글이 NFC 후 같은 값이라 서로 중복이고, 호환 자모와 음절은 다른 값이다',
      ),
      async () => {
        const c = await createRoom(s.http);
        const composed = '한글';
        expect((await join(s.http, c.inviteCode, composed)).res.status).toBe(201);
        expectApiError(
          (await join(s.http, c.inviteCode, composed.normalize('NFD'))).res,
          409,
          'NICKNAME_TAKEN',
        );
        expect((await join(s.http, c.inviteCode, 'ㅎㅏㄴ')).res.status).toBe(201); // 호환 자모 낱자 나열은 다른 값
      },
    );

    it('방장 닉네임도 닉네임 중복 판정에 포함한다(방 생성자도 RoomMember)', async () => {
      const c = await createRoom(s.http, { nickname: 'Host' });
      expectApiError((await join(s.http, c.inviteCode, 'host')).res, 409, 'NICKNAME_TAKEN');
    });
  });

  describe('한도(RoomMember 10명)', () => {
    it(
      ac(
        ['AC-ROOM-008-1', 'AC-ROOM-008-11'],
        'S1 §6.4',
        '10번째 성공, 11번째 409 MEMBER_LIMIT_EXCEEDED(details.limit). 10명 방에서 기존 신원은 복원된다',
      ),
      async () => {
        const c = await createRoom(s.http); // 방장 1명
        const keys: string[] = [];
        for (let i = 2; i <= 10; i++) {
          const { key, res } = await join(s.http, c.inviteCode, `m${i}`);
          expect(res.status, `member ${i}`).toBe(201);
          keys.push(key);
        }
        expect(await count(s.db, 'RoomMember', c.roomId)).toBe(10);
        const eleventh = await join(s.http, c.inviteCode, 'm11');
        expectApiError(eleventh.res, 409, 'MEMBER_LIMIT_EXCEEDED', [{ limit: 10 }]);
        expect(await count(s.db, 'RoomMember', c.roomId)).toBe(10); // 부분 저장 없음
        // 기존 신원은 한도와 무관하게 복원된다
        expect((await join(s.http, c.inviteCode, 'x', keys[0])).res.status).toBe(200);
        expect((await join(s.http, c.inviteCode, 'x', c.key)).res.status).toBe(200);
      },
    );

    it('8번(닉네임 중복)이 9번(한도)보다 앞이다', async () => {
      const c = await createRoom(s.http, { nickname: 'Host' });
      for (let i = 2; i <= 10; i++) await join(s.http, c.inviteCode, `m${i}`);
      expectApiError((await join(s.http, c.inviteCode, 'M2')).res, 409, 'NICKNAME_TAKEN');
    });
  });

  it('요청 키가 없는 본문의 닉네임 검증은 7번(422)이고 복원 경로에서는 본문 파싱 실패도 무시된다', async () => {
    const c = await createRoom(s.http);
    const bad = await s.http
      .post(`/invites/${c.inviteCode}/members`)
      .set(auth(newKey()))
      .set('Content-Type', 'application/json')
      .send('{"nick');
    expectApiError(bad, 422, 'VALIDATION_FAILED', [{ field: 'body', code: 'INVALID_VALUE' }]);
    const restored = await s.http
      .post(`/invites/${c.inviteCode}/members`)
      .set(auth(c.key))
      .set('Content-Type', 'application/json')
      .send('{"nick');
    expect(restored.status).toBe(200);
  });
});
