import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/common/db/prisma.service.js';
import { newId, newInviteCode } from '../../src/common/ids/ids.js';
import { createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';
import { sqlState } from '../helpers/util.js';

let db: IsolatedDb;
beforeAll(async () => {
  db = await createIsolatedDb({ migrations: true });
});
afterAll(() => db?.drop());

const HASH = 'a'.repeat(64);
const hash = (c: string) => c.repeat(64);

async function reject(sql: string, params: unknown[] = []): Promise<string | undefined> {
  try {
    await db.query(sql, params);
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

async function newRoom(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = (overrides.id as string) ?? newId();
  await db.query(`INSERT INTO "Room" ("id","name","unit","inviteCode") VALUES ($1,$2,$3,$4)`, [
    id,
    overrides.name ?? 'Friday 7',
    overrides.unit ?? '원',
    overrides.inviteCode ?? newInviteCode(),
  ]);
  return id;
}

async function newParticipant(roomId: string, o: Record<string, unknown> = {}) {
  const id = (o.id as string) ?? newId();
  await db.query(
    `INSERT INTO "Participant" ("id","roomId","nickname","nicknameKey","status","order","isHost","identityKeyHash") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      roomId,
      o.nickname ?? 'Han',
      o.nicknameKey ?? 'han',
      o.status ?? 'ACTIVE',
      o.order ?? 1,
      o.isHost ?? false,
      o.hash ?? null,
    ],
  );
  return id;
}

let seq = 0;
/** 순서·닉네임이 겹치지 않는 참여자(제약 시험의 배경용) */
const someone = (roomId: string, o: Record<string, unknown> = {}) => {
  const n = ++seq;
  return newParticipant(roomId, { order: n, nickname: `p${n}`, nicknameKey: `p${n}`, ...o });
};

async function newClaim(roomId: string, participantId: string, o: Record<string, unknown> = {}) {
  const id = (o.id as string) ?? newId();
  await db.query(
    `INSERT INTO "ClaimRequest" ("id","roomId","participantId","requesterKeyHash","status","rejectReason","resolvedAt","resolvedById") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      roomId,
      participantId,
      o.hash ?? HASH,
      o.status ?? 'PENDING',
      o.rejectReason ?? null,
      o.resolvedAt ?? null,
      o.resolvedById ?? null,
    ],
  );
  return id;
}

describe('S1 데이터 모델 제약 (BE-S1-1, v2.0.0 개정 BE-M1)', () => {
  describe('Room', () => {
    it('기본값: 상태 IN_PROGRESS, createdAt은 DB 시각', async () => {
      const id = await newRoom();
      const [r] = await db.query<{ status: string; createdAt: Date }>(
        `SELECT "status","createdAt" FROM "Room" WHERE "id"=$1`,
        [id],
      );
      expect(r!.status).toBe('IN_PROGRESS');
      expect(r!.createdAt).toBeInstanceOf(Date);
    });

    it('초대 코드는 유일하다', async () => {
      const code = newInviteCode();
      await newRoom({ inviteCode: code });
      expect(
        await reject(
          `INSERT INTO "Room" ("id","name","unit","inviteCode") VALUES ($1,'a','원',$2)`,
          [newId(), code],
        ),
      ).toBe('23505');
    });

    it('같은 이름의 방은 여럿 만들 수 있다(AC-ROOM-001-5의 저장 근거)', async () => {
      await newRoom({ name: 'Dup' });
      await newRoom({ name: 'Dup' });
    });

    it('상태는 IN_PROGRESS·ENDED만 허용한다', async () => {
      const id = await newRoom();
      await db.query(`UPDATE "Room" SET "status"='ENDED' WHERE "id"=$1`, [id]);
      expect(await reject(`UPDATE "Room" SET "status"='OPEN' WHERE "id"=$1`, [id])).toBe('23514');
    });

    it('이름·단위 길이는 1~12 코드 포인트다(0·13 거부, 이모지 한 글자는 1)', async () => {
      expect(
        await reject(
          `INSERT INTO "Room" ("id","name","unit","inviteCode") VALUES ($1,'', '원',$2)`,
          [newId(), newInviteCode()],
        ),
      ).toBe('23514');
      expect(
        await reject(
          `INSERT INTO "Room" ("id","name","unit","inviteCode") VALUES ($1,$2,'원',$3)`,
          [newId(), 'a'.repeat(13), newInviteCode()],
        ),
      ).toBe('23514');
      expect(
        await reject(`INSERT INTO "Room" ("id","name","unit","inviteCode") VALUES ($1,'a',$2,$3)`, [
          newId(),
          'b'.repeat(13),
          newInviteCode(),
        ]),
      ).toBe('23514');
      await newRoom({ name: 'a'.repeat(12), unit: 'b'.repeat(12) });
      await newRoom({ name: '😀'.repeat(12) });
    });

    it('필수 필드가 없으면 거부한다', async () => {
      expect(
        await reject(`INSERT INTO "Room" ("id","name","inviteCode") VALUES ($1,'a',$2)`, [
          newId(),
          newInviteCode(),
        ]),
      ).toBe('23502');
    });

    it('초대 코드가 너무 짧으면 거부한다(추측 가능한 코드 방지)', async () => {
      expect(
        await reject(
          `INSERT INTO "Room" ("id","name","unit","inviteCode") VALUES ($1,'a','원','short')`,
          [newId()],
        ),
      ).toBe('23514');
    });
  });

  describe('Participant 신원·방장 (BE-M1, PD-21)', () => {
    it('같은 방에서 같은 신원 키 해시는 한 참여자에만 연결된다(S1 I3)', async () => {
      const room = await newRoom();
      await someone(room, { hash: HASH });
      expect(
        await reject(
          `INSERT INTO "Participant" ("id","roomId","nickname","nicknameKey","order","identityKeyHash") VALUES ($1,$2,'B','b',99,$3)`,
          [newId(), room, HASH],
        ),
      ).toBe('23505');
    });

    it('신원이 없는(NULL) 참여자는 여럿이어도 된다(직접 추가, OQ-042)', async () => {
      const room = await newRoom();
      await someone(room);
      await someone(room);
      await someone(room, { hash: null });
    });

    it('다른 방에서는 같은 신원 키 해시가 별개의 신원이다(방 단위 권한, AC-SYS-003-6·7의 저장 근거)', async () => {
      const a = await newRoom();
      const b = await newRoom();
      await someone(a, { hash: HASH });
      await someone(b, { hash: HASH });
    });

    it('방마다 방장은 최대 한 명이다(두 번째 방장 거부, 일반 참여자는 여럿)', async () => {
      const room = await newRoom();
      await someone(room, { isHost: true, hash: hash('1') });
      expect(
        await reject(
          `INSERT INTO "Participant" ("id","roomId","nickname","nicknameKey","order","isHost") VALUES ($1,$2,'H2','h2',99,true)`,
          [newId(), room],
        ),
      ).toBe('23505');
      await someone(room);
      await someone(room);
      await someone(await newRoom(), { isHost: true });
    });

    it('방장 표시를 다른 참여자로 옮기려는 갱신도 부분 유일 인덱스가 막는다', async () => {
      const room = await newRoom();
      await someone(room, { isHost: true });
      const m = await someone(room);
      expect(await reject(`UPDATE "Participant" SET "isHost"=true WHERE "id"=$1`, [m])).toBe(
        '23505',
      );
    });

    it('방장은 비활성일 수 없다(P-4의 마지막 방어선). isHost 기본값은 false', async () => {
      const room = await newRoom();
      const host = await someone(room, { isHost: true });
      expect(
        await reject(`UPDATE "Participant" SET "status"='INACTIVE' WHERE "id"=$1`, [host]),
      ).toBe('23514');
      const m = await newParticipant(room, { order: 77, nicknameKey: 'zz', nickname: 'ZZ' });
      const [row] = await db.query<{ isHost: boolean }>(
        `SELECT "isHost" FROM "Participant" WHERE "id"=$1`,
        [m],
      );
      expect(row!.isHost).toBe(false);
    });

    it('신원 키 해시는 SHA-256 소문자 hex 64자여야 한다(원문 키를 저장할 수 없다)', async () => {
      const room = await newRoom();
      for (const bad of [
        'A'.repeat(64),
        'a'.repeat(63),
        'a'.repeat(65),
        'g'.repeat(64),
        'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE',
      ]) {
        expect(
          await reject(
            `INSERT INTO "Participant" ("id","roomId","nickname","nicknameKey","order","identityKeyHash") VALUES ($1,$2,'a','a',1,$3)`,
            [newId(), room, bad],
          ),
          bad,
        ).toBe('23514');
      }
    });
  });

  describe('ClaimRequest (BE-M1, S1 §2.1, §5.5)', () => {
    it('같은 방에서 같은 키의 PENDING은 하나만(P-8). 끝난 요청은 여럿이어도 된다', async () => {
      const room = await newRoom();
      const target = await someone(room);
      await newClaim(room, target, { hash: hash('1') });
      expect(
        await reject(
          `INSERT INTO "ClaimRequest" ("id","roomId","participantId","requesterKeyHash") VALUES ($1,$2,$3,$4)`,
          [newId(), room, await someone(room), hash('1')],
        ),
      ).toBe('23505');
      const now = new Date();
      await newClaim(room, target, { hash: hash('1'), status: 'CANCELED', resolvedAt: now });
      await newClaim(room, target, { hash: hash('1'), status: 'CANCELED', resolvedAt: now });
      // 다른 방이면 같은 키의 PENDING이 따로 있어도 된다
      const other = await newRoom();
      await newClaim(other, await someone(other), { hash: hash('1') });
    });

    it('같은 대상에 다른 키의 PENDING은 여럿이어도 된다(승인 하나만 이긴다, P-7)', async () => {
      const room = await newRoom();
      const target = await someone(room);
      await newClaim(room, target, { hash: hash('2') });
      await newClaim(room, target, { hash: hash('3') });
    });

    it('상태·거절 사유는 정해진 값만(CHECK)', async () => {
      const room = await newRoom();
      const target = await someone(room);
      const host = await someone(room, { isHost: true });
      expect(
        await reject(
          `INSERT INTO "ClaimRequest" ("id","roomId","participantId","requesterKeyHash","status") VALUES ($1,$2,$3,$4,'EXPIRED')`,
          [newId(), room, target, hash('4')],
        ),
      ).toBe('23514');
      expect(
        await reject(
          `INSERT INTO "ClaimRequest" ("id","roomId","participantId","requesterKeyHash","status","rejectReason","resolvedAt","resolvedById") VALUES ($1,$2,$3,$4,'REJECTED','SPAM',clock_timestamp(),$5)`,
          [newId(), room, target, hash('4'), host],
        ),
      ).toBe('23514');
      for (const reason of ['HOST_REJECTED', 'TARGET_CLAIMED', 'REQUESTER_LINKED'])
        await newClaim(room, target, {
          hash: hash('4'),
          status: 'REJECTED',
          rejectReason: reason,
          resolvedAt: new Date(),
          resolvedById: host,
        });
    });

    it('상태와 사유·처리 시각·처리자는 서로 맞아야 한다(CHECK)', async () => {
      const room = await newRoom();
      const target = await someone(room);
      const host = await someone(room, { isHost: true });
      const now = new Date();
      const bad: Record<string, unknown>[] = [
        { status: 'PENDING', resolvedAt: now }, // 대기 중인데 처리 시각
        { status: 'PENDING', rejectReason: 'HOST_REJECTED' },
        { status: 'APPROVED', resolvedAt: now }, // 처리자 없음
        { status: 'APPROVED', resolvedById: host }, // 처리 시각 없음
        { status: 'APPROVED', resolvedAt: now, resolvedById: host, rejectReason: 'HOST_REJECTED' },
        { status: 'REJECTED', resolvedAt: now, resolvedById: host }, // 사유 없음
        { status: 'CANCELED', resolvedAt: now, resolvedById: host }, // 취소는 처리자 없음(AC-ROOM-004-5)
      ];
      for (const o of bad) {
        const err = await newClaim(room, target, { hash: hash('5'), ...o }).then(
          () => undefined,
          (e: { code?: string }) => e.code,
        );
        expect(err, JSON.stringify(o)).toBe('23514');
      }
      await newClaim(room, target, {
        hash: hash('5'),
        status: 'APPROVED',
        resolvedAt: now,
        resolvedById: host,
      });
      await newClaim(room, target, { hash: hash('5'), status: 'CANCELED', resolvedAt: now });
    });

    it('요청 키 해시는 SHA-256 hex 형식, 대상·처리자는 참여자, 방은 있어야 한다', async () => {
      const room = await newRoom();
      const target = await someone(room);
      expect(
        await reject(
          `INSERT INTO "ClaimRequest" ("id","roomId","participantId","requesterKeyHash") VALUES ($1,$2,$3,'raw-key')`,
          [newId(), room, target],
        ),
      ).toBe('23514');
      expect(
        await reject(
          `INSERT INTO "ClaimRequest" ("id","roomId","participantId","requesterKeyHash") VALUES ($1,$2,'nope',$3)`,
          [newId(), room, hash('6')],
        ),
      ).toBe('23503');
      expect(
        await reject(
          `INSERT INTO "ClaimRequest" ("id","roomId","participantId","requesterKeyHash") VALUES ($1,'nope',$2,$3)`,
          [newId(), target, hash('6')],
        ),
      ).toBe('23503');
      expect(
        await newClaim(room, target, {
          hash: hash('6'),
          status: 'APPROVED',
          resolvedAt: new Date(),
          resolvedById: 'nope',
        }).then(
          () => undefined,
          (e: { code?: string }) => e.code,
        ),
      ).toBe('23503');
    });

    it('기본값: PENDING, createdAt은 DB 시각', async () => {
      const room = await newRoom();
      const id = await newClaim(room, await someone(room), { hash: hash('7') });
      const [c] = await db.query<{ status: string; createdAt: Date }>(
        `SELECT "status","createdAt" FROM "ClaimRequest" WHERE "id"=$1`,
        [id],
      );
      expect(c!.status).toBe('PENDING');
      expect(c!.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('RevokedIdentity (BE-M1, S1-C4)', () => {
    const insert = (roomId: string, keyHash: string, participantId: string) =>
      db.query(
        `INSERT INTO "RevokedIdentity" ("roomId","keyHash","participantId") VALUES ($1,$2,$3)`,
        [roomId, keyHash, participantId],
      );

    it('(방, 키 해시)는 한 번만 기록된다. 다른 방이면 같은 해시도 따로 기록된다', async () => {
      const room = await newRoom();
      const p = await someone(room);
      await insert(room, hash('8'), p);
      expect(
        await reject(
          `INSERT INTO "RevokedIdentity" ("roomId","keyHash","participantId") VALUES ($1,$2,$3)`,
          [room, hash('8'), await someone(room)],
        ),
      ).toBe('23505');
      const other = await newRoom();
      await insert(other, hash('8'), await someone(other));
    });

    it('키 해시 형식, 참여자·방 참조를 검사한다', async () => {
      const room = await newRoom();
      const p = await someone(room);
      expect(
        await reject(
          `INSERT INTO "RevokedIdentity" ("roomId","keyHash","participantId") VALUES ($1,'x',$2)`,
          [room, p],
        ),
      ).toBe('23514');
      expect(
        await reject(
          `INSERT INTO "RevokedIdentity" ("roomId","keyHash","participantId") VALUES ($1,$2,'nope')`,
          [room, hash('9')],
        ),
      ).toBe('23503');
    });
  });

  describe('Participant', () => {
    it('방 안에서 order는 유일하고 양의 정수다(결번 허용, 다른 방과는 독립)', async () => {
      const a = await newRoom();
      const b = await newRoom();
      await newParticipant(a, { order: 1, nicknameKey: 'a' });
      await newParticipant(a, { order: 5, nicknameKey: 'b' }); // 결번
      expect(
        await reject(
          `INSERT INTO "Participant" ("id","roomId","nickname","nicknameKey","order") VALUES ($1,$2,'C','c',5)`,
          [newId(), a],
        ),
      ).toBe('23505');
      await newParticipant(b, { order: 1, nicknameKey: 'a' });
      for (const bad of [0, -1]) {
        expect(
          await reject(
            `INSERT INTO "Participant" ("id","roomId","nickname","nicknameKey","order") VALUES ($1,$2,'D','d',$3)`,
            [newId(), a, bad],
          ),
          String(bad),
        ).toBe('23514');
      }
    });

    it('닉네임 비교 키는 방 안에서 유일하다(상태와 무관하게 센다)', async () => {
      const room = await newRoom();
      await newParticipant(room, { order: 1, nicknameKey: 'han', status: 'INACTIVE' });
      expect(
        await reject(
          `INSERT INTO "Participant" ("id","roomId","nickname","nicknameKey","order") VALUES ($1,$2,'HAN','han',2)`,
          [newId(), room],
        ),
      ).toBe('23505');
    });

    it('상태는 ACTIVE·INACTIVE만 허용하고 기본은 ACTIVE다', async () => {
      const room = await newRoom();
      const id = await newParticipant(room, { order: 1, nicknameKey: 'a' });
      const [p] = await db.query<{ status: string }>(
        `SELECT "status" FROM "Participant" WHERE "id"=$1`,
        [id],
      );
      expect(p!.status).toBe('ACTIVE');
      expect(await reject(`UPDATE "Participant" SET "status"='GONE' WHERE "id"=$1`, [id])).toBe(
        '23514',
      );
    });

    it('없는 방을 가리킬 수 없다', async () => {
      expect(
        await reject(
          `INSERT INTO "Participant" ("id","roomId","nickname","nicknameKey","order") VALUES ($1,'nope','a','a',1)`,
          [newId()],
        ),
      ).toBe('23503');
    });
  });

  describe('구조', () => {
    it('RoomMember 테이블이 없고 사람 단위는 Participant 하나다(S1 §2.3 I2, PD-21)', async () => {
      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`,
        [db.schema],
      );
      expect(tables.map((t) => t.table_name)).toEqual(
        [
          'ClaimRequest',
          'IdempotencyRecord',
          'Participant',
          'RevokedIdentity',
          'Room',
          'StreamLease',
          'Transaction',
        ].sort(),
      );
      const cols = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'Participant'`,
        [db.schema],
      );
      expect(cols.map((c) => c.column_name).sort()).toEqual(
        [
          'createdAt',
          'id',
          'identityKeyHash',
          'isHost',
          'nickname',
          'nicknameKey',
          'order',
          'roomId',
          'status',
        ].sort(),
      );
    });

    it('거래 작성자·삭제자, 멱등 기록, 연결 임대, 이어받기, 접근 상실은 모두 Participant를 가리킨다', async () => {
      const fks = await db.query<{ child: string; col: string; parent: string }>(
        `SELECT c.relname AS child, a.attname AS col, p.relname AS parent FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
         WHERE k.contype='f' AND n.nspname=$1 AND p.relname = 'Participant' ORDER BY 1,2`,
        [db.schema],
      );
      expect(fks.map((f) => `${f.child}.${f.col}`)).toEqual([
        'ClaimRequest.participantId',
        'ClaimRequest.resolvedById',
        'IdempotencyRecord.participantId',
        'RevokedIdentity.participantId',
        'StreamLease.participantId',
        'Transaction.authorId',
        'Transaction.deletedById',
        'Transaction.payeeId',
        'Transaction.payerId',
      ]);
    });

    it('방을 삭제하는 경로는 없다: 자식이 있으면 삭제가 거부된다(RESTRICT)', async () => {
      const room = await newRoom();
      await someone(room, { isHost: true, hash: hash('9') });
      expect(await reject(`DELETE FROM "Room" WHERE "id"=$1`, [room])).toBe('23503');
    });
  });

  describe('Prisma 클라이언트와 SQL이 같은 구조를 본다', () => {
    it('생성된 모델로 방·방장 참여자·참여자·이어받기 요청을 만들고 읽는다', async () => {
      const prisma = new PrismaService({ DATABASE_URL: db.databaseUrl, DB_POOL_MAX: 2 });
      try {
        const roomId = newId();
        await prisma.client.room.create({
          data: {
            id: roomId,
            name: 'Prisma',
            unit: '원',
            inviteCode: newInviteCode(),
            participants: {
              create: [
                {
                  id: newId(),
                  nickname: 'Host',
                  nicknameKey: 'host',
                  order: 1,
                  isHost: true,
                  identityKeyHash: hash('c'),
                },
                { id: newId(), nickname: 'P1', nicknameKey: 'p1', order: 2 },
              ],
            },
          },
        });
        const p1 = await prisma.client.participant.findFirstOrThrow({
          where: { roomId, order: 2 },
        });
        await prisma.client.claimRequest.create({
          data: { id: newId(), roomId, participantId: p1.id, requesterKeyHash: hash('d') },
        });
        const room = await prisma.client.room.findUniqueOrThrow({
          where: { id: roomId },
          include: { participants: { orderBy: { order: 'asc' } }, claimRequests: true },
        });
        expect(room.status).toBe('IN_PROGRESS');
        expect(room.participants.map((p) => [p.isHost, p.status, p.identityKeyHash])).toEqual([
          [true, 'ACTIVE', hash('c')],
          [false, 'ACTIVE', null],
        ]);
        expect(room.claimRequests[0]!.status).toBe('PENDING');
        expect(room.createdAt).toBeInstanceOf(Date);
      } finally {
        await prisma.onModuleDestroy();
      }
    });

    it('Prisma 경로도 DB 제약에 막힌다(두 번째 방장)', async () => {
      const prisma = new PrismaService({ DATABASE_URL: db.databaseUrl, DB_POOL_MAX: 2 });
      try {
        const roomId = await newRoom();
        await prisma.client.participant.create({
          data: { id: newId(), roomId, nickname: 'A', nicknameKey: 'a', order: 1, isHost: true },
        });
        const err = await prisma.client.participant
          .create({
            data: { id: newId(), roomId, nickname: 'B', nicknameKey: 'b', order: 2, isHost: true },
          })
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(sqlState(err) ?? (err as { code?: string }).code).toBeDefined();
      } finally {
        await prisma.onModuleDestroy();
      }
    });
  });
});

describe('ID·초대 코드 생성 (PD-14)', () => {
  it('128비트 이상 난수의 base64url 22자이며 패딩이 없다', () => {
    for (const make of [newId, newInviteCode]) {
      const v = make();
      expect(v).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(Buffer.from(v, 'base64url').length).toBe(16);
    }
  });

  it('충돌하지 않는다(5만 개 중복 없음)와 ID·초대 코드가 서로 다르다', () => {
    const ids = new Set(Array.from({ length: 50_000 }, () => newId()));
    expect(ids.size).toBe(50_000);
    expect(newId()).not.toBe(newInviteCode());
  });

  it('바이트 분포가 한쪽으로 치우치지 않는다(정적 이름·시각 기반이 아님)', () => {
    const counts = new Array<number>(64).fill(0);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (let i = 0; i < 4_000; i++)
      for (const ch of newId().slice(0, 21)) counts[alphabet.indexOf(ch)]!++;
    const total = 4_000 * 21;
    for (const c of counts) expect(Math.abs(c / total - 1 / 64)).toBeLessThan(0.006);
  });
});
