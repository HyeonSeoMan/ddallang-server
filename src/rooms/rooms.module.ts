import { Module } from '@nestjs/common';
import { InvitesController, RoomsController } from './rooms.controller.js';
import { RoomsService } from './rooms.service.js';

/** S1 방·초대·입장(BE-S1-2~3). */
@Module({
  controllers: [RoomsController, InvitesController],
  providers: [RoomsService],
})
export class RoomsModule {}
