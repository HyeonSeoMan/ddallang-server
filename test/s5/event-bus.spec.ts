import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROOM_EVENTS_CHANNEL } from '../../src/common/db/database.service.js';
import { RoomEventBus, type RoomEventPayload } from '../../src/realtime/room-event-bus.js';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { createIsolatedDb, baseDatabaseUrl, type IsolatedDb } from '../helpers/isolated-db.js';
import { sleep } from '../helpers/util.js';
import { api, createTx, makeRoom } from './s5-helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let db: IsolatedDb;
let inst: Instance[];
let admin: pg.Client;
const buses: RoomEventBus[] = [];

const newBus = () => {
  const appName = `bus-test-${randomBytes(4).toString('hex')}`;
  const bus = new RoomEventBus({ DATABASE_URL: db.databaseUrl }, appName);
  buses.push(bus);
  return { bus, appName };
};
const backendPids = async (appName: string) =>
  (
    await admin.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE application_name = $1`,
      [appName],
    )
  ).rows.map((r) => r.pid);

beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
  inst = await startInstances(2, { databaseUrl: db.databaseUrl, entry: 'main' });
  admin = new pg.Client({ connectionString: baseDatabaseUrl() });
  await admin.connect();
});
afterAll(async () => {
  await Promise.all(buses.map((b) => b.onModuleDestroy()));
  await admin?.end();
  await stopAll(inst ?? []);
  await db?.drop();
});

describe('RoomEventBus (BE-S5-1)', () => {
  it('첫 구독 때 LISTEN 전용 연결 하나를 만든다(구독 전에는 연결하지 않는다)', async () => {
    const { bus, appName } = newBus();
    expect(await backendPids(appName)).toHaveLength(0);
    bus.subscribe('room-x', () => undefined);
    bus.subscribe('room-y', () => undefined);
    await bus.ready();
    expect(await backendPids(appName)).toHaveLength(1); // 방이 여러 개여도 연결은 하나
    expect(bus.listening).toBe(true);
  });

  it('다른 프로세스(서버 인스턴스)가 커밋한 변경의 통지를 받고 방별로 나눈다', async () => {
    const r = await makeRoom(inst[0]!);
    const other = await makeRoom(inst[0]!);
    const { bus } = newBus();
    const got: RoomEventPayload[] = [];
    const gotOther: RoomEventPayload[] = [];
    bus.subscribe(r.roomId, (e) => got.push(e));
    bus.subscribe(other.roomId, (e) => gotOther.push(e));
    await bus.ready();
    const t = await createTx(inst[1]!, r, 321); // 이 프로세스가 아닌 다른 프로세스가 변경한다
    await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 5_000 });
    expect(got[0]).toMatchObject({
      event: 'transaction.created',
      roomId: r.roomId,
      transactionId: t.body.transaction.id,
    });
    expect(got[0]!.revision).toBe(4);
    expect(gotOther).toHaveLength(0);
  });

  it('같은 방의 구독자 여럿이 모두 받고, 해제한 구독자는 받지 않는다. 처리 중 예외가 다른 구독자를 막지 않는다', async () => {
    const r = await makeRoom(inst[0]!);
    const { bus } = newBus();
    const a: number[] = [];
    const b: number[] = [];
    const c: number[] = [];
    bus.subscribe(r.roomId, () => {
      throw new Error('구독자 오류');
    });
    bus.subscribe(r.roomId, (e) => a.push(e.revision));
    const unsubB = bus.subscribe(r.roomId, (e) => b.push(e.revision));
    bus.subscribe(r.roomId, (e) => c.push(e.revision));
    await bus.ready();
    await createTx(inst[0]!, r, 1);
    await vi.waitFor(() => expect(a).toEqual([4]), { timeout: 5_000 });
    unsubB();
    await createTx(inst[1]!, r, 2);
    await vi.waitFor(() => expect(a).toEqual([4, 5]), { timeout: 5_000 });
    expect(b).toEqual([4]);
    expect(c).toEqual([4, 5]);
  });

  it('형식이 틀린 통지(JSON 아님·roomId 없음)는 버리고 계속 동작한다', async () => {
    const r = await makeRoom(inst[0]!);
    const { bus } = newBus();
    const got: RoomEventPayload[] = [];
    bus.subscribe(r.roomId, (e) => got.push(e));
    await bus.ready();
    await admin.query(`SELECT pg_notify($1, 'not json')`, [ROOM_EVENTS_CHANNEL]);
    await admin.query(`SELECT pg_notify($1, '{"event":"x"}')`, [ROOM_EVENTS_CHANNEL]);
    await createTx(inst[0]!, r, 5);
    await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 5_000 });
    expect(got[0]!.event).toBe('transaction.created');
  });

  it('통지는 커밋된 뒤에만 도착한다: 롤백되는 요청은 통지가 없다', async () => {
    const r = await makeRoom(inst[0]!);
    const { bus } = newBus();
    const got: RoomEventPayload[] = [];
    bus.subscribe(r.roomId, (e) => got.push(e));
    await bus.ready();
    await createTx(inst[0]!, r, 0); // 422 거부: 롤백 또는 변경 없음
    await api(inst[0]!, 'POST', `/rooms/${r.roomId}/participants`, r.key, {}); // 422
    await sleep(500);
    expect(got).toHaveLength(0);
  });

  it('연결이 끊기면 자동으로 재연결하고 다시 LISTEN해 이후 통지를 받는다', async () => {
    const r = await makeRoom(inst[0]!);
    const { bus, appName } = newBus();
    const got: RoomEventPayload[] = [];
    bus.subscribe(r.roomId, (e) => got.push(e));
    await bus.ready();
    expect(bus.connectCount).toBe(1);
    const [pid] = await backendPids(appName);
    await admin.query('SELECT pg_terminate_backend($1)', [pid]); // 서버가 연결을 끊는다
    await vi.waitFor(() => expect(bus.connectCount).toBe(2), { timeout: 10_000, interval: 100 });
    expect(await backendPids(appName)).toHaveLength(1); // 새 연결
    expect((await backendPids(appName))[0]).not.toBe(pid);
    await createTx(inst[1]!, r, 9);
    await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 5_000 });
  });

  it('끊긴 동안의 통지는 복구하지 않는다(저장·재전송 없음). 재연결 뒤 통지만 받는다', async () => {
    const r = await makeRoom(inst[0]!);
    const { bus, appName } = newBus();
    const got: number[] = [];
    bus.subscribe(r.roomId, (e) => got.push(e.revision));
    await bus.ready();
    const [pid] = await backendPids(appName);
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await createTx(inst[0]!, r, 1); // 재연결(0.5초 백오프) 전에 커밋된다 → 유실
    await createTx(inst[0]!, r, 2);
    await vi.waitFor(() => expect(bus.connectCount).toBe(2), { timeout: 10_000, interval: 100 });
    await createTx(inst[0]!, r, 3);
    await vi.waitFor(() => expect(got.length).toBeGreaterThanOrEqual(1), { timeout: 5_000 });
    await sleep(300);
    expect(got).toEqual([6]); // revision 4·5는 유실, 6만 도착(하트비트가 뒤처짐을 알린다: S5-5)
  });

  it('종료하면 연결을 닫고 재연결하지 않는다', async () => {
    const { bus, appName } = newBus();
    bus.subscribe('r', () => undefined);
    await bus.ready();
    expect(await backendPids(appName)).toHaveLength(1);
    await bus.onModuleDestroy();
    await sleep(300);
    expect(await backendPids(appName)).toHaveLength(0);
    expect(bus.listening).toBe(false);
  });
});
