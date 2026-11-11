import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Env } from '../config/env.js';
import { PrismaService } from './prisma.service.js';

export type DbTx = Prisma.TransactionClient;

export type DbTimeouts = Pick<
  Env,
  'DB_LOCK_TIMEOUT_MS' | 'DB_STATEMENT_TIMEOUT_MS' | 'REQUEST_TIMEOUT_MS'
>;

/** S5 §4.2 이벤트 종류와 식별자. 내용(금액·사유·닉네임 등)은 싣지 않는다(R-I3). */
export type RoomEvent =
  | {
      event: 'transaction.created' | 'transaction.updated' | 'transaction.deleted';
      transactionId: string;
    }
  | { event: 'participant.created' | 'participant.status_changed'; participantId: string }
  | { event: 'room.ended' };

/** 변경 콜백의 결과. `event`가 있을 때만(변경이 실제로 있을 때만) `revision`을 소비하고 통지한다. */
export interface MutationOutcome<T> {
  value: T;
  event?: RoomEvent;
}

/** PD-5: 모든 방 변경 통지가 오가는 PostgreSQL 채널. */
export const ROOM_EVENTS_CHANNEL = 'room_events';

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
    return this.transaction(undefined, async (tx, remaining) => {
      await this.applyTimeouts(tx, remaining);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Room" WHERE "id" = ${roomId} FOR UPDATE`;
      if (rows.length === 0) throw new RoomNotFoundError(roomId);
      return fn(tx);
    });
  }

  /**
   * 변경 트랜잭션 파이프라인(PD-3~PD-5, S5 §6.1): 방 잠금 → 호출자 변경 → **변경이 실제로 있을 때만**
   * `Room.revision` + 1 → 같은 트랜잭션에서 `pg_notify` → 커밋. PostgreSQL은 통지를 커밋될 때만 전달하므로
   * 커밋 전에 나가거나 롤백된 변경의 이벤트가 나가는 일이 없다. 거부(콜백이 던짐)·멱등 재전송·값이 같은
   * 변경(`event` 없음)은 `revision`을 소비하지 않고 통지하지 않는다. 통지에는 식별자와 종류만 싣는다.
   * 반환의 `revision`은 소비했을 때만 값이 있다.
   */
  async withRoomMutation<T>(
    roomId: string,
    fn: (tx: DbTx) => Promise<MutationOutcome<T>>,
  ): Promise<{ value: T; revision: number | null }> {
    return this.withRoomLock(roomId, async (tx) => {
      const { value, event } = await fn(tx);
      if (!event) return { value, revision: null };
      const rows = await tx.$queryRaw<{ revision: number }[]>`
        UPDATE "Room" SET "revision" = "revision" + 1 WHERE "id" = ${roomId} RETURNING "revision"`;
      const revision = rows[0]!.revision;
      const serverTime = (await this.dbNow(tx)).toISOString();
      const payload = JSON.stringify({ ...event, roomId, revision, serverTime });
      await tx.$executeRaw`SELECT pg_notify(${ROOM_EVENTS_CHANNEL}, ${payload})`;
      return { value, revision };
    });
  }

  /** 방 잠금 없이 한 시점의 일관된 읽기(REPEATABLE READ, READ ONLY). 쓰기를 막지 않는다. */
  async readSnapshot<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.transaction('RepeatableRead', async (tx, remaining) => {
      // 첫 문장이어야 한다.
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await this.applyTimeouts(tx, remaining);
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
   * - 호출자: 마감 전까지 결과를 받는다. 마감이 지나면 `RequestTimeoutError`로 거부된다. 단 콜백이 마감 안에
   *   끝나 커밋이 진행 중이면 거부하지 않고 커밋 결과를 기다린다(시간 초과로 보고했는데 커밋되는 불일치를 막는다).
   * - 트랜잭션: 콜백 안에서 남은 시간으로 마감을 걸어 같은 시각에 콜백을 거부시키면 Prisma가 롤백을 요청한다.
   *   마감 뒤에 도착한 문장은 닫힌 트랜잭션에서 실패한다. 트랜잭션이 마감 뒤에야 시작되거나 콜백이 마감 뒤에
   *   끝나면 커밋하지 않고 던진다. 롤백 요청은 진행 중인 문장 뒤에 줄을 서므로 잠금 해제는 그 문장이 끝날
   *   때까지(최대 남은 시간으로 줄인 `statement_timeout`) 늦어질 수 있다.
   * - 콜백 `fn` 자체는 취소되지 않고 계속 실행될 수 있다(부수 효과는 트랜잭션 안에서만 만든다).
   */
  private async transaction<T>(
    isolationLevel: 'RepeatableRead' | undefined,
    fn: (tx: DbTx, remainingMs: number) => Promise<T>,
  ): Promise<T> {
    const limit = this.timeouts.REQUEST_TIMEOUT_MS;
    const deadlineAt = Date.now() + limit;
    let state: 'running' | 'committing' | 'expired' = 'running';
    const expired = (): boolean => state === 'expired'; // 클로저에서 바뀌므로 함수로 읽는다
    let callerTimer: NodeJS.Timeout | undefined;
    const callerDeadline = new Promise<never>((_, reject) => {
      callerTimer = setTimeout(() => {
        if (state === 'committing') return; // 커밋 결과를 기다린다
        state = 'expired';
        reject(new RequestTimeoutError(limit));
      }, limit);
    });
    const run = this.prisma.client.$transaction(
      async (tx) => {
        const remaining = deadlineAt - Date.now();
        if (expired() || remaining <= 0) throw new RequestTimeoutError(limit);
        let txTimer: NodeJS.Timeout | undefined;
        const txDeadline = new Promise<never>((_, reject) => {
          txTimer = setTimeout(() => reject(new RequestTimeoutError(limit)), remaining);
        });
        try {
          const value = await Promise.race([fn(tx, remaining), txDeadline]);
          // 마감을 넘겨 끝난 콜백은 커밋하지 않는다. 마감 안에 끝났으면 커밋 결과까지 호출자가 기다린다.
          if (expired() || Date.now() >= deadlineAt) throw new RequestTimeoutError(limit);
          state = 'committing';
          return value;
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

  /** 잠금·문장 제한은 설정값과 남은 시간 중 작은 값이다(마감 뒤로 문장이 길게 이어지지 않게 한다). */
  private async applyTimeouts(tx: DbTx, remainingMs: number): Promise<void> {
    const { DB_LOCK_TIMEOUT_MS: lock, DB_STATEMENT_TIMEOUT_MS: stmt } = this.timeouts;
    const cap = Math.max(1, Math.floor(remainingMs));
    await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${Math.min(lock, cap)}ms`}, true),
                              set_config('statement_timeout', ${`${Math.min(stmt, cap)}ms`}, true)`;
  }
}
