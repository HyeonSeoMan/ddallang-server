import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { PrismaService } from '../common/db/prisma.service.js';
import { newId } from '../common/ids/ids.js';

/** S5 §4.1 E-9: 한 RoomMember당 동시 스트림 5개, 방당 50개(서버 인스턴스 전체 합산, 사용자 결정 D1). */
export const MEMBER_STREAM_LIMIT = 5;
export const ROOM_STREAM_LIMIT = 50;
/** 임대 만료 T = 15초(사용자 결정 D2). */
export const LEASE_TTL_MS = 15_000;

export interface LeaseOptions {
  ttlMs?: number;
  /** 단조 시계(ms). 시험에서 바꿀 수 있다. */
  now?: () => number;
}

/** 열려 있는 스트림 하나의 임대. 스트림은 쓰기 직전마다 `alive()`를 확인한다. */
export interface Lease {
  readonly id: string;
  /** 자기 종료 마감(단조 시계 ms) */
  readonly deadline: number;
  /** 마감 전이고 임대를 잃지 않았다 */
  alive(): boolean;
}

export type AcquireResult = { ok: true; lease: Lease } | { ok: false; reason: 'limit' | 'late' };

interface LocalLease {
  id: string;
  deadline: number;
  lost: boolean;
  onLost: () => void;
}

/**
 * SSE 연결 임대(BE-S5-6, PD-6). 연결마다 `StreamLease` 행을 두고 방 단위 advisory lock 안에서
 * 만료된 임대를 지우고 개수를 센 뒤 한도 미만일 때만 삽입한다. 인스턴스가 T/3마다 자기 임대를 **한 번의 UPDATE**로
 * 일괄 갱신하고, 갱신되지 않은(이미 만료된) 임대의 스트림은 즉시 닫는다.
 *
 * 자기 종료 마감은 **요청 송신 시각 + 2T/3**(단조 시계)이며 응답 수신 시각은 쓰지 않는다. DB는 요청을 처리한 시각
 * (송신 이후) + T를 만료로 기록하므로 마감은 항상 DB 만료보다 앞선다. 마감이 지난 스트림은 닫고 되살리지 않으며,
 * **최초 임대**도 같다(마감 뒤 도착한 성공 응답은 폐기하고 임대를 반납한다). 모든 스트림 쓰기 직전에 `alive()`를 확인한다.
 */
@Injectable()
export class StreamLeaseService implements OnModuleDestroy {
  private readonly logger = new Logger(StreamLeaseService.name);
  readonly instanceId = newId();
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly local = new Map<string, LocalLease>();
  private renewTimer?: NodeJS.Timeout;
  private deadlineTimer?: NodeJS.Timeout;
  private renewing = false;

  constructor(
    private readonly prisma: PrismaService,
    options: LeaseOptions = {},
  ) {
    this.ttl = options.ttlMs ?? LEASE_TTL_MS;
    this.now = options.now ?? (() => performance.now());
  }

  /** 마감까지 남은 안전 시간: 2T/3 */
  private get selfTerminateMs(): number {
    return (this.ttl * 2) / 3;
  }

  /** 현재 이 인스턴스가 들고 있는 임대 수(시험·진단용). */
  get localCount(): number {
    return this.local.size;
  }

