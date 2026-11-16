import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../db/prisma.service.js';
import { ApiError } from '../errors/api-error.js';
import { hashIdentityKey, parseIdentityKey } from './identity-key.js';
import { requireLinked, resolveIdentity, type LinkedParticipant } from './identity.js';

/**
 * 인증된 요청자: 요청 경로의 방에서 신원 키가 연결된 참여자(S1 §2.3 I2). `identityKeyHash`는 방 잠금 안의
 * 재확인(PD-24)과 스트림 메타(PD-27)에만 쓰며 응답·로그에 싣지 않는다(PD-14).
 */
export interface RequesterContext {
  participant: LinkedParticipant;
  identityKeyHash: string;
}

/** 키만 인증하는 요청(방 생성, `/invites/{inviteCode}/…`): 형식이 맞는 키와 그 해시. */
export interface IdentityContext {
  identityKeyHash: string;
}

const requesterByRequest = new WeakMap<object, RequesterContext>();
const identityByRequest = new WeakMap<object, IdentityContext>();

/**
 * S1 §3.3 1~3번: 신원 키 형식(401 `UNAUTHENTICATED`) → 방 존재와 신원 상태(BE-F4, PD-23). LINKED만 통과하고,
 * 접근 상실은 `401 IDENTITY_REVOKED`, 신원 없음·대기와 없는 방은 같은 `404 ROOM_NOT_FOUND`다. 비참여자와 없는 방을
 * 구별할 수 없게 해 임의의 키 보유자가 방 존재 여부를 알 수 없다. 키는 방 단위다(다른 방에 연결된 키는 이 방에서
 * 아무 권한이 없다, AC-SYS-003-6·7). 라우트 단계(404·405)는 이 가드보다 앞선다.
 */
@Injectable()
export class ParticipantGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const key = parseIdentityKey(req.headers.authorization);
    const identityKeyHash = hashIdentityKey(key);
    const roomId = req.params['roomId'];
    if (typeof roomId !== 'string' || roomId.length === 0) throw new ApiError('ROOM_NOT_FOUND');
    // 없는 방의 해시는 어떤 상태에도 해당하지 않으므로 NONE → 404다(접근 상실 기록은 방에 묶여 있다).
    const participant = requireLinked(
      await resolveIdentity(this.prisma.client, roomId, identityKeyHash),
    );
    requesterByRequest.set(req, { participant, identityKeyHash });
    return true;
  }
}

/** 키 형식만 확인하는 가드(방에 아직 연결되지 않은 요청: 방 생성, 입장, 이어받기). */
@Injectable()
export class IdentityKeyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    identityByRequest.set(req, {
      identityKeyHash: hashIdentityKey(parseIdentityKey(req.headers.authorization)),
    });
    return true;
  }
}

export const CurrentRequester = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): RequesterContext => {
    const requester = requesterByRequest.get(ctx.switchToHttp().getRequest<object>());
    if (!requester)
      throw new Error('ParticipantGuard가 적용되지 않은 경로에서 CurrentRequester를 썼다');
    return requester;
  },
);

export const CurrentIdentity = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): IdentityContext => {
    const identity = identityByRequest.get(ctx.switchToHttp().getRequest<object>());
    if (!identity)
      throw new Error('IdentityKeyGuard가 적용되지 않은 경로에서 CurrentIdentity를 썼다');
    return identity;
  },
);

/** 방장 전용 동작(S1 §5.1)은 비방장에게 `403 HOST_ONLY`다(§3.3 4번). 방 참여자에게만 도달하므로 방 정보를 드러내지 않는다. */
export function requireHost(participant: Pick<LinkedParticipant, 'isHost'>): void {
  if (!participant.isHost) throw new ApiError('HOST_ONLY');
}
