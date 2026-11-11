import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  CurrentIdentity,
  CurrentMember,
  IdentityKeyGuard,
  RoomMemberGuard,
  type IdentityContext,
  type RoomMemberContext,
} from '../../src/common/auth/room-member.guard.js';

/** BE-F4 가드 시험용(실제 S1 경로는 S1 Task가 만든다). */
@Controller('__auth')
export class AuthFixture {
  @Get('rooms/:roomId/whoami')
  @UseGuards(RoomMemberGuard)
  whoami(@CurrentMember() member: RoomMemberContext): RoomMemberContext {
    return member;
  }

  @Post('identity')
  @UseGuards(IdentityKeyGuard)
  identity(@CurrentIdentity() identity: IdentityContext): { hash: string } {
    return { hash: identity.identityKeyHash };
  }
}
