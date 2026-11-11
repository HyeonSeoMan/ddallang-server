-- BE-F7: 방 변경 번호(S5 E-3). 방 행 잠금을 쥔 채 1씩 증가시킨다(PD-4).
ALTER TABLE "Room" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Room" ADD CONSTRAINT "Room_revision_check" CHECK ("revision" >= 0);
