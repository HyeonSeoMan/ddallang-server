import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from '../config/env.js';
import { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Prisma 클라이언트 하나와 연결 풀 하나(PD-2). 풀은 지연 연결이라 기동 시 DB에 접속하지 않는다.
 * `schema`는 시험에서 스키마 격리(search_path)에만 쓴다.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(env: Pick<Env, 'DATABASE_URL' | 'DB_POOL_MAX'>, options: { schema?: string } = {}) {
    if (options.schema !== undefined && !/^[a-z0-9_]+$/.test(options.schema)) {
      throw new Error('invalid schema name');
    }
    const adapter = new PrismaPg({
      connectionString: env.DATABASE_URL,
      max: env.DB_POOL_MAX,
      // 어댑터의 schema 옵션은 raw SQL의 검색 경로를 바꾸지 않으므로 연결 단위로 지정한다.
      ...(options.schema ? { options: `-c search_path=${options.schema}` } : {}),
    });
    this.client = new PrismaClient({ adapter });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
