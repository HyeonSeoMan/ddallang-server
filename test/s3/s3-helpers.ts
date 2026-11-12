import type { IsolatedDb } from '../helpers/isolated-db.js';
import type { Setup } from '../s2/s2-helpers.js';

export * from '../s2/s2-helpers.js';

export interface SeedOptions {
  count: number;
  payer: string;
  payee: string;
  /** 거래마다 1ms씩 늘어나는 createdAt의 시작 시각(기본 지금 - 1시간) */
  startMs?: number;
  /** 모든 행의 createdAt을 같게 한다(seq로 순서가 결정되는지 확인) */
  sameCreatedAt?: boolean;
  amount?: number;
  /** n번째(1부터) 행을 삭제 표시한다 */
  deleteIf?: (n: number) => boolean;
}

/**
 * 거래를 DB에 직접 채운다(API로 수백 건을 만들지 않으려는 시험 도우미). 방의 nextTxnSeq 이후 번호를 쓰고
 * 카운터와 마지막 생성 시각을 맞춘다. 반환값은 삽입한 ID(seq 순서).
 */
export async function seedTransactions(
  db: IsolatedDb,
  s: Setup,
  o: SeedOptions,
): Promise<string[]> {
  const [room] = await db.query<{ nextTxnSeq: number }>(
    `SELECT "nextTxnSeq" FROM "Room" WHERE "id"=$1`,
    [s.c.roomId],
  );
  const first = room!.nextTxnSeq;
  const start = o.startMs ?? Date.now() - 3_600_000;
  const ids: string[] = [];
  const values: string[] = [];
  const params: unknown[] = [s.c.roomId, o.payer, o.payee, s.c.hostId];
  for (let n = 1; n <= o.count; n++) {
    // 서버의 거래 ID 형식(22자 base64url)에 맞춘다(라우트 레지스트리가 형식이 다른 ID를 404로 판정한다)
    const id = `seed${s.c.roomId.slice(0, 6)}${String(first + n - 1).padStart(6, '0')}`.padEnd(
      22,
      'x',
    );
    ids.push(id);
    const createdAt = new Date(o.sameCreatedAt ? start : start + n).toISOString();
    const deleted = o.deleteIf?.(n) ?? false;
    params.push(id, first + n - 1, o.amount ?? 100, createdAt);
    const i = params.length - 3;
    values.push(
      `($${i}, $1, $${i + 1}, $2, $3, $${i + 2}, $4, $${i + 2}, $${i + 3}::timestamptz, $${i + 3}::timestamptz${deleted ? ', clock_timestamp(), $4' : ', NULL, NULL'})`,
    );
  }
  await db.query(
    `INSERT INTO "Transaction" ("id","roomId","seq","payerId","payeeId","amount","authorId","originalAmount","createdAt","updatedAt","deletedAt","deletedById") VALUES ${values.join(',')}`,
    params,
  );
  await db.query(
    `UPDATE "Room" SET "nextTxnSeq" = $2, "lastTxnCreatedAt" = (SELECT max("createdAt") FROM "Transaction" WHERE "roomId"=$1) WHERE "id"=$1`,
    [s.c.roomId, first + o.count],
  );
  return ids;
}
