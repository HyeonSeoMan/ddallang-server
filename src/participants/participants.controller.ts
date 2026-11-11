import { Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  CurrentMember,
  RoomMemberGuard,
  type RoomMemberContext,
} from '../common/auth/room-member.guard.js';
import type { ParticipantDto } from '../common/domain/dto.js';
import { ApiError } from '../common/errors/api-error.js';
import { JsonBody, type BodyInput } from '../common/http/json-body.js';
import { ApiErrorResponses, ApiIdentityKey } from '../common/swagger-docs.js';
import { ParticipantsService } from './participants.service.js';

/** 방장 전용 동작(S1 §5.1)은 비방장에게 `403 HOST_ONLY`다. 방 멤버에게만 도달하므로 방 정보를 드러내지 않는다. */
function requireHost(member: RoomMemberContext): void {
  if (!member.isHost) throw new ApiError('HOST_ONLY'); // 4번
}

@ApiTags('participants')
@Controller('rooms/:roomId/participants')
@UseGuards(RoomMemberGuard)
@ApiIdentityKey()
export class ParticipantsController {
  constructor(private readonly participants: ParticipantsService) {}

  @Get()
  @ApiOperation({ summary: '참여자 목록 (S1 §4.5): order 오름차순, 비활성 포함' })
  @ApiResponse({ status: 200, description: '{ participants: Participant[] }' })
  @ApiErrorResponses(401, 404)
  async list(
    @CurrentMember() member: RoomMemberContext,
  ): Promise<{ participants: ParticipantDto[] }> {
    return { participants: await this.participants.list(member.roomId) };
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: '참여자 등록 (S1 §4.6, 방장 전용)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['nickname'],
      properties: { nickname: { type: 'string' } },
    },
  })
  @ApiResponse({ status: 201, description: '{ participant }' })
  @ApiErrorResponses(401, 403, 404, 409, 422)
  async create(
    @CurrentMember() member: RoomMemberContext,
    @JsonBody() body: BodyInput,
  ): Promise<{ participant: ParticipantDto }> {
    requireHost(member);
    return { participant: await this.participants.create(member.roomId, body) };
  }

  @Patch(':participantId')
  @ApiOperation({ summary: '참여자 활성 상태 변경 (S1 §4.7, 방장 전용). status 한 필드만' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] } },
    },
  })
  @ApiResponse({ status: 200, description: '{ participant }' })
  @ApiErrorResponses(401, 403, 404, 409, 422)
  async patch(
    @CurrentMember() member: RoomMemberContext,
    @Param('participantId') participantId: string,
    @JsonBody() body: BodyInput,
  ): Promise<{ participant: ParticipantDto }> {
    requireHost(member);
    return { participant: await this.participants.setStatus(member.roomId, participantId, body) };
  }
}
