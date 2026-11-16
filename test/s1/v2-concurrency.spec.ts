import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROOM_EVENTS_CHANNEL } from '../../src/common/db/database.service.js';
import { ac } from '../helpers/contract.js';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { baseDatabaseUrl, createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { parseNotification, sleep } from '../helpers/util.js';
import { api, idem, makeRoom, newKey, type ApiRes, type Room } from '../s5/s5-helpers.js';

/**
 * BE-M7 개정 경합 시험(S1 §7 1~9, S2 §7 1·5b·5c): 서버 프로세스 3개가 같은 DB에 붙은 상태에서 요청을 동시에 보낸다.
 * 시나리오마다 기대 결과(tasks.md §J BE-M7)와 불변식(S1 §2.3), `revision` 증가 수 = 커밋된 변경 수 = 이벤트 수를 확인한다.
 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 90_000 });

let db: IsolatedDb;
let inst: Instance[];
let listener: pg.Client;
const notices: Record<string, unknown>[] = [];
const at = (n: number) => inst[n % inst.length]!;
const ROUNDS = 6;

beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
  inst = await startInstances(3, { databaseUrl: db.databaseUrl, entry: 'main' });
  listener = new pg.Client({ connectionString: baseDatabaseUrl() });
  await listener.connect();
  await listener.query(`LISTEN ${ROOM_EVENTS_CHANNEL}`);
  listener.on('notification', (m) => {
    const e = parseNotification(m.payload);
    if (e) notices.push(e);
  });
});
afterAll(async () => {
  await listener?.end();
  await stopAll(inst ?? []);
  await db?.drop();
});

const tally = (rs: ApiRes[]) => {
  const t: Record<string, number> = {};
  for (const r of rs) {
    const k = `${r.status}${r.body.error ? ' ' + r.body.error.code : ''}`;
    t[k] = (t[k] ?? 0) + 1;
  }
  return t;
};
const revisionOf = async (roomId: string) =>
  (
    await db.query<{ revision: number }>(`SELECT "revision" FROM "Room" WHERE "id"=$1`, [roomId])
  )[0]!.revision;

/**
 * 변경 구간 하나를 재고 끝나면 `revision` 증가 수 = 통지 수 = `expected`(커밋된 변경 수)인지, 번호가 빠짐없는지 본다.
 */
async function window<T>(roomId: string, run: () => Promise<T>, expected: (r: T) => number) {
  const rev0 = await revisionOf(roomId);
  const from = notices.length;
  const result = await run();
  await sleep(300);
  const rev1 = await revisionOf(roomId);
  const evs = notices.slice(from).filter((e) => e.roomId === roomId);
  const n = expected(result);
  expect(rev1 - rev0, 'revision 증가 수').toBe(n);
  expect(evs.length, '이벤트 수').toBe(n);
  expect(evs.map((e) => e.revision).sort((a, b) => Number(a) - Number(b))).toEqual(
    Array.from({ length: n }, (_, i) => rev0 + i + 1),
  );
  return { result, events: evs };
}

/** S1 §2.3 I3·I4: 한 해시는 한 참여자, 연결된 해시는 대기 요청이 없고 접근 상실 기록도 없다, 대기 요청은 키마다 하나. */
async function invariants(roomId: string) {
  const dupLinked = await db.query(
    `SELECT "identityKeyHash" FROM "Participant" WHERE "roomId"=$1 AND "identityKeyHash" IS NOT NULL GROUP BY 1 HAVING count(*) > 1`,
    [roomId],
  );
  const linkedPending = await db.query(
    `SELECT 1 FROM "ClaimRequest" c JOIN "Participant" p ON p."roomId"=c."roomId" AND p."identityKeyHash"=c."requesterKeyHash"
     WHERE c."roomId"=$1 AND c."status"='PENDING'`,
    [roomId],
  );
  const linkedRevoked = await db.query(
    `SELECT 1 FROM "RevokedIdentity" r JOIN "Participant" p ON p."roomId"=r."roomId" AND p."identityKeyHash"=r."keyHash" WHERE r."roomId"=$1`,
    [roomId],
  );
  const revokedPending = await db.query(
    `SELECT 1 FROM "RevokedIdentity" r JOIN "ClaimRequest" c ON c."roomId"=r."roomId" AND c."requesterKeyHash"=r."keyHash" AND c."status"='PENDING' WHERE r."roomId"=$1`,
    [roomId],
  );
  const hosts = await db.query(
    `SELECT 1 FROM "Participant" WHERE "roomId"=$1 AND "isHost" AND "status"='ACTIVE'`,
    [roomId],
  );
  const count = Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "Participant" WHERE "roomId"=$1`,
        [roomId],
      )
    )[0]!.n,
  );
  expect({
    dupLinked,
    linkedPending,
    linkedRevoked,
    revokedPending,
    hosts: hosts.length,
    overLimit: count > 10,
  }).toEqual({
    dupLinked: [],
    linkedPending: [],
    linkedRevoked: [],
    revokedPending: [],
    hosts: 1,
    overLimit: false,
  });
}

const join = (n: number, r: Room, nickname: string, key = newKey()) =>
  api(at(n), 'POST', `/invites/${r.inviteCode}/members`, key, { nickname }).then((res) => ({
    key,
    res,
  }));
const add = (n: number, r: Room, nickname: string) =>
  api(at(n), 'POST', `/rooms/${r.roomId}/participants`, r.key, { nickname });
const claim = (n: number, r: Room, key: string, nickname: string) =>
  api(at(n), 'POST', `/invites/${r.inviteCode}/claims`, key, { nickname });
const approve = (n: number, r: Room, id: string) =>
  api(at(n), 'POST', `/rooms/${r.roomId}/claims/${id}/approve`, r.key);
const reject = (n: number, r: Room, id: string) =>
  api(at(n), 'POST', `/rooms/${r.roomId}/claims/${id}/reject`, r.key);
const cancel = (n: number, r: Room, key: string, id: string) =>
  api(at(n), 'POST', `/invites/${r.inviteCode}/claims/${id}/cancel`, key);
/**
 * 동시 요청을 보내되 라운드마다 시작 지연(0·20·40ms…)을 돌려 가며 준다. 먼저 보낸 요청이 늘 이기는 편향을 줄여
 * 시나리오의 두 처리 순서가 모두 관찰되게 한다. 결과는 `fns`와 같은 순서다.
 */
const race = (round: number, fns: (() => Promise<ApiRes>)[]) =>
  Promise.all(
    fns.map(async (f, i) => {
      await sleep(((i + round) % fns.length) * 20);
      return f();
    }),
  );
const ok = (r: ApiRes) => r.status >= 200 && r.status < 300;
const isCreated = (r: ApiRes) => r.status === 201;

describe('S1 §7 개정 경합 (프로세스 3개, BE-M7)', () => {
  it(
    ac(
      ['AC-ROOM-006-11'],
      'S1 §7 1',
      '같은 닉네임의 입장·직접 추가 N개(섞어서) → 201 하나, 나머지 NICKNAME_TAKEN',
    ),
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const r = await makeRoom(at(round), 0);
        const { result } = await window(
          r.roomId,
          () =>
            Promise.all(
              Array.from({ length: 8 }, (_, i) =>
                i % 2 ? add(round + i, r, 'Same') : join(round + i, r, 'same').then((x) => x.res),
              ),
            ),
          (rs) => rs.filter(isCreated).length,
        );
        expect(tally(result)).toEqual({ '201': 1, '409 NICKNAME_TAKEN': 7 });
        await invariants(r.roomId);
      }
    },
  );

  it(
    ac(
      ['AC-ROOM-008-5'],
      'S1 §7 2',
      '마지막 슬롯에 서로 다른 닉네임의 입장·직접 추가 N개(섞어서) → 201 하나, 나머지 PARTICIPANT_LIMIT_EXCEEDED',
    ),
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const r = await makeRoom(at(round), 8); // 방장 + 8 = 9명
        const { result } = await window(
          r.roomId,
          () =>
            Promise.all(
              Array.from({ length: 8 }, (_, i) =>
                i % 2 ? add(round + i, r, `a${i}`) : join(round + i, r, `j${i}`).then((x) => x.res),
              ),
            ),
          (rs) => rs.filter(isCreated).length,
        );
        expect(tally(result)).toEqual({ '201': 1, '409 PARTICIPANT_LIMIT_EXCEEDED': 7 });
        await invariants(r.roomId);
      }
    },
  );

  it(
    ac(
      ['AC-PART-001-5'],
      'S1 §7 3',
      '서로 다른 닉네임의 입장·직접 추가(한도 안) → 모두 201, order가 모두 다르고 처리(커밋) 순서와 일치',
    ),
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const r = await makeRoom(at(round), 0);
        const { result, events } = await window(
          r.roomId,
          () =>
            Promise.all(
              Array.from({ length: 9 }, (_, i) =>
                i % 2 ? add(round + i, r, `a${i}`) : join(round + i, r, `j${i}`).then((x) => x.res),
              ),
            ),
          () => 9,
        );
        expect(tally(result)).toEqual({ '201': 9 });
        const byId = new Map(
          result.map((x) => {
            const p = (x.body.participant ?? x.body.me) as { id: string; order: number };
            return [p.id, p.order];
          }),
        );
        // 이벤트(커밋) 순서대로 order가 증가한다
        const ordered = [...events]
          .sort((a, b) => Number(a.revision) - Number(b.revision))
          .map((e) => byId.get(e.participantId as string)!);
        expect(ordered).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
        await invariants(r.roomId);
      }
    },
  );

  it(
    ac(
      ['AC-ROOM-004-3', 'AC-ROOM-006-11'],
      'S1 §7 4',
      '같은 키의 입장 N개 → 201 하나·나머지 200 같은 me.id(변경 1건). 같은 키의 이어받기 요청 N개 → PENDING 하나·나머지 CLAIM_PENDING. 같은 키의 입장과 이어받기 요청 동시 → 먼저 처리된 쪽만 성공, 다른 쪽은 CLAIM_PENDING 또는 ALREADY_PARTICIPANT',
    ),
    async () => {
      const seen = new Set<string>();
      for (let round = 0; round < ROUNDS * 2; round++) {
        const r = await makeRoom(at(round), 1);
        const key = newKey();
        const { result: twins } = await window(
          r.roomId,
          () =>
            Promise.all(
              Array.from({ length: 6 }, (_, i) =>
                join(round + i, r, 'Twin', key).then((x) => x.res),
              ),
            ),
          () => 1, // 복원은 revision·이벤트를 만들지 않는다
        );
        expect(tally(twins)).toEqual({ '201': 1, '200': 5 });
        expect(new Set(twins.map((x) => x.body.me.id)).size).toBe(1);

        const ck = newKey();
        const { result: claims } = await window(
          r.roomId,
          () => Promise.all(Array.from({ length: 6 }, (_, i) => claim(round + i, r, ck, 'P0'))),
          () => 1,
        );
        expect(tally(claims)).toEqual({ '201': 1, '409 CLAIM_PENDING': 5 });
        const pendings = await db.query(
          `SELECT 1 FROM "ClaimRequest" WHERE "roomId"=$1 AND "status"='PENDING' AND "requesterKeyHash" = encode(sha256(convert_to($2,'UTF8')),'hex')`,
          [r.roomId, ck],
        );
        expect(pendings).toHaveLength(1);

        const k = newKey();
        const { result } = await window(
          r.roomId,
          () =>
            race(round, [
              () => join(round, r, 'Racer', k).then((x) => x.res),
              () => claim(round + 1, r, k, 'P0'),
            ]),
          (rs) => rs.filter(ok).length,
        );
        const [j, c] = result as [ApiRes, ApiRes];
        const outcome =
          j.status === 201
            ? `join first: claim ${c.status} ${c.body.error?.code}`
            : `claim first: join ${j.status} ${j.body.error?.code}`;
        seen.add(outcome.split(':')[0]!);
        if (j.status === 201) {
          expect([c.status, c.body.error?.code]).toEqual([409, 'ALREADY_PARTICIPANT']);
        } else {
          expect(c.status).toBe(201);
          expect([j.status, j.body.error?.code]).toEqual([409, 'CLAIM_PENDING']);
        }
        await invariants(r.roomId);
      }
      console.info(`[BE-M7] 같은 키 입장 대 이어받기: ${[...seen].join(', ')}`);
      expect([...seen].sort()).toEqual(['claim first', 'join first']); // 두 처리 순서가 모두 관찰됐다
    },
  );

  it(
    ac(
      ['AC-ROOM-009-8'],
      'S1 §7 5',
      '같은 요청에 승인·거절·취소 동시 → 성공 하나·나머지 CLAIM_ALREADY_RESOLVED, 연결은 승인일 때만',
    ),
    async () => {
      const winners: Record<string, number> = {};
      for (let round = 0; round < ROUNDS * 2; round++) {
        const r = await makeRoom(at(round), 1);
        const key = newKey();
        const id = (await claim(round, r, key, 'P0')).body.claim.id as string;
        const ops = [
          () => approve(round, r, id),
          () => reject(round + 1, r, id),
          () => cancel(round + 2, r, key, id),
        ];
        const { result } = await window(
          r.roomId,
          () => race(round, ops),
          (rs) => rs.filter(ok).length,
        );
        expect(tally(result)).toEqual({ '200': 1, '409 CLAIM_ALREADY_RESOLVED': 2 });
        const win = ['approve', 'reject', 'cancel'][result.findIndex(ok)]!;
        winners[win] = (winners[win] ?? 0) + 1;
        const linked = await db.query(
          `SELECT 1 FROM "Participant" WHERE "id"=$1 AND "identityKeyHash" IS NOT NULL`,
          [r.p[0]],
        );
        expect(linked.length).toBe(win === 'approve' ? 1 : 0);
        await invariants(r.roomId);
      }
      console.info(`[BE-M7] 승인·거절·취소 경합 승자: ${JSON.stringify(winners)}`);
      expect(Object.keys(winners).sort()).toEqual(['approve', 'cancel', 'reject']);
    },
  );

  it(
    ac(
      ['AC-ROOM-009-8'],
      'S1 §7 5, §4.13 7',
      '같은 대상의 두 요청을 동시에 승인 → 승인 하나, 다른 요청은 TARGET_CLAIMED, 늦은 승인은 CLAIM_ALREADY_RESOLVED',
    ),
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const r = await makeRoom(at(round), 1);
        const [k1, k2] = [newKey(), newKey()];
        const a = (await claim(round, r, k1, 'P0')).body.claim.id as string;
        const b = (await claim(round, r, k2, 'P0')).body.claim.id as string;
        const { result } = await window(
          r.roomId,
          () => race(round, [() => approve(round, r, a), () => approve(round + 1, r, b)]),
          (rs) => rs.filter(ok).length,
        );
        expect(tally(result)).toEqual({ '200': 1, '409 CLAIM_ALREADY_RESOLVED': 1 });
        const won = result[0]!.status === 200 ? a : b;
        const lost = won === a ? b : a;
        const rows = await db.query<{ id: string; status: string; rejectReason: string | null }>(
          `SELECT "id","status","rejectReason" FROM "ClaimRequest" WHERE "roomId"=$1`,
          [r.roomId],
        );
        expect(rows.find((x) => x.id === won)).toMatchObject({ status: 'APPROVED' });
        expect(rows.find((x) => x.id === lost)).toMatchObject({
          status: 'REJECTED',
          rejectReason: 'TARGET_CLAIMED',
        });
        await invariants(r.roomId);
      }
    },
  );

  it(
    ac(
      ['AC-ROOM-004-3', 'AC-ROOM-009-14'],
      'S1 §7 4·6, §4.3 3',
      '대기 키의 승인 대 같은 키의 입장 → 입장이 먼저면 입장 CLAIM_PENDING(연결 없음)·승인 APPROVED, 승인이 먼저면 입장 200 복원. 어떤 경우에도 한 키는 한 참여자',
    ),
    async () => {
      const seen = new Set<string>();
      for (let round = 0; round < ROUNDS * 2; round++) {
        const r = await makeRoom(at(round), 1);
        const key = newKey();
        const id = (await claim(round, r, key, 'P0')).body.claim.id as string;
        const { result } = await window(
          r.roomId,
          () =>
            race(round, [
              () => approve(round, r, id),
              () => join(round + 1, r, 'Other', key).then((x) => x.res),
            ]),
          (rs) => (rs[0]!.status === 200 ? 1 : 0) + (rs[1]!.status === 201 ? 1 : 0),
        );
        const [ap, jn] = result as [ApiRes, ApiRes];
        expect(ap.status).toBe(200);
        expect(ap.body.claim.status).toBe('APPROVED');
        if (jn.status === 200) {
          seen.add('approve first');
          expect(jn.body.me.id).toBe(r.p[0]); // 복원
        } else {
          seen.add('join first');
          expect([jn.status, jn.body.error?.code]).toEqual([409, 'CLAIM_PENDING']);
        }
        const linked = await db.query<{ id: string }>(
          `SELECT "id" FROM "Participant" WHERE "roomId"=$1 AND "identityKeyHash" = encode(sha256(convert_to($2,'UTF8')),'hex')`,
          [r.roomId, key],
        );
        expect(linked).toEqual([{ id: r.p[0] }]);
        await invariants(r.roomId);
      }
      console.info(`[BE-M7] 승인 대 입장: ${[...seen].join(', ')}`);
      expect([...seen].sort()).toEqual(['approve first', 'join first']);
    },
  );

  it(
    ac(
      ['AC-ROOM-002-7', 'AC-PART-004-1'],
      'S1 §7 7',
      '종료 대 입장 → 종료가 먼저면 GAME_ENDED(참여자 미생성), 입장이 먼저면 201 후 종료. 이어받기 요청은 종료와 무관하게 201',
    ),
    async () => {
      const seen = new Set<string>();
      for (let round = 0; round < ROUNDS * 2; round++) {
        const r = await makeRoom(at(round), 1);
        const before = Number(
          (
            await db.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM "Participant" WHERE "roomId"=$1`,
              [r.roomId],
            )
          )[0]!.n,
        );
        const { result } = await window(
          r.roomId,
          () =>
            race(round, [
              () => api(at(round), 'POST', `/rooms/${r.roomId}/end`, r.key, undefined, idem()),
              () => join(round + 1, r, 'Late').then((x) => x.res),
              () => claim(round + 2, r, newKey(), 'P0'),
            ]),
          (rs) => rs.filter(ok).length,
        );
        const [e, j, c] = result as [ApiRes, ApiRes, ApiRes];
        expect(e.status).toBe(200);
        expect(c.status).toBe(201);
        const after = Number(
          (
            await db.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM "Participant" WHERE "roomId"=$1`,
              [r.roomId],
            )
          )[0]!.n,
        );
        if (j.status === 201) {
          seen.add('join first');
          expect(after).toBe(before + 1);
        } else {
          seen.add('end first');
          expect([j.status, j.body.error.code]).toEqual([409, 'GAME_ENDED']);
          expect(after).toBe(before);
        }
        await invariants(r.roomId);
      }
      console.info(`[BE-M7] 종료 대 입장: ${[...seen].join(', ')}`);
      expect([...seen].sort()).toEqual(['end first', 'join first']);
    },
  );

  it(
    ac(
      ['AC-PART-002-8', 'AC-PART-002-13'],
      'S1 §7 8, S2 §7 5·5b',
      '비활성화 대 그 참여자를 당사자로 한 생성·그 참여자 신원의 생성·수정·삭제 → 처리(직렬) 시점 상태: 비활성화 뒤면 PARTICIPANT_INACTIVE·REQUESTER_INACTIVE(기록 없음), 앞이면 성공',
    ),
    async () => {
      const seen: Record<string, Set<number>> = {};
      const body = (r: Room, extra: object) => ({ payerId: r.hostId, payeeId: r.p[0], ...extra });
      for (let round = 0; round < ROUNDS * 2; round++) {
        const r = await makeRoom(at(round), 1);
        const kim = await join(round, r, 'Kim');
        const kimId = kim.res.body.me.id as string;
        const tx = (i: number, key: string, extra: object) =>
          api(at(i), 'POST', `/rooms/${r.roomId}/transactions`, key, body(r, extra), idem());
        const own = [
          (await tx(round, kim.key, { amount: 1 })).body.transaction.id as string,
          (await tx(round, kim.key, { amount: 2 })).body.transaction.id as string,
        ];
        const recsBefore = (
          await db.query(`SELECT 1 FROM "IdempotencyRecord" WHERE "participantId"=$1`, [kimId])
        ).length;
        const { result, events } = await window(
          r.roomId,
          () =>
            race(round, [
              () =>
                api(at(round), 'PATCH', `/rooms/${r.roomId}/participants/${kimId}`, r.key, {
                  status: 'INACTIVE',
                }),
              () => tx(round + 1, r.key, { payerId: kimId, amount: 10 }), // 당사자로 지정
              () => tx(round + 2, kim.key, { amount: 20 }), // 요청자로 생성
              () =>
                api(
                  at(round + 3),
                  'PUT',
                  `/rooms/${r.roomId}/transactions/${own[0]}`,
                  kim.key,
                  { amount: 30 },
                  idem(),
                ),
              () =>
                api(
                  at(round + 4),
                  'DELETE',
                  `/rooms/${r.roomId}/transactions/${own[1]}`,
                  kim.key,
                  undefined,
                  idem(),
                ),
            ]),
          (rs) => rs.filter(ok).length,
        );
        const [st, asParty, create, update, remove] = result as ApiRes[];
        expect(st!.status).toBe(200);
        const deactivatedAt = Number(
          events.find((e) => e.event === 'participant.status_changed')!.revision,
        );
        const cases: [string, ApiRes, number, number, string][] = [
          ['party', asParty!, 201, 409, 'PARTICIPANT_INACTIVE'],
          ['create', create!, 201, 403, 'REQUESTER_INACTIVE'],
          ['update', update!, 200, 403, 'REQUESTER_INACTIVE'],
          ['delete', remove!, 200, 403, 'REQUESTER_INACTIVE'],
        ];
        for (const [label, res, okStatus, badStatus, code] of cases) {
          (seen[label] ??= new Set()).add(res.status);
          if (res.status === okStatus) {
            // 성공했다면 비활성화보다 먼저 커밋됐다(직렬 순서)
            const id =
              label === 'update' ? own[0] : label === 'delete' ? own[1] : res.body.transaction.id;
            const mine = events.find((e) => e.transactionId === id)!;
            expect(Number(mine.revision), label).toBeLessThan(deactivatedAt);
          } else {
            expect([res.status, res.body.error?.code], label).toEqual([badStatus, code]);
          }
        }
        const kimOk = [create!, update!, remove!].filter(ok).length;
        const recs = (
          await db.query(`SELECT 1 FROM "IdempotencyRecord" WHERE "participantId"=$1`, [kimId])
        ).length;
        expect(recs - recsBefore).toBe(kimOk); // 거부(REQUESTER_INACTIVE)는 기록하지 않는다
        await invariants(r.roomId);
      }
      console.info(
        `[BE-M7] 비활성화 대 거래: ${Object.entries(seen)
          .map(([k, v]) => `${k} ${[...v].sort().join('/')}`)
          .join(', ')}`,
      );
      // 각 요청에서 비활성화 앞·뒤 두 순서가 모두 관찰됐다
      expect(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, [...v].sort()]))).toEqual({
        party: [201, 409],
        create: [201, 403],
        update: [200, 403],
        delete: [200, 403],
      });
    },
  );

  it(
    ac(
      ['AC-ROOM-009-5', 'AC-ROOM-004-3'],
      'S1 §7 9, S2 §7 5c',
      '승인 대 이전 키의 거래(재전송 포함) → 승인이 먼저면 IDENTITY_REVOKED, 거래가 먼저면 유효하고 작성자는 그 참여자',
    ),
    async () => {
      const seen = new Set<string>();
      for (let round = 0; round < ROUNDS * 2; round++) {
        const r = await makeRoom(at(round), 1);
        const kim = await join(round, r, 'Kim');
        const kimId = kim.res.body.me.id as string;
        const h = idem();
        const body = { payerId: r.hostId, payeeId: r.p[0], amount: 30 };
        const first = await api(
          at(round),
          'POST',
          `/rooms/${r.roomId}/transactions`,
          kim.key,
          body,
          h,
        );
        expect(first.status).toBe(201);
        const id = (await claim(round, r, newKey(), 'Kim')).body.claim.id as string;
        const { result } = await window(
          r.roomId,
          () =>
            race(round, [
              () => approve(round, r, id),
              () => api(at(round + 1), 'POST', `/rooms/${r.roomId}/transactions`, kim.key, body, h), // 재전송
              () =>
                api(
                  at(round + 2),
                  'POST',
                  `/rooms/${r.roomId}/transactions`,
                  kim.key,
                  body,
                  idem(),
                ), // 새 요청
            ]),
          (rs) => (rs[0]!.status === 200 ? 1 : 0) + (rs[2]!.status === 201 ? 1 : 0),
        );
        const [ap, replay, fresh] = result as [ApiRes, ApiRes, ApiRes];
        expect(ap.status).toBe(200);
        for (const [label, res, okStatus] of [
          ['replay', replay, 201],
          ['fresh', fresh, 201],
        ] as const) {
          if (res.status === okStatus) {
            seen.add(`${label} before approve`);
            expect(res.body.transaction.authorId).toBe(kimId);
          } else {
            seen.add(`${label} after approve`);
            expect([res.status, res.body.error.code]).toEqual([401, 'IDENTITY_REVOKED']);
          }
        }
        if (replay.status === 201) expect(replay.headers.get('idempotent-replayed')).toBe('true');
        const txs = await db.query<{ authorId: string }>(
          `SELECT "authorId" FROM "Transaction" WHERE "roomId"=$1`,
          [r.roomId],
        );
        expect(txs.length).toBe(fresh.status === 201 ? 2 : 1);
        for (const t of txs) expect(t.authorId).toBe(kimId);
        await invariants(r.roomId);
      }
      console.info(`[BE-M7] 승인 대 이전 키 거래: ${[...seen].join(', ')}`);
      expect([...seen].sort()).toEqual([
        'fresh after approve',
        'fresh before approve',
        'replay after approve',
        'replay before approve',
      ]);
    },
  );
});
