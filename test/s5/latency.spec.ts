import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ac } from '../helpers/contract.js';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { createTx, makeRoom } from './s5-helpers.js';
import { openStream } from './sse-client.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 90_000 });

let db: IsolatedDb;
let inst: Instance[];

beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
  inst = await startInstances(2, { databaseUrl: db.databaseUrl, entry: 'main' });
});
afterAll(async () => {
  await stopAll(inst ?? []);
  await db?.drop();
});

const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)]!;

describe('이벤트 지연 (BE-S5-4)', () => {
  it(
    ac(
      ['AC-SYS-002-1'],
      'S5 §5',
      '같은 호스트에서 변경 응답 직전~스트림 수신까지 p95 ≤ 1초, 최대 ≤ 3초(서로 다른 인스턴스, 구독자 5명)',
    ),
    async () => {
      const r = await makeRoom(inst[0]!);
      const subs = await Promise.all(
        Array.from({ length: 5 }, (_, i) => openStream(inst[i % 2]!, r.roomId, r.key)),
      );
      try {
        await Promise.all(subs.map((s) => s.waitFor((e) => e.some((x) => x.event === 'ready'))));
        const N = 60;
        const samples: number[] = [];
        for (let n = 1; n <= N; n++) {
          const sentAt = Date.now(); // 같은 호스트·같은 시계: 보정 불필요
          await createTx(inst[n % 2]!, r, n);
          const rev = 3 + n + 1 - 1; // 방 생성 후 참여자 3명 → revision 4부터
          for (const s of subs) {
            const ev = await s.waitFor((e) =>
              e.some((x) => Number(x.data.revision) === rev && x.event === 'transaction.created'),
            );
            const got = ev.find(
              (x) => Number(x.data.revision) === rev && x.event === 'transaction.created',
            )!;
            samples.push(got.receivedAt - sentAt);
          }
        }
        const p95 = pct(samples, 0.95);
        const max = Math.max(...samples);
        console.info(
          `[S5-4] n=${samples.length} p50=${pct(samples, 0.5)}ms p95=${p95}ms max=${max}ms (같은 호스트, 로컬 DB)`,
        );
        expect(p95).toBeLessThanOrEqual(1000);
        expect(max).toBeLessThanOrEqual(3000);
      } finally {
        subs.forEach((s) => s.close());
      }
    },
  );
});
