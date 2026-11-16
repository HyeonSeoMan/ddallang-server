import { Injectable } from '@nestjs/common';
import { resolveIdentity, type IdentityState } from '../common/auth/identity.js';
import { DatabaseService } from '../common/db/database.service.js';
import { PrismaService } from '../common/db/prisma.service.js';
import { createParticipant } from '../common/domain/participants.js';
import {
  toMyClaimDto,
  toParticipantDto,
  toRoomDto,
  type MyClaimDto,
  type ParticipantDto,
  type RoomDto,
} from '../common/domain/dto.js';
import { ApiError } from '../common/errors/api-error.js';
import {
  asObject,
  strictTextField,
  throwIfInvalid,
  type FieldDetail,
} from '../common/http/fields.js';
import { requireJsonBody, type BodyInput } from '../common/http/json-body.js';
import { newId, newInviteCode } from '../common/ids/ids.js';
import { nicknameKey } from '../common/validation/index.js';
import { latestClaimOf } from './claim-queries.js';

export type RoomSummary = Pick<RoomDto, 'id' | 'name' | 'unit' | 'status'>;

export interface JoinResult {
  /** 새 참여자를 만들었으면 true(201), 같은 키로 복원했으면 false(200) */
  created: boolean;
  room: RoomSummary;
  me: ParticipantDto;
}

/** 초대 조회의 신원 상태(S1 §4.2). LINKED는 `PARTICIPANT`로 알린다. */
export type InviteIdentity = 'NONE' | 'PARTICIPANT' | 'PENDING' | 'REVOKED';

export interface InviteView {
  room: Pick<RoomDto, 'name' | 'unit' | 'status'>;
  identity: InviteIdentity;
  claim: MyClaimDto | null;
  claimableNicknames: string[];
}

/** 입장의 `NICKNAME_TAKEN`·`PARTICIPANT_LIMIT_EXCEEDED`는 이어받기를 안내한다(S1 §4.3, AC-ROOM-002-6, 008-8). */
const JOIN_NICKNAME_TAKEN =
  '이미 사용 중인 닉네임입니다. 이 방의 기존 참여자라면 그 닉네임으로 이어받기를 요청할 수 있습니다.';
const JOIN_LIMIT_EXCEEDED =
  '참여자가 가득 찼습니다. 이 방의 기존 참여자라면 이어받기를 요청할 수 있습니다.';

