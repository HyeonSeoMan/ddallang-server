import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../common/db/prisma.service.js';
import { RoomEventBus, type RoomEventPayload } from './room-event-bus.js';
import type { SseStream } from './sse-stream.js';

/** 하트비트 간격(S5 §6.2): 15초. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

interface RoomEntry {
  streams: Set<SseStream>;
  unsubscribe: () => void;
  timer: NodeJS.Timeout;
}

/**
 * 방별 스트림 분배(BE-S5-2): 방마다 구독 하나와 **하트비트 타이머 하나**를 두고, 그 방의 모든 스트림에
 * 이벤트를 나눠 준다. 하트비트는 그 시점의 DB `revision`을 한 번 읽어 모든 스트림에 보낸다(유실 보완).
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

  attach(roomId: string, stream: SseStream): void {
    let entry = this.rooms.get(roomId);
    if (!entry) {
      const streams = new Set<SseStream>();
      const created: RoomEntry = {
        streams,
        unsubscribe: this.bus.subscribe(roomId, (e) => this.dispatch(streams, e)),
        timer: setInterval(() => void this.heartbeat(roomId, streams), this.heartbeatMs),
      };
      created.timer.unref();
      this.rooms.set(roomId, created);
      entry = created;
    }
    entry.streams.add(stream);
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

  /** 이벤트 `data`에는 종류(event)를 빼고 `roomId`·`revision`·`serverTime`·식별자만 싣는다(내용 없음, S5 §4.2). */
  private dispatch(streams: Set<SseStream>, payload: RoomEventPayload): void {
    const { event, ...data } = payload;
    for (const stream of [...streams]) stream.send({ event, id: payload.revision, data });
  }

  private async heartbeat(roomId: string, streams: Set<SseStream>): Promise<void> {
    try {
      const room = await this.prisma.client.room.findUnique({
        where: { id: roomId },
        select: { revision: true },
      });
      if (!room) return;
      const data = { roomId, revision: room.revision, serverTime: new Date().toISOString() };
      for (const stream of [...streams]) stream.send({ event: 'heartbeat', data });
    } catch (err) {
      this.logger.warn(`하트비트 revision 조회 실패: ${(err as Error).message}`);
    }
  }

  /** 우아한 종료: 열려 있는 모든 스트림을 닫는다. */
  onModuleDestroy(): void {
    for (const entry of [...this.rooms.values()])
      for (const stream of [...entry.streams]) stream.close();
  }
}
