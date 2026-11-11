import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ac, expectApiError } from '../helpers/contract.js';
import {
  auth,
  bootS2,
  delTx,
  endRoom,
  join,
  newKey,
  postTx,
  putTx,
  setupRoom,
  type S2Env,
  type Setup,
} from '../s2/s2-helpers.js';
import { seedTransactions } from './s3-helpers.js';

let s: S2Env;
beforeAll(async () => {
  s = await bootS2();
});
afterAll(() => s?.close());

interface Page {
  transactions: {
    id: string;
    payerId: string;
    payeeId: string;
    createdAt: string;
    updatedAt: string;
    amount: number;
  }[];
  nextCursor: string | null;
}
const list = (r: Setup, qs = '', key = r.c.key) =>
  s.http.get(`/rooms/${r.c.roomId}/transactions${qs}`).set(auth(key));
const enc = (v: string) => encodeURIComponent(v);
async function pages(r: Setup, filter?: string): Promise<Page[]> {
  const out: Page[] = [];
  let cursor: string | null = null;
  do {
    const q = [filter ? `participantId=${enc(filter)}` : '', cursor ? `cursor=${enc(cursor)}` : '']
      .filter(Boolean)
      .join('&');
    const res = await list(r, q ? `?${q}` : '');
    expect(res.status).toBe(200);
    out.push(res.body as Page);
    cursor = (res.body as Page).nextCursor;
  } while (cursor);
  return out;
}
const idsOf = (ps: Page[]) => ps.flatMap((p) => p.transactions.map((t) => t.id));

