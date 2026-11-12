import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ac } from '../helpers/contract.js';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { seedTransactions } from '../s3/s3-helpers.js';
import { api, endReq, idem, pct, resync } from '../s4/s4-helpers.js';
import { joinRoom, makeRoom, type Room } from './s5-helpers.js';
import { openStream, type OpenedStream } from './sse-client.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });

let db: IsolatedDb;
let inst: Instance[];
const at = (n: number) => inst[n % inst.length]!;

beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
  inst = await startInstances(2, { databaseUrl: db.databaseUrl, entry: 'main' });
});
afterAll(async () => {
  await stopAll(inst ?? []);
  await db?.drop();
});

interface Live {
  room: Room;
  keys: string[];
  streams: OpenedStream[];
}

/** S5 §6.7 측정 조건: 방 한도 접속자 10명(방장 + 9명)이 SSE로 연결되고 참여자·거래가 초기 상태로 채워진 방. */
async function liveRoom(participants: number, txs: number): Promise<Live> {
  const room = await makeRoom(at(0), participants);
  const keys = [room.key];
  for (let m = 1; m < 10; m++) keys.push((await joinRoom(at(m), room, `M${m}`)).key);
  if (txs > 0) {
    await seedTransactions(
      db,
      { c: { roomId: room.roomId, hostId: room.hostId }, p: {} } as never,
      { count: txs, payer: room.p[0]!, payee: room.p[1]!, amount: 100 },
    );
  }
  const streams = await Promise.all(keys.map((k, m) => openStream(at(m), room.roomId, k)));
  await Promise.all(streams.map((s) => s.waitFor((e) => e.some((x) => x.event === 'ready'))));
  return { room, keys, streams };
}

const samples: Record<string, { deliver: number[]; screen: number[] }> = {};

/** 변경 한 건: T0는 요청 송신 시각(보수 기준), 10개 클라이언트의 수신과 10개 클라이언트 각각의 5개 조회 완료를 잰다. */
async function measure(
  kind: string,
  live: Live,
  n: number,
  run: () => Promise<unknown>,
  event: string,
) {
  const from = live.streams.map((s) => s.events.length);
  const t0 = Date.now();
  const res = (await run()) as { status: number; body: unknown };
  if (res.status >= 300)
    throw new Error(`${kind} 요청 실패 ${res.status} ${JSON.stringify(res.body)}`);
  const per = await Promise.all(
    live.streams.map(async (s, i) => {
      const ev = await s.waitFor((e) => e.slice(from[i]!).some((x) => x.event === event), 15_000);
      const deliver = ev.slice(from[i]!).find((x) => x.event === event)!.receivedAt - t0;
      await resync(at(i), live.room, live.keys[i]!); // 클라이언트마다 5개 조회를 끝낸다
      return { deliver, screen: Date.now() - t0 };
    }),
  );
  const got = per.map((p) => p.deliver);
  const screens = per.map((p) => p.screen);
  const bucket = (samples[kind] ??= { deliver: [], screen: [] });
  bucket.deliver.push(...got);
  bucket.screen.push(...screens);
}

const closeLive = (l: Live) => l.streams.forEach((s) => s.close());
const txIds = async (roomId: string, n: number) =>
  (
    await db.query<{ id: string }>(
      `SELECT "id" FROM "Transaction" WHERE "roomId"=$1 AND "deletedAt" IS NULL ORDER BY "seq" LIMIT ${n}`,
      [roomId],
    )
  ).map((r) => r.id);

