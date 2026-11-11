import { Controller, Get, Module, Param, Post } from '@nestjs/common';
import { DatabaseService } from '../../src/common/db/database.service.js';
import { PrismaService } from '../../src/common/db/prisma.service.js';
import type { Env } from '../../src/common/config/env.js';
import { ENV } from '../../src/common/config/env.token.js';

/**
 * BE-F8 하네스 자체 시험 전용 프로브. `dist-test`에서만 빌드하며 운영 dist·AppModule·Swagger에는 없다.
 * 시험용 "Room"(id, revision) 테이블을 전제로 한다.
 */
@Controller('__probe/rooms')
class ProbeController {
  constructor(
    private readonly db: DatabaseService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':id')
  async get(@Param('id') id: string): Promise<{ revision: number; pid: number }> {
    const rows = await this.prisma.client.$queryRaw<{ revision: number }[]>`
      SELECT "revision" FROM "Room" WHERE "id" = ${id}`;
    return { revision: rows[0]!.revision, pid: process.pid };
  }

  /** withRoomLock 안에서 읽고 쓴다(경쟁에 안전해야 한다). */
  @Post(':id/increment')
  async increment(@Param('id') id: string): Promise<{ revision: number; pid: number }> {
    const revision = await this.db.withRoomLock(id, async (tx) => {
      const rows = await tx.$queryRaw<{ revision: number }[]>`
        SELECT "revision" FROM "Room" WHERE "id" = ${id}`;
      const next = rows[0]!.revision + 1;
      await tx.$executeRaw`UPDATE "Room" SET "revision" = ${next} WHERE "id" = ${id}`;
      return next;
    });
    return { revision, pid: process.pid };
  }

  /** 음성 대조: 잠금 없이 읽고 지연 뒤 쓴다. 동시 실행에서 갱신이 유실되어야 한다. */
  @Post(':id/increment-unsafe')
  async incrementUnsafe(@Param('id') id: string): Promise<{ revision: number; pid: number }> {
    const rows = await this.prisma.client.$queryRaw<{ revision: number }[]>`
      SELECT "revision" FROM "Room" WHERE "id" = ${id}`;
    const next = rows[0]!.revision + 1;
    await new Promise((r) => setTimeout(r, 30));
    await this.prisma.client.$executeRaw`UPDATE "Room" SET "revision" = ${next} WHERE "id" = ${id}`;
    return { revision: next, pid: process.pid };
  }
}

@Module({
  controllers: [ProbeController],
  providers: [
    { provide: PrismaService, useFactory: (env: Env) => new PrismaService(env), inject: [ENV] },
    {
      provide: DatabaseService,
      useFactory: (prisma: PrismaService, env: Env) => new DatabaseService(prisma, env),
      inject: [PrismaService, ENV],
    },
  ],
})
export class ProbeModule {}
