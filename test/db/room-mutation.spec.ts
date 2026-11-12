import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DatabaseService,
  RequestTimeoutError,
  ROOM_EVENTS_CHANNEL,
  RoomNotFoundError,
} from '../../src/common/db/database.service.js';
import { PrismaService } from '../../src/common/db/prisma.service.js';
import { newId, newInviteCode } from '../../src/common/ids/ids.js';
import { baseDatabaseUrl, createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { deferred, sleep } from '../helpers/util.js';

let db: IsolatedDb;
let prisma: PrismaService;
let svc: DatabaseService;
let listener: pg.Client;
const received: { roomId: string; [k: string]: unknown }[] = [];

beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
  prisma = new PrismaService({ DATABASE_URL: db.databaseUrl, DB_POOL_MAX: 10 });
  svc = new DatabaseService(prisma, {
    DB_LOCK_TIMEOUT_MS: 5_000,
    DB_STATEMENT_TIMEOUT_MS: 10_000,
    REQUEST_TIMEOUT_MS: 30_000,
  });
  // 통지는 데이터베이스 전체 채널이라 다른 시험의 방 통지가 섞일 수 있다. roomId로 가려서 본다.
  listener = new pg.Client({ connectionString: baseDatabaseUrl() });
  await listener.connect();
  await listener.query(`LISTEN ${ROOM_EVENTS_CHANNEL}`);
  listener.on('notification', (m) => {
    if (m.channel === ROOM_EVENTS_CHANNEL && m.payload) received.push(JSON.parse(m.payload));
  });
});
afterAll(async () => {
  await listener?.end();
  await prisma?.onModuleDestroy();
  await db?.drop();
});

async function room(): Promise<string> {
  const id = newId();
  await db.query(`INSERT INTO "Room" ("id","name","unit","inviteCode") VALUES ($1,'R','원',$2)`, [
    id,
    newInviteCode(),
  ]);
  return id;
}
const revisionOf = async (id: string) =>
  (await db.query<{ revision: number }>(`SELECT "revision" FROM "Room" WHERE "id"=$1`, [id]))[0]!
    .revision;
const eventsFor = (roomId: string) => received.filter((e) => e.roomId === roomId);

