import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../src/common/db/prisma.service.js';
import { newId, newInviteCode } from '../../src/common/ids/ids.js';
import {
  LEASE_TTL_MS,
  MEMBER_STREAM_LIMIT,
  ROOM_STREAM_LIMIT,
  StreamLeaseService,
} from '../../src/realtime/stream-lease.service.js';
import { createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { sleep } from '../helpers/util.js';

vi.setConfig({ testTimeout: 60_000 });

describe('임대 한도·갱신·정리 (실제 PostgreSQL, 짧은 TTL=3초)', () => {
  let db: IsolatedDb;
  let prisma: PrismaService;
  const services: StreamLeaseService[] = [];
  const TTL = 3_000;

  beforeAll(async () => {
    db = await createIsolatedDb({ migrations: true });
    prisma = new PrismaService({ DATABASE_URL: db.databaseUrl, DB_POOL_MAX: 20 });
  });
  afterAll(async () => {
    await Promise.all(services.map((s) => s.onModuleDestroy()));
    await prisma?.onModuleDestroy();
    await db?.drop();
  });

  const svc = (ttlMs = TTL) => {
    const s = new StreamLeaseService(prisma, { ttlMs });
    services.push(s);
    return s;
  };
  async function room(memberCount = 1): Promise<{ roomId: string; members: string[] }> {
    const roomId = newId();
    await db.query(`INSERT INTO "Room" ("id","name","unit","inviteCode") VALUES ($1,'R','원',$2)`, [
      roomId,
      newInviteCode(),
    ]);
    const members: string[] = [];
    for (let i = 0; i < memberCount; i++) {
      const id = newId();
      await db.query(
        `INSERT INTO "RoomMember" ("id","roomId","nickname","nicknameKey","isHost","identityKeyHash") VALUES ($1,$2,$3,$3,$4,$5)`,
        [id, roomId, `m${i}`, i === 0, String(i).padStart(64, 'a')],
      );
      members.push(id);
    }
    return { roomId, members };
  }
  const rows = (roomId: string) =>
    db
      .query<{ n: string }>(`SELECT count(*)::text AS n FROM "StreamLease" WHERE "roomId"=$1`, [
        roomId,
      ])
      .then((r) => Number(r[0]!.n));

  it('상수: 한도 5·50, 만료 T=15초', () => {
    expect([MEMBER_STREAM_LIMIT, ROOM_STREAM_LIMIT, LEASE_TTL_MS]).toEqual([5, 50, 15_000]);
  });

  it('RoomMember당 5개까지만 허용하고 6번째 새 연결은 거부하며 기존 연결은 유지한다. 해제하면 슬롯이 돌아온다', async () => {
    const { roomId, members } = await room(2);
    const s = svc();
    const open = [];
    for (let i = 0; i < 5; i++) {
      const r = await s.acquire({ roomId, memberId: members[0]! }, () => undefined);
      expect(r.ok).toBe(true);
      if (r.ok) open.push(r.lease);
    }
    expect(await s.acquire({ roomId, memberId: members[0]! }, () => undefined)).toEqual({
      ok: false,
      reason: 'limit',
    });
    expect(open.every((l) => l.alive())).toBe(true); // 기존 5개는 유지된다
    expect((await s.acquire({ roomId, memberId: members[1]! }, () => undefined)).ok).toBe(true); // 다른 멤버는 별도 한도
    await s.release(open[0]!.id);
    expect((await s.acquire({ roomId, memberId: members[0]! }, () => undefined)).ok).toBe(true);
    expect(await rows(roomId)).toBe(6); // 5 + 1(다른 멤버)
  });

  it('방당 50개 한도: 멤버 10명이 5개씩 채우면 새 연결은 거부된다(멤버 한도와 별개로 방 한도)', async () => {
    const { roomId, members } = await room(11);
    const s = svc();
    for (let m = 0; m < 10; m++) {
      for (let i = 0; i < 5; i++)
        expect((await s.acquire({ roomId, memberId: members[m]! }, () => undefined)).ok).toBe(true);
    }
    expect(await rows(roomId)).toBe(50);
    expect(await s.acquire({ roomId, memberId: members[10]! }, () => undefined)).toEqual({
      ok: false,
      reason: 'limit',
    });
  });

  it('인스턴스 둘이 같은 멤버의 12개 연결을 동시에 시도해도 정확히 5개만 허용된다(한도 초과 없음)', async () => {
    const { roomId, members } = await room(1);
    const a = svc();
    const b = svc();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? a : b).acquire({ roomId, memberId: members[0]! }, () => undefined),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.reason === 'limit')).toHaveLength(7);
    expect(await rows(roomId)).toBe(5);
  });

  it('만료된 임대는 새 연결 판정 때 지워져 슬롯을 돌려준다(강제 종료된 인스턴스의 임대)', async () => {
    const { roomId, members } = await room(1);
    const crashed = svc();
    for (let i = 0; i < 5; i++)
      await crashed.acquire({ roomId, memberId: members[0]! }, () => undefined);
    // 프로세스가 갑자기 죽은 상황: 반납도 갱신도 없다(타이머만 멈춘다)
    (crashed as unknown as { stopTimers(): void }).stopTimers();
    (crashed as unknown as { local: Map<string, unknown> }).local.clear();
    const other = svc();
    expect(await other.acquire({ roomId, memberId: members[0]! }, () => undefined)).toEqual({
      ok: false,
      reason: 'limit',
    }); // 아직 만료 전
    await sleep(TTL + 300);
    expect((await other.acquire({ roomId, memberId: members[0]! }, () => undefined)).ok).toBe(true); // T 안에 정리되어 슬롯이 돌아왔다
    expect(await rows(roomId)).toBe(1);
  });

  it('갱신: 살아 있는 연결은 TTL을 넘겨서도 유지되고 DB 만료가 계속 미래다', async () => {
    const { roomId, members } = await room(1);
    const s = svc();
    const r = await s.acquire({ roomId, memberId: members[0]! }, () => undefined);
    if (!r.ok) throw new Error('임대 실패');
    await sleep(TTL * 2 + 500);
    expect(r.lease.alive()).toBe(true);
    const [row] = await db.query<{ left: number }>(
      `SELECT extract(epoch FROM ("expiresAt" - clock_timestamp()))::float AS "left" FROM "StreamLease" WHERE "id"=$1`,
      [r.lease.id],
    );
    expect(row!.left).toBeGreaterThan(0.2);
  });

  it('DB 갱신이 막히면 스트림이 임대 만료 전에 스스로 닫히고, 그동안 새 연결이 한도를 넘지 않는다', async () => {
    const { roomId, members } = await room(1);
    const a = svc();
    let closedAt = 0;
    const t0 = Date.now();
    const leases = [];
    for (let i = 0; i < 5; i++) {
      const r = await a.acquire({ roomId, memberId: members[0]! }, () => {
        closedAt ||= Date.now();
      });
      if (r.ok) leases.push(r.lease);
    }
    expect(leases).toHaveLength(5);
    // 다른 연결이 이 인스턴스의 임대 행을 잠가 갱신 UPDATE를 막는다
    const blocker = new (await import('pg')).default.Client({ connectionString: db.databaseUrl });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query(`SELECT "id" FROM "StreamLease" WHERE "roomId"=$1 FOR UPDATE`, [roomId]);
    try {
      const b = svc();
      // 만료 전(약 1.5초): 아직 DB에는 5개가 남아 있어 새 연결은 거부된다
      await sleep(1_200);
      expect(await b.acquire({ roomId, memberId: members[0]! }, () => undefined)).toEqual({
        ok: false,
        reason: 'limit',
      });
      // 자기 종료 마감(2T/3 = 2초, 획득 시각 기준) 뒤에는 닫혀 있다 — DB 만료(3초)보다 앞선다
      await vi.waitFor(() => expect(closedAt).toBeGreaterThan(0), {
        timeout: 5_000,
        interval: 50,
      });
      const closedAfter = closedAt - t0;
      expect(closedAfter).toBeGreaterThanOrEqual(1_700);
      expect(closedAfter).toBeLessThan(TTL - 200); // DB 만료 전에 스스로 닫혔다
      expect(leases.every((l) => !l.alive())).toBe(true);
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
    }
  });

  it('임대를 잃은(DB에서 이미 만료·삭제된) 연결은 다음 갱신에서 즉시 닫힌다', async () => {
    const { roomId, members } = await room(1);
    const s = svc();
    let lost = false;
    const r = await s.acquire({ roomId, memberId: members[0]! }, () => (lost = true));
    if (!r.ok) throw new Error('임대 실패');
    await db.query(`DELETE FROM "StreamLease" WHERE "id"=$1`, [r.lease.id]);
    await vi.waitFor(() => expect(lost).toBe(true), { timeout: 3_000, interval: 50 });
    expect(r.lease.alive()).toBe(false);
  });

  it('우아한 종료: onModuleDestroy가 이 인스턴스의 임대를 모두 반납한다', async () => {
    const { roomId, members } = await room(1);
    const s = svc();
    for (let i = 0; i < 3; i++) await s.acquire({ roomId, memberId: members[0]! }, () => undefined);
    expect(await rows(roomId)).toBe(3);
    await s.onModuleDestroy();
    expect(await rows(roomId)).toBe(0);
  });
});

