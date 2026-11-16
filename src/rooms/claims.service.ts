import { Injectable } from '@nestjs/common';
import { IdentityInvariantError, relinkInLock, resolveIdentity } from '../common/auth/identity.js';
import { requireHost } from '../common/auth/participant.guard.js';
import { DatabaseService, type DbTx } from '../common/db/database.service.js';
import { PrismaService } from '../common/db/prisma.service.js';
import {
  toClaimDto,
  toMyClaimDto,
  toParticipantDto,
  type ClaimDto,
  type MyClaimDto,
  type ParticipantDto,
} from '../common/domain/dto.js';
import { ApiError } from '../common/errors/api-error.js';
import { asObject, throwIfInvalid, type FieldDetail } from '../common/http/fields.js';
import { requireJsonBody, type BodyInput } from '../common/http/json-body.js';
import { newId } from '../common/ids/ids.js';
import { nicknameKey } from '../common/validation/index.js';
import { CLAIM_SELECT, findClaim, flattenClaim } from './claim-queries.js';

export interface ApproveResult {
  claim: ClaimDto;
  participant: ParticipantDto;
}

/**
 * 이어받기(S1 §4.9~§4.15, FR-ROOM-009). 요청·취소·승인·거절은 모두 방 잠금 안의 한 트랜잭션이고 잠금을 얻은 뒤
 * 신원 상태를 다시 판정한다(PD-24). 게임 상태·참여자 한도와 무관하고 만료가 없다(P-6, P-9). 요청 키 해시는 응답·로그에
 * 싣지 않는다. 변경마다 `revision`을 소비하고 `claim.*` 이벤트를 낸다(PD-26, S5 §4.2).
 */