  /**
   * 새 연결의 임대를 얻는다. 한도에 도달해 있으면 `limit`(호출자가 429로 거부), 응답이 마감 뒤에 도착하면 `late`
   * (임대를 반납했고 연결을 열지 않는다). `onLost`는 임대를 잃었을 때(갱신 안 됨·마감) 스트림을 닫는 콜백이다.
   */
  async acquire(
    input: { roomId: string; memberId: string },
    onLost: () => void,
  ): Promise<AcquireResult> {
    const sentAt = this.now(); // 요청 송신 시각(단조)
    const id = newId();
    const granted = await this.prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stream-lease:${input.roomId}`}, 0))`;
        await tx.$executeRaw`DELETE FROM "StreamLease" WHERE "roomId" = ${input.roomId} AND "expiresAt" <= clock_timestamp()`;
        const rows = await tx.$queryRaw<{ member: bigint; room: bigint }[]>`
          SELECT count(*) FILTER (WHERE "memberId" = ${input.memberId}) AS "member", count(*) AS "room"
          FROM "StreamLease" WHERE "roomId" = ${input.roomId}`;
        if (
          Number(rows[0]!.member) >= MEMBER_STREAM_LIMIT ||
          Number(rows[0]!.room) >= ROOM_STREAM_LIMIT
        )
          return false;
        await tx.$executeRaw`
          INSERT INTO "StreamLease" ("id", "roomId", "memberId", "instanceId", "expiresAt")
          VALUES (${id}, ${input.roomId}, ${input.memberId}, ${this.instanceId}, clock_timestamp() + make_interval(secs => ${this.ttl / 1000}))`;
        return true;
      },
      { maxWait: this.ttl / 3, timeout: this.selfTerminateMs },
    );
    if (!granted) return { ok: false, reason: 'limit' };
    const deadline = sentAt + this.selfTerminateMs;
    if (this.now() >= deadline) {
      // 응답이 마감 뒤에 도착했다: 이 연결은 열지 않고 임대를 반납한다(늦은 응답 폐기).
      await this.release(id);
      return { ok: false, reason: 'late' };
    }
    const entry: LocalLease = { id, deadline, lost: false, onLost };
    this.local.set(id, entry);
    this.startTimers();
    return {
      ok: true,
      lease: {
        id,
        get deadline() {
          return entry.deadline;
        },
        alive: () => !entry.lost && this.now() < entry.deadline,
      },
    };
  }

  /** 연결 종료·정리 때 즉시 반납한다(실패해도 만료가 정리한다). */
  async release(id: string): Promise<void> {
    const entry = this.local.get(id);
    this.local.delete(id);
    if (entry) entry.lost = true;
    if (this.local.size === 0) this.stopTimers();
    await this.prisma.client.$executeRaw`DELETE FROM "StreamLease" WHERE "id" = ${id}`.catch(
      () => undefined,
    );
  }

  /**
   * 이 인스턴스의 모든 임대를 **한 번의 UPDATE**로 갱신한다(이미 만료된 행은 갱신하지 않는다). 갱신된 임대의 마감은
   * `이 요청의 송신 시각 + 2T/3`으로 올리고(낮추지 않는다) 갱신되지 않은 임대의 스트림은 즉시 닫는다.
   * 요청이 실패·지연되면 마감이 그대로라 스트림이 마감에 스스로 닫힌다.
   */
  async renewAll(): Promise<void> {
    if (this.renewing || this.local.size === 0) return;
    this.renewing = true;
    try {
      const ids = [...this.local.keys()];
      const sentAt = this.now(); // 송신 시각(응답 수신 시각을 쓰지 않는다)
      const rows = await this.prisma.client.$queryRaw<{ id: string }[]>`
        UPDATE "StreamLease" SET "expiresAt" = clock_timestamp() + make_interval(secs => ${this.ttl / 1000})
        WHERE "instanceId" = ${this.instanceId} AND "id" = ANY(${ids}::text[]) AND "expiresAt" > clock_timestamp()
        RETURNING "id"`;
      const renewed = new Set(rows.map((r) => r.id));
      const proposed = sentAt + this.selfTerminateMs;
      for (const id of ids) {
        const entry = this.local.get(id);
        if (!entry) continue;
        if (renewed.has(id)) {
          if (!entry.lost && this.now() < entry.deadline)
            entry.deadline = Math.max(entry.deadline, proposed); // 되살리지 않는다
        } else {
          this.lose(entry); // 이미 만료됨: 즉시 닫는다
        }
      }
    } catch (err) {
      this.logger.warn(
        `임대 갱신 실패(마감이 지나면 스트림이 스스로 닫힌다): ${(err as Error).message}`,
      );
    } finally {
      this.renewing = false;
    }
  }

  /** 마감이 지난 임대의 스트림을 닫는다(타이머가 부른다). */
  checkDeadlines(): void {
    const now = this.now();
    for (const entry of [...this.local.values()]) {
      if (!entry.lost && now >= entry.deadline) this.lose(entry);
    }
  }

  private lose(entry: LocalLease): void {
    entry.lost = true;
    this.local.delete(entry.id);
    if (this.local.size === 0) this.stopTimers();
    void this.prisma.client.$executeRaw`DELETE FROM "StreamLease" WHERE "id" = ${entry.id}`.catch(
      () => undefined,
    );
    try {
      entry.onLost();
    } catch (err) {
      this.logger.error(`스트림 닫기 오류: ${(err as Error).message}`);
    }
  }

  private startTimers(): void {
    this.renewTimer ??= setInterval(() => void this.renewAll(), this.ttl / 3);
    this.deadlineTimer ??= setInterval(
      () => this.checkDeadlines(),
      Math.max(50, Math.min(500, this.ttl / 30)),
    );
    this.renewTimer.unref();
    this.deadlineTimer.unref();
  }

  private stopTimers(): void {
    clearInterval(this.renewTimer);
    clearInterval(this.deadlineTimer);
    this.renewTimer = undefined;
    this.deadlineTimer = undefined;
  }

  /** 우아한 종료: 이 인스턴스의 임대를 모두 반납한다(PD-16 e). */
  async onModuleDestroy(): Promise<void> {
    this.stopTimers();
    for (const entry of this.local.values()) entry.lost = true;
    this.local.clear();
    await this.prisma.client
      .$executeRaw`DELETE FROM "StreamLease" WHERE "instanceId" = ${this.instanceId}`.catch(
      () => undefined,
    );
  }
}
