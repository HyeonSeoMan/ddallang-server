import type { DbTx } from '../db/database.service.js';
import { ApiError } from '../errors/api-error.js';

/** 신원 키가 연결된 참여자(S1 §2.1 응답 필드와 같다). 키 해시는 담지 않는다. */
export interface LinkedParticipant {
  id: string;
  roomId: string;
  nickname: string;
  status: string;
  order: number;
  isHost: boolean;
  createdAt: Date;
}

/** S1 §2.2: 한 방에서 신원 키 해시의 상태. */
export type IdentityState =
  | { kind: 'LINKED'; participant: LinkedParticipant }
  | { kind: 'REVOKED' }
  | { kind: 'PENDING'; claimId: string }
  | { kind: 'NONE' };

/** S1 §2.3 I4를 어기는 상태. 조용히 하나를 고르지 않고 500으로 실패시킨다(PD-23, BE-C4). */
export class IdentityInvariantError extends Error {
  constructor(roomId: string, states: string) {
    // 키 해시는 메시지·로그에 싣지 않는다(S1 §10, PD-14)
    super(`identity invariant violated in room ${roomId}: ${states}`);
    this.name = 'IdentityInvariantError';
  }
}

type Row = {
  id: string | null;
  roomId: string | null;
  nickname: string | null;
  status: string | null;
  order: number | null;
  isHost: boolean | null;
  createdAt: Date | null;
  revoked: boolean;
  pendingClaimId: string | null;
};

/** `$queryRaw`만 쓰므로 트랜잭션 클라이언트와 일반 클라이언트 모두 받는다. */
type Queryable = Pick<DbTx, '$queryRaw'>;

/**
 * PD-23: (방, 키 해시)의 상태를 **한 질의**로 판정한다. 순서는 LINKED → REVOKED → PENDING → NONE이다.
 * - LINKED와 PENDING이 함께 해당하면 LINKED다(Spec이 정한 경합·우회 결과, S1 §4.13 3, AC-ROOM-009-14).
 *   남은 PENDING 요청은 승인 3단계가 처리한다.
 * - 그 밖에 둘 이상 해당하면(LINKED+REVOKED, REVOKED+PENDING) `IdentityInvariantError`(500)다.
 */
export async function resolveIdentity(
  db: Queryable,
  roomId: string,
  keyHash: string,
): Promise<IdentityState> {
  const [row] = await db.$queryRaw<Row[]>`
    SELECT p."id", p."roomId", p."nickname", p."status", p."order", p."isHost", p."createdAt",
           EXISTS (SELECT 1 FROM "RevokedIdentity" r WHERE r."roomId" = ${roomId} AND r."keyHash" = ${keyHash}) AS "revoked",
           (SELECT c."id" FROM "ClaimRequest" c
             WHERE c."roomId" = ${roomId} AND c."requesterKeyHash" = ${keyHash} AND c."status" = 'PENDING') AS "pendingClaimId"
    FROM (SELECT 1) AS one
    LEFT JOIN "Participant" p ON p."roomId" = ${roomId} AND p."identityKeyHash" = ${keyHash}`;
  const linked = row!.id !== null;
  const { revoked, pendingClaimId } = row!;
  if (linked && revoked) throw new IdentityInvariantError(roomId, 'LINKED+REVOKED');
  if (revoked && pendingClaimId) throw new IdentityInvariantError(roomId, 'REVOKED+PENDING');
  if (linked) {
    return {
      kind: 'LINKED',
      participant: {
        id: row!.id!,
        roomId: row!.roomId!,
        nickname: row!.nickname!,
        status: row!.status!,
        order: row!.order!,
        isHost: row!.isHost!,
        createdAt: row!.createdAt!,
      },
    };
  }
  if (revoked) return { kind: 'REVOKED' };
  if (pendingClaimId) return { kind: 'PENDING', claimId: pendingClaimId };
  return { kind: 'NONE' };
}

/**
 * `/rooms/{roomId}/…`의 요청자 판정(S1 §3.3 3번): LINKED만 통과한다. 접근 상실은 `401 IDENTITY_REVOKED`,
 * 신원 없음·대기는 없는 방과 같은 `404 ROOM_NOT_FOUND`다. 가드와 방 잠금 안의 재확인(PD-24)이 함께 쓴다.
 */
export function requireLinked(state: IdentityState): LinkedParticipant {
  if (state.kind === 'LINKED') return state.participant;
  if (state.kind === 'REVOKED') throw new ApiError('IDENTITY_REVOKED');
  throw new ApiError('ROOM_NOT_FOUND');
}

/**
 * 방 잠금 안의 재확인(PD-24, S2-C3): 잠금을 얻은 시점의 상태로 요청자를 다시 판정한다. 잠금 밖의 1차 판정(가드)은
 * 빠른 거부용이며 결과를 확정하지 않는다. 반환값은 잠금 안에서 읽은 최신 참여자(상태·방장 여부)다.
 */
export async function relinkInLock(
  tx: DbTx,
  roomId: string,
  keyHash: string,
): Promise<LinkedParticipant> {
  return requireLinked(await resolveIdentity(tx, roomId, keyHash));
}
