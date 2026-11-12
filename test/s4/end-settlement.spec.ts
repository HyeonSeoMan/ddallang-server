import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ac, expectApiError } from '../helpers/contract.js';
import {
  addParticipant,
  auth,
  bootS2,
  delTx,
  fresh,
  join,
  postTx,
  putTx,
  revision,
  setupRoom,
  validBody,
  type Idem,
  type S2Env,
  type Setup,
} from '../s2/s2-helpers.js';
import { seedTransactions } from '../s3/s3-helpers.js';

let s: S2Env;
beforeAll(async () => {
  s = await bootS2();
});
afterAll(() => s?.close());

const HOUR = 3_600_000;
const end = (r: Setup, key = r.c.key, idem: Idem | false = fresh(), body?: unknown) => {
  const req = s.http.post(`/rooms/${r.c.roomId}/end`).set(auth(key));
  if (idem) req.set('Idempotency-Key', idem.key).set('Idempotency-First-Attempt-At', idem.at);
  return body === undefined ? req : req.send(body as object);
};
const settle = (r: Setup, key = r.c.key, qs = '') =>
  s.http.get(`/rooms/${r.c.roomId}/settlement${qs}`).set(auth(key));
const pay = (r: Setup, payer: string, payee: string, amount: number) =>
  postTx(s.http, r.c.roomId, r.c.key, { payerId: payer, payeeId: payee, amount });
const status = async (r: Setup) =>
  (
    await s.db.query<{ status: string }>(`SELECT "status" FROM "Room" WHERE "id"=$1`, [r.c.roomId])
  )[0]!.status;
const records = async (r: Setup) =>
  Number(
    (
      await s.db.query<{ n: string }>(
        `SELECT count(*)::text n FROM "IdempotencyRecord" WHERE "roomId"=$1 AND "operation"='END'`,
        [r.c.roomId],
      )
    )[0]!.n,
  );

