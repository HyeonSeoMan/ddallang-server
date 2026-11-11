import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from '../config/env.js';
import { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Prisma 클라이언트 하나와 연결 풀 하나(PD-2). 풀은 지연 연결이라 기동 시 DB에 접속하지 않는다.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(env: Pick<Env, 'DATABASE_URL' | 'DB_POOL_MAX'>) {
    const adapter = new PrismaPg({ connectionString: env.DATABASE_URL, max: env.DB_POOL_MAX });
    this.client = new PrismaClient({ adapter });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