describe('실시간 지연 측정 (S5 §6.7 표 그대로, BE-S5-4·BE-S4-7)', () => {
  it('거래 생성: 참여자 10명·거래 900건에서 100건(끝나면 1,000건)', async () => {
    const l = await liveRoom(10, 900);
    try {
      for (let n = 0; n < 100; n++)
        await measure(
          'transaction.created',
          l,
          n,
          () =>
            api(
              at(n),
              'POST',
              `/rooms/${l.room.roomId}/transactions`,
              l.room.key,
              {
                payerId: l.room.p[0],
                payeeId: l.room.p[1],
                amount: 100 + n,
              },
              idem(),
            ),
          'transaction.created',
        );
    } finally {
      closeLive(l);
    }
  });

  it('거래 수정·삭제: 참여자 10명·거래 1,000건에서 서로 다른 거래 100건씩', async () => {
    const l = await liveRoom(10, 1000);
    try {
      const ids = await txIds(l.room.roomId, 200);
      for (let n = 0; n < 100; n++)
        await measure(
          'transaction.updated',
          l,
          n,
          () =>
            api(
              at(n),
              'PUT',
              `/rooms/${l.room.roomId}/transactions/${ids[n]}`,
              l.room.key,
              { amount: 500 + n },
              idem(),
            ),
          'transaction.updated',
        );
      for (let n = 0; n < 100; n++)
        await measure(
          'transaction.deleted',
          l,
          n,
          () =>
            api(
              at(n),
              'DELETE',
              `/rooms/${l.room.roomId}/transactions/${ids[100 + n]}`,
              l.room.key,
              undefined,
              idem(),
            ),
          'transaction.deleted',
        );
    } finally {
      closeLive(l);
    }
  });

  it('참여자 상태 변경: 참여자 10명·거래 1,000건에서 활성·비활성 번갈아 100건', async () => {
    const l = await liveRoom(10, 1000);
    try {
      for (let n = 0; n < 100; n++)
        await measure(
          'participant.status_changed',
          l,
          n,
          () =>
            api(at(n), 'PATCH', `/rooms/${l.room.roomId}/participants/${l.room.p[2]}`, l.room.key, {
              status: n % 2 === 0 ? 'INACTIVE' : 'ACTIVE',
            }),
          'participant.status_changed',
        );
    } finally {
      closeLive(l);
    }
  });

  it('참여자 등록·게임 종료: 방 10개, 방마다 1건(등록은 9명·거래 1,000건, 종료는 10명·거래 1,000건)', async () => {
    for (let n = 0; n < 10; n++) {
      const l = await liveRoom(9, 1000);
      try {
        await measure(
          'participant.created',
          l,
          n,
          () =>
            api(at(n), 'POST', `/rooms/${l.room.roomId}/participants`, l.room.key, {
              nickname: 'New',
            }),
          'participant.created',
        );
      } finally {
        closeLive(l);
      }
    }
    for (let n = 0; n < 10; n++) {
      const l = await liveRoom(10, 1000);
      try {
        await measure('room.ended', l, n, () => endReq(at(n), l.room), 'room.ended');
      } finally {
        closeLive(l);
      }
    }
  });

  it(
    ac(
      ['AC-VIEW-005-8'],
      'S5 §6.7',
      '종류별·전체 전달 p95 ≤ 1초·최대 ≤ 3초, 화면 반영(5개 조회 완료) p95 ≤ 3초·최대 ≤ 5초',
    ),
    () => {
      const kinds = Object.keys(samples);
      expect(kinds.sort()).toEqual(
        [
          'participant.created',
          'participant.status_changed',
          'room.ended',
          'transaction.created',
          'transaction.deleted',
          'transaction.updated',
        ].sort(),
      );
      const all = { deliver: [] as number[], screen: [] as number[] };
      const lines: string[] = [];
      for (const k of kinds) {
        const v = samples[k]!;
        all.deliver.push(...v.deliver);
        all.screen.push(...v.screen);
        lines.push(
          `${k}: 클라이언트 측정 ${v.screen.length}건(수신 ${v.deliver.length}건) 전달 p95=${pct(v.deliver, 0.95)}ms max=${Math.max(...v.deliver)}ms / 화면 p95=${pct(v.screen, 0.95)}ms max=${Math.max(...v.screen)}ms`,
        );
        expect(pct(v.deliver, 0.95), k).toBeLessThanOrEqual(1000);
        expect(Math.max(...v.deliver), k).toBeLessThanOrEqual(3000);
        expect(pct(v.screen, 0.95), k).toBeLessThanOrEqual(3000);
        expect(Math.max(...v.screen), k).toBeLessThanOrEqual(5000);
      }
      console.info(
        `[S5-4/S4-7] §6.7 표 그대로(접속자 10명, 인스턴스 2개, 로컬 DB, T0=요청 송신 시각)\n  ${lines.join('\n  ')}\n  전체: 전달 p95=${pct(all.deliver, 0.95)}ms max=${Math.max(...all.deliver)}ms / 화면 p95=${pct(all.screen, 0.95)}ms max=${Math.max(...all.screen)}ms`,
      );
      expect(pct(all.deliver, 0.95)).toBeLessThanOrEqual(1000);
      expect(Math.max(...all.deliver)).toBeLessThanOrEqual(3000);
      expect(pct(all.screen, 0.95)).toBeLessThanOrEqual(3000);
      expect(Math.max(...all.screen)).toBeLessThanOrEqual(5000);
    },
  );
});
