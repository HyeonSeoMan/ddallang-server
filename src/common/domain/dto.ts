import type { ClaimRequest, Participant, Room } from '../../generated/prisma/client.js';

/** S1 §2.1의 응답 개체. 서버 내부 필드(`revision`, 신원 키 해시, 닉네임 비교 키)는 싣지 않는다. */
export interface RoomDto {
  id: string;
  name: string;
  unit: string;
  status: string;
  inviteCode: string;
  createdAt: string;
}
/** 신원 연결 여부는 응답에 담지 않는다(S1-C6). */
export interface ParticipantDto {
  id: string;
  roomId: string;
  nickname: string;
  status: string;
  order: number;
  isHost: boolean;
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

export const toParticipantDto = (
  p: Pick<Participant, 'id' | 'roomId' | 'nickname' | 'status' | 'order' | 'isHost' | 'createdAt'>,
): ParticipantDto => ({
  id: p.id,
  roomId: p.roomId,
  nickname: p.nickname,
  status: p.status,
  order: p.order,
  isHost: p.isHost,
  createdAt: p.createdAt.toISOString(),
});

/**
 * S1 §4의 이어받기 요청 두 형태(S1-C13). 요청자용 `MyClaim`에는 대상 참여자 ID와 처리한 방장 ID가 없다
 * (요청자는 아직 방 비참여자다, AC-ROOM-004-1). 요청 키 해시는 어느 쪽에도 없다.
 */
export interface MyClaimDto {
  id: string;
  nickname: string;
  status: string;
  rejectReason: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
export interface ClaimDto extends MyClaimDto {
  participantId: string;
  resolvedById: string | null;
}

type ClaimRow = Pick<
  ClaimRequest,
  'id' | 'participantId' | 'status' | 'rejectReason' | 'createdAt' | 'resolvedAt' | 'resolvedById'
> & { nickname: string };

export const toMyClaimDto = (c: ClaimRow): MyClaimDto => ({
  id: c.id,
  nickname: c.nickname,
  status: c.status,
  rejectReason: c.rejectReason,
  createdAt: c.createdAt.toISOString(),
  resolvedAt: c.resolvedAt?.toISOString() ?? null,
});

export const toClaimDto = (c: ClaimRow): ClaimDto => ({
  id: c.id,
  participantId: c.participantId,
  nickname: c.nickname,
  status: c.status,
  rejectReason: c.rejectReason,
  createdAt: c.createdAt.toISOString(),
  resolvedAt: c.resolvedAt?.toISOString() ?? null,
  resolvedById: c.resolvedById,
});

/** S2 §2.1의 클라이언트 노출 거래. 원본 값·삭제 정보·순번은 서버만 가진다. */
export interface TransactionDto {
  id: string;
  payerId: string;
  payeeId: string;
  amount: number;
  reason: string | null;
  round: string | null;
  /** 작성자 Participant ID(이어받기 뒤에도 바뀌지 않는다, S2 §2.1) */
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
