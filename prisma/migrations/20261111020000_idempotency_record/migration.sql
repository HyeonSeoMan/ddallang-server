-- BE-F6: 멱등 기록(S2 §5, PD-7). (방, RoomMember, 키)가 유일하고 거래·종료 변경과 같은 트랜잭션에서 쓴다.
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "firstAttemptAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IdempotencyRecord_roomId_memberId_key_key" ON "IdempotencyRecord"("roomId", "memberId", "key");
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "RoomMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 수동 추가(PD-2): 연산 종류, 지문(SHA-256 hex), 키 형식(S2 §5.1), 만료는 최초 시도 이후
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_operation_check" CHECK ("operation" IN ('CREATE', 'UPDATE', 'DELETE', 'END'));
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$');
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_key_check" CHECK ("key" ~ '^[A-Za-z0-9_-]{16,64}$');
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_expires_check" CHECK ("expiresAt" > "firstAttemptAt");
