-- BE-S5-6: SSE 연결 임대(S5 §4.1, PD-6). 연결 한도(RoomMember당 5, 방당 50)를 서버 인스턴스 전체에서 합산해 지킨다.
CREATE TABLE "StreamLease" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "StreamLease_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StreamLease_roomId_memberId_idx" ON "StreamLease"("roomId", "memberId");
CREATE INDEX "StreamLease_instanceId_idx" ON "StreamLease"("instanceId");
CREATE INDEX "StreamLease_expiresAt_idx" ON "StreamLease"("expiresAt");

ALTER TABLE "StreamLease" ADD CONSTRAINT "StreamLease_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StreamLease" ADD CONSTRAINT "StreamLease_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "RoomMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
