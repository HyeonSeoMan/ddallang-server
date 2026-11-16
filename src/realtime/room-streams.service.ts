import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { INTERNAL_EVENT_FIELDS } from '../common/db/database.service.js';
import { PrismaService } from '../common/db/prisma.service.js';
import { RoomEventBus, type RoomEventPayload } from './room-event-bus.js';
import type { SseStream } from './sse-stream.js';

/** 하트비트 간격(S5 §6.2): 15초. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** 스트림을 연 신원(PD-27): 요청자 참여자와 연 키의 해시. 응답·로그에 싣지 않는다. */
export interface StreamIdentity {
  participantId: string;
  keyHash: string;
}

type Streams = Map<SseStream, StreamIdentity>;

interface RoomEntry {
  streams: Streams;
  unsubscribe: () => void;
  timer: NodeJS.Timeout;
}

/**
 * 방별 스트림 분배(BE-S5-2, 개정 BE-M6): 방마다 구독 하나와 **하트비트 타이머 하나**를 두고, 그 방의 모든 스트림에
 * 이벤트를 나눠 준다. 하트비트는 그 시점의 DB `revision`과 스트림 참여자들의 연결 키 해시를 **한 질의로** 읽어,
 * 연 키가 더 이상 연결되어 있지 않은 스트림에는 하트비트 대신 `access.revoked`를 보내고 닫는다(S5 §6.2, S5-C3).
 * 이어받기 승인 통지(`revokedParticipantId`)를 받으면 그 참여자의 스트림을 바로 같은 방법으로 확인한다(PD-27).
 */
@Injectable()
export class RoomStreamsService implements OnModuleDestroy {
  private readonly logger = new Logger(RoomStreamsService.name);
  private readonly rooms = new Map<string, RoomEntry>();

  constructor(
    private readonly bus: RoomEventBus,
    private readonly prisma: PrismaService,
    private readonly heartbeatMs = HEARTBEAT_INTERVAL_MS,
  ) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  streamCount(roomId: string): number {
    return this.rooms.get(roomId)?.streams.size ?? 0;
  }

  /** 스트림을 방에 붙인다. 닫히면 자동으로 떼고, 방의 마지막 스트림이면 구독과 타이머를 정리한다. */
  /**
   * LISTEN이 준비될 때까지 기다린다(최대 `timeoutMs`). 실패해도 던지지 않는다: 준비 전에 커밋된 변경은
   * 뒤이어 읽는 revision과 하트비트가 메운다.
   */
  async whenListening(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.bus.ready().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  attach(roomId: string, stream: SseStream, identity: StreamIdentity): void {
    let entry = this.rooms.get(roomId);
    if (!entry) {
      const streams: Streams = new Map();
      const created: RoomEntry = {
        streams,
        unsubscribe: this.bus.subscribe(roomId, (e) => this.dispatch(streams, e)),
        timer: setInterval(() => void this.heartbeat(roomId, streams), this.heartbeatMs),
      };
      created.timer.unref();
      this.rooms.set(roomId, created);
      entry = created;
    }
    entry.streams.set(stream, identity);
    stream.whenClosed(() => this.detach(roomId, stream));
  }

  private detach(roomId: string, stream: SseStream): void {
    const entry = this.rooms.get(roomId);
    if (!entry) return;
    entry.streams.delete(stream);
    if (entry.streams.size === 0) {
      entry.unsubscribe();
      clearInterval(entry.timer);
      this.rooms.delete(roomId);
    }
  }

  /**
   * 이벤트 `data`에는 종류(event)를 빼고 `roomId`·`revision`·`serverTime`·식별자만 싣는다(내용 없음, S5 §4.2).
   * 통지의 내부 필드(`revokedParticipantId`, PD-26)도 뺀다.
   */
  private dispatch(streams: Streams, payload: RoomEventPayload): void {
    const { event, ...data } = payload;
    for (const field of INTERNAL_EVENT_FIELDS) delete data[field];
    for (const stream of [...streams.keys()]) stream.send({ event, id: payload.revision, data });
    if (payload.revokedParticipantId)
      void this.revokeStale(payload.roomId, streams, payload.revokedParticipantId);
  }

  /** 승인 직후 전달(PD-27): 그 참여자의 현재 연결 해시를 한 번 읽어 스트림의 해시와 다르면 `access.revoked` 후 닫는다. */
  private async revokeStale(
    roomId: string,
    streams: Streams,
    participantId: string,
  ): Promise<void> {
    const mine = [...streams].filter(([, id]) => id.participantId === participantId);
    if (mine.length === 0) return;
    try {
      const row = await this.prisma.client.participant.findUnique({
        where: { id: participantId },
        select: { identityKeyHash: true },
      });
      for (const [stream, id] of mine)
        if (id.keyHash !== row?.identityKeyHash) this.revoke(roomId, stream);
    } catch (err) {
      this.logger.warn(
        `접근 상실 확인 실패(다음 하트비트가 다시 확인한다): ${(err as Error).message}`,
      );
    }
  }

  private async heartbeat(roomId: string, streams: Streams): Promise<void> {
    const participantIds = [...new Set([...streams.values()].map((id) => id.participantId))];
    try {
      // revision과 스트림 참여자들의 현재 연결 해시를 한 질의로 읽는다(방당 한 질의, PD-27)
      const rows = await this.prisma.client.$queryRaw<
        { revision: number; participantId: string | null; keyHash: string | null }[]
      >`
        SELECT r."revision", p."id" AS "participantId", p."identityKeyHash" AS "keyHash"
        FROM "Room" r
        LEFT JOIN "Participant" p ON p."roomId" = r."id" AND p."id" = ANY(${participantIds}::text[])
        WHERE r."id" = ${roomId}`;
      if (rows.length === 0) return;
      const linked = new Map(rows.map((r) => [r.participantId, r.keyHash]));
      const data = { roomId, revision: rows[0]!.revision, serverTime: new Date().toISOString() };
      for (const [stream, id] of [...streams]) {
        if (linked.get(id.participantId) !== id.keyHash) this.revoke(roomId, stream);
        else stream.send({ event: 'heartbeat', data });
      }
    } catch (err) {
      this.logger.warn(`하트비트 조회 실패: ${(err as Error).message}`);
    }
  }

  /** S5 §4.2 `access.revoked`(변경 이벤트가 아님, revision 없음)를 보내고 닫는다. 이후 이 스트림에는 아무것도 보내지 않는다. */
  private revoke(roomId: string, stream: SseStream): void {
    stream.sendFinal({
      event: 'access.revoked',
      data: { roomId, serverTime: new Date().toISOString() },
    });
  }

  /** 우아한 종료: 열려 있는 모든 스트림을 닫는다. */
  onModuleDestroy(): void {
    for (const entry of [...this.rooms.values()])
      for (const stream of [...entry.streams.keys()]) stream.close();
  }
}
