import { Controller, Get, Headers, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { hashIdentityKey, parseIdentityKey } from '../common/auth/identity-key.js';
import {
  CurrentIdentity,
  CurrentMember,
  IdentityKeyGuard,
  RoomMemberGuard,
  type IdentityContext,
  type RoomMemberContext,
} from '../common/auth/room-member.guard.js';
import { toMemberDto, type RoomDto, type RoomMemberDto } from '../common/domain/dto.js';
import { JsonBody, type BodyInput } from '../common/http/json-body.js';
import { ApiErrors, ApiIdentityKey, ApiRoomIdParam } from '../common/swagger-docs.js';
import {
  ROOM_MEMBER_SCHEMA,
  ROOM_SCHEMA,
  ROOM_SUMMARY_SCHEMA,
  obj,
} from '../common/swagger-schemas.js';
import { RoomsService, type JoinResult } from './rooms.service.js';

@ApiTags('rooms')
@Controller('rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Post()
  @UseGuards(IdentityKeyGuard)
  @ApiIdentityKey()
  @ApiOperation({ summary: '방 생성 (S1 §4.1)' })
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
    description: '방과 방장 RoomMember',
    schema: obj({ room: ROOM_SCHEMA, me: ROOM_MEMBER_SCHEMA }),
  })
  @ApiErrors('UNAUTHENTICATED', 'VALIDATION_FAILED')
  create(
    @CurrentIdentity() identity: IdentityContext,
    @JsonBody() body: BodyInput,
  ): Promise<{ room: RoomDto; me: RoomMemberDto }> {
    return this.rooms.createRoom(identity.identityKeyHash, body);
  }

  @Get(':roomId')
  @UseGuards(RoomMemberGuard)
  @ApiIdentityKey()
  @ApiOperation({ summary: '방 조회 (S1 §4.4)' })
  @ApiResponse({
    status: 200,
    description: '방과 요청자',
    schema: obj({ room: ROOM_SCHEMA, me: ROOM_MEMBER_SCHEMA }),
  })
  @ApiRoomIdParam()
  @ApiErrors('UNAUTHENTICATED', 'ROOM_NOT_FOUND')
  async get(
    @CurrentMember() member: RoomMemberContext,
  ): Promise<{ room: RoomDto; me: RoomMemberDto }> {
    return {
      room: await this.rooms.getRoom(member.roomId),
      me: toMemberDto({ ...member, id: member.memberId }),
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
      '`Authorization`은 선택이다. 형식이 틀린 값은 오류 없이 "키 없음"으로 본다. `isMember`는 요청에 실린 키가 이 방의 RoomMember인지만 알려 준다.',
    security: [{}, { 'identity-key': [] }],
  })
  @ApiResponse({
    status: 200,
    description: '입장 전 공개 정보(이름·정산 단위·상태)와 isMember',
    schema: obj({
      room: obj({
        name: { type: 'string' },
        unit: { type: 'string' },
        status: { type: 'string', enum: ['IN_PROGRESS', 'ENDED'] },
      }),
      isMember: { type: 'boolean' },
    }),
  })
  @ApiErrors('INVITE_NOT_FOUND')
  invite(
    @Param('inviteCode') inviteCode: string,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<{ room: Pick<RoomDto, 'name' | 'unit' | 'status'>; isMember: boolean }> {
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
  @ApiOperation({ summary: '입장 (S1 §4.3). 같은 키면 200 복원, 새 RoomMember면 201' })
  @ApiBody({
    schema: {
      type: 'object',
      example: { nickname: '지연' },
      properties: { nickname: { type: 'string' } },
    },
  })
  @ApiResponse({
    status: 200,
    description: '같은 키로 복원',
    schema: obj({ room: ROOM_SUMMARY_SCHEMA, me: ROOM_MEMBER_SCHEMA }),
  })
  @ApiResponse({
    status: 201,
    description: '새 RoomMember',
    schema: obj({ room: ROOM_SUMMARY_SCHEMA, me: ROOM_MEMBER_SCHEMA }),
  })
  @ApiErrors(
    'UNAUTHENTICATED',
    'INVITE_NOT_FOUND',
    'VALIDATION_FAILED',
    'NICKNAME_TAKEN',
    'MEMBER_LIMIT_EXCEEDED',
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