describe('마감은 요청 송신 시각 기준이다 (가짜 시계·가짜 DB, T=15초)', () => {
  const T = 15_000;
  const SELF = (T * 2) / 3; // 10초

  function fixture(
    opts: {
      txDelay?: number;
      renewDelay?: number;
      renewFails?: boolean;
      renewRows?: 'all' | 'none';
    } = {},
  ) {
    let t = 0;
    const calls: string[] = [];
    const state = {
      txDelay: opts.txDelay ?? 0,
      renewDelay: opts.renewDelay ?? 0,
      renewFails: opts.renewFails ?? false,
      renewRows: opts.renewRows ?? 'all',
    };
    const tx = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [{ member: 0n, room: 0n }],
    };
    const fake = {
      client: {
        $transaction: async (fn: (x: typeof tx) => Promise<boolean>) => {
          t += state.txDelay;
          return fn(tx);
        },
        $executeRaw: async (strings: TemplateStringsArray) => {
          calls.push(strings.join('?').includes('DELETE') ? 'delete' : 'exec');
          return 1;
        },
        $queryRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
          t += state.renewDelay;
          if (state.renewFails) throw new Error('db down');
          const ids = (values.find((v) => Array.isArray(v)) ?? []) as string[];
          return state.renewRows === 'all' ? ids.map((id) => ({ id })) : [];
        },
      },
    };
    const s = new StreamLeaseService(fake as unknown as PrismaService, { ttlMs: T, now: () => t });
    return { s, calls, state, at: (ms: number) => (t = ms), clock: () => t };
  }

  const lease = async (f: ReturnType<typeof fixture>, onLost: () => void = () => undefined) => {
    const r = await f.s.acquire({ roomId: 'r', memberId: 'm' }, onLost);
    if (!r.ok) throw new Error(`임대 실패 ${r.reason}`);
    return r.lease;
  };
  afterAll(() => undefined);

  it('최초 임대의 마감은 요청 송신 시각 + 2T/3이고 모든 쓰기 전에 alive()로 확인한다', async () => {
    const f = fixture();
    f.at(1_000);
    const l = await lease(f);
    expect(l.deadline).toBe(1_000 + SELF);
    f.at(1_000 + SELF - 1);
    expect(l.alive()).toBe(true);
    f.at(1_000 + SELF);
    expect(l.alive()).toBe(false); // 타이머가 돌지 않아도(프로세스 정지 뒤) 쓰기 직전 검사로 거부된다
    await f.s.onModuleDestroy();
  });

  it('최초 임대 응답 지연: 응답이 마감(송신+2T/3) 뒤에 도착하면 연결을 열지 않고 임대를 반납한다(늦은 응답 폐기)', async () => {
    const f = fixture({ txDelay: SELF + 500 });
    const r = await f.s.acquire({ roomId: 'r', memberId: 'm' }, () => undefined);
    expect(r).toEqual({ ok: false, reason: 'late' });
    expect(f.calls).toContain('delete');
    expect(f.s.localCount).toBe(0);
    // 마감 직전에 도착한 응답은 받아들인다
    const g = fixture({ txDelay: SELF - 1 });
    expect((await g.s.acquire({ roomId: 'r', memberId: 'm' }, () => undefined)).ok).toBe(true);
    await g.s.onModuleDestroy();
  });

  it('응답 지연 시간선: 갱신 송신 0·5·10초에 응답이 0·9·18초에 와도 마감은 송신 기준이고 응답 수신 시각이 마감을 늘리거나 되살리지 않는다', async () => {
    const f = fixture();
    let closedAt = -1;
    f.at(0);
    const l = await lease(f, () => (closedAt = f.clock()));
    expect(l.deadline).toBe(10_000); // 송신 0 → 마감 10초

    // 송신 0초, 응답 0초: 마감 = 0 + 10 = 10초(변화 없음)
    f.at(0);
    f.state.renewDelay = 0;
    await f.s.renewAll();
    expect(l.deadline).toBe(10_000);

    // 송신 5초, 응답 9초(응답이 마감 10초 전에 도착): 마감 = 5 + 10 = 15초 (수신 9 + 10 = 19초가 아니다)
    f.at(5_000);
    f.state.renewDelay = 4_000;
    await f.s.renewAll();
    expect(l.deadline).toBe(15_000);
    expect(l.deadline).toBeLessThan(9_000 + SELF);

    // 송신 10초, 응답 18초(마감 15초 뒤에 도착): 되살리지 않는다 → 15초에 닫힌다
    f.at(10_000);
    f.state.renewDelay = 8_000;
    await f.s.renewAll();
    expect(l.deadline).toBe(15_000); // 연장되지 않았다
    f.at(15_000);
    f.s.checkDeadlines();
    expect(closedAt).toBe(15_000);
    expect(l.alive()).toBe(false);
    // 닫은 시각(15초) = 마지막으로 유효했던 송신(5초) + 2T/3. 그 갱신의 DB 만료는 처리 시각(≥ 5초) + 15 = 20초 이후라 5초 이상 앞선다.
    expect(20_000 - closedAt).toBeGreaterThanOrEqual(5_000);
    await f.s.onModuleDestroy();
  });

  it('마감은 낮아지지 않는다: 늦게 처리된 오래된 갱신이 더 늦은 마감을 줄이지 않는다', async () => {
    const f = fixture();
    f.at(0);
    const l = await lease(f);
    f.at(6_000);
    await f.s.renewAll(); // 송신 6초 → 마감 16초
    expect(l.deadline).toBe(16_000);
    f.at(7_000);
    f.state.renewDelay = 0;
    // 송신 시각이 더 이르다고 가정한 갱신(현재 구현은 항상 now 기준이라 더 이른 값이 나오지 않는다)
    f.at(2_000);
    await f.s.renewAll();
    expect(l.deadline).toBe(16_000);
    await f.s.onModuleDestroy();
  });

  it('갱신 실패·지연: 마감이 그대로라 마감에 스스로 닫힌다', async () => {
    const f = fixture({ renewFails: true });
    let closedAt = -1;
    f.at(0);
    const l = await lease(f, () => (closedAt = f.clock()));
    f.at(5_000);
    await f.s.renewAll(); // 실패(예외는 삼킨다)
    expect(l.deadline).toBe(10_000);
    f.at(9_999);
    f.s.checkDeadlines();
    expect(closedAt).toBe(-1);
    f.at(10_000);
    f.s.checkDeadlines();
    expect(closedAt).toBe(10_000);
  });

  it('갱신 결과에 없는(이미 만료된) 임대의 스트림은 즉시 닫는다', async () => {
    const f = fixture({ renewRows: 'none' });
    let lost = 0;
    f.at(0);
    const l = await lease(f, () => lost++);
    f.at(5_000);
    await f.s.renewAll();
    expect(lost).toBe(1);
    expect(l.alive()).toBe(false);
    expect(f.s.localCount).toBe(0);
  });

  it('갱신은 임대마다 따로가 아니라 인스턴스 전체를 한 번의 요청으로 보낸다', async () => {
    const f = fixture();
    f.at(0);
    await lease(f);
    await lease(f);
    await lease(f);
    let renewRequests = 0;
    const orig = (
      f.s as unknown as { prisma: { client: { $queryRaw: (...a: unknown[]) => Promise<unknown> } } }
    ).prisma.client.$queryRaw;
    (f.s as unknown as { prisma: { client: { $queryRaw: unknown } } }).prisma.client.$queryRaw =
      async (...a: unknown[]) => {
        renewRequests++;
        return orig(...a);
      };
    f.at(5_000);
    await f.s.renewAll();
    expect(renewRequests).toBe(1);
    await f.s.onModuleDestroy();
  });
});
