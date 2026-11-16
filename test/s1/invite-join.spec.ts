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
  pendingClaimFixture,
  revision,
  revokeFixture,
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
const participants = (c: { roomId: string; key: string }) =>
  s.http.get(`/rooms/${c.roomId}/participants`).set(auth(c.key));
const setStatus = (c: { roomId: string; key: string }, id: string, status: string) =>
  s.http.patch(`/rooms/${c.roomId}/participants/${id}`).set(auth(c.key)).send({ status });

describe('GET /invites/{inviteCode} (S1 §4.2)', () => {
  it(
    ac(
      ['AC-ROOM-004-1'],
      'S1 §4.2',
      '입장 전 공개는 이름·정산 단위·진행 상태·신원 상태·최근 요청·후보 닉네임뿐이다(방 ID·코드·참여자 ID·상태·order·방장 닉네임·인원 수 없음)',
    ),
    async () => {
      const c = await createRoom(s.http, { name: 'Open', unit: '칩', nickname: 'Boss' });
      await join(s.http, c.inviteCode, 'Kim');
      const p1 = (await addParticipant(s.http, c, 'P1')).body.participant.id as string;
      await setStatus(c, p1, 'INACTIVE');
      const res = await invite(c.inviteCode);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        room: { name: 'Open', unit: '칩', status: 'IN_PROGRESS' },
        identity: 'NONE',
        claim: null,
        claimableNicknames: ['Kim', 'P1'],
      });
      const text = JSON.stringify(res.body);
      for (const secret of [c.roomId, c.inviteCode, c.hostId, p1, 'Boss', 'INACTIVE', 'order'])
        expect(text).not.toContain(secret);
    },
  );

  it(
    ac(
      ['AC-ROOM-005-1', 'AC-ROOM-005-3', 'AC-ROOM-005-5'],
      'S1 §4.2',
      '연결된 키는 identity=PARTICIPANT(후보 없음), 다른 키·키 없음·형식 오류는 NONE(후보 있음, 오류 아님)',
    ),
    async () => {
      const c = await createRoom(s.http);
      const kim = await join(s.http, c.inviteCode, 'Kim');
      for (const key of [c.key, kim.key]) {
        const r = await invite(c.inviteCode, key);
        expect(r.body).toMatchObject({
          identity: 'PARTICIPANT',
          claim: null,
          claimableNicknames: [],
        });
      }
      for (const r of [
        await invite(c.inviteCode, newKey()),
        await invite(c.inviteCode),
        await s.http.get(`/invites/${c.inviteCode}`).set('Authorization', 'Bearer not-a-key'),
      ]) {
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
          identity: 'NONE',
          claim: null,
          claimableNicknames: ['Kim'],
        });
      }
    },
  );

  it(
    ac(
      ['AC-ROOM-005-8'],
      'S1 §4.2',
      '대기 키는 PENDING(후보 없음·claim은 그 요청), 접근을 잃은 키는 401이 아니라 REVOKED(후보 있음)',
    ),
    async () => {
      const c = await createRoom(s.http);
      const target = (await addParticipant(s.http, c, 'Direct')).body.participant.id as string;
      const waiting = newKey();
      const claimId = await pendingClaimFixture(s.db, c.roomId, target, waiting);
      const pending = await invite(c.inviteCode, waiting);
      expect(pending.body).toMatchObject({
        identity: 'PENDING',
        claimableNicknames: [],
        claim: { id: claimId, nickname: 'Direct', status: 'PENDING', rejectReason: null },
      });
      expect(pending.body.claim).not.toHaveProperty('participantId');
      expect(pending.body.claim).not.toHaveProperty('resolvedById');

      const old = newKey();
      await revokeFixture(s.db, c.roomId, target, old);
      const revoked = await invite(c.inviteCode, old);
      expect(revoked.status).toBe(200);
      expect(revoked.body).toMatchObject({
        identity: 'REVOKED',
        claim: null,
        claimableNicknames: ['Direct'],
      });
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

  it(
    ac(['AC-ROOM-002-5'], 'S1 §4.2', 'ENDED 방에서도 초대 조회가 200이고 후보를 보인다'),
    async () => {
      const c = await createRoom(s.http);
      await addParticipant(s.http, c, 'P1');
      await endRoom(s.db, c.roomId);
      const res = await invite(c.inviteCode);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ room: { status: 'ENDED' }, claimableNicknames: ['P1'] });
    },
  );

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
      ['AC-ROOM-002-1', 'AC-ROOM-007-1', 'AC-ROOM-004-1'],
      'S1 §4.3',
      '유효 코드+닉네임 → 201, me는 ACTIVE·isHost=false·order가 기존 최댓값보다 큰 새 참여자이고 목록에 있다. 가입·비밀번호 없음',
    ),
    async () => {
      const c = await createRoom(s.http);
      await addParticipant(s.http, c, 'P1'); // order 2
      const before = await count(s.db, 'Participant', c.roomId);
      const { res } = await join(s.http, c.inviteCode, 'Kim');
      expect(res.status).toBe(201);
      expect(res.body.room).toEqual({
        id: c.roomId,
        name: 'Friday 7',
        unit: '원',
        status: 'IN_PROGRESS',
      });
      expect(res.body.me).toMatchObject({
        roomId: c.roomId,
        nickname: 'Kim',
        status: 'ACTIVE',
        isHost: false,
        order: 3,
      });
      expect(res.body.room).not.toHaveProperty('inviteCode');
      expect(await count(s.db, 'Participant', c.roomId)).toBe(before + 1); // 입장은 참여자 1명
      const list = (await participants(c)).body.participants as { id: string }[];
      expect(list.map((p) => p.id)).toContain(res.body.me.id);
    },
  );

  it(
    ac(
      ['AC-ROOM-005-1', 'AC-ROOM-005-6', 'AC-ROOM-002-8', 'AC-ROOM-004-1'],
      'S1 §4.3',
      '같은 키 재입장 → 200 같은 me.id(닉네임 무시), 참여자 수 불변·이벤트 없음. 방장 키도 같은 방장',
    ),
    async () => {
      const c = await createRoom(s.http);
      const first = await join(s.http, c.inviteCode, 'Kim');
      const n = await count(s.db, 'Participant', c.roomId);
      const rev = await revision(s.db, c.roomId);
      const again = await join(s.http, c.inviteCode, 'Other', first.key);
      expect(again.res.status).toBe(200);
      expect(again.res.body.me).toEqual(first.res.body.me);
      const noBody = await s.http.post(`/invites/${c.inviteCode}/members`).set(auth(first.key));
      expect(noBody.status).toBe(200);
      const host = await s.http.post(`/invites/${c.inviteCode}/members`).set(auth(c.key)).send({});
      expect(host.status).toBe(200);
      expect(host.body.me).toMatchObject({ id: c.hostId, isHost: true, order: 1 });
      expect(await count(s.db, 'Participant', c.roomId)).toBe(n);
      expect(await revision(s.db, c.roomId)).toBe(rev); // 복원은 이벤트 대상이 아니다
    },
  );

  it(
    ac(
      ['AC-ROOM-002-8'],
      'S1 §4.3, §6.5',
      '첫 요청이 처리되지 않았던 키의 재시도는 새 입장(201). 다른 키·같은 닉네임은 409 NICKNAME_TAKEN',
    ),
    async () => {
      const c = await createRoom(s.http);
      const key = newKey();
      const first = await join(s.http, c.inviteCode, 'Kim', key);
      expect(first.res.status).toBe(201);
      expectApiError((await join(s.http, c.inviteCode, 'Kim')).res, 409, 'NICKNAME_TAKEN');
    },
  );

  it(
    ac(
      ['AC-ROOM-005-3', 'AC-ROOM-005-4', 'AC-ROOM-005-5', 'AC-ROOM-005-7'],
      'S1 §6.1',
      '키를 잃고 다른 키로 입장하면 새 참여자이며 방장·이전 신원으로 인식되지 않는다. 방장 키를 잃어도 아무도 방장이 되지 않는다',
    ),
    async () => {
      const c = await createRoom(s.http);
      const lost = await join(s.http, c.inviteCode, 'Han'); // 이전 키(소실)
      const fresh = await join(s.http, c.inviteCode, 'Han2'); // 새 키
      expect(fresh.res.status).toBe(201);
      expect(fresh.res.body.me.id).not.toBe(lost.res.body.me.id);
      expect(fresh.res.body.me.isHost).toBe(false);
      const newcomer = await join(s.http, c.inviteCode, 'NewHost'); // 방장 키를 잃은 방장의 새 입장
      expect(newcomer.res.body.me.isHost).toBe(false);
      const hosts = await s.db.query<{ id: string }>(
        `SELECT "id" FROM "Participant" WHERE "roomId"=$1 AND "isHost"`,
        [c.roomId],
      );
      expect(hosts).toEqual([{ id: c.hostId }]);
    },
  );

  it(
    ac(
      ['AC-ROOM-005-8'],
      'S1 §4.3 2',
      '접근을 잃은 키의 입장 → 401 IDENTITY_REVOKED, 참여자 미생성',
    ),
    async () => {
      const c = await createRoom(s.http);
      const target = (await addParticipant(s.http, c, 'Direct')).body.participant.id as string;
      const old = newKey();
      await revokeFixture(s.db, c.roomId, target, old);
      const n = await count(s.db, 'Participant', c.roomId);
      expectApiError((await join(s.http, c.inviteCode, 'Again', old)).res, 401, 'IDENTITY_REVOKED');
      expect(await count(s.db, 'Participant', c.roomId)).toBe(n);
    },
  );

  it('대기 키의 입장 → 409 CLAIM_PENDING(P-8), 참여자 미생성. 게임 상태·닉네임보다 앞이다', async () => {
    const c = await createRoom(s.http);
    const target = (await addParticipant(s.http, c, 'Direct')).body.participant.id as string;
    const waiting = newKey();
    await pendingClaimFixture(s.db, c.roomId, target, waiting);
    const n = await count(s.db, 'Participant', c.roomId);
    expectApiError((await join(s.http, c.inviteCode, 'Fresh', waiting)).res, 409, 'CLAIM_PENDING');
    expectApiError((await join(s.http, c.inviteCode, '', waiting)).res, 409, 'CLAIM_PENDING');
    await endRoom(s.db, c.roomId);
    expectApiError((await join(s.http, c.inviteCode, 'Fresh', waiting)).res, 409, 'CLAIM_PENDING');
    expect(await count(s.db, 'Participant', c.roomId)).toBe(n);
  });

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

  it(
    ac(
      ['AC-ROOM-002-5', 'AC-PART-004-1', 'AC-ROOM-005-1'],
      'S1 §4.3, §5.3',
      'ENDED 방: 새 키 입장 → 409 GAME_ENDED, 참여자 수 불변. 기존 키 복원은 200',
    ),
    async () => {
      const c = await createRoom(s.http);
      const kim = await join(s.http, c.inviteCode, 'Kim');
      await endRoom(s.db, c.roomId);
      const n = await count(s.db, 'Participant', c.roomId);
      expectApiError((await join(s.http, c.inviteCode, 'Late')).res, 409, 'GAME_ENDED');
      expectApiError((await join(s.http, c.inviteCode, '')).res, 409, 'GAME_ENDED'); // 5번이 7번보다 앞
      expect(await count(s.db, 'Participant', c.roomId)).toBe(n);
      const restored = await join(s.http, c.inviteCode, 'x', kim.key);
      expect(restored.res.status).toBe(200);
      expect(restored.res.body).toMatchObject({
        room: { status: 'ENDED' },
        me: { id: kim.res.body.me.id },
      });
      expect((await join(s.http, c.inviteCode, 'x', c.key)).res.status).toBe(200);
    },
  );

  it('새 입장은 participant.created로 revision을 하나 소비한다(S5 §4.2, N-5 대체)', async () => {
    const c = await createRoom(s.http);
    await join(s.http, c.inviteCode, 'Kim');
    await join(s.http, c.inviteCode, 'Lee');
    expect(await revision(s.db, c.roomId)).toBe(2);
    expectApiError((await join(s.http, c.inviteCode, 'kim')).res, 409, 'NICKNAME_TAKEN');
    expect(await revision(s.db, c.roomId)).toBe(2); // 거부는 소비하지 않는다
  });

  describe('닉네임 규칙(입장)', () => {
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
        expect(await count(s.db, 'Participant', c.roomId)).toBe(1); // 방장만
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
      ac(['AC-ROOM-006-5'], 'S1 §6.2', '"Kim" 사용 중 → "kim"·"KIM"의 입장 거부 NICKNAME_TAKEN'),
      async () => {
        const c = await createRoom(s.http);
        await join(s.http, c.inviteCode, 'Kim');
        for (const nick of ['kim', 'KIM', 'Kim']) {
          expectApiError((await join(s.http, c.inviteCode, nick)).res, 409, 'NICKNAME_TAKEN');
        }
      },
    );

    it(
      ac(
        ['AC-ROOM-006-6', 'AC-ROOM-002-6'],
        'S1 §6.2',
        '입장 참여자 "Kim" → 직접 추가 "kim" 409. 직접 추가 "Kim" → 입장 "kim" 409(이어받기 안내 문구)',
      ),
      async () => {
        const a = await createRoom(s.http);
        await join(s.http, a.inviteCode, 'Kim');
        expectApiError(await addParticipant(s.http, a, 'kim'), 409, 'NICKNAME_TAKEN');
        const b = await createRoom(s.http);
        expect((await addParticipant(s.http, b, 'Kim')).status).toBe(201);
        const res = (await join(s.http, b.inviteCode, 'kim')).res;
        expectApiError(res, 409, 'NICKNAME_TAKEN');
        expect(res.body.error.message).toContain('이어받기');
      },
    );

    it(
      ac(
        ['AC-ROOM-006-10', 'AC-ROOM-002-6'],
        'S1 §6.2',
        '비활성 참여자와 대소문자 무시 같은 닉네임의 입장·직접 추가 → 409',
      ),
      async () => {
        const c = await createRoom(s.http);
        const kim = (await addParticipant(s.http, c, 'Kim')).body.participant.id as string;
        await setStatus(c, kim, 'INACTIVE');
        expectApiError((await join(s.http, c.inviteCode, 'KIM')).res, 409, 'NICKNAME_TAKEN');
        expectApiError(await addParticipant(s.http, c, 'kim'), 409, 'NICKNAME_TAKEN');
      },
    );

    it(ac(['AC-ROOM-006-7'], 'S1 §6.2', '다른 방에서는 같은 닉네임을 쓸 수 있다'), async () => {
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

    it('방장 닉네임도 닉네임 중복 판정에 포함한다(방 생성자도 참여자)', async () => {
      const c = await createRoom(s.http, { nickname: 'Host' });
      expectApiError((await join(s.http, c.inviteCode, 'host')).res, 409, 'NICKNAME_TAKEN');
    });
  });

  describe('한도(참여자 10명, 입장·직접 추가·방장 모두 센다)', () => {
    it(
      ac(
        ['AC-ROOM-008-1', 'AC-ROOM-008-4', 'AC-ROOM-008-8'],
        'S1 §6.4',
        '9명 방에서 입장 성공(10명), 10명 방에서 입장 409 PARTICIPANT_LIMIT_EXCEEDED(details.limit, 이어받기 안내), 부분 저장 없음',
      ),
      async () => {
        const c = await createRoom(s.http); // 방장 1명
        for (let i = 2; i <= 5; i++) await addParticipant(s.http, c, `d${i}`); // 신원 없는 참여자 4명
        for (let i = 6; i <= 9; i++) await join(s.http, c.inviteCode, `m${i}`);
        expect(await count(s.db, 'Participant', c.roomId)).toBe(9);
        expect((await join(s.http, c.inviteCode, 'm10')).res.status).toBe(201);
        expect(await count(s.db, 'Participant', c.roomId)).toBe(10);
        const rev = await revision(s.db, c.roomId);
        const eleventh = (await join(s.http, c.inviteCode, 'm11')).res;
        expectApiError(eleventh, 409, 'PARTICIPANT_LIMIT_EXCEEDED', [{ limit: 10 }]);
        expect(eleventh.body.error.message).toContain('이어받기');
        expect(await count(s.db, 'Participant', c.roomId)).toBe(10); // 부분 저장 없음
        expect(await revision(s.db, c.roomId)).toBe(rev);
      },
    );

    it(
      ac(
        ['AC-ROOM-008-6', 'AC-ROOM-008-7'],
        'S1 §6.4',
        '비활성·직접 추가·신원 상실 참여자도 센다: 10명 중 1명 비활성화 뒤에도 입장·직접 추가 거부',
      ),
      async () => {
        const c = await createRoom(s.http);
        const ids: string[] = [];
        for (let i = 2; i <= 6; i++)
          ids.push((await addParticipant(s.http, c, `d${i}`)).body.participant.id as string);
        for (let i = 7; i <= 10; i++) await join(s.http, c.inviteCode, `m${i}`);
        await revokeFixture(s.db, c.roomId, ids[1]!, newKey()); // 신원을 잃은 참여자도 남는다
        await setStatus(c, ids[0]!, 'INACTIVE');
        expectApiError(
          (await join(s.http, c.inviteCode, 'late')).res,
          409,
          'PARTICIPANT_LIMIT_EXCEEDED',
        );
        expectApiError(await addParticipant(s.http, c, 'late'), 409, 'PARTICIPANT_LIMIT_EXCEEDED');
      },
    );

    it(
      ac(['AC-ROOM-008-11'], 'S1 §6.4', '10명 방에서도 기존 키 복원은 200, 참여자 수 10 유지'),
      async () => {
        const c = await createRoom(s.http);
        const keys: string[] = [];
        for (let i = 2; i <= 10; i++) keys.push((await join(s.http, c.inviteCode, `m${i}`)).key);
        expect((await join(s.http, c.inviteCode, 'x', keys[0])).res.status).toBe(200);
        expect((await join(s.http, c.inviteCode, 'x', c.key)).res.status).toBe(200);
        expect(await count(s.db, 'Participant', c.roomId)).toBe(10);
      },
    );

    it('8번(닉네임 중복)이 9번(한도)보다 앞이다', async () => {
      const c = await createRoom(s.http, { nickname: 'Host' });
      for (let i = 2; i <= 10; i++) await join(s.http, c.inviteCode, `m${i}`);
      expectApiError((await join(s.http, c.inviteCode, 'M2')).res, 409, 'NICKNAME_TAKEN');
    });
  });

  it('본문의 닉네임 검증은 7번(422)이고 복원 경로에서는 본문 파싱 실패도 무시된다', async () => {
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
