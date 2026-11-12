import { Module } from '@nestjs/common';
import type { Env } from '../common/config/env.js';
import { ENV } from '../common/config/env.token.js';
import { PrismaService } from '../common/db/prisma.service.js';
import { EventsController } from './events.controller.js';
import { RoomEventBus } from './room-event-bus.js';
import { RoomStreamsService } from './room-streams.service.js';
import { StreamLeaseService } from './stream-lease.service.js';

/** S5 실시간 반영: LISTEN 분배(S5-1), 연결 임대(S5-6), SSE 엔드포인트(S5-2). */
@Module({
  controllers: [EventsController],
  providers: [
    { provide: RoomEventBus, useFactory: (env: Env) => new RoomEventBus(env), inject: [ENV] },
    {
      provide: StreamLeaseService,
      useFactory: (prisma: PrismaService) => new StreamLeaseService(prisma),
      inject: [PrismaService],
    },
    {
      provide: RoomStreamsService,
      useFactory: (bus: RoomEventBus, prisma: PrismaService) => new RoomStreamsService(bus, prisma),
      inject: [RoomEventBus, PrismaService],
    },
  ],
  exports: [RoomEventBus, StreamLeaseService, RoomStreamsService],
})
export class RealtimeModule {}
