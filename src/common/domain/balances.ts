import type { DbTx } from '../db/database.service.js';

export interface BalanceRow {
  participantId: string;
  nickname: string;
  status: string;
  order: number;
  /** 수취 합 − 지급 합(유효 거래만), 64비트 정수 */
  balance: bigint;
}

/**
 * S3 §6.1·S4 §6.2 순손익의 단일 정의. 방의 모든 참여자(비활성·거래 없음 포함)를 `balance` 내림차순,
 * 동률은 `order` 오름차순으로 돌려준다. 순손익 조회와 정산 계산이 같은 SQL을 쓴다.
 */
export function queryBalances(tx: DbTx, roomId: string): Promise<BalanceRow[]> {
  return tx.$queryRaw<BalanceRow[]>`
    SELECT p."id" AS "participantId", p."nickname", p."status", p."order",
           COALESCE(SUM(CASE WHEN t."payeeId" = p."id" THEN t."amount" ELSE -t."amount" END), 0)::bigint AS "balance"
    FROM "Participant" p
    LEFT JOIN "Transaction" t
      ON t."roomId" = p."roomId" AND t."deletedAt" IS NULL AND (t."payeeId" = p."id" OR t."payerId" = p."id")
    WHERE p."roomId" = ${roomId}
    GROUP BY p."id", p."nickname", p."status", p."order"
    ORDER BY "balance" DESC, p."order" ASC`;
}

export function safeBalance(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('balance exceeds the safe integer range');
  return n;
}
