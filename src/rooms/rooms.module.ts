import { Module } from '@nestjs/common';
import { InviteClaimsController, RoomClaimsController } from './claims.controller.js';
import { ClaimsService } from './claims.service.js';
import { InvitesController, RoomsController } from './rooms.controller.js';
import { RoomsService } from './rooms.service.js';

/** S1 방·초대·입장(BE-S1-2~3, 개정 BE-M3)과 이어받기(BE-M4). */
@Module({
  controllers: [RoomsController, InvitesController, InviteClaimsController, RoomClaimsController],
  providers: [RoomsService, ClaimsService],
})
export class RoomsModule {}
