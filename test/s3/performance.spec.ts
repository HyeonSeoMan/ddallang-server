import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addParticipant,
  auth,
  bootS2,
  setupRoom,
  type S2Env,
  type Setup,
} from '../s2/s2-helpers.js';

let s: S2Env;
let r: Setup;
let participants: string[];
beforeAll(async () => {
  s = await bootS2();
  r = await setupRoom(s.http);
  participants = [r.p.a, r.p.b, r.p.c];
  for (let i = 4; i <= 10; i++)
    participants.push((await addParticipant(s.http, r.c, `Pp${i}`)).body.participant.id as string);
  // 방당 거래 1,000건(S3 §13): 무작위 당사자 쌍, 일부는 삭제 표시(약 10%)
  await s.db.query(
    `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","authorId","originalAmount","createdAt","updatedAt","deletedAt","deletedById")
     SELECT 'perf' || lpad(g::text, 18, '0'), $1, g, ($2::text[])[1 + (g * 7) % 10], ($2::text[])[1 + (g * 7 + 1 + (g % 9)) % 10], 1 + (g * 37) % 999999999, $3, 1,
            now() - interval '2 hours' + g * interval '1 millisecond', now() - interval '2 hours' + g * interval '1 millisecond',
            CASE WHEN g % 10 = 0 THEN now() END, CASE WHEN g % 10 = 0 THEN $3 END
     FROM generate_series(1, 1000) g`,
    [r.c.roomId, participants, r.c.hostId],
  );
  await s.db.query(
    `UPDATE "Room" SET "nextTxnSeq" = 1001, "lastTxnCreatedAt" = now() - interval '2 hours' + 1000 * interval '1 millisecond' WHERE "id"=$1`,
    [r.c.roomId],
  );
});
afterAll(() => s?.close());

async function measure(name: string, runs: number, fn: () => Promise<unknown>) {
  await fn(); // 워밍업
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  const p = (x: number) =>
    Math.round(ms[Math.min(ms.length - 1, Math.floor(ms.length * x))]! * 10) / 10;
  const result = { p50: p(0.5), p95: p(0.95), max: p(1) };
  console.log(
    `[S3-4] ${name}: p50=${result.p50}ms p95=${result.p95}ms max=${result.max}ms (n=${runs})`,
  );
  return result;
}

describe('S3 성능 확인 (BE-S3-4: 방당 거래 1,000건, 참여자 10명)', () => {
  it('목록(첫 페이지·깊은 페이지·필터)과 순손익 응답 시간을 측정한다', async () => {
    const first = await s.http.get(`/rooms/${r.c.roomId}/transactions`).set(auth(r.c.key));
    expect(first.status).toBe(200);
    expect(first.body.transactions).toHaveLength(20);
    // 깊은 페이지의 커서(약 40번째 페이지 근처)를 만든다
    let cursor: string | null = first.body.nextCursor;
    let deep = cursor!;
    for (let i = 0; i < 30 && cursor; i++) {
      const res = await s.http
        .get(`/rooms/${r.c.roomId}/transactions?cursor=${encodeURIComponent(cursor)}`)
        .set(auth(r.c.key));
      cursor = res.body.nextCursor;
      if (cursor) deep = cursor;
    }
    const results = {
      list: await measure('목록 첫 페이지', 40, () =>
        s.http.get(`/rooms/${r.c.roomId}/transactions`).set(auth(r.c.key)),
      ),
      listDeep: await measure('목록 깊은 페이지(커서)', 40, () =>
        s.http
          .get(`/rooms/${r.c.roomId}/transactions?cursor=${encodeURIComponent(deep)}`)
          .set(auth(r.c.key)),
      ),
      listFiltered: await measure('목록 필터(참여자 1명)', 40, () =>
        s.http
          .get(`/rooms/${r.c.roomId}/transactions?participantId=${participants[3]}`)
          .set(auth(r.c.key)),
      ),
      balances: await measure('누적 손익', 40, () =>
        s.http.get(`/rooms/${r.c.roomId}/balances`).set(auth(r.c.key)),
      ),
    };
    // 기준: 사람이 느끼는 한계보다 한참 짧다. 넘으면 인덱스·질의를 개선한다(S3 §13).
    for (const [name, v] of Object.entries(results)) expect(v.p95, name).toBeLessThan(500);
  });

  it('목록 질의는 (방, createdAt, seq) 부분 인덱스로 정렬 없이 읽을 수 있다', async () => {
    await s.db.query('BEGIN');
    try {
      await s.db.query('SET LOCAL enable_seqscan = off');
      await s.db.query('SET LOCAL enable_bitmapscan = off');
      const plan = await s.db.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT * FROM "Transaction" WHERE "roomId" = $1 AND "deletedAt" IS NULL ORDER BY "createdAt" DESC, "seq" DESC LIMIT 21`,
        [r.c.roomId],
      );
      const text = plan.map((x) => x['QUERY PLAN']).join('\n');
      expect(text).toContain('Transaction_roomId_createdAt_seq_valid_idx');
      expect(text).not.toMatch(/\bSort\b/);
    } finally {
      await s.db.query('ROLLBACK');
    }
  });

  it('순손익 합은 삭제 거래를 제외한 1,000건 기준으로 0이다', async () => {
    const res = await s.http.get(`/rooms/${r.c.roomId}/balances`).set(auth(r.c.key));
    expect(res.body.balances).toHaveLength(10);
    expect((res.body.balances as { balance: number }[]).reduce((a, x) => a + x.balance, 0)).toBe(0);
    const [{ n }] = (await s.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "Transaction" WHERE "roomId"=$1 AND "deletedAt" IS NULL`,
      [r.c.roomId],
    )) as [{ n: string }];
    expect(n).toBe('900');
  });
});
