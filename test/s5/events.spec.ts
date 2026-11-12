import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ac } from '../helpers/contract.js';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { sleep } from '../helpers/util.js';
import { api, createTx, idem, joinRoom, makeRoom, newKey } from './s5-helpers.js';
import { openStream } from './sse-client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 90_000 });

let db: IsolatedDb;
let inst: Instance[];
const at = (n: number) => inst[n % inst.length]!;
const q = <T extends object>(sql: string, params: unknown[] = []) =>
  db.query(sql, params) as Promise<T[]>;

beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
  inst = await startInstances(2, { databaseUrl: db.databaseUrl, entry: 'main' });
});
afterAll(async () => {
  await stopAll(inst ?? []);
  await db?.drop();
});

describe('GET /rooms/{roomId}/events (S5 §4.1)', () => {
  it('성공 응답: 200, text/event-stream, no-store, X-Accel-Buffering, 헤더 직후 ready(현재 revision)', async () => {
    const r = await makeRoom(at(0));
    const s = await openStream(at(1), r.roomId, r.key);
    try {
      expect(s.status).toBe(200);
      expect(s.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(s.headers.get('cache-control')).toBe('no-store');
      expect(s.headers.get('x-accel-buffering')).toBe('no');
      await s.waitFor((e) => e.length >= 1);
      expect(s.events[0]).toMatchObject({ event: 'ready' });
      expect(s.events[0]!.id).toBeUndefined(); // ready에는 id가 없다
      expect(s.events[0]!.data).toMatchObject({ roomId: r.roomId, revision: 3 }); // 참여자 3명 등록 = revision 3
      expect(String(s.events[0]!.data.serverTime)).toMatch(/^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/);
    } finally {
      s.close();
    }
  });

  it(
    ac(
      ['AC-SYS-003-1'],
      'S5 §3.3',
      '신원 키가 없거나 형식이 틀리면 401(스트림이 열리기 전의 JSON)',
    ),
    async () => {
      const r = await makeRoom(at(0));
      for (const key of [undefined, 'short']) {
        const s = await openStream(at(0), r.roomId, key);
        expect(s.status).toBe(401);
        expect(s.headers.get('content-type')).toMatch(/application\/json/);
        expect(s.body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      }
    },
  );

  it(
    ac(
      ['AC-SYS-003-5', 'AC-SYS-003-6', 'AC-SYS-003-7'],
      'S5 §3.3',
      '다른 방의 RoomMember(방장 키 포함)와 비멤버·없는 방은 같은 404 ROOM_NOT_FOUND이고 이벤트를 받지 못한다. 쿼리 매개변수는 422, 메서드는 405',
    ),
    async () => {
      const a = await makeRoom(at(0));
      const b = await makeRoom(at(0));
      const foreign = await openStream(at(0), a.roomId, b.key); // b의 방장 키로 a의 방에 연결
      const stranger = await openStream(at(1), a.roomId, newKey());
      const missing = await openStream(at(0), 'no-such-room', a.key);
      for (const s of [foreign, stranger, missing]) {
        expect(s.status).toBe(404);
        expect(s.body).toMatchObject({ error: { code: 'ROOM_NOT_FOUND' } });
      }
      expect(foreign.body).toEqual(missing.body); // 구별되지 않는다
      expect(foreign.events).toHaveLength(0);
      const withQuery = await openStream(at(0), a.roomId, a.key, {}, '?x=1&cursor=abc');
      expect(withQuery.status).toBe(422);
      expect(withQuery.body).toMatchObject({
        error: {
          code: 'VALIDATION_FAILED',
          details: [
            { field: 'x', code: 'NOT_ALLOWED_FIELD' },
            { field: 'cursor', code: 'NOT_ALLOWED_FIELD' },
          ],
        },
      });
      for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await api(at(0), m, `/rooms/${a.roomId}/events`, a.key, {});
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET');
        expect(res.body.error.code).toBe('NOT_SUPPORTED');
      }
      // 오류 응답은 데이터를 바꾸지 않는다: 열린 연결 임대가 남지 않는다
      const leases = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM "StreamLease" WHERE "roomId" IN ($1,$2)`,
        [a.roomId, b.roomId],
      );
      expect(leases[0]!.n).toBe('0');
    },
  );

  it('Last-Event-ID는 무시한다: 이벤트를 재전송하지 않고 새 ready를 받는다', async () => {
    const r = await makeRoom(at(0));
    await createTx(at(0), r, 100);
    const s = await openStream(at(0), r.roomId, r.key, { 'Last-Event-ID': '1' });
    try {
      await s.waitFor((e) => e.length >= 1);
      await sleep(400);
      expect(s.events.map((e) => e.event)).toEqual(['ready']); // 과거 이벤트(revision 2~4)를 재생하지 않는다
      expect(s.events[0]!.data.revision).toBe(4);
    } finally {
      s.close();
    }
  });

  it(
    ac(
      ['AC-SYS-003-2', 'AC-ROOM-002-5'],
      'S5 §3.3',
      '종료된 방에서도 연결할 수 있다(종료 후 입장자 포함)',
    ),
    async () => {
      const r = await makeRoom(at(0));
      const late = await joinRoom(at(0), r, 'Late');
      await q(`UPDATE "Room" SET "status"='ENDED' WHERE "id"=$1`, [r.roomId]);
      const s1 = await openStream(at(0), r.roomId, r.key);
      const s2 = await openStream(at(1), r.roomId, late.key);
      try {
        expect([s1.status, s2.status]).toEqual([200, 200]);
        await s2.waitFor((e) => e.length >= 1);
      } finally {
        s1.close();
        s2.close();
      }
    },
  );

  it('연결이 끊기면 서버가 감지해 임대를 반납한다(슬롯 반환)', async () => {
    const r = await makeRoom(at(0));
    const s = await openStream(at(0), r.roomId, r.key);
    await s.waitFor((e) => e.length >= 1);
    expect(
      Number(
        (
          await q<{ n: string }>(
            `SELECT count(*)::text AS n FROM "StreamLease" WHERE "roomId"=$1`,
            [r.roomId],
          )
        )[0]!.n,
      ),
    ).toBe(1);
    s.close();
    let n = 1;
    for (let i = 0; i < 50 && n > 0; i++) {
      await sleep(100);
      n = Number(
        (
          await q<{ n: string }>(
            `SELECT count(*)::text AS n FROM "StreamLease" WHERE "roomId"=$1`,
            [r.roomId],
          )
        )[0]!.n,
      );
    }
    expect(n).toBe(0);
  });
});

describe('이벤트 발생 횡단 시험 (BE-S5-3, S5 §4.2, §6.1)', () => {
  it(
    ac(
      ['AC-VIEW-005-1', 'AC-VIEW-005-2', 'AC-VIEW-005-3', 'AC-VIEW-005-4', 'AC-VIEW-005-5'],
      'S5 §6.1',
      '모든 변경이 정확히 하나의 revision·이벤트를 만들고, 거부·멱등 재전송·값이 같은 수정·상태 변경·입장은 만들지 않는다. data에는 내용이 없다',
    ),
    async () => {
      const r = await makeRoom(at(0));
      const s = await openStream(at(1), r.roomId, r.key); // 변경은 0번 인스턴스, 스트림은 1번 인스턴스
      try {
        await s.waitFor((e) => e.length >= 1);
        const base = s.events[0]!.data.revision as number;
        // --- 이벤트를 만드는 변경 6종 ---
        const added = (
          await api(at(0), 'POST', `/rooms/${r.roomId}/participants`, r.key, { nickname: 'New' })
        ).body.participant.id as string;
        await api(at(0), 'PATCH', `/rooms/${r.roomId}/participants/${added}`, r.key, {
          status: 'INACTIVE',
        });
        const h = idem();
        const t = (await createTx(at(0), r, 1234, h)).body.transaction.id as string;
        await api(
          at(0),
          'PUT',
          `/rooms/${r.roomId}/transactions/${t}`,
          r.key,
          { amount: 4321, reason: '비밀 사유' },
          idem(),
        );
        await api(
          at(0),
          'DELETE',
          `/rooms/${r.roomId}/transactions/${t}`,
          r.key,
          undefined,
          idem(),
        );
        // --- 이벤트를 만들지 않는 요청 ---
        await createTx(at(0), r, 1234, h); // 멱등 재전송
        await api(at(0), 'PATCH', `/rooms/${r.roomId}/participants/${added}`, r.key, {
          status: 'INACTIVE',
        }); // 같은 값
        await api(at(0), 'POST', `/rooms/${r.roomId}/participants`, r.key, { nickname: 'new' }); // 409 닉네임 중복
        await api(at(0), 'POST', `/rooms/${r.roomId}/participants`, r.key, {}); // 422
        await createTx(at(0), r, 0); // 422 금액
        await api(
          at(0),
          'PUT',
          `/rooms/${r.roomId}/transactions/${t}`,
          r.key,
          { amount: 5 },
          idem(),
        ); // 409 삭제됨
        await joinRoom(at(0), r, 'Joiner'); // 입장은 이벤트 대상이 아니다(N-5)
        const other = (await createTx(at(0), r, 50)).body.transaction.id as string;
        await api(
          at(0),
          'PUT',
          `/rooms/${r.roomId}/transactions/${other}`,
          r.key,
          { amount: 50 },
          idem(),
        ); // 값이 같은 수정
        await s.waitFor((e) => e.length >= 7, 8_000); // ready + 변경 6건
        await sleep(800); // 더 오는 이벤트가 없는지 기다린다
        const changes = s.events.slice(1);
        expect(changes.map((e) => e.event)).toEqual([
          'participant.created',
          'participant.status_changed',
          'transaction.created',
          'transaction.updated',
          'transaction.deleted',
          'transaction.created', // 마지막 createTx(50)
        ]);
        expect(changes.map((e) => e.data.revision)).toEqual([
          base + 1,
          base + 2,
          base + 3,
          base + 4,
          base + 5,
          base + 6,
        ]); // 빠짐없이 1씩
        expect(changes.map((e) => Number(e.id))).toEqual(changes.map((e) => e.data.revision)); // id = revision
        // data: 식별자와 종류만, 내용(금액·사유·닉네임)은 없다
        for (const e of changes) {
          const keys = Object.keys(e.data).sort().join();
          expect([
            ['participantId', 'revision', 'roomId', 'serverTime'].join(),
            ['revision', 'roomId', 'serverTime', 'transactionId'].join(),
          ]).toContain(keys);
          expect(JSON.stringify(e.data)).not.toMatch(/4321|비밀|New|amount|reason|nickname/);
        }
        expect(changes[0]!.data.participantId).toBe(added);
        expect(changes[2]!.data.transactionId).toBe(t);
      } finally {
        s.close();
      }
    },
  );
});

describe('스트림 쓰기 규칙', () => {
  it('같은 방의 모든 스트림이 같은 이벤트를 revision 순서로 받는다(두 인스턴스에 걸쳐)', async () => {
    const r = await makeRoom(at(0));
    const streams = await Promise.all([
      openStream(at(0), r.roomId, r.key),
      openStream(at(1), r.roomId, r.key),
      openStream(at(1), r.roomId, r.key),
    ]);
    try {
      await Promise.all(streams.map((s) => s.waitFor((e) => e.length >= 1)));
      for (let i = 0; i < 6; i++) await createTx(at(i), r, 10 + i);
      await Promise.all(streams.map((s) => s.waitFor((e) => e.length >= 7, 8_000)));
      const revs = streams.map((s) => s.events.slice(1).map((e) => e.data.revision as number));
      expect(revs[0]).toEqual(revs[1]);
      expect(revs[1]).toEqual(revs[2]);
      expect([...revs[0]!].sort((a, b) => a - b)).toEqual(revs[0]); // 오름차순
      expect(new Set(revs[0]).size).toBe(6);
    } finally {
      streams.forEach((s) => s.close());
    }
  });

  it('다른 방의 이벤트는 받지 않는다', async () => {
    const a = await makeRoom(at(0));
    const b = await makeRoom(at(0));
    const s = await openStream(at(1), a.roomId, a.key);
    try {
      await s.waitFor((e) => e.length >= 1);
      await createTx(at(0), b, 77);
      await sleep(500);
      expect(s.events.map((e) => e.event)).toEqual(['ready']);
    } finally {
      s.close();
    }
  });
});