const INVITE_IDENTITY: Record<IdentityState['kind'], InviteIdentity> = {
  LINKED: 'PARTICIPANT',
  PENDING: 'PENDING',
  REVOKED: 'REVOKED',
  NONE: 'NONE',
};

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DatabaseService,
  ) {}

  /**
   * S1 §4.1: 방과 첫 참여자(방장, `order = 1`, 이 키에 연결)를 한 트랜잭션에서 만든다. 검증이 하나라도 실패하면
   * 아무것도 만들지 않는다. 새 방이므로 연결된 스트림이 없고 `revision`을 소비하지 않는다.
   */
  async createRoom(
    identityKeyHash: string,
    input: BodyInput,
  ): Promise<{ room: RoomDto; me: ParticipantDto }> {
    const body = asObject(requireJsonBody(input)); // 7번: 본문 파싱 실패는 검증 차례에 422
    const details: FieldDetail[] = [];
    const name = strictTextField(body, 'name', details);
    const unit = strictTextField(body, 'unit', details);
    const nickname = strictTextField(body, 'nickname', details);
    throwIfInvalid(details);

    const room = await this.prisma.client.room.create({
      data: {
        id: newId(),
        name: name!,
        unit: unit!,
        inviteCode: newInviteCode(),
        participants: {
          create: {
            id: newId(),
            nickname: nickname!,
            nicknameKey: nicknameKey(nickname!),
            order: 1,
            isHost: true,
            identityKeyHash,
          },
        },
      },
      include: { participants: true },
    });
    return { room: toRoomDto(room), me: toParticipantDto(room.participants[0]!) };
  }

  /**
   * S1 §4.2: 입장 전에 공개하는 것은 이름·정산 단위·진행 상태, 자기 신원 상태와 최근 이어받기 요청, 이어받기 후보
   * 닉네임뿐이다. 후보는 방장을 뺀 모든 참여자(활성·비활성, 신원 연결 여부 무관)를 `order` 순으로, 신원이 없음·접근
   * 상실일 때만 채운다. 한 스냅샷에서 읽는다. 이 경로는 접근 상실을 401로 거부하지 않고 `REVOKED`로 알린다.
   */
  async getInvite(inviteCode: string, identityKeyHash: string | undefined): Promise<InviteView> {
    return this.db.readSnapshot(async (tx) => {
      const room = await tx.room.findUnique({
        where: { inviteCode },
        select: { id: true, name: true, unit: true, status: true },
      });
      if (!room) throw new ApiError('INVITE_NOT_FOUND');
      const state: IdentityState = identityKeyHash
        ? await resolveIdentity(tx, room.id, identityKeyHash)
        : { kind: 'NONE' };
      const claim = identityKeyHash ? await latestClaimOf(tx, room.id, identityKeyHash) : null;
      const showCandidates = state.kind === 'NONE' || state.kind === 'REVOKED';
      const candidates = showCandidates
        ? await tx.participant.findMany({
            where: { roomId: room.id, isHost: false },
            orderBy: { order: 'asc' },
            select: { nickname: true },
          })
        : [];
      return {
        room: { name: room.name, unit: room.unit, status: room.status },
        identity: INVITE_IDENTITY[state.kind],
        claim: claim ? toMyClaimDto(claim) : null,
        claimableNicknames: candidates.map((c) => c.nickname),
      };
    });
  }

  /**
   * S1 §4.3: 키의 이 방 상태로 분기한다. 판정과 변경을 모두 방 잠금 안에서 하고 잠금을 얻은 뒤 상태를 다시 읽는다
   * (PD-24). LINKED는 복원(200, 닉네임·게임 상태·한도 검사 없음, 이벤트 없음), REVOKED는 401, PENDING은
   * `CLAIM_PENDING`, NONE은 새 참여자다: 종료(5) → 검증(7) → 닉네임 중복(8) → 한도(9) 순서이며 `participant.created`
   * 로 `revision`을 소비한다. 같은 키·같은 닉네임·마지막 슬롯의 동시 요청에서도 정확히 하나만 만들어진다.
   */
  async join(inviteCode: string, identityKeyHash: string, input: BodyInput): Promise<JoinResult> {
    const found = await this.prisma.client.room.findUnique({
      where: { inviteCode },
      select: { id: true },
    });
    if (!found) throw new ApiError('INVITE_NOT_FOUND');
    const roomId = found.id;

    const { value } = await this.db.withRoomMutation<JoinResult>(roomId, async (tx) => {
      const room = await tx.room.findUniqueOrThrow({
        where: { id: roomId },
        select: { id: true, name: true, unit: true, status: true },
      });
      const state = await resolveIdentity(tx, roomId, identityKeyHash);
      if (state.kind === 'LINKED') {
        return { value: { created: false, room, me: toParticipantDto(state.participant) } };
      }
      if (state.kind === 'REVOKED') throw new ApiError('IDENTITY_REVOKED');
      if (state.kind === 'PENDING') throw new ApiError('CLAIM_PENDING');

      if (room.status === 'ENDED') throw new ApiError('GAME_ENDED'); // 5번(OQ-043)
      const body = asObject(requireJsonBody(input)); // 7번
      const details: FieldDetail[] = [];
      const nickname = strictTextField(body, 'nickname', details);
      throwIfInvalid(details);
      const participant = await createParticipant(tx, roomId, nickname!, {
        identityKeyHash,
        nicknameTakenMessage: JOIN_NICKNAME_TAKEN,
        limitMessage: JOIN_LIMIT_EXCEEDED,
      });
      return {
        value: { created: true, room, me: toParticipantDto(participant) },
        event: { event: 'participant.created', participantId: participant.id },
      };
    });
    return value;
  }

  /** S1 §4.4. 방 존재·요청자는 가드가 이미 판정했다. */
  async getRoom(roomId: string): Promise<RoomDto> {
    const room = await this.prisma.client.room.findUnique({ where: { id: roomId } });
    if (!room) throw new ApiError('ROOM_NOT_FOUND');
    return toRoomDto(room);
  }
}
