-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "inviteCode" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomMember" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "nicknameKey" TEXT NOT NULL,
    "isHost" BOOLEAN NOT NULL,
    "identityKeyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "RoomMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Participant" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "nicknameKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "Participant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Room_inviteCode_key" ON "Room"("inviteCode");

-- CreateIndex
CREATE UNIQUE INDEX "RoomMember_roomId_identityKeyHash_key" ON "RoomMember"("roomId", "identityKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "RoomMember_roomId_nicknameKey_key" ON "RoomMember"("roomId", "nicknameKey");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_roomId_order_key" ON "Participant"("roomId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_roomId_nicknameKey_key" ON "Participant"("roomId", "nicknameKey");

-- AddForeignKey
ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- 수동 추가: Prisma가 표현하지 못하는 CHECK 제약과 부분 인덱스(PD-2)
-- ---------------------------------------------------------------------------

-- 방 상태와 길이(S1 §2.1, §3.2): 길이는 코드 포인트 수이며 애플리케이션 검증의 마지막 방어선이다.
ALTER TABLE "Room" ADD CONSTRAINT "Room_status_check" CHECK ("status" IN ('IN_PROGRESS', 'ENDED'));
ALTER TABLE "Room" ADD CONSTRAINT "Room_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 12);
ALTER TABLE "Room" ADD CONSTRAINT "Room_unit_length_check" CHECK (char_length("unit") BETWEEN 1 AND 12);
ALTER TABLE "Room" ADD CONSTRAINT "Room_inviteCode_nonempty_check" CHECK (char_length("inviteCode") >= 22);

-- RoomMember: 닉네임 길이, 신원 키 해시는 SHA-256 소문자 hex 64자(PD-14)
ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_nickname_length_check" CHECK (char_length("nickname") BETWEEN 1 AND 12);
ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_nicknameKey_length_check" CHECK (char_length("nicknameKey") BETWEEN 1 AND 12);
ALTER TABLE "RoomMember" ADD CONSTRAINT "RoomMember_identityKeyHash_format_check" CHECK ("identityKeyHash" ~ '^[0-9a-f]{64}$');

-- 방마다 방장은 최대 한 명(S1 §2.2 I1). 정확히 한 명이라는 것은 방 생성 트랜잭션이 보장한다(방장을 바꾸는 경로는 없다).
CREATE UNIQUE INDEX "RoomMember_roomId_host_key" ON "RoomMember" ("roomId") WHERE "isHost";

-- Participant: 상태, 양의 정수 order(S1 §2.1), 닉네임 길이
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_status_check" CHECK ("status" IN ('ACTIVE', 'INACTIVE'));
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_order_positive_check" CHECK ("order" > 0);
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_nickname_length_check" CHECK (char_length("nickname") BETWEEN 1 AND 12);
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_nicknameKey_length_check" CHECK (char_length("nicknameKey") BETWEEN 1 AND 12);
