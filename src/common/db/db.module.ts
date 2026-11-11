import { Module } from '@nestjs/common';
import type { Env } from '../config/env.js';
import { ENV } from '../config/env.token.js';
import { DatabaseService } from './database.service.js';
import { PrismaService } from './prisma.service.js';

@Module({
  providers: [
    { provide: PrismaService, useFactory: (env: Env) => new PrismaService(env), inject: [ENV] },
    {
      provide: DatabaseService,
      useFactory: (prisma: PrismaService, env: Env) => new DatabaseService(prisma, env),
      inject: [PrismaService, ENV],
    },
  ],
  exports: [DatabaseService],
})
export class DbModule {}
