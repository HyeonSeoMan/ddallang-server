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

/** S2 §2.1의 클라이언트 노출 거래. 원본 값·삭제 정보·순번은 서버만 가진다. */
export interface TransactionDto {
  id: string;
  payerId: string;
  payeeId: string;
  amount: number;
  reason: string | null;
  round: string | null;
  authorId: string;
  createdAt: string;
  updatedAt: string;
}

export function toTransactionDto(t: {
  id: string;
  payerId: string;
  payeeId: string;
  amount: bigint;
  reason: string | null;
  round: string | null;
  authorId: string;
  createdAt: Date;
  updatedAt: Date;
}): TransactionDto {
  return {
    id: t.id,
    payerId: t.payerId,
    payeeId: t.payeeId,
    amount: Number(t.amount), // 최대 999,999,999라 안전 정수 범위 안이다(NFR-009)
    reason: t.reason,
    round: t.round,
    authorId: t.authorId,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