@Injectable()
export class ClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DatabaseService,
  ) {}

  private async roomOfInvite(inviteCode: string): Promise<string> {
    const room = await this.prisma.client.room.findUnique({
      where: { inviteCode },
      select: { id: true },
    });
    if (!room) throw new ApiError('INVITE_NOT_FOUND'); // 2번
    return room.id;
  }

  /**
   * S1 §4.9: 3번(신원 상태: 연결 `ALREADY_PARTICIPANT`, 접근 상실 401, 대기 `CLAIM_PENDING`) → 7번(닉네임이 없거나
   * 문자열이 아님) → 6번(비교 키가 같은 참여자, 방장이면 없는 것과 같다) → `PENDING` 요청. 참여자도 신원 연결도 만들지 않는다.
   */
  async request(inviteCode: string, keyHash: string, input: BodyInput): Promise<MyClaimDto> {
    const roomId = await this.roomOfInvite(inviteCode);
    const { value } = await this.db.withRoomMutation<MyClaimDto>(roomId, async (tx) => {
      const state = await resolveIdentity(tx, roomId, keyHash);
      if (state.kind === 'LINKED') throw new ApiError('ALREADY_PARTICIPANT');
      if (state.kind === 'REVOKED') throw new ApiError('IDENTITY_REVOKED');
      if (state.kind === 'PENDING') throw new ApiError('CLAIM_PENDING');

      const body = asObject(requireJsonBody(input));
      const raw = body['nickname'];
      const details: FieldDetail[] = [];
      if (raw === undefined || raw === null || raw === '')
        details.push({ field: 'nickname', code: 'REQUIRED' });
      else if (typeof raw !== 'string') details.push({ field: 'nickname', code: 'INVALID_TYPE' });
      throwIfInvalid(details); // 그 밖의 문자 규칙은 보지 않는다(일치하는 참여자가 없으면 404다)

      const target = await tx.participant.findUnique({
        where: {
          roomId_nicknameKey: {
            roomId,
            nicknameKey: nicknameKey((raw as string).normalize('NFC')),
          },
        },
        select: { id: true, isHost: true },
      });
      if (!target || target.isHost) throw new ApiError('PARTICIPANT_NOT_FOUND'); // 방장 닉네임도 같은 404(S1-C7)
      const claim = await tx.claimRequest.create({
        data: { id: newId(), roomId, participantId: target.id, requesterKeyHash: keyHash },
        select: CLAIM_SELECT,
      });
      return {
        value: toMyClaimDto(flattenClaim(claim)),
        event: { event: 'claim.created', claimId: claim.id },
      };
    });
    return value;
  }

  /** S1 §4.10: 그 요청을 만든 키만(승인되어 연결된 뒤에도) 조회한다. 접근 상실 키는 401. 한 스냅샷에서 읽는다. */
  async mine(inviteCode: string, keyHash: string, claimId: string): Promise<MyClaimDto> {
    const roomId = await this.roomOfInvite(inviteCode);
    return this.db.readSnapshot(async (tx) => {
      if ((await resolveIdentity(tx, roomId, keyHash)).kind === 'REVOKED')
        throw new ApiError('IDENTITY_REVOKED');
      const claim = await findClaim(tx, roomId, claimId, keyHash);
      if (!claim) throw new ApiError('CLAIM_NOT_FOUND'); // 다른 키·다른 방의 요청도 같다
      return toMyClaimDto(claim);
    });
  }

  /** S1 §4.11: 그 요청을 만든 키만 취소한다. `PENDING`이 아니면 `CLAIM_ALREADY_RESOLVED`. 게임 상태와 무관하다. */
  async cancel(inviteCode: string, keyHash: string, claimId: string): Promise<MyClaimDto> {
    const roomId = await this.roomOfInvite(inviteCode);
    const { value } = await this.db.withRoomMutation<MyClaimDto>(roomId, async (tx) => {
      if ((await resolveIdentity(tx, roomId, keyHash)).kind === 'REVOKED')
        throw new ApiError('IDENTITY_REVOKED');
      const claim = await findClaim(tx, roomId, claimId, keyHash);
      if (!claim) throw new ApiError('CLAIM_NOT_FOUND');
      if (claim.status !== 'PENDING') throw new ApiError('CLAIM_ALREADY_RESOLVED');
      const updated = await tx.claimRequest.update({
        where: { id: claim.id },
        data: { status: 'CANCELED', resolvedAt: await this.db.dbNow(tx) },
        select: CLAIM_SELECT,
      });
      return {
        value: toMyClaimDto(flattenClaim(updated)),
        event: { event: 'claim.canceled', claimId: claim.id },
      };
    });
    return value;
  }

  /** S1 §4.12: 방장 전용, `PENDING`만 `createdAt`·`id` 오름차순. 방장 여부는 컨트롤러가 앞서 본다(4번). */
  async pending(roomId: string): Promise<ClaimDto[]> {
    const rows = await this.prisma.client.claimRequest.findMany({
      where: { roomId, status: 'PENDING' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: CLAIM_SELECT,
    });
    return rows.map((r) => toClaimDto(flattenClaim(r)));
  }

  /** S1 §4.15: 방장 전용, 상태와 무관하게(끝난 요청 포함) 돌려준다. */
  async one(roomId: string, claimId: string): Promise<ClaimDto> {
    const claim = await findClaim(this.prisma.client, roomId, claimId);
    if (!claim) throw new ApiError('CLAIM_NOT_FOUND');
    return toClaimDto(claim);
  }

  /**
   * S1 §4.13 승인(한 트랜잭션): 1 요청 없음 404 → 2 `PENDING` 아님 409 → 3 요청 키가 이미 다른 참여자에 연결되어 있으면
   * 그 요청만 `REJECTED`(`REQUESTER_LINKED`)로 바꿔 **커밋한 뒤** 409 `CLAIM_REQUESTER_LINKED`(PD-25, I9) →
   * 4 대상의 이전 키를 접근 상실로 기록 → 5 요청 키를 대상에 연결 → 6 `APPROVED` → 7 같은 대상의 다른 대기 요청을
   * `TARGET_CLAIMED`로 거절. 대상의 닉네임·상태·`order`·`isHost`는 바뀌지 않는다. 이벤트는 `claim.resolved` 하나이며
   * 이전 키를 끊었을 때만 내부 필드 `revokedParticipantId`를 싣는다(PD-26).
   */
  async approve(roomId: string, hostKeyHash: string, claimId: string): Promise<ApproveResult> {
    const { value } = await this.db.withRoomMutation<ApproveResult | null>(roomId, async (tx) => {
      const host = await relinkInLock(tx, roomId, hostKeyHash);
      requireHost(host); // 3·4번 재확인
      const claim = await this.pendingClaim(tx, roomId, claimId);
      const now = await this.db.dbNow(tx);

      // 3번: 요청 키의 연결은 resolveIdentity가 아니라 참여자 연결을 직접 본다(PD-23)
      const linked = await tx.participant.findFirst({
        where: { roomId, identityKeyHash: claim.requesterKeyHash },
        select: { id: true },
      });
      if (linked) {
        await this.resolve(tx, claim.id, now, host.id, 'REQUESTER_LINKED');
        return {
          value: null, // 응답은 커밋 뒤의 409다
          event: { event: 'claim.resolved', claimId: claim.id },
          afterCommitError: new ApiError('CLAIM_REQUESTER_LINKED'),
        };
      }
      const revoked = await tx.revokedIdentity.findUnique({
        where: { roomId_keyHash: { roomId, keyHash: claim.requesterKeyHash } },
        select: { roomId: true },
      });
      if (revoked) throw new IdentityInvariantError(roomId, 'REVOKED+PENDING'); // 연결하면 불변식이 깨진다(BE-C4)

      const target = await tx.participant.findUniqueOrThrow({
        where: { id: claim.participantId },
        select: { id: true, identityKeyHash: true },
      });
      if (target.identityKeyHash) {
        await tx.revokedIdentity.create({
          data: {
            roomId,
            keyHash: target.identityKeyHash,
            participantId: target.id,
            revokedAt: now,
          },
        }); // 4번(P-2)
      }
      const participant = await tx.participant.update({
        where: { id: target.id },
        data: { identityKeyHash: claim.requesterKeyHash },
      }); // 5번
      const approved = await this.resolve(tx, claim.id, now, host.id); // 6번
      await tx.claimRequest.updateMany({
        where: { roomId, participantId: target.id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          rejectReason: 'TARGET_CLAIMED',
          resolvedAt: now,
          resolvedById: host.id,
        },
      }); // 7번(P-7)
      return {
        value: { claim: approved, participant: toParticipantDto(participant) },
        event: {
          event: 'claim.resolved',
          claimId: claim.id,
          ...(target.identityKeyHash ? { revokedParticipantId: target.id } : {}),
        },
      };
    });
    return value!;
  }

  /** S1 §4.14 거절: 404 → 409 → `REJECTED`(`HOST_REJECTED`). 신원 연결은 바뀌지 않는다. */
  async reject(roomId: string, hostKeyHash: string, claimId: string): Promise<ClaimDto> {
    const { value } = await this.db.withRoomMutation<ClaimDto>(roomId, async (tx) => {
      const host = await relinkInLock(tx, roomId, hostKeyHash);
      requireHost(host);
      const claim = await this.pendingClaim(tx, roomId, claimId);
      const rejected = await this.resolve(
        tx,
        claim.id,
        await this.db.dbNow(tx),
        host.id,
        'HOST_REJECTED',
      );
      return { value: rejected, event: { event: 'claim.resolved', claimId: claim.id } };
    });
    return value;
  }

  /** 승인·거절의 1·2번: 이 방의 요청이 없으면 404, `PENDING`이 아니면 409(AC-ROOM-009-8). */
  private async pendingClaim(tx: DbTx, roomId: string, claimId: string) {
    const claim = await findClaim(tx, roomId, claimId);
    if (!claim) throw new ApiError('CLAIM_NOT_FOUND');
    if (claim.status !== 'PENDING') throw new ApiError('CLAIM_ALREADY_RESOLVED');
    return claim;
  }

  /** 요청 하나를 승인(사유 없음) 또는 거절로 끝낸다. 처리한 방장의 참여자 ID를 남긴다(AC-ROOM-004-5). */
  private async resolve(
    tx: DbTx,
    claimId: string,
    now: Date,
    hostId: string,
    rejectReason?: 'HOST_REJECTED' | 'REQUESTER_LINKED',
  ): Promise<ClaimDto> {
    const row = await tx.claimRequest.update({
      where: { id: claimId },
      data: {
        status: rejectReason ? 'REJECTED' : 'APPROVED',
        rejectReason: rejectReason ?? null,
        resolvedAt: now,
        resolvedById: hostId,
      },
      select: CLAIM_SELECT,
    });
    return toClaimDto(flattenClaim(row));
  }
}