describe('GET /rooms/{roomId}/transactions — 정렬 (S3 §4.1.1)', () => {
  it(
    ac(
      ['AC-VIEW-003-1', 'AC-VIEW-003-3'],
      'S3 §4.1.1',
      '나중에 만든 거래가 위에 오고 수정해도 위치가 바뀌지 않는다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const made: string[] = [];
      for (let i = 1; i <= 4; i++)
        made.push(
          (await postTx(s.http, r.c.roomId, r.c.key, { payerId: r.p.a, payeeId: r.p.b, amount: i }))
            .body.transaction.id,
        );
      expect((await list(r)).body.transactions.map((t: { id: string }) => t.id)).toEqual(
        [...made].reverse(),
      );
      const upd = await putTx(s.http, r.c.roomId, r.c.key, made[0]!, { amount: 999 }); // 가장 오래된 거래를 수정
      expect(upd.status).toBe(200);
      const after = (await list(r)).body.transactions;
      expect(after.map((t: { id: string }) => t.id)).toEqual([...made].reverse()); // 순서 불변
      expect(after[3].amount).toBe(999);
      expect(Date.parse(after[3].updatedAt)).toBeGreaterThan(Date.parse(after[3].createdAt));
    },
  );

  it(
    ac(
      ['AC-VIEW-003-2', 'AC-VIEW-003-6'],
      'S3 §2.3',
      '같은 createdAt이면 seq가 큰 쪽이 위이고 순서가 결정적이다. createdAt은 감소하지 않고 seq는 고유하다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const ids = await seedTransactions(s.db, r, {
        count: 6,
        payer: r.p.a,
        payee: r.p.b,
        sameCreatedAt: true,
      });
      const first = (await list(r)).body.transactions.map((t: { id: string }) => t.id);
      expect(first).toEqual([...ids].reverse());
      for (let i = 0; i < 3; i++)
        expect((await list(r)).body.transactions.map((t: { id: string }) => t.id)).toEqual(first); // 반복해도 같다
      const rows = await s.db.query<{ seq: number; createdAt: Date }>(
        `SELECT "seq","createdAt" FROM "Transaction" WHERE "roomId"=$1 ORDER BY "seq"`,
        [r.c.roomId],
      );
      expect(new Set(rows.map((x) => x.seq)).size).toBe(rows.length);
      for (let i = 1; i < rows.length; i++)
        expect(rows[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(
          rows[i - 1]!.createdAt.getTime(),
        );
    },
  );

  it(ac(['AC-VIEW-003-6'], 'S3 §2.3.1', 'seq는 수정·삭제·재전송으로 바뀌지 않는다'), async () => {
    const r = await setupRoom(s.http);
    const key = { key: 'S'.repeat(22), at: new Date().toISOString() };
    const t = (
      await postTx(s.http, r.c.roomId, r.c.key, { payerId: r.p.a, payeeId: r.p.b, amount: 5 }, key)
    ).body.transaction;
    const seqOf = async () =>
      (
        await s.db.query<{ seq: number }>(`SELECT "seq" FROM "Transaction" WHERE "id"=$1`, [t.id])
      )[0]!.seq;
    const seq = await seqOf();
    await putTx(s.http, r.c.roomId, r.c.key, t.id, { amount: 6 });
    const replay = await postTx(
      s.http,
      r.c.roomId,
      r.c.key,
      { payerId: r.p.a, payeeId: r.p.b, amount: 5 },
      key,
    ); // 재전송
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(JSON.stringify(replay.body)).not.toMatch(/seq/i); // 재전송 본문에도 seq가 없다
    expect(await seqOf()).toBe(seq);
    await delTx(s.http, r.c.roomId, r.c.key, t.id);
    expect(await seqOf()).toBe(seq);
  });

  it(ac(['AC-VIEW-003-5'], 'S3 §4.1', '삭제된 거래는 목록에 없다'), async () => {
    const r = await setupRoom(s.http);
    const a = (
      await postTx(s.http, r.c.roomId, r.c.key, { payerId: r.p.a, payeeId: r.p.b, amount: 1 })
    ).body.transaction.id;
    const b = (
      await postTx(s.http, r.c.roomId, r.c.key, { payerId: r.p.a, payeeId: r.p.b, amount: 2 })
    ).body.transaction.id;
    await delTx(s.http, r.c.roomId, r.c.key, a);
    expect((await list(r)).body.transactions.map((t: { id: string }) => t.id)).toEqual([b]);
  });

  it('거래가 없으면 빈 목록과 null 커서', async () => {
    const r = await setupRoom(s.http);
    expect((await list(r)).body).toEqual({ transactions: [], nextCursor: null });
  });

  it('응답 거래는 S2 Transaction 필드 그대로이고 seq·원본 값·삭제 정보·키는 없다', async () => {
    const r = await setupRoom(s.http);
    await postTx(s.http, r.c.roomId, r.c.key, {
      payerId: r.p.a,
      payeeId: r.p.b,
      amount: 5,
      reason: '메모',
      round: 'R1',
    });
    const res = await list(r);
    expect(Object.keys(res.body.transactions[0]).sort()).toEqual([
      'amount',
      'authorId',
      'createdAt',
      'id',
      'payeeId',
      'payerId',
      'reason',
      'round',
      'updatedAt',
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/"seq"|original|deleted|identityKey|Hash/i);
    expect(res.body.transactions[0].authorId).toBe(r.c.hostId); // RoomMember ID(해시가 아니다)
  });
});

describe('페이지네이션과 필터 (S3 §4.1)', () => {
  it(
    ac(
      ['AC-VIEW-004-1'],
      'S3 §4.1',
      '유효 거래 45건 → 20, 20, 5건 (삭제 거래는 계산에서 제외), 마지막 페이지의 nextCursor는 null',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const ids = await seedTransactions(s.db, r, {
        count: 50,
        payer: r.p.a,
        payee: r.p.b,
        deleteIf: (n) => n > 45,
      }); // 5건은 삭제 표시
      const ps = await pages(r);
      expect(ps.map((p) => p.transactions.length)).toEqual([20, 20, 5]);
      expect(ps.map((p) => p.nextCursor === null)).toEqual([false, false, true]);
      expect(idsOf(ps)).toEqual(ids.slice(0, 45).reverse()); // 전체 순서, 중복·누락 없음
    },
  );

  it('정확히 20건·40건이면 마지막 페이지의 nextCursor는 null이다(21번째 확인)', async () => {
    const r = await setupRoom(s.http);
    await seedTransactions(s.db, r, { count: 20, payer: r.p.a, payee: r.p.b });
    expect((await list(r)).body.nextCursor).toBeNull();
    const r2 = await setupRoom(s.http);
    await seedTransactions(s.db, r2, { count: 40, payer: r2.p.a, payee: r2.p.b });
    const ps = await pages(r2);
    expect(ps.map((p) => p.transactions.length)).toEqual([20, 20]);
    expect(ps[1]!.nextCursor).toBeNull();
    const r3 = await setupRoom(s.http);
    await seedTransactions(s.db, r3, { count: 21, payer: r3.p.a, payee: r3.p.b });
    expect((await pages(r3)).map((p) => p.transactions.length)).toEqual([20, 1]);
  });

  it(
    ac(
      ['AC-VIEW-004-9'],
      'S3 §4.1.1',
      '삭제 거래가 섞여도 마지막 페이지를 제외한 모든 페이지가 20건이다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      await seedTransactions(s.db, r, {
        count: 100,
        payer: r.p.a,
        payee: r.p.b,
        deleteIf: (n) => n % 3 === 0,
      }); // 67건 유효
      const ps = await pages(r);
      expect(ps.map((p) => p.transactions.length)).toEqual([20, 20, 20, 7]);
    },
  );

  it(
    ac(
      ['AC-VIEW-004-2', 'AC-VIEW-004-4'],
      'S3 §4.1',
      '참여자 필터: 그 참여자가 지급자 또는 수취자인 거래만, 필터 상태에서도 20건 단위',
    ),
    async () => {
      const r = await setupRoom(s.http);
      await seedTransactions(s.db, r, {
        count: 30,
        payer: r.p.a,
        payee: r.p.b,
        startMs: Date.now() - 7_200_000,
      }); // A→B 30건
      await seedTransactions(s.db, r, {
        count: 25,
        payer: r.p.b,
        payee: r.p.c,
        startMs: Date.now() - 3_600_000,
      }); // B→C 25건
      const forA = await pages(r, r.p.a);
      expect(forA.map((p) => p.transactions.length)).toEqual([20, 10]);
      for (const t of idsOf(forA)) void t;
      for (const p of forA)
        for (const t of p.transactions) expect([t.payerId, t.payeeId]).toContain(r.p.a);
      const forB = await pages(r, r.p.b); // 지급자 25건 + 수취자 30건
      expect(forB.map((p) => p.transactions.length)).toEqual([20, 20, 15]);
      const forC = await pages(r, r.p.c);
      expect(forC.map((p) => p.transactions.length)).toEqual([20, 5]);
      expect(idsOf(await pages(r))).toHaveLength(55);
    },
  );

  it(ac(['AC-VIEW-004-6'], 'S3 §6.3', '비활성 참여자도 필터 대상이다'), async () => {
    const r = await setupRoom(s.http);
    await postTx(s.http, r.c.roomId, r.c.key, { payerId: r.p.a, payeeId: r.p.b, amount: 5 });
    await s.http
      .patch(`/rooms/${r.c.roomId}/participants/${r.p.b}`)
      .set(auth(r.c.key))
      .send({ status: 'INACTIVE' });
    const res = await list(r, `?participantId=${r.p.b}`);
    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
  });

  it(
    ac(
      ['AC-VIEW-004-3'],
      'S3 §3.3',
      'participantId 2개·빈 값 → INVALID_VALUE, 이 방의 참여자가 아니면(다른 방 포함) PARTICIPANT_NOT_FOUND',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const other = await setupRoom(s.http);
      expectApiError(
        await list(r, `?participantId=${r.p.a}&participantId=${r.p.b}`),
        422,
        'VALIDATION_FAILED',
        [{ field: 'participantId', code: 'INVALID_VALUE' }],
      );
      expectApiError(await list(r, '?participantId='), 422, 'VALIDATION_FAILED', [
        { field: 'participantId', code: 'INVALID_VALUE' },
      ]);
      expectApiError(await list(r, '?participantId=nope'), 422, 'VALIDATION_FAILED', [
        { field: 'participantId', code: 'PARTICIPANT_NOT_FOUND' },
      ]);
      const foreign = await list(r, `?participantId=${other.p.a}`);
      expectApiError(foreign, 422, 'VALIDATION_FAILED', [
        { field: 'participantId', code: 'PARTICIPANT_NOT_FOUND' },
      ]);
      expect(foreign.body).toEqual((await list(r, '?participantId=nope')).body); // 구별되지 않는다(AC-SYS-003-8과 같은 원칙)
    },
  );

  it('허용되지 않은 쿼리 매개변수는 NOT_ALLOWED_FIELD이고 위반은 모아서 반환한다', async () => {
    const r = await setupRoom(s.http);
    expectApiError(await list(r, '?limit=5'), 422, 'VALIDATION_FAILED', [
      { field: 'limit', code: 'NOT_ALLOWED_FIELD' },
    ]);
    const many = await list(
      r,
      `?page=2&participantId=${r.p.a}&participantId=${r.p.b}&cursor=&from=2026`,
    );
    expect(many.status).toBe(422);
    const flat = many.body.error.details
      .map((d: { field: string; code: string }) => `${d.field}:${d.code}`)
      .sort();
    expect(flat).toEqual([
      'cursor:INVALID_VALUE',
      'from:NOT_ALLOWED_FIELD',
      'page:NOT_ALLOWED_FIELD',
      'participantId:INVALID_VALUE',
    ]);
  });
});

