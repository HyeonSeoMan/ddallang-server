import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import type { LinkedParticipant } from '../../src/common/auth/identity.js';
import {
  CurrentIdentity,
  CurrentRequester,
  IdentityKeyGuard,
  ParticipantGuard,
  type IdentityContext,
  type RequesterContext,
} from '../../src/common/auth/participant.guard.js';

/** BE-F4 가드 시험용(실제 S1 경로는 S1 Task가 만든다). */
@Controller('__auth')
export class AuthFixture {
  @Get('rooms/:roomId/whoami')
  @UseGuards(ParticipantGuard)
  whoami(@CurrentRequester() requester: RequesterContext): LinkedParticipant {
    return requester.participant; // 키 해시는 응답에 싣지 않는다
  }

  @Post('identity')
  @UseGuards(IdentityKeyGuard)
  identity(@CurrentIdentity() identity: IdentityContext): { hash: string } {
    return { hash: identity.identityKeyHash };
  }
}
