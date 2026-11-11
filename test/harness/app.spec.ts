import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/common/db/database.service.js';
import { bootTestApp, type TestApp } from '../helpers/app.js';
import { createIsolatedDb, TEST_ROOM_DDL, type IsolatedDb } from '../helpers/isolated-db.js';

let db: IsolatedDb;
let t: TestApp;
beforeAll(async () => {
  db = await createIsolatedDb();
  await db.fixtures(TEST_ROOM_DDL);
  await db.fixtures(`INSERT INTO "Room" ("id") VALUES ('r1')`);
  t = await bootTestApp({ DATABASE_URL: db.databaseUrl });
});
afterAll(async () => {
  await t?.close();
  await db?.drop();
});

describe('요청 도우미 (BE-F8)', () => {
  it('운영과 같은 createApp 경로로 /health에 응답한다', async () => {
    const res = await t.http.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('앱의 DB 접근이 시험 스키마로 향한다', async () => {
    const out = await t.app
      .get(DatabaseService)
      .withRoomLock(
        'r1',
        async (tx) => tx.$queryRaw<{ s: string }[]>`SELECT current_schema() AS s`,
      );
    expect(out[0]).toEqual({ s: db.schema });
  });
});