describe('커서 (S3 §4.1.2, PD-12)', () => {
  async function firstCursor(r: Setup, filter?: string) {
    const res = await list(r, filter ? `?participantId=${filter}` : '');
    return res.body.nextCursor as string;
  }

  it(
    ac(
      ['AC-VIEW-003-6'],
      'S3 §2.3.1 4',
      '커서는 불투명하다: seq·시각이 평문으로 나타나지 않고, 같은 위치라도 토큰이 다르며, 응답 어디에도 seq가 없다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      await seedTransactions(s.db, r, { count: 30, payer: r.p.a, payee: r.p.b });
      const a = await firstCursor(r);
      const b = await firstCursor(r);
      expect(a).not.toBe(b); // IV가 달라 같은 위치라도 다르다
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
      const raw = Buffer.from(a, 'base64url').toString('latin1');
      expect(raw).not.toMatch(/seq|createdAt|\d{4}-\d{2}-\d{2}|"s"|"c"/);
      const [{ seq }] = (await s.db.query<{ seq: number }>(
        `SELECT "seq" FROM "Transaction" WHERE "roomId"=$1 AND "id" = (SELECT "id" FROM "Transaction" WHERE "roomId"=$1 ORDER BY "createdAt" DESC, "seq" DESC OFFSET 19 LIMIT 1)`,
        [r.c.roomId],
      )) as [{ seq: number }];
      expect(raw).not.toContain(String(seq).padStart(3, '0'));
      expect(JSON.stringify((await list(r)).body)).not.toContain('"seq"');
      // 두 토큰 모두 같은 다음 페이지를 준다
      const p1 = await list(r, `?cursor=${enc(a)}`);
      const p2 = await list(r, `?cursor=${enc(b)}`);
      expect(p1.body.transactions).toEqual(p2.body.transactions);
    },
  );

  it(
    ac(
      ['AC-VIEW-003-6', 'AC-VIEW-004-8'],
      'S3 §4.1.2',
      '변조·잘린·빈·임의 커서는 cursor/INVALID_VALUE로 거부된다',
    ),
    async () => {
      const r = await setupRoom(s.http);
      await seedTransactions(s.db, r, { count: 30, payer: r.p.a, payee: r.p.b });
      const good = await firstCursor(r);
      const flip = (i: number) =>
        good.slice(0, i) + (good[i] === 'A' ? 'B' : 'A') + good.slice(i + 1);
      const bad = [
        flip(0),
        flip(15),
        flip(good.length - 1),
        good.slice(0, -4),
        good + 'AAAA',
        '',
        'x',
        'not-a-cursor',
        Buffer.from('{"c":"2026-01-01T00:00:00.000Z","s":1,"f":null,"r":"x"}').toString(
          'base64url',
        ),
        '!!!!',
      ];
      for (const token of bad) {
        expectApiError(await list(r, `?cursor=${enc(token)}`), 422, 'VALIDATION_FAILED', [
          { field: 'cursor', code: 'INVALID_VALUE' },
        ]);
      }
    },
  );

  it(
    ac(
      ['AC-VIEW-004-8'],
      'S3 §6.3',
      '다른 방에서 발급된 커서와 발급 때와 다른 필터의 커서는 거부된다(양방향)',
    ),
    async () => {
      const r = await setupRoom(s.http);
      const other = await setupRoom(s.http);
      await seedTransactions(s.db, r, { count: 30, payer: r.p.a, payee: r.p.b });
      await seedTransactions(s.db, other, { count: 30, payer: other.p.a, payee: other.p.b });
      const plain = await firstCursor(r);
      const filteredA = await firstCursor(r, r.p.a);
      const foreign = await firstCursor(other);
      const reject = async (qs: string) =>
        expectApiError(await list(r, qs), 422, 'VALIDATION_FAILED', [
          { field: 'cursor', code: 'INVALID_VALUE' },
        ]);
      await reject(`?cursor=${enc(foreign)}`); // 다른 방의 커서
      await reject(`?participantId=${r.p.a}&cursor=${enc(plain)}`); // 필터 없이 발급된 커서에 필터 추가
      await reject(`?cursor=${enc(filteredA)}`); // 필터로 발급된 커서에서 필터 해제
      await reject(`?participantId=${r.p.b}&cursor=${enc(filteredA)}`); // 다른 필터
      expect((await list(r, `?participantId=${r.p.a}&cursor=${enc(filteredA)}`)).status).toBe(200); // 같은 필터면 통과
      expect((await list(r, `?cursor=${enc(plain)}`)).status).toBe(200);
    },
  );

  it('비멤버가 커서를 쓰거나 다른 사람의 커서를 쓰는 것은 같은 방이면 가능하지만 비멤버는 404다', async () => {
    const r = await setupRoom(s.http);
    await seedTransactions(s.db, r, { count: 30, payer: r.p.a, payee: r.p.b });
    const cursor = await firstCursor(r);
    const member = await join(s.http, r.c.inviteCode, 'Kim');
    expect((await list(r, `?cursor=${enc(cursor)}`, member.key)).status).toBe(200); // 같은 방 멤버(커서에 신원은 없다)
    expectApiError(await list(r, `?cursor=${enc(cursor)}`, newKey()), 404, 'ROOM_NOT_FOUND');
  });
});

