import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  CurrentMember,
  RoomMemberGuard,
  type RoomMemberContext,
} from '../common/auth/room-member.guard.js';
import { PrismaService } from '../common/db/prisma.service.js';
import { ApiError } from '../common/errors/api-error.js';
import { ApiErrors, ApiIdentityKey, ApiRoomIdParam } from '../common/swagger-docs.js';
import { ERROR_SCHEMA } from '../common/swagger-schemas.js';
import { RoomStreamsService } from './room-streams.service.js';
import { SseStream } from './sse-stream.js';
import { StreamLeaseService } from './stream-lease.service.js';

/** 한도 초과 429의 `Retry-After`(초, S5 §3.3). */
const RETRY_AFTER_SECONDS = '30';

@ApiTags('realtime')
@Controller('rooms/:roomId/events')
@UseGuards(RoomMemberGuard)
@ApiIdentityKey()
@ApiRoomIdParam()
export class EventsController {
  constructor(
    private readonly leases: StreamLeaseService,
    private readonly streams: RoomStreamsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * S5 §4.1 실시간 스트림. 검사 순서(§3.3): 0 라우트(레지스트리), 1·2 인증·멤버(가드), 3 쿼리 매개변수(422),
   * 4 연결 한도(429 + `Retry-After`). 오류는 스트림이 열리기 전의 일반 JSON이다. `Last-Event-ID`는 무시한다
   * (이벤트를 저장하거나 재전송하지 않는다). 종료된 방에서도 연결할 수 있다.
   */
  @Get()
  @ApiOperation({
    summary:
      '실시간 스트림 (S5 §4.1): fetch로 연다(EventSource 아님). ready → 변경 이벤트·heartbeat',
    description:
      '`text/event-stream`. 서버는 헤더를 보낸 즉시 `ready{roomId, revision, serverTime}`를 보내고, 변경이 커밋되면 ' +
      '`id: <revision>` · `event: transaction.created|updated|deleted · participant.created|status_changed · room.ended` · ' +
      '`data: {roomId, revision, serverTime, transactionId|participantId}`를 보낸다. 15초마다 `heartbeat{roomId, revision, serverTime}`. ' +
      '이벤트에는 내용(금액·사유·닉네임)을 싣지 않는다. 재전송은 없다: 끊기면 새로 연결해 전체를 재조회한다. ' +
      '한도: RoomMember당 5개, 방당 50개(인스턴스 전체 합산). 초과하면 새 연결만 429.',
  })
  @ApiResponse({
    status: 200,
    description: 'SSE 스트림(Cache-Control: no-store, X-Accel-Buffering: no)',
    content: {
      'text/event-stream': {
        schema: { type: 'string' },
        example:
          'event: ready\ndata: {"roomId":"…","revision":12,"serverTime":"2026-11-12T03:21:45.123Z"}\n\n' +
          'id: 13\nevent: transaction.created\ndata: {"roomId":"…","revision":13,"serverTime":"…","transactionId":"…"}\n\n',
      },
    },
  })
  @ApiResponse({
    status: 429,
    description:
      '`CONNECTION_LIMIT_EXCEEDED` — 한도에 도달했을 때의 새 연결(기존 스트림은 유지). `Retry-After: 30`',
    headers: { 'Retry-After': { description: '초', schema: { type: 'string', example: '30' } } },
    schema: ERROR_SCHEMA,
  })
  @ApiErrors('UNAUTHENTICATED', 'ROOM_NOT_FOUND', 'VALIDATION_FAILED')
  async stream(
    @CurrentMember() member: RoomMemberContext,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const names = Object.keys(query);
    if (names.length > 0) {
      // 3번: 이 엔드포인트는 쿼리 매개변수를 받지 않는다(S3 §3.3 표와 같은 형식)
      throw new ApiError('VALIDATION_FAILED', {
        details: names.map((field) => ({ field, code: 'NOT_ALLOWED_FIELD' })),
      });
    }

    const holder: { stream?: SseStream } = {};
    const lease = await this.leases.acquire(
      { roomId: member.roomId, memberId: member.memberId },
      () => holder.stream?.close(true),
    );
    if (!lease.ok) {
      if (lease.reason === 'limit') {
        throw new ApiError('CONNECTION_LIMIT_EXCEEDED', {
          headers: { 'Retry-After': RETRY_AFTER_SECONDS },
        }); // 4번
      }
      throw new ApiError('INTERNAL_ERROR'); // 임대 응답이 마감 뒤에 도착했다(연결을 열지 않는다)
    }
    if (req.destroyed || res.destroyed) {
      await this.leases.release(lease.lease.id);
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const stream = new SseStream(res, lease.lease);
    holder.stream = stream;
    stream.whenClosed(() => void this.leases.release(lease.lease.id));
    // 구독을 먼저 걸고 revision을 읽는다: ready 전에 도착한 이벤트는 붙잡아 두었다가 ready 뒤에 보낸다.
    this.streams.attach(member.roomId, stream);
    try {
      // LISTEN이 준비된 뒤에 revision을 읽어, 첫 구독·재연결 틈에 커밋된 변경이 ready 이후 이벤트로도 하트비트로도
      // 빠지지 않게 한다(준비가 늦으면 최대 2초만 기다리고 하트비트에 맡긴다).
      await this.streams.whenListening(2_000);
      const room = await this.prisma.client.room.findUniqueOrThrow({
        where: { id: member.roomId },
        select: { revision: true },
      });
      stream.sendReady({
        roomId: member.roomId,
        revision: room.revision,
        serverTime: new Date().toISOString(),
      });
    } catch {
      stream.close();
    }
  }
}
