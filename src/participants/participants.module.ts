import { Module } from '@nestjs/common';
import { ParticipantsController } from './participants.controller.js';
import { ParticipantsService } from './participants.service.js';

/** S1 참여자 조회·등록·상태 변경(BE-S1-4~5). */
@Module({
  controllers: [ParticipantsController],
  providers: [ParticipantsService],
})
export class ParticipantsModule {}
