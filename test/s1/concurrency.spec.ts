import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ac } from '../helpers/contract.js';
import { startInstances, stopAll, type Instance } from '../helpers/instances.js';
import { createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { newKey } from './s1-helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

let db: IsolatedDb;
let inst: Instance[];

/** 응답 본문(시험에서 필요한 모양만 느슨하게 본다) */
type Body = { [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Res {
  status: number;
  body: Body;
}
async function fx(
  i: Instance,
  method: string,
  path: string,
  key?: string,
  body?: unknown,
): Promise<Res> {
  const res = await i.fetch(path, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
}
/** 두 프로세스에 번갈아 요청을 보낸다. */
const at = (n: number) => inst[n % inst.length]!;

async function room(nickname = 'Host') {
  const key = newKey();
  const res = await fx(at(0), 'POST', '/rooms', key, { name: 'Race', unit: '원', nickname });
  expect(res.status).toBe(201);
  return { key, roomId: res.body.room.id as string, code: res.body.room.inviteCode as string };
}
const joinAs = (n: number, code: string, nickname: string, key = newKey()) =>
  fx(at(n), 'POST', `/invites/${code}/members`, key, { nickname });
const register = (n: number, r: { key: string; roomId: string }, nickname: string) =>
  fx(at(n), 'POST', `/rooms/${r.roomId}/participants`, r.key, { nickname });
const tally = (rs: Res[]) => {
  const t: Record<string, number> = {};
  for (const r of rs) {
    const k = `${r.status}${r.body.error ? ' ' + r.body.error.code : ''}`;
    t[k] = (t[k] ?? 0) + 1;
  }
  return t;
};
const n = async (table: string, roomId: string) =>
  Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${table}" WHERE "roomId"=$1`,
        [roomId],
      )
    )[0]!.n,
  );

beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
  inst = await startInstances(2, { databaseUrl: db.databaseUrl, entry: 'main' });
});
afterAll(async () => {
  await stopAll(inst ?? []);
  await db?.drop();
});