describe('정산 조회 (BE-S4-2)', () => {
  it(
    ac(
      ['AC-SET-008-1', 'AC-SET-006-1', 'AC-SET-003-5'],
      'S4 §4.2',
      '진행 중 EXPECTED, 거래 0건이면 items: []',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const empty = await settle(r);
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ settlement: { kind: 'EXPECTED', items: [] } });
      await pay(r, r.p.a, r.p.b, 100);
      await pay(r, r.p.b, r.p.a, 100); // 상쇄: 모든 순손익 0
      expect((await settle(r)).body.settlement.items).toEqual([]);
    },
  );

  it(
    ac(
      ['AC-SET-005-1', 'AC-SET-007-1', 'AC-SET-007-3', 'AC-SET-008-4', 'AC-ROOM-002-5'],
      'S4 §6.4',
      '종료 직후 FINAL, 예상과 같은 항목, 반복 조회·종료 후 입장자도 같다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      await pay(r, r.p.a, r.p.b, 300);
      await pay(r, r.p.c, r.p.b, 100);
      const before = await settle(r);
      expect(before.body.settlement.kind).toBe('EXPECTED');
      expect(before.body.settlement.items).toEqual([
        { payerId: r.p.a, payerNickname: 'Aa', payeeId: r.p.b, payeeNickname: 'Bb', amount: 300 },
        { payerId: r.p.c, payerNickname: 'Cc', payeeId: r.p.b, payeeNickname: 'Bb', amount: 100 },
      ]);
      expect((await end(r)).status).toBe(200);
      const late = await join(s.http, r.c.inviteCode, 'Late');
      const a = await settle(r);
      const b = await settle(r, late.key);
      expect(a.body.settlement.kind).toBe('FINAL');
      expect(a.body.settlement.items).toEqual(before.body.settlement.items);
      expect(JSON.stringify(b.body)).toBe(JSON.stringify(a.body));
    },
  );

  it(
    ac(
      ['AC-TXN-005-3', 'AC-TXN-005-5', 'AC-PART-002-6', 'AC-SET-003-7'],
      'S4 §6.2',
      '삭제 제외·수정 반영·비활성 참여자 포함·거래 순서와 무관',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const t1 = (await pay(r, r.p.a, r.p.b, 500)).body.transaction.id as string;
      const t2 = (await pay(r, r.p.a, r.p.c, 200)).body.transaction.id as string;
      await s.http
        .patch(`/rooms/${r.c.roomId}/participants/${r.p.c}`)
        .set(auth(r.c.key))
        .send({ status: 'INACTIVE' });
      let items = (await settle(r)).body.settlement.items as { payeeId: string; amount: number }[];
      expect(items.map((i) => i.amount).sort()).toEqual([200, 500]);
      await delTx(s.http, r.c.roomId, r.c.key, t2);
      await putTx(s.http, r.c.roomId, r.c.key, t1, { amount: 700 });
      items = (await settle(r)).body.settlement.items;
      expect(items).toHaveLength(1);
      expect(items[0]!.amount).toBe(700);
    },
  );

  it(
    ac(['AC-SET-008-6', 'AC-VIEW-004-7'], 'S4 §4.2', '쿼리 매개변수는 어떤 것도 NOT_ALLOWED_FIELD'),
    async () => {
      const r = await setupRoom(s.http);
      const res = await settle(r, r.c.key, `?participantId=${r.p.a}`);
      expectApiError(res, 422, 'VALIDATION_FAILED', [
        { field: 'participantId', code: 'NOT_ALLOWED_FIELD' },
      ]);
    },
  );

  it(
    ac(
      ['AC-SYS-003-5', 'AC-SYS-003-6'],
      'S4 §3.1',
      '인증·비멤버·다른 방 방장은 404, 키 없으면 401',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const other = await setupRoom(s.http);
      expectApiError(await settle(r, other.c.key), 404, 'ROOM_NOT_FOUND');
      expectApiError(await end(r, other.c.key), 404, 'ROOM_NOT_FOUND');
      expect((await s.http.get(`/rooms/${r.c.roomId}/settlement`)).status).toBe(401);
      expect(await status(r)).toBe('IN_PROGRESS');
    },
  );

  it(
    ac(['AC-SET-007-2', 'AC-SET-001-5'], 'S4 §4.3', '메서드 405(Allow)·재개·확정 경로는 404'),
    async () => {
      const r = await setupRoom(s.http);
      const e = await s.http.get(`/rooms/${r.c.roomId}/end`).set(auth(r.c.key));
      expectApiError(e, 405, 'NOT_SUPPORTED');
      expect(e.headers['allow']).toBe('POST');
      const g = await s.http.post(`/rooms/${r.c.roomId}/settlement`).set(auth(r.c.key));
      expectApiError(g, 405, 'NOT_SUPPORTED');
      expect(g.headers['allow']).toBe('GET');
      for (const p of [
        'reopen',
        'resume',
        'end/cancel',
        'settlement/confirm',
        'settlement/versions',
        'settlement/paid',
        'corrections',
      ])
        expectApiError(
          await s.http.post(`/rooms/${r.c.roomId}/${p}`).set(auth(r.c.key)),
          404,
          'ROUTE_NOT_FOUND',
        );
    },
  );
});

