import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ac } from '../helpers/contract.js';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { createTx } from '../s5/s5-helpers.js';
import { openStream } from '../s5/sse-client.js';
import { api, endReq, idem, makeRoom, settlementOf } from './s4-helpers.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 90_000 });

let db: IsolatedDb;
let inst: Instance[];
const at = (n: number) => inst[n % inst.length]!;
const q = <T extends object>(sql: string, p: unknown[] = []) => db.query(sql, p) as Promise<T[]>;
const revisionOf = async (roomId: string) =>
  (await q<{ revision: number }>(`SELECT "revision" FROM "Room" WHERE "id"=$1`, [roomId]))[0]!
    .revision;

beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
  inst = await startInstances(3, { databaseUrl: db.databaseUrl, entry: 'main' });
});
afterAll(async () => {
  await stopAll(inst ?? []);
  await db?.drop();
});

describe('종료 동시성 (BE-S4-4, 프로세스 3개)', () => {
  it(
    ac(
      ['AC-SET-001-9', 'AC-SET-001-8', 'AC-VIEW-005-4'],
      'S4 §6.1',
      '종료 12개(같은 키 6 + 다른 키 6) 동시 → 전이 1회, revision +1, room.ended 1회, 성공은 전이 요청과 그 같은 키 재전송뿐',
    ),
    async () => {
      const r = await makeRoom(at(0));
      const watcher = await openStream(at(1), r.roomId, r.key);
      await watcher.waitFor((e) => e.some((x) => x.event === 'ready'));
      const rev = await revisionOf(r.roomId);
      const shared = idem();
      const calls = [
        ...Array.from({ length: 6 }, (_, n) => ({ h: shared, n })),
        ...Array.from({ length: 6 }, (_, n) => ({ h: idem(), n: n + 6 })),
      ];
      const res = await Promise.all(calls.map((c) => endReq(at(c.n), r, c.h)));
      try {
        const ok = res.map((x, i) => ({ x, c: calls[i]! })).filter((v) => v.x.status === 200);
        const transitions = ok.filter((v) => !v.x.headers.get('idempotent-replayed'));
        expect(transitions).toHaveLength(1);
        const winnerKey = transitions[0]!.c.h.key;
        for (const v of ok) expect(v.c.h.key).toBe(winnerKey); // 성공은 전이 요청의 키뿐
        for (const x of res.filter((x) => x.status !== 200)) {
          expect(x.status).toBe(409);
          expect(x.body.error.code).toBe('GAME_ENDED');
        }
        expect(await revisionOf(r.roomId)).toBe(rev + 1);
        await watcher.waitFor((e) => e.some((x) => x.event === 'room.ended'));
        await new Promise((ok2) => setTimeout(ok2, 1500)); // 중복 도착이 없는지 잠시 지켜본다
        expect(watcher.events.filter((x) => x.event === 'room.ended')).toHaveLength(1);
        const [n] = await q<{ n: string }>(
          `SELECT count(*)::text n FROM "IdempotencyRecord" WHERE "roomId"=$1 AND "operation"='END'`,
          [r.roomId],
        );
        expect(Number(n!.n)).toBeGreaterThanOrEqual(1);
        await createTx(at(2), r, 5).then((t) => expect(t.status).toBe(409));
        expect(await revisionOf(r.roomId)).toBe(rev + 1); // 종료 뒤 revision 불변
      } finally {
        watcher.close();
      }
    },
  );

  it(
    ac(
      ['AC-TXN-009-5', 'AC-SET-008-4'],
      'S4 §7',
      '종료 vs 거래 저장 경쟁: 거래가 먼저면 최종 정산에 포함, 종료가 먼저면 GAME_ENDED·정산에 없음',
    ),
    async () => {
      let before = 0;
      let after = 0;
      for (let round = 0; round < 12; round++) {
        const r = await makeRoom(at(0));
        const [e, t] = await Promise.all([endReq(at(round), r), createTx(at(round + 1), r, 700)]);
        expect(e.status).toBe(200);
        const final = (await settlementOf(at(round + 2), r)).body.settlement;
        expect(final.kind).toBe('FINAL');
        if (t.status === 201) {
          before++;
          expect(final.items.map((i: { amount: number }) => i.amount)).toEqual([700]);
        } else {
          after++;
          expect(t.status).toBe(409);
          expect(t.body.error.code).toBe('GAME_ENDED');
          expect(final.items).toEqual([]);
        }
        const n = (
          await q<{ n: string }>(`SELECT count(*)::text n FROM "Transaction" WHERE "roomId"=$1`, [
            r.roomId,
          ])
        )[0]!.n;
        expect(Number(n)).toBe(t.status === 201 ? 1 : 0);
      }
      console.info(`[S4-4] 종료 vs 거래: 거래 먼저 ${before}, 종료 먼저 ${after}`);
    },
  );

  it(
    ac(
      ['AC-PART-004-1', 'AC-PART-004-2'],
      'S4 §7',
      '종료 vs 참여자 등록·상태 변경 경쟁: 종료가 먼저면 GAME_ENDED, 변경이 먼저면 최종 정산 입력에 반영',
    ),
    async () => {
      for (let round = 0; round < 10; round++) {
        const r = await makeRoom(at(0));
        const [e, add, st] = await Promise.all([
          endReq(at(round), r),
          api(at(round + 1), 'POST', `/rooms/${r.roomId}/participants`, r.key, { nickname: 'Z' }),
          api(at(round + 2), 'PATCH', `/rooms/${r.roomId}/participants/${r.p[0]}`, r.key, {
            status: 'INACTIVE',
          }),
        ]);
        expect(e.status).toBe(200);
        for (const x of [add, st]) {
          if (x.status !== 200 && x.status !== 201) {
            expect(x.status).toBe(409);
            expect(x.body.error.code).toBe('GAME_ENDED');
          }
        }
        const rev = await revisionOf(r.roomId);
        const n = (
          await q<{ n: string }>(`SELECT count(*)::text n FROM "Participant" WHERE "roomId"=$1`, [
            r.roomId,
          ])
        )[0]!.n;
        expect(Number(n)).toBe(add.status === 201 ? 4 : 3);
        await api(at(0), 'POST', `/rooms/${r.roomId}/participants`, r.key, { nickname: 'Y' });
        expect(await revisionOf(r.roomId)).toBe(rev); // 종료 뒤 반영 없음
      }
    },
  );
});