describe('S1 동시성·한도 (서로 다른 프로세스 2개, 같은 DB)', () => {
  it(
    ac(
      ['AC-ROOM-006-11'],
      'S1 §7 1',
      '같은 닉네임 12개 동시 입장 → 정확히 하나만 성공, 나머지 409 NICKNAME_TAKEN',
    ),
    async () => {
      const r = await room();
      const results = await Promise.all(
        Array.from({ length: 9 }, (_, i) => joinAs(i, r.code, 'Same')),
      );
      expect(tally(results)).toEqual({ '201': 1, '409 NICKNAME_TAKEN': 8 });
      expect(await n('RoomMember', r.roomId)).toBe(2); // 방장 + 1
    },
  );

  it(
    ac(
      ['AC-ROOM-006-11'],
      'S1 §4.3',
      '같은 키로 동시에 입장 → 한 명만 만들어지고 나머지는 200으로 같은 RoomMember를 복원한다',
    ),
    async () => {
      const r = await room();
      const key = newKey();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => joinAs(i, r.code, 'Twin', key)),
      );
      expect(tally(results)).toEqual({ '201': 1, '200': 7 });
      expect(new Set(results.map((x) => x.body.me.id)).size).toBe(1);
      expect(await n('RoomMember', r.roomId)).toBe(2);
    },
  );

  it(
    ac(
      ['AC-ROOM-008-5', 'AC-ROOM-008-4'],
      'S1 §6.4',
      'RoomMember 마지막 슬롯에 서로 다른 신원 6개가 동시 도착 → 정확히 하나만 슬롯을 얻고 나머지는 MEMBER_LIMIT_EXCEEDED, 한도를 넘지 않는다',
    ),
    async () => {
      const r = await room(); // 방장 1명
      for (let i = 0; i < 8; i++) expect((await joinAs(i, r.code, `m${i}`)).status).toBe(201); // 9명
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => joinAs(i, r.code, `late${i}`)),
      );
      expect(tally(results)).toEqual({ '201': 1, '409 MEMBER_LIMIT_EXCEEDED': 5 });
      expect(await n('RoomMember', r.roomId)).toBe(10);
      for (const x of results.filter((x) => x.status === 409))
        expect(x.body.error.details).toEqual([{ limit: 10 }]);
    },
  );

  it(
    ac(
      ['AC-ROOM-008-5', 'AC-ROOM-008-4'],
      'S1 §6.4',
      'Participant 마지막 슬롯 경쟁 → 정확히 하나만 성공, 나머지 PARTICIPANT_LIMIT_EXCEEDED',
    ),
    async () => {
      const r = await room();
      for (let i = 0; i < 9; i++) expect((await register(i, r, `p${i}`)).status).toBe(201);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => register(i, r, `last${i}`)),
      );
      expect(tally(results)).toEqual({ '201': 1, '409 PARTICIPANT_LIMIT_EXCEEDED': 5 });
      expect(await n('Participant', r.roomId)).toBe(10);
    },
  );

  it(
    ac(
      ['AC-PART-001-5'],
      'S1 §7 3',
      '서로 다른 닉네임 10개를 동시 등록 → order가 모두 다르고(1~10) 저장 순서와 일치한다',
    ),
    async () => {
      const r = await room();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => register(i, r, `p${i}`)),
      );
      expect(tally(results)).toEqual({ '201': 10 });
      const orders = results.map((x) => x.body.participant.order as number).sort((a, b) => a - b);
      expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const rows = await db.query<{ order: number; createdAt: Date }>(
        `SELECT "order","createdAt" FROM "Participant" WHERE "roomId"=$1 ORDER BY "order"`,
        [r.roomId],
      );
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(
          rows[i - 1]!.createdAt.getTime(),
        ); // 저장 순서 = order 순서
      }
      // revision은 등록 10건 = 10, 번호가 비지 않는다
      const rev = (
        await db.query<{ revision: number }>(`SELECT "revision" FROM "Room" WHERE "id"=$1`, [
          r.roomId,
        ])
      )[0]!.revision;
      expect(rev).toBe(10);
    },
  );

  it(
    ac(
      ['AC-ROOM-006-11'],
      'S1 §3.3',
      '닉네임 중복과 한도가 동시에 해당하면 중복 판정(NICKNAME_TAKEN)이 우선한다',
    ),
    async () => {
      const r = await room();
      for (let i = 0; i < 8; i++) await joinAs(i, r.code, `m${i}`); // 9명
      // 같은 새 닉네임으로 6개 동시: 하나가 마지막 슬롯을 얻고 나머지는 한도가 아니라 닉네임 중복이어야 한다
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => joinAs(i, r.code, 'Dup')),
      );
      expect(tally(results)).toEqual({ '201': 1, '409 NICKNAME_TAKEN': 5 });
    },
  );

  it(
    ac(
      ['AC-ROOM-008-6', 'AC-ROOM-008-7', 'AC-ROOM-008-8', 'AC-ROOM-008-2'],
      'S1 §6.4',
      '비활성 참여자·소실된 신원·접속하지 않은 RoomMember도 한도에 포함된다',
    ),
    async () => {
      const r = await room();
      // RoomMember: 키를 버린(소실) 입장자도 센다
      for (let i = 0; i < 9; i++) expect((await joinAs(i, r.code, `lost${i}`)).status).toBe(201);
      const eleventh = await joinAs(0, r.code, 'newcomer');
      expect(eleventh.status).toBe(409);
      expect(eleventh.body.error.code).toBe('MEMBER_LIMIT_EXCEEDED');
      // Participant: 10명 중 1명을 비활성화해도 11번째는 거부된다
      const created: Res[] = [];
      for (let i = 0; i < 10; i++) created.push(await register(i, r, `q${i}`));
      const first = created[0]!.body.participant.id as string;
      expect(
        (
          await fx(at(0), 'PATCH', `/rooms/${r.roomId}/participants/${first}`, r.key, {
            status: 'INACTIVE',
          })
        ).status,
      ).toBe(200);
      const eleventhP = await register(1, r, 'q10');
      expect(eleventhP.status).toBe(409);
      expect(eleventhP.body.error.code).toBe('PARTICIPANT_LIMIT_EXCEEDED');
      expect(await n('Participant', r.roomId)).toBe(10);
    },
  );

  it('두 프로세스에서 같은 방의 참여자 변경이 번호 충돌 없이 직렬화된다(등록 + 상태 변경 혼합)', async () => {
    const r = await room();
    const seed = await Promise.all(Array.from({ length: 4 }, (_, i) => register(i, r, `s${i}`)));
    const ids = seed.map((x) => x.body.participant.id as string);
    const mixed = await Promise.all([
      ...ids.map((id, i) =>
        fx(at(i + 1), 'PATCH', `/rooms/${r.roomId}/participants/${id}`, r.key, {
          status: 'INACTIVE',
        }),
      ),
      ...Array.from({ length: 4 }, (_, i) => register(i, r, `t${i}`)),
    ]);
    expect(tally(mixed)).toEqual({ '200': 4, '201': 4 });
    const rev = (
      await db.query<{ revision: number }>(`SELECT "revision" FROM "Room" WHERE "id"=$1`, [
        r.roomId,
      ])
    )[0]!.revision;
    expect(rev).toBe(12); // 등록 4 + (상태 변경 4 + 등록 4)
  });
});
