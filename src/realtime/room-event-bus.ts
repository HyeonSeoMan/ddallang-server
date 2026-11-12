import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import type { Env } from '../common/config/env.js';
import { ENV } from '../common/config/env.token.js';
import { ROOM_EVENTS_CHANNEL } from '../common/db/database.service.js';

/** `pg_notify('room_events', …)`의 본문(식별자와 종류만, S5 §4.2). */
export interface RoomEventPayload {
  event: string;
  roomId: string;
  revision: number;
  serverTime: string;
  transactionId?: string;
  participantId?: string;
}

type Handler = (event: RoomEventPayload) => void;

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/**
 * 이벤트 수신·분배(BE-S5-1, PD-5): `LISTEN room_events` 전용 연결 하나(풀과 분리, 세션 단위)를 유지하고 받은
 * 통지를 방별 구독자에게 나눠 준다. 첫 구독 때 연결한다. 연결이 끊기면 백오프로 재연결하고 다시 `LISTEN`한다.
 * 끊긴 동안 유실된 통지는 이벤트를 저장·재전송하지 않으므로 복구하지 않는다(하트비트가 뒤처짐을 알린다, S5 §6.2).
 */
@Injectable()
export class RoomEventBus implements OnModuleDestroy {
  private readonly logger = new Logger(RoomEventBus.name);
  private readonly subscribers = new Map<string, Set<Handler>>();
  private client?: pg.Client;
  private connecting?: Promise<void>;
  private closed = false;
  private retryMs = RECONNECT_MIN_MS;
  private retryTimer?: NodeJS.Timeout;
  /** 시험·진단용: 성공한 연결 횟수 */
  connectCount = 0;

  constructor(
    @Inject(ENV) private readonly env: Pick<Env, 'DATABASE_URL'>,
    /** 진단용 연결 이름(pg_stat_activity). 기본은 프로세스별로 구분된다. */
    private readonly applicationName = `ddallang-bus-${process.pid}`,
  ) {}

  /** 방의 이벤트를 받는다. 반환값을 호출하면 구독을 해제한다. */
  subscribe(roomId: string, handler: Handler): () => void {
    const set = this.subscribers.get(roomId) ?? new Set<Handler>();
    set.add(handler);
    this.subscribers.set(roomId, set);
    void this.ensureConnected();
    return () => {
      set.delete(handler);
      if (set.size === 0 && this.subscribers.get(roomId) === set) this.subscribers.delete(roomId);
    };
  }

  /** 지금 `LISTEN` 중이면 true. */
  get listening(): boolean {
    return this.client !== undefined;
  }

  /** 연결이 확립될 때까지 기다린다(시험·준비 확인용). */
  async ready(): Promise<void> {
    await this.ensureConnected();
  }

  private ensureConnected(): Promise<void> {
    if (this.closed || this.client) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const url = new URL(this.env.DATABASE_URL);
    url.searchParams.delete('schema'); // Prisma 전용 매개변수는 pg에 넘기지 않는다
    const client = new pg.Client({
      connectionString: url.toString(),
      application_name: this.applicationName,
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${ROOM_EVENTS_CHANNEL}`);
    } catch (err) {
      await client.end().catch(() => undefined);
      this.logger.warn(`LISTEN 연결 실패: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    if (this.closed) {
      await client.end().catch(() => undefined);
      return;
    }
    client.on('notification', (msg) => {
      if (msg.channel !== ROOM_EVENTS_CHANNEL || !msg.payload) return;
      let payload: RoomEventPayload;
      try {
        payload = JSON.parse(msg.payload) as RoomEventPayload;
      } catch {
        return; // 형식이 틀린 통지는 버린다(하트비트가 보완한다)
      }
      const set = this.subscribers.get(payload.roomId);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch (err) {
          this.logger.error(`구독자 처리 오류: ${(err as Error).message}`);
        }
      }
    });
    const lost = (err?: Error) => {
      if (this.client !== client) return;
      this.client = undefined;
      if (err) this.logger.warn(`LISTEN 연결 오류: ${err.message}`);
      void client.end().catch(() => undefined);
      this.scheduleReconnect();
    };
    client.on('error', lost);
    client.on('end', () => lost());
    this.client = client;
    this.connectCount++;
    this.retryMs = RECONNECT_MIN_MS;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.subscribers.size > 0 || this.connectCount === 0) void this.ensureConnected();
      else this.scheduleReconnect(); // 구독자가 없으면 다음 구독 때 연결한다
    }, this.retryMs);
    this.retryTimer.unref();
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }
}
