import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { SettlementController } from './settlement.controller.js';
import { SettlementService } from './settlement.service.js';

/** S4 게임 종료·정산(저장하지 않고 요청 때마다 유효 거래에서 계산한다). */
@Module({
  imports: [IdempotencyModule],
  controllers: [SettlementController],
  providers: [SettlementService],
})
export class SettlementModule {}
