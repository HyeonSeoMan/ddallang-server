import { randomBytes } from 'node:crypto';
import type request from 'supertest';
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
  table: 'Room' | 'RoomMember' | 'Participant',
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
