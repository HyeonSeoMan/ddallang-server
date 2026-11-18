-- 운영 DB(Supabase)는 public 스키마의 표를 Data API(PostgREST)로 공개한다. 모든 표에 RLS를 켜고 정책을 두지 않아
-- Data API 역할(anon, authenticated)이 행에 접근하지 못하게 한다(Supabase 보안 경고 rls_disabled_in_public).
-- 앱은 표 소유자로 직접 연결하므로 RLS를 우회한다(FORCE ROW LEVEL SECURITY를 쓰지 않는다).
-- 새 표를 만드는 마이그레이션도 같은 마이그레이션 안에서 RLS를 켠다(test/db/rls.spec.ts가 확인한다).
ALTER TABLE "Room" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Participant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClaimRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevokedIdentity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Transaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdempotencyRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StreamLease" ENABLE ROW LEVEL SECURITY;

-- `_prisma_migrations`는 `prisma migrate deploy`가 만드는 이력 표라 시험의 격리 스키마에는 없을 수 있다.
-- Supabase 전용 역할은 다른 Postgres(로컬·시험)에는 없으므로 있을 때만 권한을 회수한다. 지금 있는 표의 권한과 함께,
-- 이 연결 역할이 앞으로 이 스키마에 만드는 표에 자동으로 주는 기본 권한도 회수한다.
-- 다른 역할(예: supabase_admin)이 준 기본 권한은 그 역할이 만드는 표에만 적용되므로 남겨 둔다. 앱 표는 모두 이 역할이 만든다.
DO $$
BEGIN
  IF to_regclass('"_prisma_migrations"') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM anon', current_schema());
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM anon', current_schema());
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM authenticated', current_schema());
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM authenticated', current_schema());
  END IF;
END $$;
