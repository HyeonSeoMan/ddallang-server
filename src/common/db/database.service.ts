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

  private transaction<T>(
    isolationLevel: 'RepeatableRead' | undefined,
    fn: (tx: DbTx) => Promise<T>,
  ): Promise<T> {
    return this.prisma.client.$transaction(fn, {
      // 풀 연결을 기다리는 시간은 잠금 대기와 같은 한도로 묶는다.
      maxWait: this.timeouts.DB_LOCK_TIMEOUT_MS,
      timeout: this.timeouts.REQUEST_TIMEOUT_MS,
      ...(isolationLevel ? { isolationLevel } : {}),
    });
  }

  private async applyTimeouts(tx: DbTx): Promise<void> {
    const { DB_LOCK_TIMEOUT_MS: lock, DB_STATEMENT_TIMEOUT_MS: stmt } = this.timeouts;
    await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${lock}ms`}, true),
                              set_config('statement_timeout', ${`${stmt}ms`}, true)`;
  }
}
