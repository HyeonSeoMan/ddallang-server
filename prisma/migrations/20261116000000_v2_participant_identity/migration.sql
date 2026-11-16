-- BE-M1 (plan §11, PD-21·PD-22): 접속자·참여자 통합(Spec v0.3.0). RoomMember를 없애고 신원 키 해시를 Participant에 둔다.
-- v1.x의 RoomMember와 Participant는 서로 연결이 없어 기계적으로 옮길 수 없으므로 데이터를 옮기지 않는다(PD-22).
-- 방이 하나라도 있으면 아무것도 바꾸지 않고 실패한다. 데이터를 지우려면 먼저 prisma/reset-v1-data.sql을 실행한다
-- (로컬·시험 DB만. 배포 DB는 사용자 승인 뒤에만).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Room") THEN
    RAISE EXCEPTION 'BE-M1: v1.x 데이터가 남아 있다. 데이터는 옮기지 않는다(PD-22). prisma/reset-v1-data.sql로 지운 뒤 다시 적용하라';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RoomMember를 가리키던 참조를 Participant로 옮긴다
-- ---------------------------------------------------------------------------

-- 거래 작성자·삭제자는 참여자 ID다(S2 §2.1, §6.4). 열 이름은 Spec의 필드 이름과 같게 둔다.
ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_authorId_fkey";
ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_deletedById_fkey";
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 멱등 기록: (방, 참여자, 키) 유일(PD-7, S2 §5.1)
ALTER TABLE "IdempotencyRecord" DROP CONSTRAINT "IdempotencyRecord_memberId_fkey";
ALTER TABLE "IdempotencyRecord" RENAME COLUMN "memberId" TO "participantId";
ALTER INDEX "IdempotencyRecord_roomId_memberId_key_key" RENAME TO "IdempotencyRecord_roomId_participantId_key_key";
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 연결 임대: 한도 단위는 참여자다(PD-28, S5 E-9)
ALTER TABLE "StreamLease" DROP CONSTRAINT "StreamLease_memberId_fkey";
ALTER TABLE "StreamLease" RENAME COLUMN "memberId" TO "participantId";
ALTER INDEX "StreamLease_roomId_memberId_idx" RENAME TO "StreamLease_roomId_participantId_idx";
ALTER TABLE "StreamLease" ADD CONSTRAINT "StreamLease_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TABLE "RoomMember";

-- ---------------------------------------------------------------------------
-- Participant: 방장 표시와 신원 키 해시(S1 §2.1, §2.3 I1·I3)
-- ---------------------------------------------------------------------------

ALTER TABLE "Participant" ADD COLUMN "isHost" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Participant" ADD COLUMN "identityKeyHash" TEXT;

-- 신원 키 해시는 SHA-256 소문자 hex 64자(PD-14). 직접 추가한 참여자는 없다(NULL).
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_identityKeyHash_format_check" CHECK ("identityKeyHash" IS NULL OR "identityKeyHash" ~ '^[0-9a-f]{64}$');
-- 방장은 비활성화할 수 없다(I1, P-4). 애플리케이션 검사의 마지막 방어선이다.
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_host_active_check" CHECK (NOT "isHost" OR "status" = 'ACTIVE');
-- 한 방에서 한 해시는 최대 한 참여자에 연결된다(I3)
CREATE UNIQUE INDEX "Participant_roomId_identityKeyHash_key" ON "Participant" ("roomId", "identityKeyHash") WHERE "identityKeyHash" IS NOT NULL;
-- 방마다 방장은 최대 한 명(I1). 정확히 한 명이라는 것은 방 생성 트랜잭션이 보장한다(방장을 바꾸는 경로는 없다).
CREATE UNIQUE INDEX "Participant_roomId_host_key" ON "Participant" ("roomId") WHERE "isHost";

-- ---------------------------------------------------------------------------
-- 이어받기 요청(S1 §2.1, §5.5). 닉네임은 복제하지 않고 대상 참여자에서 읽는다(닉네임 불변, I8)
-- ---------------------------------------------------------------------------

CREATE TABLE "ClaimRequest" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "requesterKeyHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rejectReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedById" TEXT,

    CONSTRAINT "ClaimRequest_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ClaimRequest" ADD CONSTRAINT "ClaimRequest_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimRequest" ADD CONSTRAINT "ClaimRequest_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimRequest" ADD CONSTRAINT "ClaimRequest_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ClaimRequest" ADD CONSTRAINT "ClaimRequest_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELED'));
ALTER TABLE "ClaimRequest" ADD CONSTRAINT "ClaimRequest_rejectReason_check" CHECK ("rejectReason" IS NULL OR "rejectReason" IN ('HOST_REJECTED', 'TARGET_CLAIMED', 'REQUESTER_LINKED'));
ALTER TABLE "ClaimRequest" ADD CONSTRAINT "ClaimRequest_requesterKeyHash_format_check" CHECK ("requesterKeyHash" ~ '^[0-9a-f]{64}$');
-- 거절 사유는 REJECTED일 때만, 처리 시각은 끝난 요청에만, 처리한 방장은 승인·거절에만 있다(취소는 null, AC-ROOM-004-5)
ALTER TABLE "ClaimRequest" ADD CONSTRAINT "ClaimRequest_rejectReason_status_check" CHECK (("rejectReason" IS NOT NULL) = ("status" = 'REJECTED'));
ALTER TABLE "ClaimRequest" ADD CONSTRAINT "ClaimRequest_resolvedAt_status_check" CHECK (("resolvedAt" IS NULL) = ("status" = 'PENDING'));
ALTER TABLE "ClaimRequest" ADD CONSTRAINT "ClaimRequest_resolvedBy_status_check" CHECK (("resolvedById" IS NOT NULL) = ("status" IN ('APPROVED', 'REJECTED')));

-- 한 해시의 PENDING 요청은 방마다 최대 하나(I4, P-8)
CREATE UNIQUE INDEX "ClaimRequest_roomId_requesterKeyHash_pending_key" ON "ClaimRequest" ("roomId", "requesterKeyHash") WHERE "status" = 'PENDING';
-- 대기 목록(S1 §4.12)과 같은 대상의 대기 요청 일괄 거절(§4.13 7)
CREATE INDEX "ClaimRequest_roomId_pending_idx" ON "ClaimRequest" ("roomId", "createdAt", "id") WHERE "status" = 'PENDING';
CREATE INDEX "ClaimRequest_participantId_pending_idx" ON "ClaimRequest" ("participantId") WHERE "status" = 'PENDING';
-- 초대 조회의 "이 키의 가장 최근 요청"(S1 §4.2)
CREATE INDEX "ClaimRequest_roomId_requesterKeyHash_createdAt_idx" ON "ClaimRequest" ("roomId", "requesterKeyHash", "createdAt" DESC, "id" DESC);

-- ---------------------------------------------------------------------------
-- 접근을 잃은 신원(S1 §2.1 RevokedIdentity, S1-C4). 응답 개체가 아닌 서버 내부 기록
-- ---------------------------------------------------------------------------

CREATE TABLE "RevokedIdentity" (
    "roomId" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "revokedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "RevokedIdentity_pkey" PRIMARY KEY ("roomId", "keyHash")
);

ALTER TABLE "RevokedIdentity" ADD CONSTRAINT "RevokedIdentity_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RevokedIdentity" ADD CONSTRAINT "RevokedIdentity_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RevokedIdentity" ADD CONSTRAINT "RevokedIdentity_keyHash_format_check" CHECK ("keyHash" ~ '^[0-9a-f]{64}$');
