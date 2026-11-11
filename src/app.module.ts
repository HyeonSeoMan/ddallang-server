import { DynamicModule, Module } from '@nestjs/common';
import type { DestinationStream } from 'pino';
import { BalancesModule } from './balances/balances.module.js';
import { CommonModule } from './common/common.module.js';
import type { Env } from './common/config/env.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';
import { ParticipantsModule } from './participants/participants.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { RoomsModule } from './rooms/rooms.module.js';
import { SettlementModule } from './settlement/settlement.module.js';
import { TransactionsModule } from './transactions/transactions.module.js';

@Module({})
export class AppModule {
  static register(env: Env, logStream?: DestinationStream): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CommonModule.register(env, logStream),
        RoomsModule,
        ParticipantsModule,
        TransactionsModule,
        IdempotencyModule,
        BalancesModule,
        RealtimeModule,
        SettlementModule,
      ],
    };
  }
}
