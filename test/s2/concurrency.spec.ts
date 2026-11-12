import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROOM_EVENTS_CHANNEL } from '../../src/common/db/database.service.js';
import { ac } from '../helpers/contract.js';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { baseDatabaseUrl, createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { sleep } from '../helpers/util.js';
import { newKey } from '../s1/s1-helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 90_000 });

type Body = { [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Res {
  status: number;
  body: Body;
  replayed: boolean;
}

let db: IsolatedDb;
let inst: Instance[];
let listener: pg.Client;
const events: Body[] = [];

const at = (n: number) => inst[n % inst.length]!;
const idem = () => ({ key: randomBytes(16).toString('base64url'), at: new Date().toISOString() });

async function call(
  i: Instance,
  method: string,
  path: string,
  key: string,
  body?: unknown,
  h = idem(),
): Promise<Res> {
  const res = await i.fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': h.key,
      'Idempotency-First-Attempt-At': h.at,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Body,
    replayed: res.headers.get('idempotent-replayed') === 'true',
  };
}
async function plain(i: Instance, method: string, path: string, key: string, body?: unknown) {
  const res = await i.fetch(path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
}

interface Room {
  key: string;
  roomId: string;
  hostId: string;
  p: string[];
}
async function room(participants = 3): Promise<Room> {
  const key = newKey();
  const created = await plain(at(0), 'POST', '/rooms', key, {
    name: 'Race',
    unit: '원',
    nickname: 'Host',
  });
  const roomId = created.body.room.id as string;
  const p: string[] = [];
  for (let i = 0; i < participants; i++) {
    p.push(
      (await plain(at(i), 'POST', `/rooms/${roomId}/participants`, key, { nickname: `P${i}` })).body
        .participant.id as string,
    );
  }
  return { key, roomId, hostId: created.body.me.id as string, p };
}
const create = (n: number, r: Room, body: Record<string, unknown>, h = idem()) =>
  call(
    at(n),
    'POST',
    `/rooms/${r.roomId}/transactions`,
    r.key,
    { payerId: r.p[0], payeeId: r.p[1], amount: 100, ...body },
    h,
  );
const tally = (rs: Res[]) => {
  const t: Record<string, number> = {};
  for (const x of rs) {
    const k = `${x.status}${x.body.error ? ' ' + x.body.error.code : ''}`;
    t[k] = (t[k] ?? 0) + 1;
  }
  return t;
};
const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  db.query<T>(sql, params);

beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
  inst = await startInstances(2, { databaseUrl: db.databaseUrl, entry: 'main' });
  listener = new pg.Client({ connectionString: baseDatabaseUrl() });
  await listener.connect();
  await listener.query(`LISTEN ${ROOM_EVENTS_CHANNEL}`);
  listener.on('notification', (m) => m.payload && events.push(JSON.parse(m.payload) as Body));
});
afterAll(async () => {
  await listener?.end();
  await stopAll(inst ?? []);
  await db?.drop();
});

describe('S2 동시성·경쟁 (서로 다른 프로세스 2개, 같은 DB)', () => {
  it(
    ac(
      ['AC-ROOM-008-5'],
      'S2 §7 6',
      '거래 마지막 슬롯에 서로 다른 키 8개가 동시 도착 → 정확히 하나만 성공, 나머지 TRANSACTION_LIMIT_EXCEEDED, 1,000건을 넘지 않는다',
    ),
    async () => {
      const r = await room();
      await q(
        `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","authorId","originalAmount","createdAt","updatedAt")
       SELECT 'race' || g, $1, g, $2, $3, 100, $4, 100, clock_timestamp(), clock_timestamp() FROM generate_series(1, 999) g`,
        [r.roomId, r.p[0], r.p[1], r.hostId],
      );
      await q(`UPDATE "Room" SET "nextTxnSeq"=1000 WHERE "id"=$1`, [r.roomId]);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => create(i, r, { amount: i + 1 })),
      );
      expect(tally(results)).toEqual({ '201': 1, '409 TRANSACTION_LIMIT_EXCEEDED': 7 });
      expect(
        Number(
          (
            await q<{ n: string }>(
              `SELECT count(*)::text AS n FROM "Transaction" WHERE "roomId"=$1`,
              [r.roomId],
            )
          )[0]!.n,
        ),
      ).toBe(1000);
    },
  );

  it(
    ac(
      ['AC-TXN-007-2'],
      'S2 §7 7',
      '같은 키·같은 내용의 생성 10개가 동시 도착 → 거래 1건, 나머지는 같은 결과의 재전송(Idempotent-Replayed)',
    ),
    async () => {
      const r = await room();
      const h = idem();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => create(i, r, { reason: '동시' }, h)),
      );
      expect(tally(results)).toEqual({ '201': 10 });
      expect(results.filter((x) => x.replayed)).toHaveLength(9); // 하나만 처리하고 나머지는 재전송
      expect(new Set(results.map((x) => x.body.transaction.id)).size).toBe(1);
      expect(
        Number(
          (
            await q<{ n: string }>(
              `SELECT count(*)::text AS n FROM "Transaction" WHERE "roomId"=$1`,
              [r.roomId],
            )
          )[0]!.n,
        ),
      ).toBe(1);
      const rec = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM "IdempotencyRecord" WHERE "roomId"=$1 AND "key"=$2`,
        [r.roomId, h.key],
      );
      expect(rec[0]!.n).toBe('1');
    },
  );

  it(
    ac(['AC-TXN-007-2'], 'S2 §7 7', '같은 키의 수정·삭제가 동시 도착해도 부작용은 한 번이다'),
    async () => {
      const r = await room();
      const t = (await create(0, r, {})).body.transaction.id as string;
      const hu = idem();
      const updates = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          call(at(i), 'PUT', `/rooms/${r.roomId}/transactions/${t}`, r.key, { amount: 555 }, hu),
        ),
      );
      expect(tally(updates)).toEqual({ '200': 6 });
      const hd = idem();
      const deletes = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          call(at(i), 'DELETE', `/rooms/${r.roomId}/transactions/${t}`, r.key, undefined, hd),
        ),
      );
      expect(tally(deletes)).toEqual({ '200': 6 });
      expect(new Set(deletes.map((x) => x.body.deletedAt)).size).toBe(1);
      const ev = events
        .filter((e) => e.roomId === r.roomId && e.transactionId === t)
        .map((e) => e.event);
      await vi.waitFor(
        () =>
          expect(
            events.filter((e) => e.roomId === r.roomId && e.event === 'transaction.deleted'),
          ).not.toHaveLength(0),
        { timeout: 30_000 },
      );
      await sleep(300); // 중복 발행이 없는지 보는 음성 확인(양성 도착은 위에서 기다렸다)
      const evAfter = events
        .filter((e) => e.roomId === r.roomId && e.transactionId === t)
        .map((e) => e.event);
      expect(evAfter.filter((e) => e === 'transaction.updated')).toHaveLength(1);
      expect(evAfter.filter((e) => e === 'transaction.deleted')).toHaveLength(1);
      void ev;
    },
  );

  it(
    ac(
      ['AC-TXN-006-1'],
      'S2 §7 3',
      '같은 거래를 동시에 수정하면 나중에 처리된 저장이 최종값이고 필드가 섞이지 않는다(통째 교체)',
    ),
    async () => {
      const r = await room();
      const t = (await create(0, r, { reason: '처음', round: 'R0' })).body.transaction.id as string;
      const bodies = Array.from({ length: 12 }, (_, i) => ({
        amount: 1000 + i,
        reason: `사유${i}`,
        round: `R${i}`,
      }));
      const results = await Promise.all(
        bodies.map((b, i) => call(at(i), 'PUT', `/rooms/${r.roomId}/transactions/${t}`, r.key, b)),
      );
      expect(tally(results)).toEqual({ '200': 12 });
      const [final] = await q<{ amount: string; reason: string; round: string; updatedAt: Date }>(
        `SELECT "amount"::text,"reason","round","updatedAt" FROM "Transaction" WHERE "id"=$1`,
        [t],
      );
      // 최종값은 요청 하나의 세 값 그대로다(섞이지 않는다)
      expect(
        bodies.some(
          (b) =>
            String(b.amount) === final!.amount &&
            b.reason === final!.reason &&
            b.round === final!.round,
        ),
      ).toBe(true);
      // 그리고 가장 늦은 updatedAt을 가진 응답의 값이다
      const latest = Math.max(...results.map((x) => Date.parse(x.body.transaction.updatedAt)));
      const winners = results
        .filter((x) => Date.parse(x.body.transaction.updatedAt) === latest)
        .map((x) => String(x.body.transaction.amount));
      expect(winners).toContain(final!.amount);
      // 변경 이벤트 번호는 빠짐없이 증가한다
      await vi.waitFor(
        () =>
          expect(
            events.filter((e) => e.roomId === r.roomId && e.event === 'transaction.updated'),
          ).toHaveLength(12),
        { timeout: 30_000 },
      );
      const revs = events
        .filter((e) => e.roomId === r.roomId && e.event === 'transaction.updated')
        .map((e) => e.revision as number);
      expect(revs).toHaveLength(12);
      expect(new Set(revs).size).toBe(12);
    },
  );

  it(
    ac(
      ['AC-TXN-006-4'],
      'S2 §7 4',
      '수정과 삭제가 동시에 도착하면 일관된 하나의 결과: 삭제 뒤의 수정은 TRANSACTION_DELETED이고 삭제 뒤에 반영된 수정이 없다',
    ),
    async () => {
      for (let round = 0; round < 3; round++) {
        const r = await room();
        const t = (await create(0, r, {})).body.transaction.id as string;
        const results = await Promise.all([
          call(at(0), 'DELETE', `/rooms/${r.roomId}/transactions/${t}`, r.key),
          ...Array.from({ length: 6 }, (_, i) =>
            call(at(i + 1), 'PUT', `/rooms/${r.roomId}/transactions/${t}`, r.key, {
              amount: 200 + i,
            }),
          ),
        ]);
        const del = results[0]!;
        const upds = results.slice(1);
        expect(del.status).toBe(200); // 삭제는 한 번 성공한다
        for (const u of upds) expect([200, 409]).toContain(u.status);
        for (const u of upds.filter((x) => x.status === 409))
          expect(u.body.error.code).toBe('TRANSACTION_DELETED');
        const [row] = await q<{ deletedAt: Date; updatedAt: Date; amount: string }>(
          `SELECT "deletedAt","updatedAt","amount"::text FROM "Transaction" WHERE "id"=$1`,
          [t],
        );
        expect(row!.deletedAt).toBeInstanceOf(Date); // 최종 상태는 삭제됨
        for (const u of upds.filter((x) => x.status === 200)) {
          expect(Date.parse(u.body.transaction.updatedAt)).toBeLessThanOrEqual(
            row!.deletedAt.getTime(),
          ); // 삭제 뒤에 반영된 수정이 없다
        }
        expect(
          upds.filter((x) => x.status === 200).length + upds.filter((x) => x.status === 409).length,
        ).toBe(6);
      }
    },
  );

  it(
    ac(
      ['AC-PART-002-8'],
      'S1 §7 6',
      '참여자 비활성화와 거래 생성이 동시에 도착하면 처리 시점의 상태로 판정한다(비활성화 이후의 생성은 PARTICIPANT_INACTIVE)',
    ),
    async () => {
      const r = await room();
      const target = r.p[1]!;
      const results = await Promise.all([
        ...Array.from({ length: 6 }, (_, i) => create(i, r, { amount: 10 + i })),
        plain(at(1), 'PATCH', `/rooms/${r.roomId}/participants/${target}`, r.key, {
          status: 'INACTIVE',
        }),
        ...Array.from({ length: 6 }, (_, i) => create(i + 1, r, { amount: 20 + i })),
      ]);
      await vi.waitFor(
        () =>
          expect(
            events.filter((e) => e.roomId === r.roomId && e.event === 'transaction.created'),
          ).toHaveLength(results.filter((x) => x.status === 201).length),
        { timeout: 30_000 },
      );
      await vi.waitFor(
        () =>
          expect(
            events.some((e) => e.roomId === r.roomId && e.event === 'participant.status_changed'),
          ).toBe(true),
        { timeout: 30_000 },
      );
      const evs = events.filter((e) => e.roomId === r.roomId);
      const change = evs.find((e) => e.event === 'participant.status_changed')!;
      const createdBefore = evs
        .filter(
          (e) =>
            e.event === 'transaction.created' &&
            (e.revision as number) < (change.revision as number),
        )
        .map((e) => e.transactionId);
      const createdAfter = evs.filter(
        (e) =>
          e.event === 'transaction.created' && (e.revision as number) > (change.revision as number),
      );
      expect(createdAfter).toHaveLength(0); // 비활성화 뒤에는 어떤 생성도 성공하지 않는다
      const succeeded = results
        .filter((x) => x.status === 201 && x.body.transaction)
        .map((x) => x.body.transaction.id as string);
      expect([...succeeded].sort()).toEqual([...(createdBefore as string[])].sort());
      for (const x of results.filter((x) => x.status === 409))
        expect(x.body.error.code).toBe('PARTICIPANT_INACTIVE');
    },
  );

  it(
    ac(
      ['AC-TXN-009-2'],
      'S2 §7 2',
      '종료와 거래 생성이 경쟁하면 직렬 순서대로 판정된다(종료 뒤의 생성은 GAME_ENDED, 앞선 거래는 반영된다)',
    ),
    async () => {
      const r = await room();
      // 종료 API는 S4 소관이라 DB에서 방 잠금을 쥔 종료 트랜잭션을 흉내 낸다(다른 연결, 같은 잠금).
      const ender = new pg.Client({ connectionString: db.databaseUrl });
      await ender.connect();
      try {
        const before = await Promise.all(
          Array.from({ length: 3 }, (_, i) => create(i, r, { amount: 1 + i })),
        );
        expect(tally(before)).toEqual({ '201': 3 });
        await ender.query('BEGIN');
        await ender.query(`SELECT "id" FROM "Room" WHERE "id"=$1 FOR UPDATE`, [r.roomId]);
        const racing = Promise.all(
          Array.from({ length: 6 }, (_, i) => create(i, r, { amount: 50 + i })),
        );
        await sleep(500);
        await ender.query(`UPDATE "Room" SET "status"='ENDED' WHERE "id"=$1`, [r.roomId]);
        await ender.query('COMMIT');
        expect(tally(await racing)).toEqual({ '409 GAME_ENDED': 6 });
      } finally {
        await ender.end();
      }
      expect(
        Number(
          (
            await q<{ n: string }>(
              `SELECT count(*)::text AS n FROM "Transaction" WHERE "roomId"=$1`,
              [r.roomId],
            )
          )[0]!.n,
        ),
      ).toBe(3);
    },
  );

  it('seq는 고유하고 증가하며 createdAt은 비감소다(두 프로세스에서 40건 동시 생성)', async () => {
    const r = await room();
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => create(i, r, { amount: i + 1 })),
    );
    expect(tally(results)).toEqual({ '201': 40 });
    const rows = await q<{ seq: number; createdAt: Date }>(
      `SELECT "seq","createdAt" FROM "Transaction" WHERE "roomId"=$1 ORDER BY "seq"`,
      [r.roomId],
    );
    expect(rows.map((x) => x.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(rows[i - 1]!.createdAt.getTime());
  });

  it('시계가 거꾸로 가도(마지막 생성 시각이 미래) createdAt은 이전 값 아래로 내려가지 않는다', async () => {
    const r = await room();
    const first = (await create(0, r, {})).body.transaction;
    const future = new Date(Date.now() + 2 * 3_600_000);
    await q(`UPDATE "Room" SET "lastTxnCreatedAt"=$2 WHERE "id"=$1`, [r.roomId, future]);
    const next = await Promise.all(
      Array.from({ length: 4 }, (_, i) => create(i, r, { amount: i + 1 })),
    );
    for (const x of next)
      expect(Date.parse(x.body.transaction.createdAt)).toBeGreaterThanOrEqual(future.getTime());
    const rows = await q<{ seq: number; createdAt: Date }>(
      `SELECT "seq","createdAt" FROM "Transaction" WHERE "roomId"=$1 ORDER BY "seq"`,
      [r.roomId],
    );
    expect(Date.parse(first.createdAt)).toBeLessThan(future.getTime());
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(rows[i - 1]!.createdAt.getTime());
  });

  it('잠금 대기 시간 측정(RK-10): 방 하나에 60건 동시 쓰기의 지연', async () => {
    const r = await room();
    const durations: number[] = [];
    const results = await Promise.all(
      Array.from({ length: 60 }, async (_, i) => {
        const t0 = performance.now();
        const res = await create(i, r, { amount: (i % 900) + 1 });
        durations.push(performance.now() - t0);
        return res;
      }),
    );
    expect(tally(results)).toEqual({ '201': 60 });
    durations.sort((a, b) => a - b);
    const p = (x: number) =>
      Math.round(durations[Math.min(durations.length - 1, Math.floor(durations.length * x))]!);
    console.log(
      `[RK-10] 같은 방 60건 동시 생성(프로세스 2개): p50=${p(0.5)}ms p95=${p(0.95)}ms max=${p(1)}ms`,
    );
    expect(p(0.95)).toBeLessThan(10_000); // 요청 제한 시간(30초)보다 한참 짧다
  });
});
