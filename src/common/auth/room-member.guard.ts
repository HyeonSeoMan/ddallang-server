import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../db/prisma.service.js';
import { ApiError } from '../errors/api-error.js';
import { hashIdentityKey, parseIdentityKey } from './identity-key.js';

/** 인증된 요청자(요청 경로의 방에서 신원 키로 찾은 RoomMember). */
export interface RoomMemberContext {
  memberId: string;
  roomId: string;
  nickname: string;
  isHost: boolean;
}

/** 키만 인증하는 요청(입장 `POST /invites/{code}/members`, 방 생성): 형식이 맞는 키와 그 해시. */
export interface IdentityContext {
  identityKeyHash: string;
}

const memberByRequest = new WeakMap<object, RoomMemberContext>();
const identityByRequest = new WeakMap<object, IdentityContext>();

/**
 * S1 §3.3 1~3번: 신원 키 형식(401) → 방 존재·멤버 여부(둘 다 같은 `404 ROOM_NOT_FOUND`).
 * 비멤버와 없는 방을 구별할 수 없게 해 임의의 키 보유자가 방 존재 여부를 알 수 없다. 키는 방 단위다
 * (다른 방에 등록된 키는 이 방에서 아무 권한이 없다, AC-SYS-003-6·7). 라우트 단계(404·405)는 이 가드보다 앞선다.
 */
@Injectable()
export class RoomMemberGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const key = parseIdentityKey(req.headers.authorization);
    const identityKeyHash = hashIdentityKey(key);
    const roomId = req.params['roomId'];
    if (typeof roomId !== 'string' || roomId.length === 0) throw new ApiError('ROOM_NOT_FOUND');

    const member = await this.prisma.client.roomMember.findUnique({
      where: { roomId_identityKeyHash: { roomId, identityKeyHash } },
      select: { id: true, roomId: true, nickname: true, isHost: true },
    });
    if (!member) throw new ApiError('ROOM_NOT_FOUND');
    memberByRequest.set(req, {
      memberId: member.id,
      roomId: member.roomId,
      nickname: member.nickname,
      isHost: member.isHost,
    });
    return true;
  }
}

/** 키 형식만 확인하는 가드(방에 아직 멤버가 아닌 요청: 입장·방 생성). */
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

export const CurrentMember = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): RoomMemberContext => {
    const member = memberByRequest.get(ctx.switchToHttp().getRequest<object>());
    if (!member) throw new Error('RoomMemberGuard가 적용되지 않은 경로에서 CurrentMember를 썼다');
    return member;
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
