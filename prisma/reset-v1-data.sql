-- BE-M1 (PD-22): v1.x 스키마의 데이터를 모두 지운다. 마이그레이션 20261116000000_v2_participant_identity는
-- 방이 하나라도 있으면 실패하므로 그 전에 이 파일을 실행한다. 스키마는 바꾸지 않는다.
--
-- 로컬·시험 DB에서만 실행한다. 배포 DB(Supabase)에서 실행하는 것은 데이터 삭제이므로 사용자 승인 뒤에만 한다
-- (프론트엔드 2.0.0과 같은 시점, RK-20). 실행 예: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/reset-v1-data.sql
BEGIN;
DELETE FROM "StreamLease";
DELETE FROM "IdempotencyRecord";
DELETE FROM "Transaction";
DELETE FROM "Participant";
DELETE FROM "RoomMember";
DELETE FROM "Room";
COMMIT;
