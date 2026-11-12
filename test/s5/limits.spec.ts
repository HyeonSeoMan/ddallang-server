import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ac } from '../helpers/contract.js';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { sleep } from '../helpers/util.js';
import { createTx, joinRoom, makeRoom, type Room } from './s5-helpers.js';
import { openStream, type OpenedStream } from './sse-client.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 90_000 });

let db: IsolatedDb;
let inst: Instance[];
const at = (n: number) => inst[n % inst.length]!;
const leaseCount = async (roomId: string) =>
  Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "StreamLease" WHERE "roomId"=$1`,
        [roomId],
      )
    )[0]!.n,
  );
const closeAll = (ss: OpenedStream[]) => ss.forEach((s) => s.close());
const ok = (ss: OpenedStream[]) => ss.filter((s) => s.status === 200);
const limited = (ss: OpenedStream[]) => ss.filter((s) => s.status === 429);

beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
  inst = await startInstances(2, { databaseUrl: db.databaseUrl, entry: 'main' });
});
afterAll(async () => {
  await stopAll(inst ?? []);
  await db?.drop();
});

describe('SSE 연결 한도 (서버 인스턴스 전체 합산)', () => {
  it(
    ac(
      ['AC-SYS-003-5'],
      'S5 §4.1',
      '한 RoomMember가 두 프로세스에서 6개를 열면 5개까지만 열리고 6번째는 429 + Retry-After: 30(JSON 오류)이며 기존 5개는 유지된다',
    ),
    async () => {
      const r = await makeRoom(at(0));
      const open: OpenedStream[] = [];
      for (let i = 0; i < 5; i++) open.push(await openStream(at(i), r.roomId, r.key)); // 두 프로세스에 번갈아
      expect(open.every((s) => s.status === 200)).toBe(true);
      const sixth = await openStream(at(1), r.roomId, r.key);
      try {
        expect(sixth.status).toBe(429);
        expect(sixth.headers.get('retry-after')).toBe('30');
        expect(sixth.headers.get('content-type')).toMatch(/application\/json/);
        expect(sixth.body).toMatchObject({ error: { code: 'CONNECTION_LIMIT_EXCEEDED' } });
        // 기존 스트림은 쫓겨나지 않고 계속 이벤트를 받는다
        await Promise.all(open.map((s) => s.waitFor((e) => e.length >= 1)));
        await createTx(at(0), r, 10);
        await Promise.all(
          open.map((s) => s.waitFor((e) => e.some((x) => x.event === 'transaction.created'))),
        );
        expect(open.every((s) => !s.isClosed())).toBe(true);
        expect(await leaseCount(r.roomId)).toBe(5);
        // 하나를 닫으면 슬롯이 돌아온다
        open[0]!.close();
        let again = await openStream(at(0), r.roomId, r.key);
        for (let i = 0; i < 30 && again.status !== 200; i++) {
          await sleep(100);
          again = await openStream(at(0), r.roomId, r.key);
        }
        expect(again.status).toBe(200);
        again.close();
      } finally {
        closeAll(open);
      }
    },
  );

  it(
    ac(
      ['AC-ROOM-008-5'],
      'S5 §4.1',
      '동시 연결 경쟁: 같은 멤버가 두 프로세스에 12개를 동시에 열면 정확히 5개만 열린다',
    ),
    async () => {
      const r = await makeRoom(at(0));
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => openStream(at(i), r.roomId, r.key)),
      );
      try {
        expect(ok(results)).toHaveLength(5);
        expect(limited(results)).toHaveLength(7);
        expect(await leaseCount(r.roomId)).toBe(5);
      } finally {
        closeAll(results);
      }
    },
  );

  it('방당 50개: 멤버 10명이 5개씩 열어 50개(= 방 한도)가 되면 어느 멤버의 새 연결도 거부된다', async () => {
    const r = await makeRoom(at(0));
    const members: { key: string }[] = [{ key: r.key }];
    for (let i = 1; i < 10; i++) members.push(await joinRoom(at(0), r, `Mem${i}`));
    const all: OpenedStream[] = [];
    try {
      for (let m = 0; m < 10; m++) {
        const batch = await Promise.all(
          Array.from({ length: 5 }, (_, i) => openStream(at(m + i), r.roomId, members[m]!.key)),
        );
        all.push(...batch);
      }
      expect(ok(all)).toHaveLength(50);
      expect(await leaseCount(r.roomId)).toBe(50);
      // 방 전체가 50개다. RoomMember가 최대 10명이라 방 한도(50)는 멤버 한도(5)의 합과 같아 멤버 한도가 먼저 닿는다
      const rejected = await openStream(at(1), r.roomId, members[3]!.key);
      expect(rejected.status).toBe(429);
      expect(rejected.body).toMatchObject({ error: { code: 'CONNECTION_LIMIT_EXCEEDED' } });
    } finally {
      closeAll(all);
    }
  });

  it('프로세스 종료(SIGTERM)는 임대를 즉시 반납한다(우아한 종료)', async () => {
    const [a] = await startInstances(1, { databaseUrl: db.databaseUrl, entry: 'main' });
    const r = await makeRoom(a!);
    const open = await Promise.all(
      Array.from({ length: 3 }, () => openStream(a!, r.roomId, r.key)),
    );
    try {
      expect(await leaseCount(r.roomId)).toBe(3);
      await a!.stop(); // SIGTERM
      let n = 3;
      for (let i = 0; i < 40 && n > 0; i++) {
        await sleep(100);
        n = await leaseCount(r.roomId);
      }
      expect(n).toBe(0);
      await Promise.all(open.map((s) => s.closed)); // 서버가 스트림을 닫았다
    } finally {
      closeAll(open);
      await a!.stop();
    }
  });

  it(
    ac(
      ['AC-SYS-003-5'],
      'S5 §4.1',
      '서버 프로세스가 강제 종료(SIGKILL)돼도 임대가 T=15초 안에 만료되어 슬롯이 돌아온다',
    ),
    async () => {
      const [victim, other] = await startInstances(2, {
        databaseUrl: db.databaseUrl,
        entry: 'main',
      });
      try {
        const r = await makeRoom(other!);
        const held = await Promise.all(
          Array.from({ length: 5 }, () => openStream(victim!, r.roomId, r.key)),
        );
        expect(held.every((s) => s.status === 200)).toBe(true);
        victim!.signal('SIGKILL');
        await Promise.all(held.map((s) => s.closed)); // 연결이 끊겼다
        const killedAt = Date.now();
        // 임대는 아직 DB에 남아 있어 만료 전에는 새 연결이 거부된다
        const early = await openStream(other!, r.roomId, r.key);
        expect(early.status).toBe(429);
        let opened: OpenedStream[] = [];
        for (let i = 0; i < 40; i++) {
          const probe = await openStream(other!, r.roomId, r.key);
          if (probe.status === 200) {
            opened = [probe];
            break;
          }
          await sleep(500);
        }
        const recovered = (Date.now() - killedAt) / 1000;
        expect(opened).toHaveLength(1);
        expect(recovered).toBeLessThan(17); // T(15초) 안에 정리된다
        console.log(`[S5-6] SIGKILL 뒤 슬롯 복구까지 ${recovered.toFixed(1)}초`);
        closeAll(opened);
      } finally {
        await stopAll([victim!, other!]);
      }
    },
  );

  it(
    ac(
      ['AC-SYS-003-5'],
      'S5 §4.1 RK-14',
      '프로세스 정지(SIGSTOP) > T 동안 다른 인스턴스가 슬롯을 재사용하고, SIGCONT 뒤 정지했던 스트림은 어떤 데이터도 받지 않고 닫힌다',
    ),
    async () => {
      const [frozen, other] = await startInstances(2, {
        databaseUrl: db.databaseUrl,
        entry: 'main',
      });
      try {
        const r: Room = await makeRoom(other!);
        const old = await Promise.all(
          Array.from({ length: 5 }, () => openStream(frozen!, r.roomId, r.key)),
        );
        await Promise.all(old.map((s) => s.waitFor((e) => e.length >= 1)));
        expect(old.every((s) => s.status === 200)).toBe(true);
        frozen!.signal('SIGSTOP');
        await sleep(16_500); // T(15초)보다 오래 멈춘다: 임대가 만료된다
        // 다른 인스턴스가 같은 멤버의 슬롯 5개를 모두 다시 얻는다(한도 5가 인스턴스 합산이어도 만료된 임대는 세지 않는다)
        const fresh = await Promise.all(
          Array.from({ length: 5 }, () => openStream(other!, r.roomId, r.key)),
        );
        expect(ok(fresh)).toHaveLength(5);
        const bytesBefore = old.map((s) => s.bytes());
        frozen!.signal('SIGCONT');
        await createTx(other!, r, 4242); // 재개 직후 변경 이벤트가 생긴다
        await Promise.all(
          fresh.map((s) =>
            s.waitFor((e) => e.some((x) => x.event === 'transaction.created'), 8_000),
          ),
        );
        await Promise.all(old.map((s) => s.closed)); // 정지했던 스트림은 닫힌다
        await sleep(500);
        for (const [i, s] of old.entries()) {
          expect(s.isClosed(), `old ${i}`).toBe(true);
          expect(s.bytes(), `old ${i}는 재개 뒤 어떤 데이터도 받지 않았다`).toBe(bytesBefore[i]);
          expect(s.events.some((e) => e.event === 'transaction.created')).toBe(false);
        }
        expect(await leaseCount(r.roomId)).toBe(5); // 새 5개만 남는다
        closeAll(fresh);
      } finally {
        await stopAll([frozen!, other!]);
      }
    },
  );
});
