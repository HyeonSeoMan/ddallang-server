import { Injectable } from '@nestjs/common';
import { DatabaseService, type DbTx, type RoomEvent } from '../common/db/database.service.js';
import { toTransactionDto } from '../common/domain/dto.js';
import { TRANSACTION_LIMIT } from '../common/domain/limits.js';
import { ApiError, errorBody, type ApiErrorOptions } from '../common/errors/api-error.js';
import type { ErrorCode } from '../common/errors/error-codes.js';
import { isPlainObject, throwIfInvalid, type FieldDetail } from '../common/http/fields.js';
import { requireJsonBody, type BodyInput } from '../common/http/json-body.js';
import { newId } from '../common/ids/ids.js';
import {
  validateAmount,
  validateReason,
  validateRound,
  type ValidationReason,
} from '../common/validation/index.js';
import { fingerprint, type Operation } from '../idempotency/fingerprint.js';
import { parseIdempotencyHeaders } from '../idempotency/headers.js';
import { IdempotencyService, type StoredResponse } from '../idempotency/idempotency.service.js';

/** 컨트롤러가 그대로 응답으로 옮기는 결과. `replayed`이면 `Idempotent-Replayed: true`를 더한다. */
export interface Reply extends StoredResponse {
  replayed: boolean;
}

export interface Requester {
  memberId: string;
  roomId: string;
  isHost: boolean;
}

interface HandlerResult extends StoredResponse {
  event?: RoomEvent;
  /** false면 멱등 기록을 만들지 않는다(기록하는 것은 성공과 영구적 거부뿐, §5.2) */
  record?: boolean;
}

type Handler = (ctx: { tx: DbTx; now: Date }) => Promise<HandlerResult>;

/** 상태에 따른 영구적 거부: 오류 응답을 만들되 던지지 않고 기록해 같은 키 재전송이 같은 거부를 받게 한다. */
function permanentRejection(code: ErrorCode, options?: ApiErrorOptions): HandlerResult {
  const error = new ApiError(code, options);
  return { status: error.status, body: errorBody(code, options), record: true };
}

const ALLOWED_CREATE = new Set(['payerId', 'payeeId', 'amount', 'reason', 'round']);
const ALLOWED_UPDATE = new Set(['amount', 'reason', 'round']);

