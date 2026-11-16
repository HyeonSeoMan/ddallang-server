import { Injectable } from '@nestjs/common';
import { relinkInLock } from '../common/auth/identity.js';
import { requireHost } from '../common/auth/participant.guard.js';
import { DatabaseService } from '../common/db/database.service.js';
import { PrismaService } from '../common/db/prisma.service.js';
import { toParticipantDto, type ParticipantDto } from '../common/domain/dto.js';
import { createParticipant } from '../common/domain/participants.js';
import { ApiError } from '../common/errors/api-error.js';
import {
  asObject,
  isPlainObject,
  strictTextField,
  throwIfInvalid,
  type FieldDetail,
} from '../common/http/fields.js';
import { requireJsonBody, type BodyInput } from '../common/http/json-body.js';

const STATUSES = ['ACTIVE', 'INACTIVE'] as const;

@Injectable()
export class ParticipantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DatabaseService,
  ) {}

  /** S1 §4.5: `order` 오름차순, 비활성 포함, 방 상태와 무관. */
  async list(roomId: string): Promise<ParticipantDto[]> {
    const rows = await this.prisma.client.participant.findMany({
      where: { roomId },
      orderBy: { order: 'asc' },
    });
    return rows.map(toParticipantDto);
  }

  /**
   * S1 §4.6(검사 순서 §3.3 5·7·8·9, 1~4는 가드와 컨트롤러): 방 상태 → 입력 검증 → 닉네임 중복 → 한도.
   * 모두 방 잠금 안의 한 트랜잭션이며 `order`도 잠금 안에서 부여하므로 동시 등록에서도 유일하고 처리 순서와 같다.
   * 잠금을 얻은 뒤 요청자(연결·방장)를 다시 확인한다(PD-24). 직접 추가한 참여자는 신원 키가 없다(OQ-042).
   */
  async create(roomId: string, identityKeyHash: string, input: BodyInput): Promise<ParticipantDto> {
    const { value } = await this.db.withRoomMutation(roomId, async (tx) => {
      requireHost(await relinkInLock(tx, roomId, identityKeyHash)); // 3·4번 재확인
      const room = await tx.room.findUniqueOrThrow({
        where: { id: roomId },
        select: { status: true },
      });
      if (room.status === 'ENDED') throw new ApiError('GAME_ENDED'); // 5번

      const body = asObject(requireJsonBody(input)); // 7번
      const details: FieldDetail[] = [];
      const nickname = strictTextField(body, 'nickname', details);
      throwIfInvalid(details);

      const participant = await createParticipant(tx, roomId, nickname!); // 8·9번
      return {
        value: toParticipantDto(participant),
        event: { event: 'participant.created', participantId: participant.id },
      };
    });
    return value;
  }

  /**
   * S1 §4.7(검사 순서 5 → 6 → 7 → 8): 방 상태 → 대상 존재(다른 방의 ID도 같은 404) → 입력 검증(`status` 한 필드만)
   * → 방장 비활성화 금지(`HOST_CANNOT_BE_DEACTIVATED`, P-4). 현재 값과 같으면 아무것도 바꾸지 않고 현재 참여자를
   * 돌려주며 `revision`·이벤트를 만들지 않는다(N-4). 비활성 참여자의 신원은 연결된 채로 남는다(OQ-044).
   */
  async setStatus(
    roomId: string,
    identityKeyHash: string,
    participantId: string,
    input: BodyInput,
  ): Promise<ParticipantDto> {
    const { value } = await this.db.withRoomMutation(roomId, async (tx) => {
      requireHost(await relinkInLock(tx, roomId, identityKeyHash)); // 3·4번 재확인
      const room = await tx.room.findUniqueOrThrow({
        where: { id: roomId },
        select: { status: true },
      });
      if (room.status === 'ENDED') throw new ApiError('GAME_ENDED'); // 5번
      const participant = await tx.participant.findFirst({ where: { id: participantId, roomId } });
      if (!participant) throw new ApiError('PARTICIPANT_NOT_FOUND'); // 6번

      const raw = requireJsonBody(input); // 7번
      const body = asObject(raw);
      const details: FieldDetail[] = [];
      for (const field of Object.keys(body)) {
        if (field !== 'status') details.push({ field, code: 'NOT_ALLOWED_FIELD' });
      }
      const status = body['status'];
      if (status === undefined || status === null)
        details.push({ field: 'status', code: 'REQUIRED' });
      else if (typeof status !== 'string') details.push({ field: 'status', code: 'INVALID_TYPE' });
      else if (!(STATUSES as readonly string[]).includes(status))
        details.push({ field: 'status', code: 'INVALID_VALUE' });
      throwIfInvalid(details);

      if (participant.isHost && status === 'INACTIVE')
        throw new ApiError('HOST_CANNOT_BE_DEACTIVATED'); // 8번
      if (!isPlainObject(raw) || status === participant.status)
        return { value: toParticipantDto(participant) };
      const updated = await tx.participant.update({
        where: { id: participantId },
        data: { status: status as string },
      });
      return {
        value: toParticipantDto(updated),
        event: { event: 'participant.status_changed', participantId },
      };
    });
    return value;
  }
}
