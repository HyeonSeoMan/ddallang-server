import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ac } from '../helpers/contract.js';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { baseDatabaseUrl, createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { createTx, makeRoom } from './s5-helpers.js';
import { openStream } from './sse-client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 90_000 });

let db: IsolatedDb;
let inst: Instance[];
let admin: pg.Client;

const listenerPids = async (i: Instance) =>
  (
    await admin.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE application_name = $1`,
      [`ddallang-bus-${i.pid}`],
    )
  ).rows.map((r) => r.pid);

beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
  inst = await startInstances(2, { databaseUrl: db.databaseUrl, entry: 'main' });
  admin = new pg.Client({ connectionString: baseDatabaseUrl() });
  await admin.connect();
});
afterAll(async () => {
  await admin?.end();
  await stopAll(inst ?? []);
  await db?.drop();
});

describe('다중 인스턴스 이벤트 전달·유실 복구 (BE-S5-5)', () => {
  it(
    ac(
      ['AC-SYS-003-2'],
      'S5 §4.2',
      '한 인스턴스가 커밋한 변경이 다른 인스턴스에 붙은 스트림에 전달된다',
    ),
    async () => {
      const r = await makeRoom(inst[0]!);
      const onA = await openStream(inst[0]!, r.roomId, r.key);
      const onB = await openStream(inst[1]!, r.roomId, r.key);
      try {
        await Promise.all(
          [onA, onB].map((s) => s.waitFor((e) => e.some((x) => x.event === 'ready'))),
        );
        await createTx(inst[0]!, r, 100);
        await createTx(inst[1]!, r, 200);
        for (const s of [onA, onB]) {
          const ev = await s.waitFor(
            (e) => e.filter((x) => x.event === 'transaction.created').length >= 2,
          );
          const revs = ev
            .filter((x) => x.event === 'transaction.created')
            .map((x) => x.data.revision);
          expect(revs).toEqual([4, 5]); // 두 스트림이 같은 순서를 본다
        }
      } finally {
        onA.close();
        onB.close();
      }
    },
  );

  it('LISTEN 연결이 끊겨 통지를 놓쳐도 다음 하트비트의 revision이 뒤처짐을 알리고, 재연결 뒤 새 이벤트가 다시 전달된다', async () => {
    const r = await makeRoom(inst[0]!);
    const s = await openStream(inst[1]!, r.roomId, r.key);
    try {
      await s.waitFor((e) => e.some((x) => x.event === 'ready'));
      const [pid] = await listenerPids(inst[1]!);
      expect(pid).toBeDefined();
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await createTx(inst[0]!, r, 1); // 재연결 전에 커밋 → 통지 유실 가능
      await createTx(inst[0]!, r, 2);
      expect(await listenerPids(inst[1]!), '재연결 전에 두 변경이 끝나야 한다').toHaveLength(0);
      // 하트비트(15초 주기)가 최신 revision을 알려 준다
      const ev = await s.waitFor(
        (e) => e.some((x) => x.event === 'heartbeat' && Number(x.data.revision) >= 5),
        25_000,
      );
      const beat = ev.filter((x) => x.event === 'heartbeat').at(-1)!;
      expect(beat.data.revision).toBe(5);
      // 재연결 뒤에는 새 이벤트가 정상 전달된다
      await vi.waitFor(async () => expect(await listenerPids(inst[1]!)).toHaveLength(1), {
        timeout: 10_000,
      });
      await createTx(inst[0]!, r, 3);
      await s.waitFor((e) =>
        e.some((x) => x.event === 'transaction.created' && x.data.revision === 6),
      );
    } finally {
      s.close();
    }
  });

  it('연속 변경 100건 동안 통지 큐가 넘치지 않고 마지막 revision까지 모두 도착한다', async () => {
    const r = await makeRoom(inst[0]!, 3);
    const s = await openStream(inst[1]!, r.roomId, r.key);
    try {
      await s.waitFor((e) => e.some((x) => x.event === 'ready'));
      const N = 100;
      for (let i = 0; i < N; i += 10)
        await Promise.all(
          Array.from({ length: 10 }, (_, k) => createTx(inst[(i + k) % 2]!, r, i + k + 1)),
        );
      const ev = await s.waitFor(
        (e) => e.filter((x) => x.event === 'transaction.created').length >= N,
        30_000,
      );
      const revs = ev
        .filter((x) => x.event === 'transaction.created')
        .map((x) => Number(x.data.revision));
      expect(revs).toHaveLength(N);
      expect(new Set(revs).size).toBe(N);
      expect(Math.max(...revs)).toBe(4 + N - 1);
      expect(s.isClosed()).toBe(false);
    } finally {
      s.close();
    }
  });
});
