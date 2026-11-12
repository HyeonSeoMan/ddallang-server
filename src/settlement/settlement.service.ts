import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../common/db/database.service.js';
import { ApiError, errorBody } from '../common/errors/api-error.js';
import { isPlainObject } from '../common/http/fields.js';
import { requireJsonBody, type BodyInput } from '../common/http/json-body.js';
import { fingerprint } from '../idempotency/fingerprint.js';
import { parseIdempotencyHeaders } from '../idempotency/headers.js';
import { IdempotencyService, type StoredResponse } from '../idempotency/idempotency.service.js';
import { computeSettlement } from './settlement-algorithm.js';

export interface Reply extends StoredResponse {
  replayed: boolean;
}

export interface Requester {
  memberId: string;
  roomId: string;
  isHost: boolean;
}

export interface SettlementItemDto {
  payerId: string;
  payerNickname: string;
  payeeId: string;
  payeeNickname: string;
  amount: number;
}

export interface SettlementDto {
  kind: 'EXPECTED' | 'FINAL';
  items: SettlementItemDto[];
}

type QueryValue = string | string[] | undefined | Record<string, unknown>;

const EXPIRED_MESSAGE = '요청 유효 기간이 지났습니다. 방의 현재 상태를 확인해 주세요.';

@Injectable()
export class SettlementService {
  constructor(
    private readonly db: DatabaseService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * S4 §3.3·§6.1 게임 종료. 1·2(인증·멤버)는 가드, 3(헤더) → 방 잠금 → 4(만료)·5(재전송) → 6(방장) →
   * 7(`GAME_ENDED`, 기록) → 8(본문) → 상태 변경·`revision`+1·멱등 기록·`room.ended`를 한 트랜잭션으로 처리한다.
   */
  async end(
    requester: Requester,
    headers: Record<string, string | string[] | undefined>,
    input: BodyInput,
  ): Promise<Reply> {
    const { key, firstAttemptAt } = parseIdempotencyHeaders(headers, new Date()); // 3번
    // 본문이 없는 것과 `{}`는 같은 내용이다
    const print = fingerprint({
      operation: 'END',
      body: input.body === undefined ? {} : input.body,
      parseFailed: input.parseFailed,
    });

    const { value } = await this.db.withRoomMutation<Reply>(requester.roomId, async (tx) => {
      const now = await this.db.dbNow(tx);
      const base = {
        roomId: requester.roomId,
        memberId: requester.memberId,
        key,
        firstAttemptAt,
        fingerprint: print,
      };
      const stored = await this.idempotency.lookup(tx, {
        ...base,
        now,
        expiredMessage: EXPIRED_MESSAGE,
      }); // 4·5번
      if (stored) return { value: { ...stored, replayed: true } };

      if (!requester.isHost) throw new ApiError('HOST_ONLY'); // 6번(기록하지 않는다)

      const room = await tx.room.findUniqueOrThrow({
        where: { id: requester.roomId },
        select: { status: true },
      });
      if (room.status === 'ENDED') {
        const options = { message: '이미 종료된 게임입니다' };
        const response = {
          status: new ApiError('GAME_ENDED', options).status,
          body: errorBody('GAME_ENDED', options),
        };
        await this.idempotency.record(tx, { ...base, operation: 'END', response }); // 7번(기록)
        return { value: { ...response, replayed: false } };
      }

      this.validateBody(input); // 8번(기록하지 않는다)

      await tx.room.update({ where: { id: requester.roomId }, data: { status: 'ENDED' } });
      const response = { status: 200, body: { roomId: requester.roomId, status: 'ENDED' } };
      await this.idempotency.record(tx, { ...base, operation: 'END', response });
      return {
        value: { ...response, replayed: false },
        event: { event: 'room.ended' },
      };
    });
    return value;
  }

  private validateBody(input: BodyInput): void {
    const raw = requireJsonBody(input);
    if (raw === undefined) return;
    if (!isPlainObject(raw)) {
      throw new ApiError('VALIDATION_FAILED', {
        details: [{ field: 'body', code: 'INVALID_TYPE' }],
      });
    }
    const names = Object.keys(raw);
    if (names.length > 0) {
      throw new ApiError('VALIDATION_FAILED', {
        details: names.map((field) => ({ field, code: 'NOT_ALLOWED_FIELD' })),
      });
    }
  }

  /**
   * S4 §4.2·§6.2~6.4: 한 스냅샷에서 방 상태, 참여자(비활성 포함), 유효 거래의 순손익을 읽어 계산한다.
   * 방 상태가 `ENDED`이면 `FINAL`, 아니면 `EXPECTED`다. 정산은 저장하지 않으며 쿼리 매개변수를 받지 않는다.
   */
  async settlement(roomId: string, query: Record<string, QueryValue>): Promise<SettlementDto> {
    const names = Object.keys(query);
    if (names.length > 0) {
      throw new ApiError('VALIDATION_FAILED', {
        details: names.map((field) => ({ field, code: 'NOT_ALLOWED_FIELD' })),
      });
    }
    const { status, rows } = await this.db.readSnapshot(async (tx) => {
      const room = await tx.room.findUniqueOrThrow({
        where: { id: roomId },
        select: { status: true },
      });
      const rows = await tx.$queryRaw<
        { participantId: string; nickname: string; order: number; balance: bigint }[]
      >`
        SELECT p."id" AS "participantId", p."nickname", p."order",
               COALESCE(SUM(CASE WHEN t."payeeId" = p."id" THEN t."amount" ELSE -t."amount" END), 0)::bigint AS "balance"
        FROM "Participant" p
        LEFT JOIN "Transaction" t
          ON t."roomId" = p."roomId" AND t."deletedAt" IS NULL AND (t."payeeId" = p."id" OR t."payerId" = p."id")
        WHERE p."roomId" = ${roomId}
        GROUP BY p."id", p."nickname", p."order"`;
      return { status: room.status, rows };
    });
    const people = rows.map((r) => {
      const balance = Number(r.balance);
      if (!Number.isSafeInteger(balance)) throw new Error('balance exceeds the safe integer range');
      return { participantId: r.participantId, nickname: r.nickname, order: r.order, balance };
    });
    const nick = new Map(people.map((p) => [p.participantId, p.nickname]));
    return {
      kind: status === 'ENDED' ? 'FINAL' : 'EXPECTED',
      items: computeSettlement(people).map((i) => ({
        payerId: i.payerId,
        payerNickname: nick.get(i.payerId)!,
        payeeId: i.payeeId,
        payeeNickname: nick.get(i.payeeId)!,
        amount: i.amount,
      })),
    };
  }
}
