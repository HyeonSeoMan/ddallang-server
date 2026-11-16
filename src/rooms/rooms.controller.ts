import { Controller, Get, Headers, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { hashIdentityKey, parseIdentityKey } from '../common/auth/identity-key.js';
import {
  CurrentIdentity,
  CurrentRequester,
  IdentityKeyGuard,
  ParticipantGuard,
  type IdentityContext,
  type RequesterContext,
} from '../common/auth/participant.guard.js';
import { toParticipantDto, type ParticipantDto, type RoomDto } from '../common/domain/dto.js';
import { JsonBody, type BodyInput } from '../common/http/json-body.js';
import { ApiErrors, ApiIdentityKey, ApiRoomIdParam } from '../common/swagger-docs.js';
import {
  MY_CLAIM_SCHEMA,
  PARTICIPANT_SCHEMA,
  ROOM_SCHEMA,
  ROOM_SUMMARY_SCHEMA,
  obj,
} from '../common/swagger-schemas.js';
import { RoomsService, type InviteView, type JoinResult } from './rooms.service.js';

@ApiTags('rooms')
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Post()
  @UseGuards(IdentityKeyGuard)
  @ApiIdentityKey()
  @ApiOperation({
    summary: '방 생성 (S1 §4.1)',
    description: '방과 첫 참여자(방장, order 1)를 만들고 첫 참여자를 이 신원 키에 연결한다.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      example: { name: 'Friday 7', unit: '원', nickname: '민수' },
      required: ['name', 'unit', 'nickname'],
      properties: {
        name: { type: 'string' },
        unit: { type: 'string' },
        nickname: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: '방과 방장 참여자(me)',
    schema: obj({ room: ROOM_SCHEMA, me: PARTICIPANT_SCHEMA }),
  })
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_FAILED')
  create(
    @CurrentIdentity() identity: IdentityContext,
    @JsonBody() body: BodyInput,
  ): Promise<{ room: RoomDto; me: ParticipantDto }> {
    return this.rooms.createRoom(identity.identityKeyHash, body);
  }

  @Get(':roomId')
  @UseGuards(ParticipantGuard)
  @ApiIdentityKey()
  @ApiOperation({ summary: '방 조회 (S1 §4.4). 이 방의 참여자(활성·비활성)' })
  @ApiResponse({
    status: 200,
    description: '방과 요청자 참여자',
    schema: obj({ room: ROOM_SCHEMA, me: PARTICIPANT_SCHEMA }),
  })
  @ApiRoomIdParam()
  @ApiErrors('UNAUTHENTICATED', 'IDENTITY_REVOKED', 'ROOM_NOT_FOUND')
  async get(
    @CurrentRequester() requester: RequesterContext,
  ): Promise<{ room: RoomDto; me: ParticipantDto }> {
    return {
      room: await this.rooms.getRoom(requester.participant.roomId),
      me: toParticipantDto(requester.participant),
    };
  }
}

@ApiTags('invites')
@Controller('invites')
export class InvitesController {
  constructor(private readonly rooms: RoomsService) {}

  @Get(':inviteCode')
  @ApiOperation({
    summary: '초대 링크 조회 (S1 §4.2)',
    description:
      '`Authorization`은 선택이다. 형식이 틀린 값은 오류 없이 "키 없음"으로 본다. `identity`는 요청에 실린 키의 이 방 상태, ' +
      '`claim`은 그 키의 가장 최근 이어받기 요청, `claimableNicknames`는 방장을 뺀 참여자 닉네임(order 순)이며 ' +
      '`identity`가 NONE·REVOKED일 때만 채운다. 접근 상실은 401로 거부하지 않고 `identity = REVOKED`로 알린다.',
    security: [{}, { 'identity-key': [] }],
  })
  @ApiResponse({
    status: 200,
    description:
      '입장 전 공개 정보. 방 ID·초대 코드·참여자 ID·상태·인원 수·방장 닉네임은 담지 않는다',
    schema: obj({
      room: obj({
        name: { type: 'string' },
        unit: { type: 'string' },
        status: { type: 'string', enum: ['IN_PROGRESS', 'ENDED'] },
      }),
      identity: { type: 'string', enum: ['NONE', 'PARTICIPANT', 'PENDING', 'REVOKED'] },
      claim: { ...MY_CLAIM_SCHEMA, nullable: true },
      claimableNicknames: { type: 'array', items: { type: 'string' } },
    }),
  })
  @ApiErrors('INVITE_NOT_FOUND')
  invite(
    @Param('inviteCode') inviteCode: string,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<InviteView> {
    let hash: string | undefined;
    try {
      hash = hashIdentityKey(parseIdentityKey(authorization));
    } catch {
      hash = undefined; // 형식이 틀린 값은 오류 없이 "키 없음"
    }
    return this.rooms.getInvite(inviteCode, hash);
  }

  @Post(':inviteCode/members')
  @HttpCode(201)
  @UseGuards(IdentityKeyGuard)
  @ApiIdentityKey()
  @ApiOperation({
    summary: '입장 (S1 §4.3). 연결된 키면 200 복원, 신원 없는 키면 새 참여자 201',
    description:
      '대기 키는 `CLAIM_PENDING`, 접근 상실 키는 `IDENTITY_REVOKED`. 종료된 방의 새 입장은 `GAME_ENDED`(복원은 된다).',
  })
  @ApiBody({
    schema: {
      type: 'object',
      example: { nickname: '지연' },
      properties: { nickname: { type: 'string', description: '새 입장에만 필수(복원은 무시)' } },
    },
  })
  @ApiResponse({
    status: 200,
    description: '같은 키로 복원(이벤트 없음)',
    schema: obj({ room: ROOM_SUMMARY_SCHEMA, me: PARTICIPANT_SCHEMA }),
  })
  @ApiResponse({
    status: 201,
    description: '새 참여자(participant.created)',
    schema: obj({ room: ROOM_SUMMARY_SCHEMA, me: PARTICIPANT_SCHEMA }),
  })
  @ApiErrors(
    'UNAUTHENTICATED',
    'IDENTITY_REVOKED',
    'INVITE_NOT_FOUND',
    'CLAIM_PENDING',
    'GAME_ENDED',
    'VALIDATION_FAILED',
    'NICKNAME_TAKEN',
    'PARTICIPANT_LIMIT_EXCEEDED',
  )
  async join(
    @Param('inviteCode') inviteCode: string,
    @CurrentIdentity() identity: IdentityContext,
    @JsonBody() body: BodyInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Omit<JoinResult, 'created'>> {
    const { created, room, me } = await this.rooms.join(inviteCode, identity.identityKeyHash, body);
    res.status(created ? 201 : 200);
    return { room, me };
  }
}
