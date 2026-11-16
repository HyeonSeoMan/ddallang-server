import { Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  CurrentRequester,
  ParticipantGuard,
  requireHost,
  type RequesterContext,
} from '../common/auth/participant.guard.js';
import type { ParticipantDto } from '../common/domain/dto.js';
import { JsonBody, type BodyInput } from '../common/http/json-body.js';
import { ApiErrors, ApiIdentityKey, ApiRoomIdParam } from '../common/swagger-docs.js';
import { PARTICIPANT_SCHEMA, arrayOf, obj } from '../common/swagger-schemas.js';
import { ParticipantsService } from './participants.service.js';

@ApiTags('participants')
@Controller('rooms/:roomId/participants')
@UseGuards(ParticipantGuard)
@ApiIdentityKey()
@ApiRoomIdParam()
export class ParticipantsController {
  constructor(private readonly participants: ParticipantsService) {}

  @Get()
  @ApiOperation({ summary: '참여자 목록 (S1 §4.5): order 오름차순, 비활성·직접 추가 포함' })
  @ApiResponse({
    status: 200,
    description: 'order 오름차순, 비활성 포함',
    schema: obj({ participants: arrayOf(PARTICIPANT_SCHEMA) }),
  })
  @ApiErrors('UNAUTHENTICATED', 'IDENTITY_REVOKED', 'ROOM_NOT_FOUND')
  async list(
    @CurrentRequester() requester: RequesterContext,
  ): Promise<{ participants: ParticipantDto[] }> {
    return { participants: await this.participants.list(requester.participant.roomId) };
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: '참여자 직접 추가 (S1 §4.6, 방장 전용). 신원 키가 연결되지 않은 참여자',
  })
  @ApiBody({
    schema: {
      type: 'object',
      example: { nickname: '철수' },
      required: ['nickname'],
      properties: { nickname: { type: 'string' } },
    },
  })
  @ApiResponse({
    status: 201,
    description: '추가된 참여자(ACTIVE, isHost false)',
    schema: obj({ participant: PARTICIPANT_SCHEMA }),
  })
  @ApiErrors(
    'UNAUTHENTICATED',
    'IDENTITY_REVOKED',
    'HOST_ONLY',
    'ROOM_NOT_FOUND',
    'GAME_ENDED',
    'VALIDATION_FAILED',
    'NICKNAME_TAKEN',
    'PARTICIPANT_LIMIT_EXCEEDED',
  )
  async create(
    @CurrentRequester() requester: RequesterContext,
    @JsonBody() body: BodyInput,
  ): Promise<{ participant: ParticipantDto }> {
    requireHost(requester.participant); // 4번
    const { roomId } = requester.participant;
    return {
      participant: await this.participants.create(roomId, requester.identityKeyHash, body),
    };
  }

  @Patch(':participantId')
  @ApiOperation({
    summary: '참여자 활성 상태 변경 (S1 §4.7, 방장 전용). status 한 필드만',
    description:
      '방장 참여자의 비활성화는 `HOST_CANNOT_BE_DEACTIVATED`. 같은 값이면 변경·이벤트 없이 200',
  })
  @ApiBody({
    schema: {
      type: 'object',
      example: { status: 'INACTIVE' },
      required: ['status'],
      properties: { status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] } },
    },
  })
  @ApiResponse({
    status: 200,
    description: '현재 참여자(같은 값이면 변경 없이 그대로)',
    schema: obj({ participant: PARTICIPANT_SCHEMA }),
  })
  @ApiErrors(
    'UNAUTHENTICATED',
    'IDENTITY_REVOKED',
    'HOST_ONLY',
    'ROOM_NOT_FOUND',
    'PARTICIPANT_NOT_FOUND',
    'GAME_ENDED',
    'VALIDATION_FAILED',
    'HOST_CANNOT_BE_DEACTIVATED',
  )
  async patch(
    @CurrentRequester() requester: RequesterContext,
    @Param('participantId') participantId: string,
    @JsonBody() body: BodyInput,
  ): Promise<{ participant: ParticipantDto }> {
    requireHost(requester.participant); // 4번
    const { roomId } = requester.participant;
    return {
      participant: await this.participants.setStatus(
        roomId,
        requester.identityKeyHash,
        participantId,
        body,
      ),
    };
  }
}
