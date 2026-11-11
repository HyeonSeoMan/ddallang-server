import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { TransactionsController } from './transactions.controller.js';
import { TransactionsService } from './transactions.service.js';

/** S2 거래 생성·수정·삭제(BE-S2-2~4). 조회는 S3(balances)가 맡는다. */
@Module({
  imports: [IdempotencyModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}
