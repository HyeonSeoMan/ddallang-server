import type { DbTx } from '../common/db/database.service.js';

/** 이어받기 요청 응답에 필요한 열. 닉네임은 복제하지 않고 대상 참여자에서 읽는다(PD-21, 닉네임 불변 S1 I8). */
export const CLAIM_SELECT = {
  id: true,
  participantId: true,
  status: true,
  rejectReason: true,
  createdAt: true,
  resolvedAt: true,
  resolvedById: true,
  participant: { select: { nickname: true } },
} as const;

export interface ClaimRow {
  id: string;
  participantId: string;
  status: string;
  rejectReason: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedById: string | null;
  nickname: string;
}

type Selected = Omit<ClaimRow, 'nickname'> & { participant: { nickname: string } };

export const flattenClaim = ({ participant, ...rest }: Selected): ClaimRow => ({
  ...rest,
  nickname: participant.nickname,
});

type Reader = Pick<DbTx, 'claimRequest'>;

/** S1 §4.2 `claim`: 이 키로 만든 요청 중 가장 최근 것(같은 시각이면 ID 내림차순), 없으면 null(S1-C9). */
export async function latestClaimOf(
  db: Reader,
  roomId: string,
  requesterKeyHash: string,
): Promise<ClaimRow | null> {
  const row = await db.claimRequest.findFirst({
    where: { roomId, requesterKeyHash },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: CLAIM_SELECT,
  });
  return row ? flattenClaim(row) : null;
}

/** 이 방의 요청 하나(다른 방의 요청 ID는 없는 것과 같다, AC-SYS-003-8). `requesterKeyHash`를 주면 그 키의 요청만. */
export async function findClaim(
  db: Reader,
  roomId: string,
  claimId: string,
  requesterKeyHash?: string,
): Promise<(ClaimRow & { requesterKeyHash: string }) | null> {
  const row = await db.claimRequest.findFirst({
    where: { id: claimId, roomId, ...(requesterKeyHash ? { requesterKeyHash } : {}) },
    select: { ...CLAIM_SELECT, requesterKeyHash: true },
  });
  return row ? { ...flattenClaim(row), requesterKeyHash: row.requesterKeyHash } : null;
}
