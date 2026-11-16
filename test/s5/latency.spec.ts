import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ac } from '../helpers/contract.js';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { baseDatabaseUrl, createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { sleep } from '../helpers/util.js';
import { seedTransactions } from '../s3/s3-helpers.js';
import { api, endReq, idem, pct, resync } from '../s4/s4-helpers.js';
import { joinRoom, makeRoom, newKey, type ApiRes, type Room } from './s5-helpers.js';
import { openStream, type OpenedStream } from './sse-client.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });

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

interface Live {
  room: Room;
  keys: string[];
  streams: OpenedStream[];
}

/**
 * S5 §6.7 측정 조건: 신원이 연결된 참여자 `people`명(방장 + 입장자)이 모두 SSE로 연결되고 거래가 초기 상태로 채워진 방.
 * 참여자 한도 10명 안에서 사람 단위는 참여자 하나다(S1 §2.3 I2). `room.p`는 입장한 참여자 ID다. `direct`명은 신원 없이
 * 직접 추가한 참여자(스트림 없음)로 `room.p` 뒤에 붙는다(이어받기 행의 대상).
 */
async function liveRoom(people: number, txs: number, direct = 0): Promise<Live> {
  const room = await makeRoom(at(0), 0);
  const keys = [room.key];
  for (let m = 1; m < people; m++) {
    const joined = await joinRoom(at(m), room, `M${m}`);
    keys.push(joined.key);
    room.p.push(joined.memberId);
  }
  for (let d = 0; d < direct; d++)
    room.p.push(
      (
        await api(at(d), 'POST', `/rooms/${room.roomId}/participants`, room.key, {
          nickname: `D${d}`,
        })
      ).body.participant.id as string,
    );
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

/**
 * 변경 한 건: T0는 요청 송신 시각(보수 기준). 연결된 클라이언트마다 이벤트 수신 시각과 S5 §6.4 갱신 대상 전체
 * (일반 참여자 5개, 방장 6개 = 대기 요청 목록 포함)가 모두 성공한 시각을 잰다(화면 반영). 0번 클라이언트가 방장이다.
 */
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
      await resync(at(i), live.room, live.keys[i]!, i === 0); // 방장 6개, 그 밖 5개
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

describe('실시간 지연 측정 (S5 §6.7 표 그대로, BE-S5-4·BE-S4-7, 개정 BE-M8)', () => {
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

  it('참여자 생성(입장·직접 추가 각각)·게임 종료: 방 10개씩, 방마다 1건(생성은 9명·거래 1,000건, 종료는 10명·거래 1,000건)', async () => {
    for (let n = 0; n < 10; n++) {
      const l = await liveRoom(9, 1000);
      try {
        await measure(
          'participant.created(입장)',
          l,
          n,
          () =>
            api(at(n), 'POST', `/invites/${l.room.inviteCode}/members`, newKey(), {
              nickname: 'New',
            }),
          'participant.created',
        );
      } finally {
        closeLive(l);
      }
    }
    for (let n = 0; n < 10; n++) {
      const l = await liveRoom(9, 1000);
      try {
        await measure(
          'participant.created(직접 추가)',
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

  it('이어받기 요청 생성·취소(방장 화면): 참여자 10명(신원 9명 SSE, 직접 추가 1명)·거래 1,000건, 번갈아 100건', async () => {
    const l = await liveRoom(9, 1000, 1);
    const target = 'D0';
    const outside = newKey(); // 방 밖의 브라우저
    let pending: string | undefined;
    try {
      for (let n = 0; n < 100; n++) {
        if (n % 2 === 0) {
          await measure(
            'claim.created(방장 화면)',
            l,
            n,
            async () => {
              const res = await api(
                at(n),
                'POST',
                `/invites/${l.room.inviteCode}/claims`,
                outside,
                {
                  nickname: target,
                },
              );
              pending = res.body.claim?.id as string | undefined;
              return res;
            },
            'claim.created',
          );
        } else {
          await measure(
            'claim.canceled(방장 화면)',
            l,
            n,
            () =>
              api(at(n), 'POST', `/invites/${l.room.inviteCode}/claims/${pending}/cancel`, outside),
            'claim.canceled',
          );
        }
      }
    } finally {
      closeLive(l);
    }
  });

  /**
   * 이어받기 승인·거절의 요청자 화면(S5 §6.8, BE-C8): 방 밖의 요청자는 내 요청 조회를 2초 간격으로 한다(조회 위상은
   * 무작위). 화면 반영은 T0(승인·거절 요청 송신)부터 결과(`APPROVED`·`REJECTED`)를 담은 조회 응답을 받기까지다.
   * 브라우저 표시까지는 프론트엔드 측정과 합친다.
   */
  async function measureRequester(
    kind: string,
    l: Live,
    decide: (claimId: string) => Promise<ApiRes>,
  ) {
    const key = newKey();
    const created = await api(at(1), 'POST', `/invites/${l.room.inviteCode}/claims`, key, {
      nickname: 'D0',
    });
    const claimId = created.body.claim.id as string;
    let stop = false;
    let seenAt: number | undefined;
    let t0 = 0;
    const poll = (async () => {
      await sleep(Math.random() * 2_000); // 조회 위상
      while (!stop) {
        const res = await api(at(2), 'GET', `/invites/${l.room.inviteCode}/claims/${claimId}`, key);
        if (t0 && res.body.claim?.status !== 'PENDING') {
          seenAt = Date.now();
          return;
        }
        await sleep(2_000);
      }
    })();
    await sleep(2_500); // 조회 루프가 돌고 있는 상태에서 처리한다
    t0 = Date.now();
    const res = await decide(claimId);
    if (res.status >= 300)
      throw new Error(`${kind} 실패 ${res.status} ${JSON.stringify(res.body)}`);
    await Promise.race([poll, sleep(10_000)]);
    stop = true;
    if (seenAt === undefined) throw new Error(`${kind}: 요청자가 결과를 받지 못했다`);
    const bucket = (samples[kind] ??= { deliver: [], screen: [] });
    bucket.screen.push(seenAt - t0);
    return key;
  }

  it('이어받기 승인·거절(요청자 화면, 2초 주기 조회): 방 10개씩, 대기 요청 1건', async () => {
    for (let n = 0; n < 10; n++) {
      const l = await liveRoom(9, 1000, 1);
      try {
        await measureRequester('claim.resolved 거절(요청자 화면)', l, (id) =>
          api(at(n), 'POST', `/rooms/${l.room.roomId}/claims/${id}/reject`, l.room.key),
        );
        await measureRequester('claim.resolved 승인(요청자 화면)', l, (id) =>
          api(at(n), 'POST', `/rooms/${l.room.roomId}/claims/${id}/approve`, l.room.key),
        );
      } finally {
        closeLive(l);
      }
    }
  });

  it('접근 상실 안내(이전 브라우저): 참여자 10명 모두 SSE, 방 10개, 이전 브라우저의 access.revoked 수신까지', async () => {
    for (let n = 0; n < 10; n++) {
      const l = await liveRoom(10, 1000);
      try {
        const victim = 1 + (n % 9); // 이어받힐 참여자(입장자)
        const key = newKey();
        const claim = await api(at(n), 'POST', `/invites/${l.room.inviteCode}/claims`, key, {
          nickname: `M${victim}`,
        });
        const s = l.streams[victim]!;
        const from = s.events.length;
        const t0 = Date.now();
        const res = await api(
          at(n + 1),
          'POST',
          `/rooms/${l.room.roomId}/claims/${claim.body.claim.id}/approve`,
          l.room.key,
        );
        expect(res.status).toBe(200);
        const ev = await s.waitFor(
          (e) => e.slice(from).some((x) => x.event === 'access.revoked'),
          10_000,
        );
        const at0 = ev.slice(from).find((x) => x.event === 'access.revoked')!.receivedAt - t0;
        (samples['access.revoked'] ??= { deliver: [], screen: [] }).deliver.push(at0);
      } finally {
        closeLive(l);
      }
    }
  });

  it(
    ac(
      ['AC-VIEW-005-9'],
      'S5 §6.7 유실 시 수렴',
      '접근 상실 유실 수렴: 승인 직후 통지를 버려도(같은·다른 인스턴스) 이전 브라우저가 하트비트의 access.revoked로 20초 안에 안내받는다',
    ),
    async () => {
      const lines: string[] = [];
      for (const [label, streamAt, approveAt] of [
        ['같은 인스턴스', 0, 0],
        ['다른 인스턴스', 1, 0],
      ] as const) {
        const l = await liveRoom(2, 0);
        try {
          const old = await openStream(inst[streamAt]!, l.room.roomId, l.keys[1]!);
          await old.waitFor((e) => e.some((x) => x.event === 'ready'));
          const key = newKey();
          const claim = await api(at(0), 'POST', `/invites/${l.room.inviteCode}/claims`, key, {
            nickname: 'M1',
          });
          const [pid] = (
            await admin.query<{ pid: number }>(
              `SELECT pid FROM pg_stat_activity WHERE application_name=$1`,
              [`ddallang-bus-${inst[streamAt]!.pid}`],
            )
          ).rows;
          await admin.query('SELECT pg_terminate_backend($1)', [pid!.pid]); // 통지를 버린다
          const t0 = Date.now();
          const res = await api(
            inst[approveAt]!,
            'POST',
            `/rooms/${l.room.roomId}/claims/${claim.body.claim.id}/approve`,
            l.room.key,
          );
          expect(res.status).toBe(200);
          const ev = await old.waitFor((e) => e.some((x) => x.event === 'access.revoked'), 25_000);
          expect(
            ev.some((x) => x.event === 'claim.resolved'),
            '통지가 버려져야 한다',
          ).toBe(false);
          const elapsed = ev.find((x) => x.event === 'access.revoked')!.receivedAt - t0;
          lines.push(`${label} ${elapsed}ms`);
          expect(elapsed).toBeLessThanOrEqual(20_000);
          old.close();
        } finally {
          closeLive(l);
        }
      }
      console.info(
        `[BE-M8] 접근 상실 유실 수렴(통지 차단→하트비트 access.revoked): ${lines.join(', ')}`,
      );
    },
  );

  it(
    ac(
      ['AC-VIEW-005-8'],
      'S5 §6.7',
      '종류별·전체 전달 p95 ≤ 1초·최대 ≤ 3초, 화면 반영(갱신 대상 전체: 방장 6개·그 밖 5개, 요청자는 2초 주기 조회) p95 ≤ 3초·최대 ≤ 5초',
    ),
    () => {
      const kinds = Object.keys(samples);
      expect(kinds.sort()).toEqual(
        [
          'access.revoked',
          'claim.canceled(방장 화면)',
          'claim.created(방장 화면)',
          'claim.resolved 거절(요청자 화면)',
          'claim.resolved 승인(요청자 화면)',
          'participant.created(입장)',
          'participant.created(직접 추가)',
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
        // 요청자 화면 행은 전달(SSE)이 없고, 접근 상실 행은 전달만 잰다(S5 §6.7 표)
        expect(v.deliver.length + v.screen.length, k).toBeGreaterThan(0);
        const show = (xs: number[]) =>
          xs.length ? `p95=${pct(xs, 0.95)}ms max=${Math.max(...xs)}ms` : '해당 없음';
        lines.push(
          `${k}: 전달 ${v.deliver.length}건 ${show(v.deliver)} / 화면 ${v.screen.length}건 ${show(v.screen)}`,
        );
        if (v.deliver.length) {
          expect(pct(v.deliver, 0.95), k).toBeLessThanOrEqual(1000);
          expect(Math.max(...v.deliver), k).toBeLessThanOrEqual(3000);
        }
        if (v.screen.length) {
          expect(pct(v.screen, 0.95), k).toBeLessThanOrEqual(3000);
          expect(Math.max(...v.screen), k).toBeLessThanOrEqual(5000);
        }
      }
      console.info(
        `[S5-4/S4-7/BE-M8] §6.7 표 그대로(Spec v0.3.0, 신원 연결 참여자 10명, 인스턴스 2개, 로컬 DB, T0=요청 송신 시각)\n  ${lines.join('\n  ')}\n  전체: 전달 p95=${pct(all.deliver, 0.95)}ms max=${Math.max(...all.deliver)}ms / 화면 p95=${pct(all.screen, 0.95)}ms max=${Math.max(...all.screen)}ms`,
      );
      expect(pct(all.deliver, 0.95)).toBeLessThanOrEqual(1000);
      expect(Math.max(...all.deliver)).toBeLessThanOrEqual(3000);
      expect(pct(all.screen, 0.95)).toBeLessThanOrEqual(3000);
      expect(Math.max(...all.screen)).toBeLessThanOrEqual(5000);
    },
  );
});
