import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { hashIdentityKey } from '../../src/common/auth/identity-key.js';
import { newId } from '../../src/common/ids/ids.js';
import { bootTestApp, type TestApp } from '../helpers/app.js';
import { createIsolatedDb, type IsolatedDb } from '../helpers/isolated-db.js';

export const newKey = () => randomBytes(32).toString('base64url');
export const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

export interface S1Env {
  db: IsolatedDb;
  app: TestApp;
  http: ReturnType<typeof request>;
  close(): Promise<void>;
}

/** 실제 PostgreSQL(마이그레이션 적용, 시험 스키마)에 붙은 전체 앱. */
export async function bootS1(): Promise<S1Env> {
  const db = await createIsolatedDb({ migrations: true });
  const app = await bootTestApp({ DATABASE_URL: db.databaseUrl });
  return {
    db,
    app,
    http: app.http,
    async close() {
      await app.close();
      await db.drop();
    },
  };
}

type Http = ReturnType<typeof request>;

export interface Created {
  key: string;
  roomId: string;
  inviteCode: string;
  hostId: string;
}

export async function createRoom(
  http: Http,
  o: { key?: string; name?: string; unit?: string; nickname?: string } = {},
): Promise<Created> {
  const key = o.key ?? newKey();
  const res = await http
    .post('/rooms')
    .set(auth(key))
    .send({ name: o.name ?? 'Friday 7', unit: o.unit ?? '원', nickname: o.nickname ?? 'Host' });
  if (res.status !== 201) throw new Error(`방 생성 실패 ${res.status} ${JSON.stringify(res.body)}`);
  return {
    key,
    roomId: res.body.room.id,
    inviteCode: res.body.room.inviteCode,
    hostId: res.body.me.id,
  };
}

export async function join(http: Http, inviteCode: string, nickname: string, key = newKey()) {
  const res = await http.post(`/invites/${inviteCode}/members`).set(auth(key)).send({ nickname });
  return { key, res };
}

export async function addParticipant(http: Http, c: Created, nickname: string) {
  return http.post(`/rooms/${c.roomId}/participants`).set(auth(c.key)).send({ nickname });
}

export async function endRoom(db: IsolatedDb, roomId: string) {
  await db.query(`UPDATE "Room" SET "status"='ENDED' WHERE "id"=$1`, [roomId]);
}

export async function count(
  db: IsolatedDb,
  table: 'Room' | 'Participant' | 'ClaimRequest' | 'RevokedIdentity',
  roomId?: string,
) {
  const where = roomId
    ? table === 'Room'
      ? `WHERE "id"='${roomId}'`
      : `WHERE "roomId"='${roomId}'`
    : '';
  return Number(
    (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}" ${where}`))[0]!.n,
  );
}

export async function revision(db: IsolatedDb, roomId: string) {
  return (
    await db.query<{ revision: number }>(`SELECT "revision" FROM "Room" WHERE "id"=$1`, [roomId])
  )[0]!.revision;
}

/**
 * 시험 픽스처: 이어받기 API(BE-M4)를 거치지 않고 신원 상태를 만든다. 대기(PENDING) 요청 하나.
 * 정상 경로로 만들 수 없는 경합 상태(AC-ROOM-009-14)의 재현에도 쓴다.
 */
export async function pendingClaimFixture(
  db: IsolatedDb,
  roomId: string,
  participantId: string,
  key: string,
): Promise<string> {
  const id = newId();
  await db.query(
    `INSERT INTO "ClaimRequest" ("id","roomId","participantId","requesterKeyHash") VALUES ($1,$2,$3,$4)`,
    [id, roomId, participantId, hashIdentityKey(key)],
  );
  return id;
}

/** 시험 픽스처: 이 키를 접근 상실(REVOKED)로 기록한다. */
export async function revokeFixture(
  db: IsolatedDb,
  roomId: string,
  participantId: string,
  key: string,
): Promise<void> {
  await db.query(
    `INSERT INTO "RevokedIdentity" ("roomId","keyHash","participantId") VALUES ($1,$2,$3)`,
    [roomId, hashIdentityKey(key), participantId],
  );
}
