import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // `prisma generate`는 DB에 연결하지 않으므로 URL이 없어도 pnpm install(postinstall)이 돌아야 한다.
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://unset:unset@localhost:5432/unset' },
});
