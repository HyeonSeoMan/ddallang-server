import { Controller, Get, Headers, HttpCode, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CurrentMember,
  RoomMemberGuard,
  type RoomMemberContext,
} from '../common/auth/room-member.guard.js';
import { JsonBody, type BodyInput } from '../common/http/json-body.js';
import { ApiErrors, ApiIdentityKey, ApiRoomIdParam } from '../common/swagger-docs.js';
import { SETTLEMENT_SCHEMA, obj } from '../common/swagger-schemas.js';
import { SettlementService, type SettlementDto } from './settlement.service.js';

type Q = Record<string, string | string[] | undefined | Record<string, unknown>>;

/** S4 게임 종료(BE-S4-3)와 정산 조회(BE-S4-2). 재개·확정·정정 등은 경로를 정의하지 않는다(§4.3). */
@ApiTags('settlement')
@Controller('rooms/:roomId')
@UseGuards(RoomMemberGuard)
@ApiIdentityKey()
@ApiRoomIdParam()
export class SettlementController {
  constructor(private readonly settlement: SettlementService) {}

  @Post('end')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '^[A-Za-z0-9_-]{16,64}$' })
  @ApiHeader({
    name: 'Idempotency-First-Attempt-At',
    required: true,
    description: 'RFC 3339 UTC 밀리초, 이 요청을 처음 시도한 시각',
  })
  @ApiOperation({ summary: '게임 종료 (S4 §4.1): 방장만. 본문 없음(또는 {})' })
  @ApiBody({ required: false, schema: { type: 'object', example: {}, properties: {} } })
  @ApiResponse({
    status: 200,
    headers: {
      'Idempotent-Replayed': {
        description: '같은 키·같은 내용의 재전송이면 true(저장된 최초 결과)',
        schema: { type: 'string', example: 'true' },
      },
    },
    description: '종료됨. 같은 키 재전송은 Idempotent-Replayed: true와 같은 본문',
    schema: obj({ roomId: { type: 'string' }, status: { type: 'string', enum: ['ENDED'] } }),
  })
  @ApiErrors(
    'UNAUTHENTICATED',
    'ROOM_NOT_FOUND',
    'HOST_ONLY',
    'VALIDATION_FAILED',
    'IDEMPOTENCY_KEY_EXPIRED',
    'IDEMPOTENCY_CONFLICT',
    'GAME_ENDED',
  )
  async end(
    @CurrentMember() member: RoomMemberContext,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @JsonBody() body: BodyInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const reply = await this.settlement.end(
      { memberId: member.memberId, roomId: member.roomId, isHost: member.isHost },
      headers,
      body,
    );
    res.status(reply.status);
    if (reply.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return reply.body;
  }

  @Get('settlement')
  @ApiOperation({
    summary:
      '정산 조회 (S4 §4.2): 진행 중이면 EXPECTED, 종료 후 FINAL. 정렬은 서버가 한다. 쿼리 매개변수 없음',
  })
  @ApiResponse({
    status: 200,
    description: '정산 종류와 항목(없으면 빈 배열)',
    schema: obj({ settlement: SETTLEMENT_SCHEMA }),
  })
  @ApiErrors('UNAUTHENTICATED', 'ROOM_NOT_FOUND', 'VALIDATION_FAILED')
  async get(
    @CurrentMember() member: RoomMemberContext,
    @Query() query: Q,
  ): Promise<{ settlement: SettlementDto }> {
    return { settlement: await this.settlement.settlement(member.roomId, query) };
  }
}
