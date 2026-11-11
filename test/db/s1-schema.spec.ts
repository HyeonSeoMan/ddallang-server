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

async function newMember(roomId: string, o: Record<string, unknown> = {}) {
  const id = (o.id as string) ?? newId();
  await db.query(
    `INSERT INTO "RoomMember" ("id","roomId","nickname","nicknameKey","isHost","identityKeyHash") VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      id,
      roomId,
      o.nickname ?? 'Han',
      o.nicknameKey ?? 'han',
      o.isHost ?? false,
      o.hash ?? hash('b'),
    ],
  );
  return id;
}

async function newParticipant(roomId: string, o: Record<string, unknown> = {}) {
  const id = (o.id as string) ?? newId();
  await db.query(
    `INSERT INTO "Participant" ("id","roomId","nickname","nicknameKey","status","order") VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, roomId, o.nickname ?? 'Han', o.nicknameKey ?? 'han', o.status ?? 'ACTIVE', o.order ?? 1],
  );
  return id;
}

describe('S1 데이터 모델 제약 (BE-S1-1)', () => {
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

  describe('RoomMember', () => {
    it('같은 방에서 같은 신원 키 해시는 한 번만(같은 키는 같은 RoomMember)', async () => {
      const room = await newRoom();
      await newMember(room, { nicknameKey: 'a', hash: HASH });
      expect(
        await reject(
          `INSERT INTO "RoomMember" ("id","roomId","nickname","nicknameKey","isHost","identityKeyHash") VALUES ($1,$2,'B','b',false,$3)`,
          [newId(), room, HASH],
        ),
      ).toBe('23505');
    });

    it('다른 방에서는 같은 신원 키 해시가 별개의 신원이다(방 단위 권한, AC-SYS-003-6·7의 저장 근거)', async () => {
      const a = await newRoom();
      const b = await newRoom();
      await newMember(a, { hash: HASH });
      await newMember(b, { hash: HASH });
    });

    it('같은 방에서 닉네임 비교 키는 유일하고 다른 방에서는 같아도 된다', async () => {
      const a = await newRoom();
      const b = await newRoom();
      await newMember(a, { nickname: 'Han', nicknameKey: 'han', hash: hash('1') });
      expect(
        await reject(
          `INSERT INTO "RoomMember" ("id","roomId","nickname","nicknameKey","isHost","identityKeyHash") VALUES ($1,$2,'HAN','han',false,$3)`,
          [newId(), a, hash('2')],
        ),
      ).toBe('23505');
      await newMember(b, { nickname: 'Han', nicknameKey: 'han', hash: hash('3') });
    });

    it('방마다 방장은 최대 한 명이다(두 번째 방장 거부, 일반 멤버는 여럿)', async () => {
      const room = await newRoom();
      await newMember(room, {
        isHost: true,
        nicknameKey: 'host',
        nickname: 'Host',
        hash: hash('1'),
      });
      expect(
        await reject(
          `INSERT INTO "RoomMember" ("id","roomId","nickname","nicknameKey","isHost","identityKeyHash") VALUES ($1,$2,'H2','h2',true,$3)`,
          [newId(), room, hash('2')],
        ),
      ).toBe('23505');
      await newMember(room, { nicknameKey: 'm1', nickname: 'M1', hash: hash('3') });
      await newMember(room, { nicknameKey: 'm2', nickname: 'M2', hash: hash('4') });
      const other = await newRoom();
      await newMember(other, {
        isHost: true,
        nicknameKey: 'host',
        nickname: 'Host',
        hash: hash('5'),
      });
    });

    it('방장 표시를 다른 멤버로 옮기려는 갱신도 부분 유일 인덱스가 막는다', async () => {
      const room = await newRoom();
      await newMember(room, { isHost: true, nicknameKey: 'h', nickname: 'H', hash: hash('1') });
      const m = await newMember(room, { nicknameKey: 'm', nickname: 'M', hash: hash('2') });
      expect(await reject(`UPDATE "RoomMember" SET "isHost"=true WHERE "id"=$1`, [m])).toBe(
        '23505',
      );
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
            `INSERT INTO "RoomMember" ("id","roomId","nickname","nicknameKey","isHost","identityKeyHash") VALUES ($1,$2,'a','a',false,$3)`,
            [newId(), room, bad],
          ),
          bad,
        ).toBe('23514');
      }
    });

    it('없는 방을 가리킬 수 없다', async () => {
      expect(
        await reject(
          `INSERT INTO "RoomMember" ("id","roomId","nickname","nicknameKey","isHost","identityKeyHash") VALUES ($1,'nope','a','a',false,$2)`,
          [newId(), HASH],
        ),
      ).toBe('23503');
    });

    it('닉네임 길이는 1~12다', async () => {
      const room = await newRoom();
      expect(
        await reject(
          `INSERT INTO "RoomMember" ("id","roomId","nickname","nicknameKey","isHost","identityKeyHash") VALUES ($1,$2,'','',false,$3)`,
          [newId(), room, hash('1')],
        ),
      ).toBe('23514');
      expect(
        await reject(
          `INSERT INTO "RoomMember" ("id","roomId","nickname","nicknameKey","isHost","identityKeyHash") VALUES ($1,$2,$3,'a',false,$4)`,
          [newId(), room, 'a'.repeat(13), hash('2')],
        ),
      ).toBe('23514');
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

    it('RoomMember와 Participant의 닉네임은 유형이 달라 서로 겹쳐도 된다(S1 §2.2 I3)', async () => {
      const room = await newRoom();
      await newMember(room, { nickname: 'Han', nicknameKey: 'han', hash: hash('1') });
      await newParticipant(room, { nickname: 'Han', nicknameKey: 'han', order: 1 });
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
    it('RoomMember와 Participant를 잇는 열·외래 키가 없다(S1 §2.2 I2)', async () => {
      const cols = await db.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name IN ('RoomMember','Participant') ORDER BY 1,2`,
        [db.schema],
      );
      const by = (t: string) =>
        cols
          .filter((c) => c.table_name === t)
          .map((c) => c.column_name)
          .sort();
      expect(by('RoomMember')).toEqual(
        [
          'createdAt',
          'id',
          'identityKeyHash',
          'isHost',
          'nickname',
          'nicknameKey',
          'roomId',
        ].sort(),
      );
      expect(by('Participant')).toEqual(
        ['createdAt', 'id', 'nickname', 'nicknameKey', 'order', 'roomId', 'status'].sort(),
      );
      const fks = await db.query<{ child: string; parent: string }>(
        `SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE k.contype='f' AND n.nspname=$1 ORDER BY 1,2`,
        [db.schema],
      );
      expect(fks).toEqual([
        { child: 'Participant', parent: 'Room' },
        { child: 'RoomMember', parent: 'Room' },
      ]);
    });

    it('방을 삭제하는 경로는 없다: 자식이 있으면 삭제가 거부된다(RESTRICT)', async () => {
      const room = await newRoom();
      await newMember(room, { isHost: true, hash: hash('9') });
      expect(await reject(`DELETE FROM "Room" WHERE "id"=$1`, [room])).toBe('23503');
    });
  });

  describe('Prisma 클라이언트와 SQL이 같은 구조를 본다', () => {
    it('생성된 모델로 방·방장·참여자를 만들고 읽는다', async () => {
      const prisma = new PrismaService({ DATABASE_URL: db.databaseUrl, DB_POOL_MAX: 2 });
      try {
        const roomId = newId();
        await prisma.client.room.create({
          data: {
            id: roomId,
            name: 'Prisma',
            unit: '원',
            inviteCode: newInviteCode(),
            members: {
              create: {
                id: newId(),
                nickname: 'Host',
                nicknameKey: 'host',
                isHost: true,
                identityKeyHash: hash('c'),
              },
            },
            participants: {
              create: [{ id: newId(), nickname: 'P1', nicknameKey: 'p1', order: 1 }],
            },
          },
        });
        const room = await prisma.client.room.findUniqueOrThrow({
          where: { id: roomId },
          include: { members: true, participants: true },
        });
        expect(room.status).toBe('IN_PROGRESS');
        expect(room.members).toHaveLength(1);
        expect(room.members[0]!.isHost).toBe(true);
        expect(room.participants[0]!.status).toBe('ACTIVE');
        expect(room.createdAt).toBeInstanceOf(Date);
      } finally {
        await prisma.onModuleDestroy();
      }
    });

    it('Prisma 경로도 DB 제약에 막힌다(두 번째 방장)', async () => {
      const prisma = new PrismaService({ DATABASE_URL: db.databaseUrl, DB_POOL_MAX: 2 });
      try {
        const roomId = await newRoom();
        await prisma.client.roomMember.create({
          data: {
            id: newId(),
            roomId,
            nickname: 'A',
            nicknameKey: 'a',
            isHost: true,
            identityKeyHash: hash('d'),
          },
        });
        const err = await prisma.client.roomMember
          .create({
            data: {
              id: newId(),
              roomId,
              nickname: 'B',
              nicknameKey: 'b',
              isHost: true,
              identityKeyHash: hash('e'),
            },
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