@Injectable()
export class TransactionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * 공통 파이프라인(S2 §3.4): 3(헤더) → 방 잠금 → 4(만료)·5(재전송) → 연산별 6~12 → 기록 → 커밋.
   * 1·2(인증·멤버)는 가드가 앞서 처리한다. 4~12는 모두 방 단위 잠금 안의 한 트랜잭션이다.
   */
  private async execute(args: {
    requester: Requester;
    operation: Operation;
    targetId?: string;
    headers: Record<string, string | string[] | undefined>;
    input: BodyInput;
    handler: Handler;
  }): Promise<Reply> {
    const { requester, operation, targetId, input } = args;
    const { key, firstAttemptAt } = parseIdempotencyHeaders(
      args.headers,
      await this.db.dbNowStandalone(),
    ); // 3번(수신 시각 = DB 시각)
    const print = fingerprint({
      operation,
      targetId,
      body: input.body,
      parseFailed: input.parseFailed,
    });

    const { value } = await this.db.withRoomMutation<Reply>(requester.roomId, async (tx) => {
      const now = await this.db.dbNow(tx); // 잠금을 얻은 시점의 DB 시각
      const base = {
        roomId: requester.roomId,
        memberId: requester.memberId,
        key,
        firstAttemptAt,
        fingerprint: print,
      };
      const stored = await this.idempotency.lookup(tx, { ...base, now }); // 4·5번
      if (stored) return { value: { ...stored, replayed: true } };

      const result = await args.handler({ tx, now });
      if (result.record !== false) {
        await this.idempotency.record(tx, {
          ...base,
          operation,
          response: { status: result.status, body: result.body },
        });
      }
      return {
        value: { status: result.status, body: result.body, replayed: false } satisfies Reply,
        event: result.event,
      };
    });
    return value;
  }

  /** S2 §4.1 거래 생성. */
  create(
    requester: Requester,
    headers: Record<string, string | string[] | undefined>,
    input: BodyInput,
  ): Promise<Reply> {
    return this.execute({
      requester,
      operation: 'CREATE',
      headers,
      input,
      handler: async ({ tx, now }) => {
        const room = await tx.room.findUniqueOrThrow({
          where: { id: requester.roomId },
          select: { status: true },
        });
        if (room.status === 'ENDED') return permanentRejection('GAME_ENDED'); // 8번

        const body = this.requireObject(input); // 10번
        const details: FieldDetail[] = [];
        const payerId = this.partyField(body, 'payerId', details);
        const payeeId = this.partyField(body, 'payeeId', details);
        const amount = this.amountField(body, details);
        const reason = this.optionalText(body, 'reason', details);
        const round = this.optionalText(body, 'round', details);
        for (const k of Object.keys(body))
          if (!ALLOWED_CREATE.has(k)) details.push({ field: k, code: 'NOT_ALLOWED_FIELD' });
        if (payerId !== undefined && payerId === payeeId)
          details.push({ field: 'payeeId', code: 'SAME_AS_PAYER' as ValidationReason });

        const ids = [...new Set([payerId, payeeId].filter((v): v is string => v !== undefined))];
        const found = ids.length
          ? await tx.participant.findMany({
              where: { roomId: requester.roomId, id: { in: ids } },
              select: { id: true, status: true },
            })
          : [];
        const byId = new Map(found.map((p) => [p.id, p.status]));
        for (const [field, id] of [
          ['payerId', payerId],
          ['payeeId', payeeId],
        ] as const) {
          if (id !== undefined && !byId.has(id))
            details.push({ field, code: 'PARTICIPANT_NOT_FOUND' as ValidationReason });
        }
        throwIfInvalid(details);

        const inactive = (['payerId', 'payeeId'] as const).filter(
          (f) => byId.get(f === 'payerId' ? payerId! : payeeId!) === 'INACTIVE',
        );
        if (inactive.length > 0) {
          throw new ApiError('PARTICIPANT_INACTIVE', {
            details: inactive.map((field) => ({ field })),
          }); // 11번(기록하지 않음)
        }
        const used = await tx.transaction.count({ where: { roomId: requester.roomId } }); // 삭제된 행 포함
        if (used >= TRANSACTION_LIMIT) {
          return permanentRejection('TRANSACTION_LIMIT_EXCEEDED', {
            details: [{ limit: TRANSACTION_LIMIT }],
          }); // 12번
        }

        // 순번과 생성 시각은 방 잠금 안에서 부여한다. createdAt은 비감소(시계가 거꾸로 가도 이전 값 이상)다.
        const [slot] = await tx.$queryRaw<{ seq: number; createdAt: Date }[]>`
          UPDATE "Room"
          SET "nextTxnSeq" = "nextTxnSeq" + 1,
              "lastTxnCreatedAt" = greatest(date_trunc('milliseconds', clock_timestamp()), coalesce("lastTxnCreatedAt", '-infinity'::timestamptz))
          WHERE "id" = ${requester.roomId}
          RETURNING "nextTxnSeq" - 1 AS "seq", "lastTxnCreatedAt" AS "createdAt"`;
        void now;
        const created = await tx.transaction.create({
          data: {
            id: newId(),
            roomId: requester.roomId,
            seq: slot!.seq,
            payerId: payerId!,
            payeeId: payeeId!,
            amount: BigInt(amount!),
            reason: reason ?? null,
            round: round ?? null,
            authorId: requester.memberId, // 본문의 작성자 값은 신뢰하지 않는다
            originalAmount: BigInt(amount!),
            originalReason: reason ?? null,
            originalRound: round ?? null,
            createdAt: slot!.createdAt,
            updatedAt: slot!.createdAt,
          },
        });
        return {
          status: 201,
          body: { transaction: toTransactionDto(created) },
          event: { event: 'transaction.created', transactionId: created.id },
        };
      },
    });
  }

  /** S2 §4.2 거래 수정(통째 교체). */
  update(
    requester: Requester,
    transactionId: string,
    headers: Record<string, string | string[] | undefined>,
    input: BodyInput,
  ): Promise<Reply> {
    return this.execute({
      requester,
      operation: 'UPDATE',
      targetId: transactionId,
      headers,
      input,
      handler: async ({ tx }) => {
        const target = await this.loadTarget(tx, requester, transactionId); // 6·7번
        const room = await tx.room.findUniqueOrThrow({
          where: { id: requester.roomId },
          select: { status: true },
        });
        if (room.status === 'ENDED') return permanentRejection('GAME_ENDED'); // 8번
        if (target.deletedAt) return permanentRejection('TRANSACTION_DELETED'); // 9번

        const body = this.requireObject(input); // 10번
        const details: FieldDetail[] = [];
        const amount = this.amountField(body, details);
        const reason = this.optionalText(body, 'reason', details);
        const round = this.optionalText(body, 'round', details);
        for (const k of Object.keys(body))
          if (!ALLOWED_UPDATE.has(k)) details.push({ field: k, code: 'NOT_ALLOWED_FIELD' });
        throwIfInvalid(details);

        const same =
          BigInt(amount!) === target.amount &&
          (reason ?? null) === target.reason &&
          (round ?? null) === target.round;
        if (same) return { status: 200, body: { transaction: toTransactionDto(target) } }; // 값이 모두 같으면 no-op
        const updatedAt = await this.nextUpdatedAt(tx, target.createdAt);
        const updated = await tx.transaction.update({
          where: { id: transactionId },
          data: {
            amount: BigInt(amount!),
            reason: reason ?? null,
            round: round ?? null,
            updatedAt,
          },
        });
        return {
          status: 200,
          body: { transaction: toTransactionDto(updated) },
          event: { event: 'transaction.updated', transactionId },
        };
      },
    });
  }

  /** S2 §4.3 거래 삭제(행을 지우지 않는다). */
  remove(
    requester: Requester,
    transactionId: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<Reply> {
    return this.execute({
      requester,
      operation: 'DELETE',
      targetId: transactionId,
      headers,
      input: { parseFailed: false, body: {} },
      handler: async ({ tx, now }) => {
        const target = await this.loadTarget(tx, requester, transactionId); // 6·7번
        const room = await tx.room.findUniqueOrThrow({
          where: { id: requester.roomId },
          select: { status: true },
        });
        if (room.status === 'ENDED') return permanentRejection('GAME_ENDED'); // 8번
        if (target.deletedAt) return permanentRejection('TRANSACTION_DELETED'); // 9번

        const deletedAt = await this.nextUpdatedAt(tx, target.createdAt, now);
        await tx.transaction.update({
          where: { id: transactionId },
          data: { deletedAt, deletedById: requester.memberId },
        });
        return {
          status: 200,
          body: { transactionId, deletedAt: deletedAt.toISOString() },
          event: { event: 'transaction.deleted', transactionId },
        };
      },
    });
  }

  // ---- 공통 보조 ----

  /** 6번(대상 존재, 다른 방의 거래 ID도 같은 404)과 7번(작성자 또는 방장). 둘 다 기록하지 않는 거부다. */
  private async loadTarget(tx: DbTx, requester: Requester, transactionId: string) {
    const target = await tx.transaction.findFirst({
      where: { id: transactionId, roomId: requester.roomId },
    });
    if (!target) throw new ApiError('TRANSACTION_NOT_FOUND');
    if (target.authorId !== requester.memberId && !requester.isHost)
      throw new ApiError('NOT_AUTHOR_OR_HOST');
    return target;
  }

  /** 갱신·삭제 시각: DB 시각이되 생성 시각보다 앞서지 않게 한다(CHECK updatedAt >= createdAt). */
  private async nextUpdatedAt(tx: DbTx, createdAt: Date, now?: Date): Promise<Date> {
    const at = now ?? (await this.db.dbNow(tx));
    return at.getTime() >= createdAt.getTime() ? at : createdAt;
  }

  private requireObject(input: BodyInput): Record<string, unknown> {
    const raw = requireJsonBody(input); // 본문 파싱 실패는 10번에서 422
    return isPlainObject(raw) ? raw : {};
  }

  private partyField(
    body: Record<string, unknown>,
    field: 'payerId' | 'payeeId',
    details: FieldDetail[],
  ): string | undefined {
    const v = body[field];
    if (v === undefined || v === null || v === '') details.push({ field, code: 'REQUIRED' });
    else if (typeof v !== 'string') details.push({ field, code: 'INVALID_TYPE' });
    else return v;
    return undefined;
  }

  private amountField(body: Record<string, unknown>, details: FieldDetail[]): number | undefined {
    const r = validateAmount(body['amount']);
    if (r.ok) return r.value;
    for (const code of r.reasons) details.push({ field: 'amount', code });
    return undefined;
  }

  /** 없음·null·""는 null이다. 위반은 `details`에 모으고 `undefined`를 돌려준다. */
  private optionalText(
    body: Record<string, unknown>,
    field: 'reason' | 'round',
    details: FieldDetail[],
  ): string | null | undefined {
    const r = field === 'reason' ? validateReason(body[field]) : validateRound(body[field]);
    if (r.ok) return r.value;
    for (const code of r.reasons) details.push({ field, code });
    return undefined;
  }
}
