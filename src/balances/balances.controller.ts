import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  CurrentMember,
  RoomMemberGuard,
  type RoomMemberContext,
} from '../common/auth/room-member.guard.js';
import type { TransactionDto } from '../common/domain/dto.js';
import { ApiErrors, ApiIdentityKey, ApiRoomIdParam } from '../common/swagger-docs.js';
import { BALANCE_SCHEMA, TRANSACTION_SCHEMA, arrayOf, obj } from '../common/swagger-schemas.js';
import { BalancesService, type Balance } from './balances.service.js';

type Q = Record<string, string | string[] | undefined | Record<string, unknown>>;

/** S3 조회 API(BE-S3-1~2). 방 상태와 무관하게 방 멤버면 조회할 수 있고 상태를 바꾸지 않는다. */
@ApiTags('balances')
@Controller('rooms/:roomId')
@UseGuards(RoomMemberGuard)
@ApiIdentityKey()
@ApiRoomIdParam()
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  @Get('balances')
  @ApiOperation({
    summary:
      '누적 손익 (S3 §4.2): 모든 참여자, balance 내림차순·order 오름차순. 쿼리 매개변수 없음',
  })
  @ApiResponse({
    status: 200,
    description: '참여자별 순손익(모든 참여자, balance 내림차순·order 오름차순)',
    schema: obj({ balances: arrayOf(BALANCE_SCHEMA) }),
  })
  @ApiErrors('UNAUTHENTICATED', 'ROOM_NOT_FOUND', 'VALIDATION_FAILED')
  async getBalances(
    @CurrentMember() member: RoomMemberContext,
    @Query() query: Q,
  ): Promise<{ balances: Balance[] }> {
    return { balances: await this.balances.balances(member.roomId, query) };
  }

  @Get('transactions')
  @ApiOperation({
    summary: '거래 목록 (S3 §4.1): 유효 거래만 (createdAt, seq) 내림차순 20건, 키셋 커서',
  })
  @ApiQuery({ name: 'participantId', required: false, description: '참여자 1명 필터(비활성 포함)' })
  @ApiQuery({ name: 'cursor', required: false, description: '이전 응답의 nextCursor' })
  @ApiResponse({
    status: 200,
    description: '유효 거래 최대 20건과 다음 페이지 커서(없으면 null)',
    schema: obj({
      transactions: arrayOf(TRANSACTION_SCHEMA),
      nextCursor: { type: 'string', nullable: true },
    }),
  })
  @ApiErrors('UNAUTHENTICATED', 'ROOM_NOT_FOUND', 'VALIDATION_FAILED')
  list(
    @CurrentMember() member: RoomMemberContext,
    @Query() query: Q,
  ): Promise<{ transactions: TransactionDto[]; nextCursor: string | null }> {
    return this.balances.list(member.roomId, query);
  }
}
