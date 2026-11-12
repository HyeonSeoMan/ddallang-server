import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../common/db/database.service.js';
import { PrismaService } from '../common/db/prisma.service.js';
import { toMemberDto, toRoomDto, type RoomDto, type RoomMemberDto } from '../common/domain/dto.js';
import { MEMBER_LIMIT } from '../common/domain/limits.js';
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

export interface JoinResult {
  /** 새 RoomMember를 만들었으면 true(201), 같은 키로 복원했으면 false(200) */
  created: boolean;
  room: Pick<RoomDto, 'id' | 'name' | 'unit' | 'status'>;
  me: RoomMemberDto;
}

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DatabaseService,
  ) {}

  /** S1 §4.1: 방, 최초 RoomMember(방장), 초대 코드를 한 트랜잭션에서 만든다. 검증이 하나라도 실패하면 아무것도 만들지 않는다. */
  async createRoom(
    identityKeyHash: string,
    input: BodyInput,
  ): Promise<{ room: RoomDto; me: RoomMemberDto }> {
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
        members: {
          create: {
            id: newId(),
            nickname: nickname!,
            nicknameKey: nicknameKey(nickname!),
            isHost: true,
            identityKeyHash,
          },
        },
      },
      include: { members: true },
    });
    return { room: toRoomDto(room), me: toMemberDto(room.members[0]!) };
  }

  /** S1 §4.2: 입장 전에 공개하는 것은 이름·정산 단위·진행 상태와 `isMember`뿐이다. */
  async getInvite(
    inviteCode: string,
    identityKeyHash: string | undefined,
  ): Promise<{ room: Pick<RoomDto, 'name' | 'unit' | 'status'>; isMember: boolean }> {
    const room = await this.prisma.client.room.findUnique({
      where: { inviteCode },
      select: { id: true, name: true, unit: true, status: true },
    });
    if (!room) throw new ApiError('INVITE_NOT_FOUND');
    let isMember = false;
    if (identityKeyHash) {
      const member = await this.prisma.client.roomMember.findUnique({
        where: { roomId_identityKeyHash: { roomId: room.id, identityKeyHash } },
        select: { id: true },
      });
      isMember = member !== null;
    }
    return { room: { name: room.name, unit: room.unit, status: room.status }, isMember };
  }

  /**
   * S1 §4.3: 같은 키의 RoomMember가 있으면 복원(닉네임·한도 검사 없음), 없으면 §3.3의 7(검증)→8(닉네임 중복)→9(한도)
   * 순서로 판정해 새로 만든다. 판정과 삽입은 방 잠금 안의 한 트랜잭션이라 마지막 슬롯·같은 닉네임·같은 키의
   * 동시 요청에서도 정확히 하나만 만들어진다. 입장은 `revision`·이벤트를 만들지 않는다(N-5).
   */
  async join(inviteCode: string, identityKeyHash: string, input: BodyInput): Promise<JoinResult> {
    const room = await this.prisma.client.room.findUnique({
      where: { inviteCode },
      select: { id: true, name: true, unit: true, status: true },
    });
    if (!room) throw new ApiError('INVITE_NOT_FOUND');
    const roomDto = { id: room.id, name: room.name, unit: room.unit, status: room.status };

    const existing = await this.prisma.client.roomMember.findUnique({
      where: { roomId_identityKeyHash: { roomId: room.id, identityKeyHash } },
    });
    if (existing) return { created: false, room: roomDto, me: toMemberDto(existing) };

    return this.db.withRoomLock(room.id, async (tx) => {
      // 방 상태는 잠금 안에서 다시 읽는다(응답이 커밋 시점과 같은 상태를 말하도록).
      const locked = await tx.room.findUniqueOrThrow({
        where: { id: room.id },
        select: { status: true },
      });
      const lockedRoom = { ...roomDto, status: locked.status };
      // 같은 키의 동시 입장: 먼저 잠금을 얻은 요청이 만들었으면 나머지는 같은 RoomMember를 복원한다.
      // 복원 판정이 검증(7번)보다 앞서므로 검증은 이 재확인 뒤에 한다(S1 §3.3, §4.3).
      const again = await tx.roomMember.findUnique({
        where: { roomId_identityKeyHash: { roomId: room.id, identityKeyHash } },
      });
      if (again) return { created: false, room: lockedRoom, me: toMemberDto(again) };

      const body = asObject(requireJsonBody(input));
      const details: FieldDetail[] = [];
      const nickname = strictTextField(body, 'nickname', details);
      throwIfInvalid(details);

      const key = nicknameKey(nickname!);
      const taken = await tx.roomMember.findUnique({
        where: { roomId_nicknameKey: { roomId: room.id, nicknameKey: key } },
        select: { id: true },
      });
      if (taken) throw new ApiError('NICKNAME_TAKEN'); // 8번이 9번보다 앞이다
      const count = await tx.roomMember.count({ where: { roomId: room.id } });
      if (count >= MEMBER_LIMIT) {
        throw new ApiError('MEMBER_LIMIT_EXCEEDED', { details: [{ limit: MEMBER_LIMIT }] });
      }
      const member = await tx.roomMember.create({
        data: {
          id: newId(),
          roomId: room.id,
          nickname: nickname!,
          nicknameKey: key,
          isHost: false,
          identityKeyHash,
        },
      });
      return { created: true, room: lockedRoom, me: toMemberDto(member) };
    });
  }

  /** S1 §4.4. 방 존재·멤버 여부는 가드가 이미 판정했다. */
  async getRoom(roomId: string): Promise<RoomDto> {
    const room = await this.prisma.client.room.findUnique({ where: { id: roomId } });
    if (!room) throw new ApiError('ROOM_NOT_FOUND');
    return toRoomDto(room);
  }
}
