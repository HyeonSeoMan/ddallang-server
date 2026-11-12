import type { Response } from 'express';
import type { Lease } from './stream-lease.service.js';

/** 느린 클라이언트: 전송 대기 이벤트가 이 수를 넘으면 스트림을 닫는다(S5 §4.1). */
export const MAX_PENDING_EVENTS = 100;

export interface SseMessage {
  event: string;
  data: unknown;
  /** 변경 이벤트의 revision(`id:` 줄). ready·heartbeat에는 없다. */
  id?: number;
}

/** SSE 형식(S5 §4.2): `id`(있으면)·`event`·한 줄 JSON `data`와 빈 줄. */
export function formatSse(msg: SseMessage): string {
  return `${msg.id !== undefined ? `id: ${msg.id}\n` : ''}event: ${msg.event}\ndata: ${JSON.stringify(msg.data)}\n\n`;
}

/**
 * 응답 객체에 직접 쓰는 스트림 하나(PD-6: NestJS `@Sse`를 쓰지 않는다).
 * - 쓰기 직전마다 임대 마감을 검사하고 지났으면 쓰지 않고 닫는다(마감 뒤 데이터 수신 금지).
 * - 소켓이 막히면 대기열에 쌓고 100개를 넘으면 닫는다(역압). 쓰기 실패도 닫는다.
 * - `ready` 전에 도착한 이벤트는 붙잡아 두었다가 `ready` 뒤에 보낸다.
 */
export class SseStream {
  private closed = false;
  private blocked = false;
  private readonly queue: string[] = [];
  private held: SseMessage[] | undefined = [];
  private onClose: Array<() => void> = [];

  constructor(
    private readonly res: Response,
    private readonly lease: Lease,
    private readonly maxPending = MAX_PENDING_EVENTS,
  ) {
    res.on('drain', () => this.flush());
    res.on('error', () => this.close());
    res.on('close', () => this.close());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 닫힐 때 한 번 호출된다(임대 반납·구독 해제 등). */
  whenClosed(fn: () => void): void {
    if (this.closed) fn();
    else this.onClose.push(fn);
  }

  /** `ready`를 보내고 그 전에 붙잡아 둔 이벤트를 이어서 보낸다. */
  sendReady(data: unknown): void {
    this.write({ event: 'ready', data });
    const held = this.held ?? [];
    this.held = undefined;
    for (const msg of held) this.write(msg);
  }

  /** 이벤트·하트비트를 보낸다(ready 전이면 붙잡아 둔다). */
  send(msg: SseMessage): void {
    if (this.closed) return;
    if (this.held) {
      this.held.push(msg);
      if (this.held.length > this.maxPending) this.close();
      return;
    }
    this.write(msg);
  }

  private write(msg: SseMessage): void {
    if (this.closed) return;
    if (!this.lease.alive()) {
      this.close(); // 마감이 지난 스트림은 어떤 데이터도 받지 못한다
      return;
    }
    const chunk = formatSse(msg);
    if (this.blocked) {
      this.queue.push(chunk);
      if (this.queue.length > this.maxPending) this.close();
      return;
    }
    try {
      if (!this.res.write(chunk)) this.blocked = true;
    } catch {
      this.close();
    }
  }

  private flush(): void {
    this.blocked = false;
    while (!this.blocked && this.queue.length > 0 && !this.closed) {
      if (!this.lease.alive()) {
        this.close();
        return;
      }
      try {
        if (!this.res.write(this.queue.shift()!)) this.blocked = true;
      } catch {
        this.close();
        return;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.held = undefined;
    try {
      this.res.end();
    } catch {
      // 이미 끊긴 소켓
    }
    const fns = this.onClose;
    this.onClose = [];
    for (const fn of fns) fn();
  }
}
