import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Env } from '../config/env.js';
import { PrismaService } from './prisma.service.js';

export type DbTx = Prisma.TransactionClient;

export type DbTimeouts = Pick<
  Env,
  'DB_LOCK_TIMEOUT_MS' | 'DB_STATEMENT_TIMEOUT_MS' | 'REQUEST_TIMEOUT_MS'
>;

/** 잠글 방이 없다. 호출자가 404 등으로 옮긴다(S1 §3.3). */
export class RoomNotFoundError extends Error {
  constructor(readonly roomId: string) {
    super('room not found');
    this.name = 'RoomNotFoundError';
  }
}

/**
 * 호출 시점부터 `REQUEST_TIMEOUT_MS` 안에 트랜잭션이 끝나지 않았다(풀 연결 대기 포함). 호출자는 콜백이
 * 끝나기를 기다리지 않고 이 마감에 거부되고, 트랜잭션은 같은 마감에 롤백되어 방 잠금이 풀린다. 콜백
 * 자체는 취소되지 않고 계속 실행될 수 있으나 이후 쿼리는 실패한다(부수 효과는 트랜잭션 안에서만 만든다).
 */
export class RequestTimeoutError extends Error {
  constructor(readonly limitMs: number) {
    super(`transaction exceeded ${limitMs}ms`);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * DB 접근의 공통 진입점. 방 단위 직렬화(PD-3), 읽기 전용 스냅샷(PD-11), DB 시각(PD-4)을 제공한다.
 * 제한 시간은 `SET LOCAL`로 트랜잭션 안에서만 적용한다(장기 연결에 영향을 주지 않는다).
 */
@Injectable()
export class DatabaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeouts: DbTimeouts,
  ) {}

  /**
   * 방 행에 `FOR UPDATE` 잠금을 **하나만** 잡고 커밋(또는 롤백)까지 유지한다. 다른 방은 막지 않는다.
   * `fn`이 던지면 롤백되고 잠금이 풀린다.
   */
  async withRoomLock<T>(roomId: string, fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.transaction(undefined, async (tx) => {
      await this.applyTimeouts(tx);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Room" WHERE "id" = ${roomId} FOR UPDATE`;
      if (rows.length === 0) throw new RoomNotFoundError(roomId);
      return fn(tx);
    });
  }

  /** 방 잠금 없이 한 시점의 일관된 읽기(REPEATABLE READ, READ ONLY). 쓰기를 막지 않는다. */
  async readSnapshot<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.transaction('RepeatableRead', async (tx) => {
      // 첫 문장이어야 한다.
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await this.applyTimeouts(tx);
      return fn(tx);
    });
  }

  /**
   * 모든 시각 판정의 기준(PD-4). `now()`는 트랜잭션 시작 시각이라 잠금 대기 뒤의 값으로 쓰지 않는다.
   */
  async dbNow(tx: DbTx): Promise<Date> {
    const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS "now"`;
    return rows[0]!.now;
  }

  /**
   * 한도는 호출 시점부터의 **절대 마감**이다. 풀 연결을 기다린 시간(`maxWait`)도 한도에 포함된다.
   * - 호출자: 마감에 `RequestTimeoutError`로 거부된다(콜백이 끝나기를 기다리지 않는다).
   * - 트랜잭션: 콜백 안에서 남은 시간으로 마감을 걸어 같은 시각에 콜백을 거부시키므로 Prisma가 그 즉시
   *   롤백하고 방 잠금이 풀린다. 마감 뒤에 도착한 문장은 닫힌 트랜잭션에서 실패해 커밋되지 않는다.
   *   트랜잭션이 마감 뒤에야 시작되면 `fn`을 실행하지 않고 던진다.
   * - 콜백 `fn` 자체는 취소되지 않고 계속 실행될 수 있다(부수 효과는 트랜잭션 안에서만 만든다).
   */
  private async transaction<T>(
    isolationLevel: 'RepeatableRead' | undefined,
    fn: (tx: DbTx) => Promise<T>,
  ): Promise<T> {
    const limit = this.timeouts.REQUEST_TIMEOUT_MS;
    const deadlineAt = Date.now() + limit;
    let callerTimer: NodeJS.Timeout | undefined;
    const callerDeadline = new Promise<never>((_, reject) => {
      callerTimer = setTimeout(() => reject(new RequestTimeoutError(limit)), limit);
    });
    const run = this.prisma.client.$transaction(
      async (tx) => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new RequestTimeoutError(limit);
        let txTimer: NodeJS.Timeout | undefined;
        const txDeadline = new Promise<never>((_, reject) => {
          txTimer = setTimeout(() => reject(new RequestTimeoutError(limit)), remaining);
        });
        try {
          return await Promise.race([fn(tx), txDeadline]);
        } finally {
          clearTimeout(txTimer);
        }
      },
      {
        // 풀 연결을 기다리는 시간은 잠금 대기와 같은 한도로 묶는다.
        maxWait: this.timeouts.DB_LOCK_TIMEOUT_MS,
        // 위 절대 마감이 먼저 롤백한다. Prisma 자체 제한은 만일을 위한 상한이다.
        timeout: limit,
        ...(isolationLevel ? { isolationLevel } : {}),
      },
    );
    run.catch(() => undefined); // 호출자 마감에 진 뒤 늦게 거부되는 결과는 처리된 것으로 본다.
    try {
      return await Promise.race([run, callerDeadline]);
    } finally {
      clearTimeout(callerTimer);
    }
  }

  private async applyTimeouts(tx: DbTx): Promise<void> {
    const { DB_LOCK_TIMEOUT_MS: lock, DB_STATEMENT_TIMEOUT_MS: stmt } = this.timeouts;
    await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${lock}ms`}, true),
                              set_config('statement_timeout', ${`${stmt}ms`}, true)`;
  }
}
