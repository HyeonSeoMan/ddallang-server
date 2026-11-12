import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { Env } from '../common/config/env.js';
import { ENV } from '../common/config/env.token.js';
import { decryptCursor, encryptCursor, roomHash } from '../common/crypto/cursor.js';
import { DatabaseService } from '../common/db/database.service.js';
import { queryBalances, safeBalance } from '../common/domain/balances.js';
import { toTransactionDto, type TransactionDto } from '../common/domain/dto.js';
import { ApiError } from '../common/errors/api-error.js';

export const PAGE_SIZE = 20;

export interface Balance {
  participantId: string;
  nickname: string;
  status: string;
  order: number;
  balance: number;
}

type QueryValue = string | string[] | undefined | Record<string, unknown>;

@Injectable()
export class BalancesService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * S3 §4.2·§6.1: 한 스냅샷의 단일 SQL 집계. 방의 모든 참여자(비활성·거래 없음 포함)를 `balance` 내림차순,
   * 동률은 `order` 오름차순으로 돌려준다. 합산은 64비트 정수(BIGINT)이고 응답 직전에 안전 정수 범위를 검사한다.
   * 쿼리 매개변수는 하나도 허용하지 않는다(필터는 순손익에 적용되지 않는다).
   */
  async balances(roomId: string, query: Record<string, QueryValue>): Promise<Balance[]> {
    const names = Object.keys(query);
    if (names.length > 0) {
      throw new ApiError('VALIDATION_FAILED', {
        details: names.map((field) => ({ field, code: 'NOT_ALLOWED_FIELD' })),
      });
    }
    const rows = await this.db.readSnapshot((tx) => queryBalances(tx, roomId));
    return rows.map((r) => {
      const balance = safeBalance(r.balance);
      return {
        participantId: r.participantId,
        nickname: r.nickname,
        status: r.status,
        order: r.order,
        balance,
      };
    });
  }

  /**
   * S3 §3.3 표·§4.1: 유효 거래만, (createdAt, seq) 내림차순, 20건+1건 조회로 `nextCursor`를 정한다.
   * 필터(참여자 1명, 비활성 포함)와 키셋 커서(AEAD)를 쓴다. 한 응답은 하나의 스냅샷이다.
   */
  async list(
    roomId: string,
    query: Record<string, QueryValue>,
  ): Promise<{ transactions: TransactionDto[]; nextCursor: string | null }> {
    const details: { field: string; code: string }[] = [];
    for (const name of Object.keys(query)) {
      if (name !== 'participantId' && name !== 'cursor')
        details.push({ field: name, code: 'NOT_ALLOWED_FIELD' });
    }
    const filter = this.single(query['participantId'], 'participantId', details);
    const token = this.single(query['cursor'], 'cursor', details);
    let position: { createdAt: Date; seq: number } | undefined;
    if (token !== undefined) {
      const c = decryptCursor(this.env.CURSOR_KEY, token);
      if (!c || c.r !== roomHash(roomId) || c.f !== (filter ?? null)) {
        details.push({ field: 'cursor', code: 'INVALID_VALUE' });
      } else {
        position = { createdAt: new Date(c.c), seq: c.s };
      }
    }
    if (details.length > 0) {
      // 다른 입력 오류가 있어도 적용되는 검증(참여자 존재)은 함께 모아 알려 준다(S3 §3.3)
      if (filter !== undefined) {
        const exists = await this.db.readSnapshot((tx) =>
          tx.participant.findFirst({ where: { id: filter, roomId }, select: { id: true } }),
        );
        if (!exists) details.push({ field: 'participantId', code: 'PARTICIPANT_NOT_FOUND' });
      }
      throw new ApiError('VALIDATION_FAILED', { details });
    }

    return this.db.readSnapshot(async (tx) => {
      if (filter !== undefined) {
        const exists = await tx.participant.findFirst({
          where: { id: filter, roomId },
          select: { id: true },
        });
        if (!exists) {
          throw new ApiError('VALIDATION_FAILED', {
            details: [{ field: 'participantId', code: 'PARTICIPANT_NOT_FOUND' }],
          });
        }
      }
      const and: Prisma.TransactionWhereInput[] = [];
      if (filter !== undefined) and.push({ OR: [{ payerId: filter }, { payeeId: filter }] });
      if (position) {
        and.push({
          OR: [
            { createdAt: { lt: position.createdAt } },
            { createdAt: position.createdAt, seq: { lt: position.seq } },
          ],
        });
      }
      const rows = await tx.transaction.findMany({
        where: { roomId, deletedAt: null, ...(and.length ? { AND: and } : {}) },
        orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
        take: PAGE_SIZE + 1,
      });
      const page = rows.slice(0, PAGE_SIZE);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > PAGE_SIZE && last
          ? encryptCursor(this.env.CURSOR_KEY, {
              c: last.createdAt.toISOString(),
              s: last.seq,
              f: filter ?? null,
              r: roomHash(roomId),
            })
          : null;
      return { transactions: page.map(toTransactionDto), nextCursor };
    });
  }

  /** 같은 매개변수 반복(배열)·빈 값·객체는 `INVALID_VALUE`다(S3 §3.3 표). 값이 없으면 `undefined`. */
  private single(
    v: QueryValue,
    field: string,
    details: { field: string; code: string }[],
  ): string | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v === '') {
      details.push({ field, code: 'INVALID_VALUE' });
      return undefined;
    }
    return v;
  }
}
