import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ac } from '../helpers/contract.js';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { baseDatabaseUrl, createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { sleep } from '../helpers/util.js';
import { api, joinRoom, makeRoom, newKey, type Room } from './s5-helpers.js';
import { openStream, type OpenedStream } from './sse-client.js';

/**
 * BE-M6 (S5 §4.2, §6.2, E-9, PD-27·PD-28): 이어받기 승인으로 접근을 잃은 신원의 스트림에 `access.revoked`를 보내고
 * 닫는다(같은 인스턴스·다른 인스턴스, 통지를 놓치면 하트비트 재확인). 스트림 연결 요청자는 참여자다.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 90_000 });

let db: IsolatedDb;
let inst: Instance[];
let admin: pg.Client;

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
const leasesOf = async (participantId: string) =>
  Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "StreamLease" WHERE "participantId"=$1`,
        [participantId],
      )
    )[0]!.n,
  );
const listenerPids = async (i: Instance) =>
  (
    await admin.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE application_name = $1`,
      [`ddallang-bus-${i.pid}`],
    )
  ).rows.map((r) => r.pid);

/** 방장이 있는 방에 입장한 Kim. Kim의 참여자를 새 키가 이어받게 할 수 있다. */
async function withKim(): Promise<{ r: Room; kim: { key: string; id: string } }> {
  const r = await makeRoom(inst[0]!, 1);
  const kim = await joinRoom(inst[0]!, r, 'Kim');
  return { r, kim: { key: kim.key, id: kim.memberId } };
}
async function requestClaim(r: Room, nickname: string, key = newKey()) {
  const res = await api(inst[0]!, 'POST', `/invites/${r.inviteCode}/claims`, key, { nickname });
  expect(res.status).toBe(201);
  return { key, claimId: res.body.claim.id as string };
}
const approve = (i: Instance, r: Room, claimId: string) =>
  api(i, 'POST', `/rooms/${r.roomId}/claims/${claimId}/approve`, r.key);

describe('스트림 연결 요청자 (S5 §3.3 2)', () => {
  it(
    ac(
      ['AC-SYS-003-6'],
      'S5 §3.3',
      '다른 방 참여자의 키·이 방의 이어받기 대기 키 → 404 ROOM_NOT_FOUND(스트림 없음), 접근 상실 키 → 401 IDENTITY_REVOKED',
    ),
    async () => {
      const { r, kim } = await withKim();
      const other = await makeRoom(inst[1]!, 0);
      const waiting = await requestClaim(r, 'P0');
      const take = await requestClaim(r, 'Kim');
      expect((await approve(inst[0]!, r, take.claimId)).status).toBe(200);
      const cases: [string, number, string][] = [
        [other.key, 404, 'ROOM_NOT_FOUND'],
        [waiting.key, 404, 'ROOM_NOT_FOUND'],
        [newKey(), 404, 'ROOM_NOT_FOUND'],
        [kim.key, 401, 'IDENTITY_REVOKED'],
      ];
      for (const [key, status, code] of cases) {
        for (const i of inst) {
          const s = await openStream(i, r.roomId, key);
          expect(s.status).toBe(status);
          expect(s.body).toMatchObject({ error: { code } });
          expect(s.events).toEqual([]);
        }
      }
      const fresh = await openStream(inst[1]!, r.roomId, take.key); // 이어받은 새 키는 연결된다
      expect(fresh.status).toBe(200);
      fresh.close();
    },
  );

  it('비활성 참여자도 연결할 수 있다(AC-PART-002-11의 스트림 쪽)', async () => {
    const { r, kim } = await withKim();
    await api(inst[0]!, 'PATCH', `/rooms/${r.roomId}/participants/${kim.id}`, r.key, {
      status: 'INACTIVE',
    });
    const s = await openStream(inst[1]!, r.roomId, kim.key);
    expect(s.status).toBe(200);
    await ready(s);
    s.close();
  });
});

describe('access.revoked 전달 (S5 §6.2, PD-27)', () => {
  for (const [label, streamAt, approveAt] of [
    ['같은 인스턴스', 0, 0],
    ['다른 인스턴스', 1, 0],
  ] as const) {
    it(
      ac(
        ['AC-VIEW-005-9'],
        'S5 §4.2, §6.2',
        `${label}: 승인 직후 이전 키의 스트림만 access.revoked(id·revision 없음)를 받고 닫히며 임대가 반납된다. 다른 스트림은 claim.resolved를 받고 유지된다`,
      ),
      async () => {
        const { r, kim } = await withKim();
        const old = await openStream(inst[streamAt]!, r.roomId, kim.key);
        const old2 = await openStream(inst[1 - streamAt]!, r.roomId, kim.key); // 같은 키의 다른 탭
        const host = await openStream(inst[streamAt]!, r.roomId, r.key);
        try {
          await Promise.all([old, old2, host].map(ready));
          expect(await leasesOf(kim.id)).toBe(2);
          const take = await requestClaim(r, 'Kim');
          const t0 = Date.now();
          expect((await approve(inst[approveAt]!, r, take.claimId)).status).toBe(200);
          for (const s of [old, old2]) {
            const ev = await s.waitFor((e) => e.some((x) => x.event === 'access.revoked'), 5_000);
            const revoked = ev.find((x) => x.event === 'access.revoked')!;
            expect(revoked.id).toBeUndefined();
            expect(Object.keys(revoked.data).sort()).toEqual(['roomId', 'serverTime']);
            expect(revoked.receivedAt - t0).toBeLessThan(3_000);
            await s.closed;
            expect(s.isClosed()).toBe(true);
            expect(ev.at(-1)!.event).toBe('access.revoked'); // 그 뒤로는 아무것도 없다
          }
          await vi.waitFor(async () => expect(await leasesOf(kim.id)).toBe(0), { timeout: 5_000 });
          const hostEv = await host.waitFor((e) => e.some((x) => x.event === 'claim.resolved'));
          expect(hostEv.some((x) => x.event === 'access.revoked')).toBe(false);
          expect(host.isClosed()).toBe(false);
          // 이어받은 새 키는 같은 참여자 한도(5)로 연결된다
          const fresh = await openStream(inst[1]!, r.roomId, take.key);
          expect(fresh.status).toBe(200);
          fresh.close();
        } finally {
          for (const s of [old, old2, host]) s.close();
        }
      },
    );
  }

  it(
    ac(
      ['AC-VIEW-005-9', 'AC-SYS-003-6'],
      'S5 §6.2 (S5-C3)',
      '승인 통지를 놓친 인스턴스도 다음 하트비트(15초)에서 연결 해시를 다시 확인해 access.revoked 후 닫는다. 연결이 유지된 스트림은 하트비트를 받는다',
    ),
    async () => {
      const { r, kim } = await withKim();
      const old = await openStream(inst[1]!, r.roomId, kim.key);
      const host = await openStream(inst[1]!, r.roomId, r.key);
      try {
        await Promise.all([old, host].map(ready));
        const take = await requestClaim(r, 'Kim');
        const [pid] = await listenerPids(inst[1]!);
        expect(pid).toBeDefined();
        await admin.query('SELECT pg_terminate_backend($1)', [pid]); // inst[1]의 LISTEN을 끊어 통지를 버린다
        const t0 = Date.now();
        expect((await approve(inst[0]!, r, take.claimId)).status).toBe(200);
        expect(await listenerPids(inst[1]!), '통지가 버려져야 한다').toHaveLength(0);
        const ev = await old.waitFor((e) => e.some((x) => x.event === 'access.revoked'), 20_000);
        expect(Date.now() - t0).toBeLessThanOrEqual(20_000); // 유실 시 수렴 20초 이하(S5 §6.7)
        expect(ev.filter((x) => x.event === 'claim.resolved')).toHaveLength(0); // 통지는 정말 버려졌다
        await old.closed;
        const beat = await host.waitFor((e) => e.some((x) => x.event === 'heartbeat'), 20_000);
        expect(beat.some((x) => x.event === 'access.revoked')).toBe(false);
        expect(host.isClosed()).toBe(false);
        await vi.waitFor(async () => expect(await leasesOf(kim.id)).toBe(0), { timeout: 5_000 });
      } finally {
        old.close();
        host.close();
      }
    },
  );
});

describe('이벤트 전달 (S5 §4.2)', () => {
  it(
    ac(
      ['AC-VIEW-005-3', 'AC-VIEW-005-9'],
      'S5 §4.2',
      '입장(201)·직접 추가는 participant.created, 이어받기 요청·취소·승인·거절은 claim.*로 방의 모든 스트림(다른 인스턴스 포함)에 전달된다. 복원은 이벤트가 없다',
    ),
    async () => {
      const r = await makeRoom(inst[0]!, 1);
      const member = await joinRoom(inst[0]!, r, 'Mem');
      const host = await openStream(inst[1]!, r.roomId, r.key);
      const other = await openStream(inst[0]!, r.roomId, member.key);
      try {
        await Promise.all([host, other].map(ready));
        const joined = await joinRoom(inst[0]!, r, 'Late');
        await api(inst[1]!, 'POST', `/invites/${r.inviteCode}/members`, joined.key, {}); // 복원
        const added = (
          await api(inst[0]!, 'POST', `/rooms/${r.roomId}/participants`, r.key, {
            nickname: 'Direct',
          })
        ).body.participant.id as string;
        const a = await requestClaim(r, 'Direct');
        const b = await requestClaim(r, 'P0');
        await api(inst[1]!, 'POST', `/invites/${r.inviteCode}/claims/${b.claimId}/cancel`, b.key);
        const c = await requestClaim(r, 'P0');
        await api(inst[0]!, 'POST', `/rooms/${r.roomId}/claims/${c.claimId}/reject`, r.key);
        await approve(inst[1]!, r, a.claimId);
        const want = [
          ['participant.created', joined.memberId],
          ['participant.created', added],
          ['claim.created', a.claimId],
          ['claim.created', b.claimId],
          ['claim.canceled', b.claimId],
          ['claim.created', c.claimId],
          ['claim.resolved', c.claimId],
          ['claim.resolved', a.claimId],
        ];
        for (const s of [host, other]) {
          const ev = await s.waitFor((e) => e.filter((x) => x.id !== undefined).length >= 8);
          await sleep(300);
          const changes = s.events.filter((x) => x.id !== undefined);
          expect(changes.map((x) => [x.event, x.data.participantId ?? x.data.claimId])).toEqual(
            want,
          );
          const revs = changes.map((x) => Number(x.data.revision));
          expect(revs).toEqual(revs.map((_, i) => revs[0]! + i)); // 빠짐없이 1씩
          void ev;
        }
      } finally {
        host.close();
        other.close();
      }
    },
  );
});
