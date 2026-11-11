import { Module } from '@nestjs/common';
import { BalancesController } from './balances.controller.js';
import { BalancesService } from './balances.service.js';

/** S3 거래 목록·누적 손익 조회(읽기 전용, 방 잠금을 쓰지 않는다). */
@Module({
  controllers: [BalancesController],
  providers: [BalancesService],
})
export class BalancesModule {}
