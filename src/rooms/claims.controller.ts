import { Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  CurrentIdentity,
  CurrentRequester,
  IdentityKeyGuard,
  ParticipantGuard,
  requireHost,
  type IdentityContext,
  type RequesterContext,
} from '../common/auth/participant.guard.js';
import type { ClaimDto, MyClaimDto } from '../common/domain/dto.js';
import { JsonBody, type BodyInput } from '../common/http/json-body.js';
import { ApiErrors, ApiIdentityKey, ApiRoomIdParam } from '../common/swagger-docs.js';
import {
  CLAIM_SCHEMA,
  MY_CLAIM_SCHEMA,
  PARTICIPANT_SCHEMA,
  arrayOf,
  obj,
} from '../common/swagger-schemas.js';
import { ClaimsService, type ApproveResult } from './claims.service.js';

const ApiClaimIdParam = () => ApiParam({ name: 'claimId', description: '이어받기 요청 ID' });

/** 요청자 쪽 이어받기(S1 §4.9~§4.11). 요청자는 아직 방 비참여자라 `/invites/{inviteCode}/…` 경로와 `MyClaim`을 쓴다. */
@ApiTags('claims')
@Controller('invites/:inviteCode/claims')
@UseGuards(IdentityKeyGuard)
@ApiIdentityKey()
export class InviteClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: '이어받기 요청 (S1 §4.9)',
    description:
      '이어받을 참여자를 닉네임(초대 조회의 claimableNicknames 중 하나)으로 지정한다. 게임 상태·한도와 무관하고 만료가 없다. ' +
      '연결된 키는 ALREADY_PARTICIPANT, 대기 키는 CLAIM_PENDING, 접근 상실 키는 IDENTITY_REVOKED. ' +
      '없는 닉네임과 방장 닉네임은 같은 PARTICIPANT_NOT_FOUND. 참여자도 신원 연결도 만들지 않는다(claim.created).',
  })
  @ApiBody({
    schema: {
      type: 'object',
      example: { nickname: '지연' },
      required: ['nickname'],
      properties: { nickname: { type: 'string' } },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'PENDING 요청',
    schema: obj({ claim: MY_CLAIM_SCHEMA }),
  })
  @ApiErrors(
    'UNAUTHENTICATED',
    'IDENTITY_REVOKED',
    'INVITE_NOT_FOUND',
    'PARTICIPANT_NOT_FOUND',
    'ALREADY_PARTICIPANT',
    'CLAIM_PENDING',
    'VALIDATION_FAILED',
  )
  async create(
    @Param('inviteCode') inviteCode: string,
    @CurrentIdentity() identity: IdentityContext,
    @JsonBody() body: BodyInput,
  ): Promise<{ claim: MyClaimDto }> {
    return { claim: await this.claims.request(inviteCode, identity.identityKeyHash, body) };
  }

  @Get(':claimId')
  @ApiOperation({
    summary: '내 이어받기 요청 조회 (S1 §4.10)',
    description:
      '그 요청을 만든 키만 조회한다(승인되어 연결된 뒤에도). 대기 중 2초 주기 조회에 쓴다(S5 §6.8).',
  })
  @ApiClaimIdParam()
  @ApiResponse({
    status: 200,
    description: '요청자용 요청',
    schema: obj({ claim: MY_CLAIM_SCHEMA }),
  })
  @ApiErrors('UNAUTHENTICATED', 'IDENTITY_REVOKED', 'INVITE_NOT_FOUND', 'CLAIM_NOT_FOUND')
  async mine(
    @Param('inviteCode') inviteCode: string,
    @Param('claimId') claimId: string,
    @CurrentIdentity() identity: IdentityContext,
  ): Promise<{ claim: MyClaimDto }> {
    return { claim: await this.claims.mine(inviteCode, identity.identityKeyHash, claimId) };
  }

  @Post(':claimId/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: '이어받기 요청 취소 (S1 §4.11)',
    description:
      '그 요청을 만든 키만 취소한다. 끝난 요청은 CLAIM_ALREADY_RESOLVED(claim.canceled).',
  })
  @ApiClaimIdParam()
  @ApiResponse({ status: 200, description: '취소된 요청', schema: obj({ claim: MY_CLAIM_SCHEMA }) })
  @ApiErrors(
    'UNAUTHENTICATED',
    'IDENTITY_REVOKED',
    'INVITE_NOT_FOUND',
    'CLAIM_NOT_FOUND',
    'CLAIM_ALREADY_RESOLVED',
  )
  async cancel(
    @Param('inviteCode') inviteCode: string,
    @Param('claimId') claimId: string,
    @CurrentIdentity() identity: IdentityContext,
  ): Promise<{ claim: MyClaimDto }> {
    return { claim: await this.claims.cancel(inviteCode, identity.identityKeyHash, claimId) };
  }
}

