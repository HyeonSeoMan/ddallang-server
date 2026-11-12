import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ac } from '../helpers/contract.js';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { baseDatabaseUrl, createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { joinRoom } from '../s5/s5-helpers.js';
import { openStream, type OpenedStream } from '../s5/sse-client.js';
import { api, endReq, idem, makeRoom, pct, resync, type Room } from './s4-helpers.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 90_000 });

let db: IsolatedDb;
let inst: Instance[];
let admin: pg.Client;
const at = (n: number) => inst[n % inst.length]!;

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

const ready = (s: OpenedStream) => s.waitFor((e) => e.some((x) => x.event === 'ready'));
const tx = (i: Instance, r: Room, body: object, h = idem()) =>
  api(i, 'POST', `/rooms/${r.roomId}/transactions`, r.key, body, h);
const total = (s: { items: { amount: number }[] }) => s.items.reduce((a, b) => a + b.amount, 0);

async function eventAfter(s: OpenedStream, name: string, from: number) {
  const ev = await s.waitFor((e) => e.slice(from).some((x) => x.event === name), 15_000);
  return ev.slice(from).find((x) => x.event === name)!;
}

describe('정산 갱신·종료 반영 (BE-S4-7)', () => {
  it(
    ac(
      ['AC-SET-008-2', 'AC-VIEW-005-5'],
      'S4 §8',
      '다른 접속자의 거래 생성·수정·삭제·참여자 변경 이벤트 뒤 재조회하면 예상 정산이 갱신된다',
    ),
    async () => {
      const r = await makeRoom(at(0));
      const guest = await joinRoom(at(1), r, 'Guest');
      const view = await openStream(at(1), r.roomId, guest.key);
      try {
        await ready(view);
        const sync = async () => (await resync(at(1), r, guest.key)).settlement;
        let from = view.events.length;
        const created = await tx(at(0), r, { payerId: r.p[0], payeeId: r.p[1], amount: 400 });
        await eventAfter(view, 'transaction.created', from);
        expect(total(await sync())).toBe(400);

        from = view.events.length;
        await api(
          at(0),
          'PUT',
          `/rooms/${r.roomId}/transactions/${created.body.transaction.id}`,
          r.key,
          { amount: 900 },
          idem(),
        );
        await eventAfter(view, 'transaction.updated', from);
        expect(total(await sync())).toBe(900);

        from = view.events.length;
        await api(at(0), 'PATCH', `/rooms/${r.roomId}/participants/${r.p[1]}`, r.key, {
          status: 'INACTIVE',
        });
        await eventAfter(view, 'participant.status_changed', from);
        expect(total(await sync())).toBe(900); // 비활성 참여자의 손익도 정산에 포함

        from = view.events.length;
        await api(
          at(0),
          'DELETE',
          `/rooms/${r.roomId}/transactions/${created.body.transaction.id}`,
          r.key,
          undefined,
          idem(),
        );
        await eventAfter(view, 'transaction.deleted', from);
        expect((await sync()).items).toEqual([]);
      } finally {
        view.close();
      }
    },
  );

  it(
    ac(
      ['AC-SET-008-3', 'AC-VIEW-005-4', 'AC-SET-007-1'],
      'S4 §6.4',
      '종료 시 다른 접속자는 room.ended 1회를 받고 재동기화로 ENDED·FINAL을 얻는다',
    ),
    async () => {
      const r = await makeRoom(at(0));
      await tx(at(0), r, { payerId: r.p[0], payeeId: r.p[1], amount: 250 });
      const guest = await joinRoom(at(1), r, 'Guest');
      const view = await openStream(at(1), r.roomId, guest.key);
      try {
        await ready(view);
        const from = view.events.length;
        expect((await endReq(at(0), r)).status).toBe(200);
        await eventAfter(view, 'room.ended', from);
        const sync = await resync(at(1), r, guest.key);
        expect(sync.room.room.status).toBe('ENDED');
        expect(sync.settlement.kind).toBe('FINAL');
        expect(total(sync.settlement)).toBe(250);
        await new Promise((ok) => setTimeout(ok, 1000));
        expect(view.events.filter((x) => x.event === 'room.ended')).toHaveLength(1);
      } finally {
        view.close();
      }
    },
  );

  it(
    ac(
      ['AC-SYS-002-1', 'AC-SYS-002-3'],
      'S5 §6.4',
      '끊김 중 종료가 일어나도 재연결 뒤 5개 조회가 모두 성공하고 ENDED·FINAL을 얻는다',
    ),
    async () => {
      const r = await makeRoom(at(0));
      const guest = await joinRoom(at(1), r, 'Guest');
      let view = await openStream(at(1), r.roomId, guest.key);
      await ready(view);
      const before = await resync(at(1), r, guest.key);
      expect(before.room.room.status).toBe('IN_PROGRESS');
      expect(before.settlement.kind).toBe('EXPECTED');
      view.close();
      await view.closed;
      await tx(at(0), r, { payerId: r.p[0], payeeId: r.p[2], amount: 60 });
      expect((await endReq(at(0), r)).status).toBe(200);
      view = await openStream(at(1), r.roomId, guest.key); // 재연결: 이벤트는 다시 오지 않는다
      try {
        await ready(view);
        const after = await resync(at(1), r, guest.key);
        expect(after.room.room.status).toBe('ENDED');
        expect(after.settlement.kind).toBe('FINAL');
        expect(total(after.settlement)).toBe(60);
        expect(view.events.some((x) => x.event === 'room.ended')).toBe(false);
      } finally {
        view.close();
      }
    },
  );

  it(
    ac(
      ['AC-VIEW-005-8'],
      'S5 §6.7',
      '모든 변경 종류(게임 종료 포함)의 이벤트 전달·5개 조회 완료(화면 반영) 지연 p95 ≤ 1초·최대 ≤ 3초',
    ),
    async () => {
      const N = 12;
      const stat: Record<string, { deliver: number[]; resync: number[] }> = {};
      const add = (k: string, d: number, s: number) => {
        (stat[k] ??= { deliver: [], resync: [] }).deliver.push(d);
        stat[k]!.resync.push(s);
      };
      const measure = async (
        kind: string,
        view: OpenedStream,
        run: () => Promise<unknown>,
        name: string,
        r: Room,
        key: string,
      ) => {
        const from = view.events.length;
        const t0 = Date.now();
        await run();
        const ev = await eventAfter(view, name, from);
        const t1 = ev.receivedAt;
        await resync(at(1), r, key);
        add(kind, t1 - t0, Date.now() - t0);
      };
      for (let round = 0; round < N; round++) {
        const r = await makeRoom(at(0));
        const guest = await joinRoom(at(1), r, 'Guest');
        const view = await openStream(at(1), r.roomId, guest.key);
        try {
          await ready(view);
          let id = '';
          await measure(
            'transaction.created',
            view,
            async () => {
              id = (
                await tx(at(round), r, { payerId: r.p[0], payeeId: r.p[1], amount: 100 + round })
              ).body.transaction.id;
            },
            'transaction.created',
            r,
            guest.key,
          );
          await measure(
            'transaction.updated',
            view,
            () =>
              api(
                at(round),
                'PUT',
                `/rooms/${r.roomId}/transactions/${id}`,
                r.key,
                { amount: 5000 },
                idem(),
              ),
            'transaction.updated',
            r,
            guest.key,
          );
          await measure(
            'participant.created',
            view,
            () =>
              api(at(round), 'POST', `/rooms/${r.roomId}/participants`, r.key, { nickname: 'New' }),
            'participant.created',
            r,
            guest.key,
          );
          await measure(
            'participant.status_changed',
            view,
            () =>
              api(at(round), 'PATCH', `/rooms/${r.roomId}/participants/${r.p[2]}`, r.key, {
                status: 'INACTIVE',
              }),
            'participant.status_changed',
            r,
            guest.key,
          );
          await measure(
            'transaction.deleted',
            view,
            () =>
              api(
                at(round),
                'DELETE',
                `/rooms/${r.roomId}/transactions/${id}`,
                r.key,
                undefined,
                idem(),
              ),
            'transaction.deleted',
            r,
            guest.key,
          );
          await measure('room.ended', view, () => endReq(at(round), r), 'room.ended', r, guest.key);
        } finally {
          view.close();
        }
      }
      const all = { deliver: [] as number[], resync: [] as number[] };
      const lines: string[] = [];
      for (const [k, v] of Object.entries(stat)) {
        all.deliver.push(...v.deliver);
        all.resync.push(...v.resync);
        lines.push(
          `${k}: n=${v.deliver.length} 전달 p95=${pct(v.deliver, 0.95)}ms max=${Math.max(...v.deliver)}ms / 5조회 완료 p95=${pct(v.resync, 0.95)}ms max=${Math.max(...v.resync)}ms`,
        );
      }
      console.info(
        `[S4-7] 인스턴스 2개·로컬 DB·같은 호스트\n  ${lines.join('\n  ')}\n  전체: 전달 p95=${pct(all.deliver, 0.95)}ms max=${Math.max(...all.deliver)}ms / 5조회 완료 p95=${pct(all.resync, 0.95)}ms max=${Math.max(...all.resync)}ms`,
      );
      expect(Object.keys(stat)).toHaveLength(6);
      expect(pct(all.deliver, 0.95)).toBeLessThanOrEqual(1000);
      expect(Math.max(...all.deliver)).toBeLessThanOrEqual(3000);
      expect(pct(all.resync, 0.95)).toBeLessThanOrEqual(1000);
      expect(Math.max(...all.resync)).toBeLessThanOrEqual(3000);
    },
  );

  it(
    ac(
      ['AC-SYS-002-3'],
      'S5 §6.6',
      '알림을 의도적으로 버려도 하트비트의 revision으로 20초 안에 수렴한다(재동기화로 최신 정산)',
    ),
    async () => {
      const r = await makeRoom(at(0));
      const guest = await joinRoom(at(1), r, 'Guest');
      const view = await openStream(at(1), r.roomId, guest.key);
      try {
        await ready(view);
        const seen = Number(view.events.find((x) => x.event === 'ready')!.data.revision);
        const [pid] = (
          await admin.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity WHERE application_name=$1`,
            [`ddallang-bus-${at(1).pid}`],
          )
        ).rows;
        await admin.query('SELECT pg_terminate_backend($1)', [pid!.pid]);
        const t0 = Date.now();
        await tx(at(0), r, { payerId: r.p[0], payeeId: r.p[1], amount: 321 });
        await view.waitFor(
          (e) => e.some((x) => x.event === 'heartbeat' && Number(x.data.revision) > seen),
          25_000,
        );
        const sync = await resync(at(1), r, guest.key);
        const elapsed = Date.now() - t0;
        console.info(`[S4-7] 유실 수렴(통지 차단→하트비트→5개 조회): ${elapsed}ms`);
        expect(total(sync.settlement)).toBe(321);
        expect(elapsed).toBeLessThanOrEqual(20_000);
      } finally {
        view.close();
      }
    },
  );
});
