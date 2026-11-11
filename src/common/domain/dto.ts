import type { Participant, Room, RoomMember } from '../../generated/prisma/client.js';

/** S1 §2.1의 응답 개체. 서버 내부 필드(`revision`, 신원 키 해시, 닉네임 비교 키)는 싣지 않는다. */
export interface RoomDto {
  id: string;
  name: string;
  unit: string;
  status: string;
  inviteCode: string;
  createdAt: string;
}
export interface RoomMemberDto {
  id: string;
  roomId: string;
  nickname: string;
  isHost: boolean;
  createdAt: string;
}
export interface ParticipantDto {
  id: string;
  roomId: string;
  nickname: string;
  status: string;
  order: number;
  createdAt: string;
}

export const toRoomDto = (
  r: Pick<Room, 'id' | 'name' | 'unit' | 'status' | 'inviteCode' | 'createdAt'>,
): RoomDto => ({
  id: r.id,
  name: r.name,
  unit: r.unit,
  status: r.status,
  inviteCode: r.inviteCode,
  createdAt: r.createdAt.toISOString(),
});

export const toMemberDto = (
  m: Pick<RoomMember, 'id' | 'roomId' | 'nickname' | 'isHost' | 'createdAt'>,
): RoomMemberDto => ({
  id: m.id,
  roomId: m.roomId,
  nickname: m.nickname,
  isHost: m.isHost,
  createdAt: m.createdAt.toISOString(),
});

export const toParticipantDto = (
  p: Pick<Participant, 'id' | 'roomId' | 'nickname' | 'status' | 'order' | 'createdAt'>,
): ParticipantDto => ({
  id: p.id,
  roomId: p.roomId,
  nickname: p.nickname,
  status: p.status,
  order: p.order,
  createdAt: p.createdAt.toISOString(),
});
