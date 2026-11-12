import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ac } from '../helpers/contract.js';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { sleep } from '../helpers/util.js';
import { newKey } from '../s1/s1-helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 90_000 });

type Body = { [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Page {
  transactions: { id: string; createdAt: string }[];
  nextCursor: string | null;
}

let db: IsolatedDb;
let inst: Instance[];
const at = (n: number) => inst[n % inst.length]!;
const idem = () => ({ key: randomBytes(16).toString('base64url'), at: new Date().toISOString() });

async function api(
  i: Instance,
  method: string,
  path: string,
  key: string,
  body?: unknown,
  h?: { key: string; at: string },
) {
  const res = await i.fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(h ? { 'Idempotency-Key': h.key, 'Idempotency-First-Attempt-At': h.at } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Body,
    headers: res.headers,
  };
}

interface Room {
  key: string;
  roomId: string;
  hostId: string;
  p: string[];
}
async function room(): Promise<Room> {
  const key = newKey();
  const created = await api(at(0), 'POST', '/rooms', key, {
    name: 'Iter',
    unit: '원',
    nickname: 'Host',
  });
  const roomId = created.body.room.id as string;
  const p: string[] = [];
  for (let i = 0; i < 3; i++)
    p.push(
      (await api(at(i), 'POST', `/rooms/${roomId}/participants`, key, { nickname: `P${i}` })).body
        .participant.id as string,
    );
  return { key, roomId, hostId: created.body.me.id as string, p };
}
const create = (n: number, r: Room, amount: number, h = idem()) =>
  api(
    at(n),
    'POST',
    `/rooms/${r.roomId}/transactions`,
    r.key,
    { payerId: r.p[0], payeeId: r.p[1], amount },
    h,
  );
const page = async (i: Instance, r: Room, cursor?: string): Promise<Page> =>
  (
    await api(
      i,
      'GET',
      `/rooms/${r.roomId}/transactions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      r.key,
    )
  ).body as Page;
const q = <T extends object>(sql: string, params: unknown[] = []) =>
  db.query(sql, params) as Promise<T[]>;

async function seed(r: Room, count: number): Promise<string[]> {
  const start = Date.now() - 3_600_000;
  const ids = Array.from(
    { length: count },
    (_, i) => `it${r.roomId.slice(0, 5)}${String(i + 1).padStart(15, '0')}`, // 22자: 경로 매개변수 제약을 통과하는 ID,
  );
  await q(
    `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","authorId","originalAmount","createdAt","updatedAt")
     SELECT 'it' || $5 || lpad(g::text, 15, '0'), $1, g, $2, $3, 100, $4, 100, to_timestamp(($6::bigint + g) / 1000.0), to_timestamp(($6::bigint + g) / 1000.0)
     FROM generate_series(1, $7::int) g`,
    [r.roomId, r.p[0], r.p[1], r.hostId, r.roomId.slice(0, 5), start, count],
  );
  await q(
    `UPDATE "Room" SET "nextTxnSeq" = $2, "lastTxnCreatedAt" = (SELECT max("createdAt") FROM "Transaction" WHERE "roomId"=$1) WHERE "id"=$1`,
    [r.roomId, count + 1],
  );
  return ids;
}

beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
  inst = await startInstances(2, { databaseUrl: db.databaseUrl, entry: 'main' });
});
afterAll(async () => {
  await stopAll(inst ?? []);
  await db?.drop();
});

describe('S3 일관성 (서로 다른 프로세스 2개, 같은 DB)', () => {
  it('CURSOR_KEY가 바뀐 인스턴스는 이전 키로 발급된 커서를 422 INVALID_VALUE로 거부한다(키 교체)', async () => {
    const r = await room();
    await seed(r, 30);
    const a = await page(at(0), r);
    const rotated = await startInstances(1, {
      databaseUrl: db.databaseUrl,
      entry: 'main',
      env: { CURSOR_KEY: Buffer.alloc(32, 9).toString('base64') },
    });
    try {
      const res = await api(
        rotated[0]!,
        'GET',
        `/rooms/${r.roomId}/transactions?cursor=${encodeURIComponent(a.nextCursor!)}`,
        r.key,
      );
      expect(res.status).toBe(422);
      expect(res.body.error.details).toEqual([{ field: 'cursor', code: 'INVALID_VALUE' }]);
    } finally {
      await stopAll(rotated);
    }
  });

  it(
    ac(
      ['AC-VIEW-003-4'],
      'S3 §4.1.2',
      '(a)(b) 45건 중 첫 20건 조회 뒤 다른 요청이 거래를 생성·수정·삭제해도 순회 시작 시점의 거래가 중복·누락 없이 한 번씩 나오고, 순회 중 생성한 거래는 후속 페이지에 없으며 첫 페이지를 다시 조회하면 맨 위에 있다',
    ),
    async () => {
      const r = await room();
      const original = await seed(r, 45);
      const first = await page(at(0), r);
      expect(first.transactions).toHaveLength(20);
      const seenInFirst = first.transactions.map((t) => t.id);
      // 순회 사이에 다른 프로세스가 변경한다: 생성 5, 수정 5(아직 안 본 거래), 삭제 5(그중 일부는 이미 본 것)
      const created = await Promise.all(Array.from({ length: 5 }, (_, i) => create(i, r, 700 + i)));
      const newIds = created.map((x) => x.body.transaction.id as string);
      const notYetSeen = original.filter((id) => !seenInFirst.includes(id));
      const toUpdate = notYetSeen.slice(0, 5);
      const toDeleteUnseen = notYetSeen.slice(10, 13); // 아직 안 본 것 중 삭제 → 순회에서 0번
      const toDeleteSeen = seenInFirst.slice(0, 2); // 이미 본 것 삭제 → 이미 한 번 받았다
      const writes = await Promise.all([
        ...toUpdate.map((id, i) =>
          api(
            at(i + 1),
            'PUT',
            `/rooms/${r.roomId}/transactions/${id}`,
            r.key,
            { amount: 5000 + i },
            idem(),
          ),
        ),
        ...[...toDeleteUnseen, ...toDeleteSeen].map((id, i) =>
          api(at(i), 'DELETE', `/rooms/${r.roomId}/transactions/${id}`, r.key, undefined, idem()),
        ),
      ]);
      expect(writes.map((w) => w.status)).toEqual(Array(writes.length).fill(200)); // 겹친 수정·삭제가 모두 성공
      const rest: string[] = [];
      let cursor = first.nextCursor;
      while (cursor) {
        const p = await page(at(1), r, cursor); // 다른 인스턴스가 같은 커서를 받아도 된다
        rest.push(...p.transactions.map((t) => t.id));
        cursor = p.nextCursor;
      }
      const all = [...seenInFirst, ...rest];
      expect(new Set(all).size).toBe(all.length); // 중복 없음
      const expected = original.filter((id) => !toDeleteUnseen.includes(id)); // 시작 시점 거래 − 아직 안 본 채 삭제된 것
      expect([...all].sort()).toEqual([...expected].sort()); // 누락 없음(이미 본 삭제분은 한 번 받았다)
      for (const id of newIds) expect(all).not.toContain(id); // 순회 중 생성은 후속 페이지에 없다
      const again = await page(at(0), r); // 첫 페이지를 다시 조회하면 새 거래가 맨 위
      expect(
        again.transactions
          .slice(0, 5)
          .map((t) => t.id)
          .sort(),
      ).toEqual([...newIds].sort());
      // 수정은 위치를 바꾸지 않는다: 수정된 거래는 원래 위치에서 나왔다
      const order = all.filter((id) => original.includes(id));
      expect(order).toEqual([...original].reverse().filter((id) => !toDeleteUnseen.includes(id)));
    },
  );

  it(
    ac(
      ['AC-VIEW-003-4', 'AC-VIEW-003-2', 'AC-VIEW-003-6'],
      'S3 §7',
      '동시 생성이 계속되는 동안 순회해도 시작 시점의 거래는 중복·누락 없이 나오고, 뒤늦게 커밋된 낮은 seq가 이미 지난 경계 위에 나타나지 않는다',
    ),
    async () => {
      const r = await room();
      const original = await seed(r, 60);
      let stop = false;
      let made = 0;
      const failedWrites: string[] = [];
      const writer = (async () => {
        let n = 0;
        while (!stop) {
          const rs = await Promise.all(
            Array.from({ length: 4 }, (_, i) => create(n + i, r, 100 + ((made + i) % 800))),
          );
          for (const x of rs) {
            if (x.status === 201) made++;
            else failedWrites.push(`${x.status} ${JSON.stringify(x.body)}`);
          }
          n += 4;
        }
      })();
      try {
        for (let traversal = 0; traversal < 4; traversal++) {
          const started = new Set<string>(original);
          const seen: string[] = [];
          let cursor: string | null | undefined;
          let first = true;
          while (first || cursor) {
            const p = await page(at(traversal + seen.length), r, cursor ?? undefined);
            seen.push(...p.transactions.map((t) => t.id));
            cursor = p.nextCursor;
            first = false;
          }
          expect(new Set(seen).size).toBe(seen.length); // 중복 없음
          // 순회 시작 때 있던 원본 거래는 모두 순서대로 한 번씩 있다
          const fromOriginal = seen.filter((id) => started.has(id));
          expect(fromOriginal).toEqual([...original].reverse());
          // 순회 중 생긴 새 거래는 (있다면) 처음 읽은 페이지 이후에 늘어나지 않는다: 원본 아래에 새 거래가 끼지 않는다
          const lastOriginalIdx = seen.lastIndexOf(original[0]!);
          for (const id of seen.slice(lastOriginalIdx + 1)) expect(started.has(id)).toBe(false);
          const firstOriginalIdx = seen.indexOf(original[original.length - 1]!);
          for (const id of seen.slice(0, firstOriginalIdx)) expect(started.has(id)).toBe(false);
          // 원본 구간 안(페이지 경계 포함)에는 순회 중 생긴 거래가 한 건도 끼어들지 않는다
          for (const id of seen.slice(firstOriginalIdx, lastOriginalIdx + 1))
            expect(started.has(id), '원본 구간에 새 거래가 끼었다').toBe(true);
        }
      } finally {
        stop = true;
        await writer;
      }
      expect(failedWrites).toEqual([]); // 겹친 쓰기가 모두 성공해야 이 시험이 의미가 있다
      expect(made).toBeGreaterThan(8);
      const seqs = await q<{ seq: number; createdAt: Date }>(
        `SELECT "seq","createdAt" FROM "Transaction" WHERE "roomId"=$1 ORDER BY "seq"`,
        [r.roomId],
      );
      expect(new Set(seqs.map((x) => x.seq)).size).toBe(seqs.length);
      for (let i = 1; i < seqs.length; i++)
        expect(seqs[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(
          seqs[i - 1]!.createdAt.getTime(),
        );
    },
  );

  it('한 응답 안은 하나의 스냅샷이다: 쓰기가 계속되는 동안 balances 합은 항상 0이고 같은 응답의 목록에는 중복이 없다', async () => {
    const r = await room();
    await seed(r, 30);
    let stop = false;
    const writer = (async () => {
      let n = 0;
      while (!stop) {
        const made = await Promise.all(
          Array.from({ length: 3 }, (_, i) => create(n + i, r, 50 + i)),
        );
        const id = made[0]!.body.transaction?.id as string | undefined;
        if (id) {
          await api(
            at(n),
            'PUT',
            `/rooms/${r.roomId}/transactions/${id}`,
            r.key,
            { amount: 999 },
            idem(),
          );
          if (n % 2 === 0)
            await api(
              at(n + 1),
              'DELETE',
              `/rooms/${r.roomId}/transactions/${id}`,
              r.key,
              undefined,
              idem(),
            );
        }
        n += 3;
      }
    })();
    try {
      for (let i = 0; i < 40; i++) {
        const b = await api(at(i), 'GET', `/rooms/${r.roomId}/balances`, r.key);
        expect(b.status).toBe(200);
        const sum = (b.body.balances as { balance: number }[]).reduce((a, x) => a + x.balance, 0);
        expect(sum).toBe(0);
        const l = await page(at(i + 1), r);
        const ids = l.transactions.map((t) => t.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (let k = 1; k < l.transactions.length; k++)
          expect(Date.parse(l.transactions[k - 1]!.createdAt)).toBeGreaterThanOrEqual(
            Date.parse(l.transactions[k]!.createdAt),
          );
      }
    } finally {
      stop = true;
      await writer;
    }
  });

  it('한 인스턴스가 발급한 커서를 다른 인스턴스가 받아들인다(같은 CURSOR_KEY)', async () => {
    const r = await room();
    await seed(r, 30);
    const a = await page(at(0), r);
    const viaB = await page(at(1), r, a.nextCursor!);
    expect(viaB.transactions).toHaveLength(10);
  });

  it(
    ac(
      ['AC-SYS-002-5', 'AC-TXN-008-5'],
      'S2 §9',
      '서버 측: 거래가 커밋된 뒤 응답이 전달되지 않아도(클라이언트 연결 끊김) 재조회하면 목록에 있고, 같은 키 재전송은 최초 성공 결과를 돌려주며 자동 재전송은 없다',
    ),
    async () => {
      const r = await room();
      const h = idem();
      const body = JSON.stringify({ payerId: r.p[0], payeeId: r.p[1], amount: 4242 });
      // 요청을 보낸 직후 클라이언트가 소켓을 끊는다(응답을 받지 못하는 상황)
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect(at(0).port, '127.0.0.1', () => {
          sock.write(
            `POST /rooms/${r.roomId}/transactions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${r.key}\r\nContent-Type: application/json\r\nIdempotency-Key: ${h.key}\r\nIdempotency-First-Attempt-At: ${h.at}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
            () => {
              sock.destroy(); // 응답을 읽지 않고 끊는다
              resolve();
            },
          );
        });
        sock.on('error', reject);
      });
      // 서버는 요청을 끝까지 처리한다: 재조회하면 거래가 목록에 있다
      let found: { id: string; amount: number } | undefined;
      for (let i = 0; i < 40 && !found; i++) {
        found = (await page(at(1), r)).transactions.find(
          (t) => (t as { amount?: number }).amount === 4242,
        ) as typeof found;
        if (!found) await sleep(100);
      }
      expect(found).toBeDefined();
      // 같은 키 재전송은 새 거래를 만들지 않고 최초 성공 결과(201, 같은 id)를 돌려준다
      const retry = await api(
        at(1),
        'POST',
        `/rooms/${r.roomId}/transactions`,
        r.key,
        { payerId: r.p[0], payeeId: r.p[1], amount: 4242 },
        h,
      );
      expect(retry.status).toBe(201);
      expect(retry.headers.get('idempotent-replayed')).toBe('true');
      expect(retry.body.transaction.id).toBe(found!.id);
      const all = await page(at(0), r);
      expect(
        all.transactions.filter((t) => (t as { amount?: number }).amount === 4242),
      ).toHaveLength(1); // 서버가 스스로 다시 보내지 않았다
    },
  );
});
