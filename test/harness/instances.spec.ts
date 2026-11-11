import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { createIsolatedDb, TEST_ROOM_DDL, type IsolatedDb } from '../helpers/isolated-db.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let db: IsolatedDb;
let a: Instance;
let b: Instance;

async function post(i: Instance, path: string) {
  const res = await i.fetch(path, { method: 'POST' });
  return (await res.json()) as { revision: number; pid: number };
}
async function get(i: Instance, id: string) {
  return (await (await i.fetch(`/__probe/rooms/${id}`)).json()) as {
    revision: number;
    pid: number;
  };
}
async function seed(...ids: string[]) {
  for (const id of ids) await db.fixtures(`INSERT INTO "Room" ("id") VALUES ('${id}')`);
}

beforeAll(async () => {
  db = await createIsolatedDb();
  await db.fixtures(TEST_ROOM_DDL);
  [a, b] = (await startInstances(2, { databaseUrl: db.databaseUrl })) as [Instance, Instance];
});
afterAll(async () => {
  await stopAll([a, b].filter(Boolean));
  await db?.drop();
});

describe('다중 프로세스 하네스 (BE-F8)', () => {
  it('별도 OS 프로세스 2개가 각자 /health에 응답한다', async () => {
    expect(a.pid).not.toBe(b.pid);
    expect(a.pid).not.toBe(process.pid);
    expect(a.port).not.toBe(b.port);
    for (const i of [a, b]) expect((await i.fetch('/health')).status).toBe(200);
  });

  it('한 프로세스의 변경을 다른 프로세스가 본다', async () => {
    await seed('see');
    const w = await post(a, '/__probe/rooms/see/increment');
    expect(w).toEqual({ revision: 1, pid: a.pid });
    const r = await get(b, 'see');
    expect(r).toEqual({ revision: 1, pid: b.pid });
    await post(b, '/__probe/rooms/see/increment');
    expect((await get(a, 'see')).revision).toBe(2);
  });

  it('두 프로세스가 동시에 증가시켜도 withRoomLock이 갱신 유실을 막는다', async () => {
    await seed('safe');
    const calls = Array.from({ length: 20 }, (_, i) =>
      post(i % 2 === 0 ? a : b, '/__probe/rooms/safe/increment'),
    );
    const results = await Promise.all(calls);
    expect(new Set(results.map((r) => r.pid))).toEqual(new Set([a.pid, b.pid]));
    expect((await get(a, 'safe')).revision).toBe(20);
    expect(new Set(results.map((r) => r.revision)).size).toBe(20);
  });

  it('음성 대조: 잠금 없이 읽고 쓰면 같은 하네스에서 갱신이 유실된다', async () => {
    await seed('unsafe');
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        post(i % 2 === 0 ? a : b, '/__probe/rooms/unsafe/increment-unsafe'),
      ),
    );
    expect((await get(a, 'unsafe')).revision).toBeLessThan(10);
  });

  it('SIGSTOP 동안 응답하지 않고 SIGCONT 뒤 복구된다', async () => {
    const [c] = await startInstances(1, { databaseUrl: db.databaseUrl });
    try {
      c!.signal('SIGSTOP');
      await expect(c!.fetch('/health', { signal: AbortSignal.timeout(500) })).rejects.toThrow();
      c!.signal('SIGCONT');
      await vi.waitFor(async () => expect((await c!.fetch('/health')).status).toBe(200), {
        timeout: 5_000,
      });
    } finally {
      await c!.stop();
    }
  });

  it('stop하면 프로세스가 사라진다(멈춘 프로세스 포함)', async () => {
    const [c] = await startInstances(1, { databaseUrl: db.databaseUrl });
    const pid = c!.pid;
    c!.signal('SIGSTOP');
    await c!.stop();
    expect(c!.isRunning()).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it('기동 실패는 캡처한 출력과 함께 던지고 남는 프로세스가 없다', async () => {
    await expect(
      startInstances(2, { databaseUrl: db.databaseUrl, env: { CORS_ORIGINS: '' } }),
    ).rejects.toThrow(/환경 변수 검증 실패/);
  });

  it('운영 진입점(main)도 같은 방식으로 띄운다', async () => {
    const [m] = await startInstances(1, { databaseUrl: db.databaseUrl, entry: 'main' });
    try {
      expect((await m!.fetch('/health')).status).toBe(200);
      expect((await m!.fetch('/__probe/rooms/x')).status).toBe(404); // 프로브는 운영 진입점에 없다
    } finally {
      await m!.stop();
    }
  });
});
