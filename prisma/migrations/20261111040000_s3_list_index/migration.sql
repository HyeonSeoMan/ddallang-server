-- BE-S3-2 (S2 §2.3.1 5 / S3 §2.3.1 5): 거래 목록 질의용 (방, 생성 시각 내림차순, 순번 내림차순) 인덱스. 삭제 행은 제외한다.
CREATE INDEX "Transaction_roomId_createdAt_seq_valid_idx" ON "Transaction" ("roomId", "createdAt" DESC, "seq" DESC) WHERE "deletedAt" IS NULL;