describe('withRoomMutation (BE-F7, PD-3~PD-5, S5 §6.1)', () => {
  it('변경 N건 뒤 revision이 빠짐없이 1씩 증가하고 값이 반환된다', async () => {
    const id = await room();
    const out = [];
    for (let i = 1; i <= 5; i++) {
      out.push(
        await svc.withRoomMutation(id, async () => ({
          value: i,
          event: { event: 'room.ended' as const },
        })),
      );
    }
    expect(out.map((o) => o.revision)).toEqual([1, 2, 3, 4, 5]);
    expect(out.map((o) => o.value)).toEqual([1, 2, 3, 4, 5]);
    expect(await revisionOf(id)).toBe(5);
  });

  it('동시 변경도 번호가 겹치거나 건너뛰지 않는다(같은 방 20건)', async () => {
    const id = await room();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        svc.withRoomMutation(id, async () => ({
          value: i,
          event: { event: 'transaction.created' as const, transactionId: `t${i}` },
        })),
      ),
    );
    expect(results.map((r) => r.revision!).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(await revisionOf(id)).toBe(20);
    await sleep(300);
    expect(eventsFor(id)).toHaveLength(20);
    expect(new Set(eventsFor(id).map((e) => e.revision)).size).toBe(20);
  });

  it('변경이 없으면(event 없음: 거부 직전의 no-op·멱등 재전송·같은 값) revision을 소비하지 않고 통지하지 않는다', async () => {
    const id = await room();
    const r = await svc.withRoomMutation(id, async () => ({ value: 'noop' }));
    expect(r).toEqual({ value: 'noop', revision: null });
    expect(await revisionOf(id)).toBe(0);
    await sleep(200);
    expect(eventsFor(id)).toHaveLength(0);
    // 이후 실제 변경은 1번을 받는다(번호가 비지 않는다)
    expect(
      (
        await svc.withRoomMutation(id, async () => ({
          value: 1,
          event: { event: 'room.ended' as const },
        }))
      ).revision,
    ).toBe(1);
  });

  it('콜백이 던지면 롤백되어 revision도 통지도 없다', async () => {
    const id = await room();
    await expect(
      svc.withRoomMutation(id, async (tx) => {
        await tx.$executeRaw`UPDATE "Room" SET "name" = 'changed' WHERE "id" = ${id}`;
        throw new Error('rejected');
      }),
    ).rejects.toThrow('rejected');
    expect(await revisionOf(id)).toBe(0);
    expect(
      (await db.query<{ name: string }>(`SELECT "name" FROM "Room" WHERE "id"=$1`, [id]))[0]!.name,
    ).toBe('R');
    await sleep(200);
    expect(eventsFor(id)).toHaveLength(0);
  });

  it('통지는 커밋 전에 수신되지 않고 커밋 뒤에 도착한다(R-I2)', async () => {
    const id = await room();
    const inside = deferred();
    const release = deferred();
    const mutation = svc.withRoomMutation(id, async () => {
      inside.resolve();
      await release.promise;
      return { value: 'x', event: { event: 'participant.created' as const, participantId: 'p1' } };
    });
    await inside.promise;
    await sleep(300);
    expect(eventsFor(id)).toHaveLength(0); // 아직 커밋 전
    release.resolve();
    await mutation;
    await vi.waitFor(() => expect(eventsFor(id)).toHaveLength(1), { timeout: 5_000 });
  });

  it('통지 본문은 종류·식별자·roomId·revision·serverTime만 담는다(S5 §4.2)', async () => {
    const id = await room();
    await svc.withRoomMutation(id, async () => ({
      value: 0,
      event: { event: 'transaction.updated' as const, transactionId: 'tx1' },
    }));
    await svc.withRoomMutation(id, async () => ({
      value: 0,
      event: { event: 'participant.status_changed' as const, participantId: 'p9' },
    }));
    await svc.withRoomMutation(id, async () => ({
      value: 0,
      event: { event: 'room.ended' as const },
    }));
    await sleep(300);
    const [a, b, c] = eventsFor(id);
    expect(a).toMatchObject({
      event: 'transaction.updated',
      roomId: id,
      revision: 1,
      transactionId: 'tx1',
    });
    expect(b).toMatchObject({
      event: 'participant.status_changed',
      roomId: id,
      revision: 2,
      participantId: 'p9',
    });
    expect(c).toMatchObject({ event: 'room.ended', roomId: id, revision: 3 });
    expect(Object.keys(a!).sort()).toEqual([
      'event',
      'revision',
      'roomId',
      'serverTime',
      'transactionId',
    ]);
    expect(Object.keys(b!).sort()).toEqual([
      'event',
      'participantId',
      'revision',
      'roomId',
      'serverTime',
    ]);
    expect(Object.keys(c!).sort()).toEqual(['event', 'revision', 'roomId', 'serverTime']);
    for (const e of [a, b, c]) {
      expect(String(e!.serverTime)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // RFC 3339 UTC 밀리초
    }
  });

  it('없는 방은 RoomNotFoundError이며 통지가 없다', async () => {
    await expect(
      svc.withRoomMutation('missing', async () => ({
        value: 1,
        event: { event: 'room.ended' as const },
      })),
    ).rejects.toBeInstanceOf(RoomNotFoundError);
  });

  it('요청 마감을 넘기면 롤백되어 번호와 통지가 남지 않는다', async () => {
    const id = await room();
    const tight = new DatabaseService(prisma, {
      DB_LOCK_TIMEOUT_MS: 300,
      DB_STATEMENT_TIMEOUT_MS: 500,
      REQUEST_TIMEOUT_MS: 600,
    });
    await expect(
      tight.withRoomMutation(id, async () => {
        await sleep(1_500);
        return { value: 1, event: { event: 'room.ended' as const } };
      }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
    await sleep(1_500);
    expect(await revisionOf(id)).toBe(0);
    expect(eventsFor(id)).toHaveLength(0);
  });

  it('다른 방의 변경은 서로의 번호에 영향을 주지 않는다', async () => {
    const a = await room();
    const b = await room();
    await svc.withRoomMutation(a, async () => ({
      value: 0,
      event: { event: 'room.ended' as const },
    }));
    await svc.withRoomMutation(a, async () => ({
      value: 0,
      event: { event: 'room.ended' as const },
    }));
    await svc.withRoomMutation(b, async () => ({
      value: 0,
      event: { event: 'room.ended' as const },
    }));
    expect(await revisionOf(a)).toBe(2);
    expect(await revisionOf(b)).toBe(1);
  });
});