describe('권한과 상태', () => {
  it('비멤버·키 없음·종료된 방', async () => {
    const r = await setupRoom(s.http);
    await postTx(s.http, r.c.roomId, r.c.key, { payerId: r.p.a, payeeId: r.p.b, amount: 5 });
    expectApiError(await list(r, '', newKey()), 404, 'ROOM_NOT_FOUND');
    expectApiError(await s.http.get(`/rooms/${r.c.roomId}/transactions`), 401, 'UNAUTHENTICATED');
    await endRoom(s.db, r.c.roomId);
    expect((await list(r)).body.transactions).toHaveLength(1);
    const member = await join(s.http, r.c.inviteCode, 'Late'); // 종료 후 입장자
    expect((await list(r, '', member.key)).status).toBe(200);
  });

  it('조회는 멱등 헤더가 필요 없고 상태를 바꾸지 않는다(revision 불변)', async () => {
    const r = await setupRoom(s.http);
    const rev = async () =>
      (
        await s.db.query<{ revision: number }>(`SELECT "revision" FROM "Room" WHERE "id"=$1`, [
          r.c.roomId,
        ])
      )[0]!.revision;
    const before = await rev();
    await list(r);
    await s.http.get(`/rooms/${r.c.roomId}/balances`).set(auth(r.c.key));
    expect(await rev()).toBe(before);
  });
});