describe('게임 종료 (BE-S4-3)', () => {
  it(
    ac(
      ['AC-SET-001-2', 'AC-ROOM-007-2', 'AC-SYS-003-1'],
      'S4 §3.3',
      '비방장 종료는 403 HOST_ONLY, 상태·revision 불변, 기록 없음',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const m = await join(s.http, r.c.inviteCode, 'Member');
      const rev = await revision(s.db, r.c.roomId);
      expectApiError(await end(r, m.key), 403, 'HOST_ONLY');
      expect(await status(r)).toBe('IN_PROGRESS');
      expect(await revision(s.db, r.c.roomId)).toBe(rev);
      expect(await records(r)).toBe(0);
      // 종료된 방에서도 비방장은 HOST_ONLY
      await end(r);
      expectApiError(await end(r, m.key), 403, 'HOST_ONLY');
    },
  );

  it(
    ac(
      ['AC-SET-001-6', 'AC-SET-001-8', 'AC-SET-001-5'],
      'S4 §6.1',
      '성공→재전송 같은 결과, 새 키 종료는 GAME_ENDED(기록), 그 키 재전송도 같은 거부',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const rev = await revision(s.db, r.c.roomId);
      const k = fresh();
      const first = await end(r, r.c.key, k);
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ roomId: r.c.roomId, status: 'ENDED' });
      expect(await revision(s.db, r.c.roomId)).toBe(rev + 1);
      const again = await end(r, r.c.key, k);
      expect(again.status).toBe(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(await revision(s.db, r.c.roomId)).toBe(rev + 1);

      const k2 = fresh();
      const dup = await end(r, r.c.key, k2);
      expectApiError(dup, 409, 'GAME_ENDED');
      expect(dup.body.error.message).toBe('이미 종료된 게임입니다');
      const dup2 = await end(r, r.c.key, k2);
      expect(dup2.status).toBe(409);
      expect(dup2.headers['idempotent-replayed']).toBe('true');
      expect(dup2.body).toEqual(dup.body);
      expect(await revision(s.db, r.c.roomId)).toBe(rev + 1);
      expect(await status(r)).toBe('ENDED');
    },
  );

  it(
    ac(
      ['AC-SET-001-8', 'AC-SET-001-2'],
      'S4 §3.2',
      '24시간 경과 → IDEMPOTENCY_KEY_EXPIRED(방 상태 안내)·상태 불변, 다른 내용·다른 연산은 CONFLICT',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const old = fresh(-25 * HOUR);
      const exp = await end(r, r.c.key, old);
      expectApiError(exp, 409, 'IDEMPOTENCY_KEY_EXPIRED');
      expect(exp.body.error.message).toContain('방의 현재 상태');
      expect(await status(r)).toBe('IN_PROGRESS');
      const k = fresh();
      await end(r, r.c.key, k);
      expectApiError(await end(r, r.c.key, k, { x: 1 }), 409, 'IDEMPOTENCY_CONFLICT');
      // 같은 키를 거래 요청에 쓰면 연산이 달라 CONFLICT
      const r2 = await setupRoom(s.http);
      const k2 = fresh();
      await postTx(s.http, r2.c.roomId, r2.c.key, validBody(r2), k2);
      expectApiError(await end(r2, r2.c.key, k2), 409, 'IDEMPOTENCY_CONFLICT');
    },
  );

  it(
    ac(
      ['AC-SET-001-2'],
      'S4 §3.3',
      '헤더 누락은 422, 본문 검증(NOT_ALLOWED_FIELD·INVALID_TYPE)은 기록하지 않는다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      expectApiError(await end(r, r.c.key, false), 422, 'VALIDATION_FAILED');
      const bad = await end(r, r.c.key, fresh(), { force: true });
      expectApiError(bad, 422, 'VALIDATION_FAILED', [
        { field: 'force', code: 'NOT_ALLOWED_FIELD' },
      ]);
      const arr = await end(r, r.c.key, fresh(), [1]);
      expectApiError(arr, 422, 'VALIDATION_FAILED', [{ field: 'body', code: 'INVALID_TYPE' }]);
      expect(await records(r)).toBe(0);
      expect(await status(r)).toBe('IN_PROGRESS');
      expect((await end(r, r.c.key, fresh(), {})).status).toBe(200); // {}도 허용
    },
  );

  it(
    ac(
      ['AC-SET-001-2'],
      'S4 §3.3',
      '본문: JSON이 아닌 본문·객체가 아닌 JSON은 INVALID_TYPE, 문법 오류는 INVALID_VALUE, 모두 종료하지 않고 기록하지 않는다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const send = (type: string, payload: string, k = fresh()) =>
        s.http
          .post(`/rooms/${r.c.roomId}/end`)
          .set(auth(r.c.key))
          .set('Idempotency-Key', k.key)
          .set('Idempotency-First-Attempt-At', k.at)
          .set('Content-Type', type)
          .send(payload);
      const invalidType = [{ field: 'body', code: 'INVALID_TYPE' }];
      expectApiError(await send('text/plain', 'end'), 422, 'VALIDATION_FAILED', invalidType);
      expectApiError(await send('application/json', '5'), 422, 'VALIDATION_FAILED', invalidType);
      expectApiError(await send('application/json', '"x"'), 422, 'VALIDATION_FAILED', invalidType);
      expectApiError(await send('application/json', 'null'), 422, 'VALIDATION_FAILED', invalidType);
      expectApiError(await send('application/json', '{bad'), 422, 'VALIDATION_FAILED', [
        { field: 'body', code: 'INVALID_VALUE' },
      ]);
      expect(await status(r)).toBe('IN_PROGRESS');
      expect(await records(r)).toBe(0);
      // 성공한 키에 JSON이 아닌 본문으로 재전송하면 재전송이 아니라 다른 내용이다
      const k = fresh();
      expect((await end(r, r.c.key, k)).status).toBe(200);
      expectApiError(await send('text/plain', 'end', k), 409, 'IDEMPOTENCY_CONFLICT');
      // 값이 다른 스칼라 본문은 같은 키로 다른 내용이다(거부 기록을 재생하지 않는다)
      const r2 = await setupRoom(s.http);
      const k2 = fresh();
      await postTx(s.http, r2.c.roomId, r2.c.key, validBody(r2), k2);
      expectApiError(await end(r2, r2.c.key, k2), 409, 'IDEMPOTENCY_CONFLICT');
    },
  );

  it(
    ac(
      ['AC-SET-001-2'],
      'S4 §3.3',
      '헤더 누락은 422, 본문 검증(NOT_ALLOWED_FIELD·INVALID_TYPE)은 기록하지 않는다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      expectApiError(await end(r, r.c.key, false), 422, 'VALIDATION_FAILED');
      const bad = await end(r, r.c.key, fresh(), { force: true });
      expectApiError(bad, 422, 'VALIDATION_FAILED', [
        { field: 'force', code: 'NOT_ALLOWED_FIELD' },
      ]);
      const arr = await end(r, r.c.key, fresh(), [1]);
      expectApiError(arr, 422, 'VALIDATION_FAILED', [{ field: 'body', code: 'INVALID_TYPE' }]);
      expect(await records(r)).toBe(0);
      expect(await status(r)).toBe('IN_PROGRESS');
      expect((await end(r, r.c.key, fresh(), {})).status).toBe(200); // {}도 허용
    },
  );

  it(
    ac(
      ['AC-SET-001-2'],
      'S4 §3.3',
      '본문: JSON이 아닌 본문·객체가 아닌 JSON은 INVALID_TYPE, 문법 오류는 INVALID_VALUE, 모두 종료하지 않고 기록하지 않는다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const send = (type: string, payload: string, k = fresh()) =>
        s.http
          .post(`/rooms/${r.c.roomId}/end`)
          .set(auth(r.c.key))
          .set('Idempotency-Key', k.key)
          .set('Idempotency-First-Attempt-At', k.at)
          .set('Content-Type', type)
          .send(payload);
      const invalidType = [{ field: 'body', code: 'INVALID_TYPE' }];
      expectApiError(await send('text/plain', 'end'), 422, 'VALIDATION_FAILED', invalidType);
      expectApiError(await send('application/json', '5'), 422, 'VALIDATION_FAILED', invalidType);
      expectApiError(await send('application/json', '"x"'), 422, 'VALIDATION_FAILED', invalidType);
      expectApiError(await send('application/json', 'null'), 422, 'VALIDATION_FAILED', invalidType);
      expectApiError(await send('application/json', '{bad'), 422, 'VALIDATION_FAILED', [
        { field: 'body', code: 'INVALID_VALUE' },
      ]);
      expect(await status(r)).toBe('IN_PROGRESS');
      expect(await records(r)).toBe(0);
      // 성공한 키에 JSON이 아닌 본문으로 재전송하면 재전송이 아니라 다른 내용이다
      const k = fresh();
      expect((await end(r, r.c.key, k)).status).toBe(200);
      expectApiError(await send('text/plain', 'end', k), 409, 'IDEMPOTENCY_CONFLICT');
      // 값이 다른 스칼라 본문은 같은 키로 다른 내용이다(거부 기록을 재생하지 않는다)
      const r2 = await setupRoom(s.http);
      await end(r2);
      const k2 = fresh();
      const sendTo = (v: string) =>
        s.http
          .post(`/rooms/${r2.c.roomId}/end`)
          .set(auth(r2.c.key))
          .set('Idempotency-Key', k2.key)
          .set('Idempotency-First-Attempt-At', k2.at)
          .set('Content-Type', 'application/json')
          .send(v);
      // 종료된 방: 방장의 종료 요청은 GAME_ENDED로 기록된다. 같은 키로 `{}`는 재전송, 다른 스칼라는 충돌이어야 한다
      expectApiError(await sendTo('5'), 409, 'GAME_ENDED'); // 이 내용이 기록된다
      expectApiError(await sendTo('5'), 409, 'GAME_ENDED'); // 같은 내용은 재전송
      expectApiError(await sendTo('"x"'), 409, 'IDEMPOTENCY_CONFLICT'); // 다른 스칼라는 충돌
      expectApiError(await sendTo('{}'), 409, 'IDEMPOTENCY_CONFLICT');
      // 객체 본문이 스칼라 본문의 지문을 흉내 낼 수 없다
      expectApiError(await sendTo('{"$nonObjectJson":5}'), 409, 'IDEMPOTENCY_CONFLICT');
      expectApiError(await sendTo('{"$nonObjectJsonScalar":[5]}'), 409, 'IDEMPOTENCY_CONFLICT');
    },
  );

  it(
    ac(
      ['AC-SET-001-3', 'AC-TXN-009-1', 'AC-PART-004-1', 'AC-PART-004-2', 'AC-SYS-003-2'],
      'S4 §4.3',
      '종료 뒤 거래 3종·참여자 등록·상태 변경은 GAME_ENDED, 데이터·revision 불변',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const t = (await pay(r, r.p.a, r.p.b, 100)).body.transaction.id as string;
      await end(r);
      const rev = await revision(s.db, r.c.roomId);
      const before = (await settle(r)).body;
      expectApiError(await pay(r, r.p.a, r.p.b, 5), 409, 'GAME_ENDED');
      expectApiError(await putTx(s.http, r.c.roomId, r.c.key, t, { amount: 9 }), 409, 'GAME_ENDED');
      expectApiError(await delTx(s.http, r.c.roomId, r.c.key, t), 409, 'GAME_ENDED');
      expectApiError(await addParticipant(s.http, r.c, 'New'), 409, 'GAME_ENDED');
      expectApiError(
        await s.http
          .patch(`/rooms/${r.c.roomId}/participants/${r.p.a}`)
          .set(auth(r.c.key))
          .send({ status: 'INACTIVE' }),
        409,
        'GAME_ENDED',
      );
      expect(await revision(s.db, r.c.roomId)).toBe(rev);
      expect((await settle(r)).body).toEqual(before);
    },
  );

  it(
    ac(
      ['AC-SET-001-4', 'AC-SET-001-7'],
      'S4 §6.1',
      '종료는 거래 0건·참여자 0명도 허용, 자동 종료·만료·삭제 경로 없음(정적)',
    ),
    async () => {
      const r = await setupRoom(s.http);
      await s.db.query(`DELETE FROM "Participant" WHERE "roomId"=$1`, [r.c.roomId]);
      expect((await end(r)).status).toBe(200);
      expect(await settle(r)).toMatchObject({
        status: 200,
        body: { settlement: { kind: 'FINAL', items: [] } },
      });
      const fs = await import('node:fs');
      const path = await import('node:path');
      const walk = (d: string): string[] =>
        fs
          .readdirSync(d, { withFileTypes: true })
          .flatMap((e) =>
            e.isDirectory()
              ? walk(path.join(d, e.name))
              : e.name.endsWith('.ts')
                ? [path.join(d, e.name)]
                : [],
          );
      const src = walk('src').filter((f) => !f.includes('generated'));
      const scheduled = src.filter((f) =>
        /@Cron\(|@Interval\(|@Timeout\(|node-cron|ScheduleModule/.test(fs.readFileSync(f, 'utf8')),
      );
      expect(scheduled).toEqual([]);
      const ender = src.filter((f) => /status:\s*'ENDED'/.test(fs.readFileSync(f, 'utf8')));
      expect(ender.map((f) => path.basename(f))).toEqual(['settlement.service.ts']);
    },
  );
});

describe('최대 금액 경계 (BE-S4-6)', () => {
  it(
    ac(
      ['AC-SET-003-4'],
      'S4 §6.2',
      'NFR-009: 999,999,999 거래 1,000건에서 예상·최종 정산이 정확하다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      await seedTransactions(s.db, r, {
        count: 1000,
        payer: r.p.a,
        payee: r.p.b,
        amount: 999_999_999,
      });
      const expected = (await settle(r)).body.settlement;
      expect(expected.items).toHaveLength(1);
      expect(expected.items[0].amount).toBe(999_999_999 * 1000);
      await s.db.query(`UPDATE "Room" SET "status"='ENDED' WHERE "id"=$1`, [r.c.roomId]);
      const final = (await settle(r)).body.settlement;
      expect(final.kind).toBe('FINAL');
      expect(final.items).toEqual(expected.items);
    },
  );
});
