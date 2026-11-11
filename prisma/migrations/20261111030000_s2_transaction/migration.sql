-- BE-S2-1: 거래(S2 §2.1, §6.4). 삭제는 행을 지우지 않고 deletedAt을 채운다. 방마다 seq는 1부터 증가한다(S3 C-1).
ALTER TABLE "Room" ADD COLUMN "nextTxnSeq" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Room" ADD COLUMN "lastTxnCreatedAt" TIMESTAMPTZ(3);
ALTER TABLE "Room" ADD CONSTRAINT "Room_nextTxnSeq_check" CHECK ("nextTxnSeq" >= 1);

CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "payerId" TEXT NOT NULL,
    "payeeId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT,
    "round" TEXT,
    "authorId" TEXT NOT NULL,
    "originalAmount" BIGINT NOT NULL,
    "originalReason" TEXT,
    "originalRound" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" TEXT,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Transaction_roomId_seq_key" ON "Transaction"("roomId", "seq");

ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "RoomMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "RoomMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 수동 추가(PD-2): 금액 1..999,999,999(T-I2), 지급자 ≠ 수취자(T-I1), 사유·라운드 길이, 삭제 표시는 한 쌍
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_amount_check" CHECK ("amount" BETWEEN 1 AND 999999999);
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_originalAmount_check" CHECK ("originalAmount" BETWEEN 1 AND 999999999);
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_parties_check" CHECK ("payerId" <> "payeeId");
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_seq_check" CHECK ("seq" >= 1);
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_reason_length_check" CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 50);
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_round_length_check" CHECK ("round" IS NULL OR char_length("round") BETWEEN 1 AND 12);
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_originalReason_length_check" CHECK ("originalReason" IS NULL OR char_length("originalReason") BETWEEN 1 AND 50);
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_originalRound_length_check" CHECK ("originalRound" IS NULL OR char_length("originalRound") BETWEEN 1 AND 12);
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_deleted_pair_check" CHECK (("deletedAt" IS NULL) = ("deletedById" IS NULL));
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_updated_check" CHECK ("updatedAt" >= "createdAt");

-- 유효 거래(삭제되지 않은 행) 부분 인덱스: 목록·순손익 집계가 쓴다(S3)
CREATE INDEX "Transaction_roomId_valid_idx" ON "Transaction" ("roomId", "seq") WHERE "deletedAt" IS NULL;
