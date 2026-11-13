import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from '../config/env.js';
import { pgConnectionConfig, type PgSslEnv } from './pg-config.js';
import { PrismaClient } from '../../generated/prisma/client.js';

/**
 * Prisma 클라이언트 하나와 연결 풀 하나(PD-2). 풀은 지연 연결이라 기동 시 DB에 접속하지 않는다.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(env: Pick<Env, 'DATABASE_URL' | 'DB_POOL_MAX'> & PgSslEnv) {
    // Prisma 관례의 `?schema=<이름>`: 생성된 모델 질의를 그 스키마로 한정한다(기본은 public).
    // pg에는 넘기지 않는다. raw SQL의 검색 경로는 연결 문자열의 `options=-c search_path=…`로 따로 정한다.
    const { schema, ...pgConfig } = pgConnectionConfig(env);
    if (schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
      throw new Error('invalid schema name');
    }
    const adapter = new PrismaPg(
      { ...pgConfig, max: env.DB_POOL_MAX },
      schema ? { schema } : undefined,
    );
    this.client = new PrismaClient({ adapter });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
