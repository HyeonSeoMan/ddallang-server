import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ac, expectApiError } from '../helpers/contract.js';
import { auth, bootS1, count, createRoom, newKey, type S1Env } from './s1-helpers.js';

let s: S1Env;
beforeAll(async () => {
  s = await bootS1();
});
afterAll(() => s?.close());

const post = (body: unknown, key = newKey()) =>
  s.http
    .post('/rooms')
    .set(auth(key))
    .send(body as object);
const valid = { name: 'Friday 7', unit: '원', nickname: 'Host' };

describe('POST /rooms (S1 §4.1)', () => {
  it(
    ac(
      ['AC-ROOM-001-1', 'AC-ROOM-001-7', 'AC-ROOM-001-9'],
      'S1 §4.1',
      '유효 입력 → 201, IN_PROGRESS, 초대 코드, 방장 me(방장 닉네임이 됨)',
    ),
    async () => {
      const key = newKey();
      const res = await post(valid, key);
      expect(res.status).toBe(201);
      expect(res.body.room).toMatchObject({ name: 'Friday 7', unit: '원', status: 'IN_PROGRESS' });
      expect(res.body.room.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(res.body.room.inviteCode).toMatch(/^[A-Za-z0-9_-]{22}$/); // 128비트 URL-safe
      expect(res.body.room.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(res.body.me).toMatchObject({
        roomId: res.body.room.id,
        nickname: 'Host',
        isHost: true,
      });
      // 서버 내부 값은 응답에 없다
      expect(JSON.stringify(res.body)).not.toContain(key);
      expect(res.body.room).not.toHaveProperty('revision');
      expect(res.body.me).not.toHaveProperty('identityKeyHash');
      expect(res.body.me).not.toHaveProperty('nicknameKey');
      // 생성 직후 방장은 정확히 1명, 생성자 RoomMember
      expect(await count(s.db, 'RoomMember', res.body.room.id)).toBe(1);
      const hosts = await s.db.query(`SELECT 1 FROM "RoomMember" WHERE "roomId"=$1 AND "isHost"`, [
        res.body.room.id,
      ]);
      expect(hosts).toHaveLength(1);
    },
  );

  it(
    ac(
      ['AC-ROOM-001-2', 'AC-ROOM-001-8'],
      'S1 §3.2',
      '빈·누락 name → 422 REQUIRED, 방이 만들어지지 않는다(우회 요청 포함)',
    ),
    async () => {
      const before = await count(s.db, 'Room');
      for (const name of [undefined, null, '']) {
        const res = await post({ ...valid, name });
        expectApiError(res, 422, 'VALIDATION_FAILED', [{ field: 'name', code: 'REQUIRED' }]);
      }
      expectApiError(await post({ ...valid, name: 123 }), 422, 'VALIDATION_FAILED', [
        { field: 'name', code: 'INVALID_TYPE' },
      ]);
      expect(await count(s.db, 'Room')).toBe(before);
    },
  );

  it(
    ac(
      ['AC-ROOM-001-3', 'AC-ROOM-001-8'],
      'S1 §3.2',
      'name 길이 1·12 허용, 0·13 거부(코드 포인트)',
    ),
    async () => {
      expect((await post({ ...valid, name: 'a' })).status).toBe(201);
      expect((await post({ ...valid, name: 'a'.repeat(12) })).status).toBe(201);
      expectApiError(await post({ ...valid, name: 'a'.repeat(13) }), 422, 'VALIDATION_FAILED', [
        { field: 'name', code: 'LENGTH_OUT_OF_RANGE' },
      ]);
    },
  );

  it(
    ac(
      ['AC-ROOM-001-4', 'AC-ROOM-001-8'],
      'S1 §3.2',
      '"Friday 7" 허용, 앞뒤 공백·특수문자·이모지 거부, 공백 자동 제거 없음',
    ),
    async () => {
      const ok = await post({ ...valid, name: 'Friday 7' });
      expect(ok.body.room.name).toBe('Friday 7');
      expectApiError(await post({ ...valid, name: ' Friday' }), 422, 'VALIDATION_FAILED', [
        { field: 'name', code: 'LEADING_OR_TRAILING_SPACE' },
      ]);
      expectApiError(await post({ ...valid, name: 'Friday!' }), 422, 'VALIDATION_FAILED', [
        { field: 'name', code: 'INVALID_CHARACTER' },
      ]);
      expectApiError(await post({ ...valid, name: '😀' }), 422, 'VALIDATION_FAILED', [
        { field: 'name', code: 'INVALID_CHARACTER' },
      ]);
    },
  );

  it(
    ac(['AC-ROOM-001-5'], 'S1 §4.1', '같은 이름의 방을 둘 만들 수 있다(다른 방·다른 초대 코드)'),
    async () => {
      const a = await post({ ...valid, name: 'Same' });
      const b = await post({ ...valid, name: 'Same' });
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.room.id).not.toBe(b.body.room.id);
      expect(a.body.room.inviteCode).not.toBe(b.body.room.inviteCode);
    },
  );

  it(
    ac(['AC-ROOM-001-6', 'AC-ROOM-001-8'], 'S1 §4.1', 'unit 누락 → 422, 방이 만들어지지 않는다'),
    async () => {
      const before = await count(s.db, 'Room');
      const res = await post({ name: 'x', nickname: 'Host' });
      expectApiError(res, 422, 'VALIDATION_FAILED', [{ field: 'unit', code: 'REQUIRED' }]);
      expect(await count(s.db, 'Room')).toBe(before);
    },
  );

  it(
    ac(
      ['AC-ROOM-001-9', 'AC-ROOM-001-8'],
      'S1 §4.1',
      'nickname 누락·규칙 위반 → 422, 방이 만들어지지 않는다',
    ),
    async () => {
      const before = await count(s.db, 'Room');
      expectApiError(await post({ name: 'x', unit: '원' }), 422, 'VALIDATION_FAILED', [
        { field: 'nickname', code: 'REQUIRED' },
      ]);
      expectApiError(
        await post({ name: 'x', unit: '원', nickname: 'a  b' }),
        422,
        'VALIDATION_FAILED',
        [{ field: 'nickname', code: 'CONSECUTIVE_SPACES' }],
      );
      expect(await count(s.db, 'Room')).toBe(before);
      expect(await count(s.db, 'RoomMember')).toBe(await count(s.db, 'Room')); // 고아 RoomMember 없음
    },
  );

  it(
    ac(
      ['AC-ROOM-001-10', 'AC-ROOM-001-8'],
      'S1 §3.2',
      '"Friday  7"(연속 공백) 거부 CONSECUTIVE_SPACES',
    ),
    async () => {
      expectApiError(await post({ ...valid, name: 'Friday  7' }), 422, 'VALIDATION_FAILED', [
        { field: 'name', code: 'CONSECUTIVE_SPACES' },
      ]);
    },
  );

  it(
    ac(
      ['AC-ROOM-001-11'],
      'S1 §3.2',
      '조합형·분해형 한글 이름이 같은 길이·같은 저장값으로 판정된다',
    ),
    async () => {
      const composed = '한글방한글방한글방'; // 9자
      const decomposed = composed.normalize('NFD');
      expect(decomposed.length).toBeGreaterThan(composed.length);
      const res = await post({ ...valid, name: decomposed });
      expect(res.status).toBe(201);
      expect(res.body.room.name).toBe(composed); // 저장·응답은 정규화한 값
    },
  );

  it(
    ac(
      ['AC-ROOM-001-13', 'AC-ROOM-001-8'],
      'S1 §3.2',
      'unit 직접 입력: "포인트"·"Chip 10" 허용, 길이 0·13, 앞뒤·연속 공백, 특수문자, 이모지 거부',
    ),
    async () => {
      for (const unit of ['포인트', 'Chip 10', '원', '점수', '칩']) {
        expect((await post({ ...valid, unit })).status, unit).toBe(201);
      }
      const bad: [string, string][] = [
        ['', 'REQUIRED'],
        ['a'.repeat(13), 'LENGTH_OUT_OF_RANGE'],
        [' 포인트', 'LEADING_OR_TRAILING_SPACE'],
        ['Chip  10', 'CONSECUTIVE_SPACES'],
        ['pt$', 'INVALID_CHARACTER'],
        ['🪙', 'INVALID_CHARACTER'],
      ];
      for (const [unit, code] of bad) {
        expectApiError(await post({ ...valid, unit }), 422, 'VALIDATION_FAILED', [
          { field: 'unit', code },
        ]);
      }
    },
  );

  it(
    ac(
      ['AC-ROOM-001-14', 'AC-ROOM-003-3'],
      'S1 §6.3',
      '저장된 unit이 방 조회에서 그대로 반환된다(환산 없음)',
    ),
    async () => {
      const c = await createRoom(s.http, { unit: 'Chip 10' });
      const res = await s.http.get(`/rooms/${c.roomId}`).set(auth(c.key));
      expect(res.body.room.unit).toBe('Chip 10');
    },
  );

  it('여러 필드가 틀리면 위반 항목 전체를 모아 반환한다(name, unit, nickname 순)', async () => {
    const res = await post({ name: '', unit: 'x!', nickname: ' a' });
    expectApiError(res, 422, 'VALIDATION_FAILED', [
      { field: 'name', code: 'REQUIRED' },
      { field: 'unit', code: 'INVALID_CHARACTER' },
      { field: 'nickname', code: 'LEADING_OR_TRAILING_SPACE' },
    ]);
  });

  it('인증: 키 누락·형식 오류는 입력 검증보다 앞서 401이다', async () => {
    expectApiError(await s.http.post('/rooms').send(valid), 401, 'UNAUTHENTICATED');
    expectApiError(
      await s.http.post('/rooms').set('Authorization', 'Bearer short').send({}),
      401,
      'UNAUTHENTICATED',
    );
  });

  it('본문이 JSON이 아니거나 객체가 아니면 422이고 방이 생기지 않는다', async () => {
    const before = await count(s.db, 'Room');
    const bad = await s.http
      .post('/rooms')
      .set(auth(newKey()))
      .set('Content-Type', 'application/json')
      .send('{"name":');
    expectApiError(bad, 422, 'VALIDATION_FAILED', [{ field: 'body', code: 'INVALID_VALUE' }]);
    const arr = await s.http.post('/rooms').set(auth(newKey())).send([1, 2]);
    expect(arr.status).toBe(422);
    expect(await count(s.db, 'Room')).toBe(before);
  });

  it('Idempotency Key가 없다: 같은 요청을 다시 보내면 별도의 방이 생긴다(S1 §6.5)', async () => {
    const key = newKey();
    const a = await post(valid, key);
    const b = await post(valid, key);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.room.id).not.toBe(b.body.room.id);
  });
});
