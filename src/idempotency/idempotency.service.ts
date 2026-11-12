import { Injectable } from '@nestjs/common';
import type { DbTx } from '../common/db/database.service.js';
import { PrismaService } from '../common/db/prisma.service.js';
import { ApiError } from '../common/errors/api-error.js';
import { newId } from '../common/ids/ids.js';
import type { Operation } from './fingerprint.js';
import { CLEANUP_GRACE_MS, IDEMPOTENCY_TTL_MS } from './idempotency.constants.js';

export interface StoredResponse {
  status: number;
  body: unknown;
}

export interface LookupInput {
  roomId: string;
  memberId: string;
  key: string;
  /** `Idempotency-First-Attempt-At` 헤더 값 */
  firstAttemptAt: Date;
  fingerprint: string;
  /** 방 잠금을 얻은 시점의 DB 시각(수신 시각이 아니다, S2 §3.4) */
  now: Date;
  /** 만료 오류의 `message`(종료 요청은 방 상태를 확인하라는 안내, S4 §3.2) */
  expiredMessage?: string;
}

export interface RecordInput extends Omit<LookupInput, 'now'> {
  operation: Operation;
  response: StoredResponse;
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * §3.4의 4(만료)·5(재전송 판정). 방 잠금 안에서 호출한다.
   * - 만료: 기록 유무·내용과 무관하게 `max(기록의 firstAttemptAt이 더 이르면 그 값, 헤더 값) + 24시간`이 지났으면 409.
   * - 기록이 있고 지문이 같으면 저장된 응답을 돌려준다(상태 검사를 다시 하지 않는다). 지문이 다르면 409 `IDEMPOTENCY_CONFLICT`.
   * - 기록이 없으면 `undefined`(새 요청).
   */
  async lookup(tx: DbTx, input: LookupInput): Promise<StoredResponse | undefined> {
    const record = await tx.idempotencyRecord.findUnique({
      where: {
        roomId_memberId_key: { roomId: input.roomId, memberId: input.memberId, key: input.key },
      },
    });
    const effectiveFirst = record
      ? Math.min(record.firstAttemptAt.getTime(), input.firstAttemptAt.getTime())
      : input.firstAttemptAt.getTime();
    if (input.now.getTime() > effectiveFirst + IDEMPOTENCY_TTL_MS) {
      throw new ApiError('IDEMPOTENCY_KEY_EXPIRED', {
        message:
          input.expiredMessage ??
          '요청 유효 기간이 지났습니다. 거래 목록에서 저장 여부를 확인해 주세요.',
        details: [{ serverTime: input.now.toISOString() }],
      });
    }
    if (!record) return undefined;
    if (record.fingerprint !== input.fingerprint) throw new ApiError('IDEMPOTENCY_CONFLICT');
    return { status: record.statusCode, body: record.responseBody };
  }

  /** 성공과 영구적 거부(§5.2)만 거래 변경과 같은 트랜잭션에서 기록한다. */
  async record(tx: DbTx, input: RecordInput): Promise<void> {
    await tx.idempotencyRecord.create({
      data: {
        id: newId(),
        roomId: input.roomId,
        memberId: input.memberId,
        key: input.key,
        operation: input.operation,
        fingerprint: input.fingerprint,
        firstAttemptAt: input.firstAttemptAt,
        expiresAt: new Date(input.firstAttemptAt.getTime() + IDEMPOTENCY_TTL_MS),
        statusCode: input.response.status,
        responseBody: input.response.body as object,
      },
    });
  }

  /**
   * `expiresAt + 1시간`이 지난 기록을 배치로 지운다(`FOR UPDATE SKIP LOCKED`라 여러 인스턴스가 돌려도 안전하다).
   * 삭제 시각은 판정 결과를 바꾸지 않는다: 만료 판정은 헤더만으로 한다. 지운 행 수를 돌려준다.
   */
  async cleanupExpired(batchSize = 500): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.prisma.client.$executeRaw`
        DELETE FROM "IdempotencyRecord" WHERE "id" IN (
          SELECT "id" FROM "IdempotencyRecord"
          WHERE "expiresAt" < clock_timestamp() - make_interval(secs => ${CLEANUP_GRACE_MS / 1000})
          ORDER BY "expiresAt" LIMIT ${batchSize} FOR UPDATE SKIP LOCKED)`;
      total += deleted;
      if (deleted < batchSize) return total;
    }
  }
}