/** 방장 쪽 이어받기(S1 §4.12~§4.15). 모두 방장 전용이며 비방장 참여자는 403 `HOST_ONLY`다. */
@ApiTags('claims')
@Controller('rooms/:roomId/claims')
@UseGuards(ParticipantGuard)
@ApiIdentityKey()
@ApiRoomIdParam()
export class RoomClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Get()
  @ApiOperation({
    summary: '대기 중인 이어받기 요청 목록 (S1 §4.12, 방장 전용)',
    description: 'PENDING만 createdAt·id 오름차순. 요청 브라우저를 식별하는 정보는 없다.',
  })
  @ApiResponse({
    status: 200,
    description: '대기 요청',
    schema: obj({ claims: arrayOf(CLAIM_SCHEMA) }),
  })
  @ApiErrors('UNAUTHENTICATED', 'IDENTITY_REVOKED', 'HOST_ONLY', 'ROOM_NOT_FOUND')
  async pending(@CurrentRequester() requester: RequesterContext): Promise<{ claims: ClaimDto[] }> {
    requireHost(requester.participant); // 4번
    return { claims: await this.claims.pending(requester.participant.roomId) };
  }

  @Get(':claimId')
  @ApiOperation({
    summary: '이어받기 요청 단건 조회 (S1 §4.15, 방장 전용)',
    description:
      '상태와 무관하게(끝난 요청 포함) 돌려준다. 승인·거절 응답이 유실됐을 때 현재 상태 확인에 쓴다.',
  })
  @ApiClaimIdParam()
  @ApiResponse({ status: 200, description: '방장용 요청', schema: obj({ claim: CLAIM_SCHEMA }) })
  @ApiErrors(
    'UNAUTHENTICATED',
    'IDENTITY_REVOKED',
    'HOST_ONLY',
    'ROOM_NOT_FOUND',
    'CLAIM_NOT_FOUND',
  )
  async one(
    @CurrentRequester() requester: RequesterContext,
    @Param('claimId') claimId: string,
  ): Promise<{ claim: ClaimDto }> {
    requireHost(requester.participant);
    return { claim: await this.claims.one(requester.participant.roomId, claimId) };
  }

  @Post(':claimId/approve')
  @HttpCode(200)
  @ApiOperation({
    summary: '이어받기 승인 (S1 §4.13, 방장 전용)',
    description:
      '한 트랜잭션: 대상의 이전 키는 접근을 잃고(IDENTITY_REVOKED) 요청 키가 대상에 연결되며, 같은 대상의 다른 대기 요청은 ' +
      'TARGET_CLAIMED로 거절된다. 게임 상태·한도·대상의 활성 상태와 무관하다. 요청 키가 이미 다른 참여자에 연결되어 있으면 ' +
      '그 요청을 REJECTED(REQUESTER_LINKED)로 바꾼 뒤 409 CLAIM_REQUESTER_LINKED(거부하면서 상태를 바꾸는 유일한 경우). ' +
      '본문은 받지 않는다(있으면 무시).',
  })
  @ApiClaimIdParam()
  @ApiResponse({
    status: 200,
    description: '승인된 요청과 대상 참여자(표시 필드는 바뀌지 않는다)',
    schema: obj({ claim: CLAIM_SCHEMA, participant: PARTICIPANT_SCHEMA }),
  })
  @ApiErrors(
    'UNAUTHENTICATED',
    'IDENTITY_REVOKED',
    'HOST_ONLY',
    'ROOM_NOT_FOUND',
    'CLAIM_NOT_FOUND',
    'CLAIM_ALREADY_RESOLVED',
    'CLAIM_REQUESTER_LINKED',
  )
  async approve(
    @CurrentRequester() requester: RequesterContext,
    @Param('claimId') claimId: string,
  ): Promise<ApproveResult> {
    requireHost(requester.participant);
    const { roomId } = requester.participant;
    return this.claims.approve(roomId, requester.identityKeyHash, claimId);
  }

  @Post(':claimId/reject')
  @HttpCode(200)
  @ApiOperation({
    summary: '이어받기 거절 (S1 §4.14, 방장 전용)',
    description:
      'REJECTED(HOST_REJECTED). 신원 연결은 바뀌지 않는다. 본문은 받지 않는다(있으면 무시).',
  })
  @ApiClaimIdParam()
  @ApiResponse({ status: 200, description: '거절된 요청', schema: obj({ claim: CLAIM_SCHEMA }) })
  @ApiErrors(
    'UNAUTHENTICATED',
    'IDENTITY_REVOKED',
    'HOST_ONLY',
    'ROOM_NOT_FOUND',
    'CLAIM_NOT_FOUND',
    'CLAIM_ALREADY_RESOLVED',
  )
  async reject(
    @CurrentRequester() requester: RequesterContext,
    @Param('claimId') claimId: string,
  ): Promise<{ claim: ClaimDto }> {
    requireHost(requester.participant);
    const { roomId } = requester.participant;
    return { claim: await this.claims.reject(roomId, requester.identityKeyHash, claimId) };
  }
}
