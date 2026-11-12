import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { MAX_PENDING_EVENTS, SseStream, formatSse } from '../../src/realtime/sse-stream.js';
import type { Lease } from '../../src/realtime/stream-lease.service.js';

class FakeRes extends EventEmitter {
  written: string[] = [];
  ended = false;
  blocked = false;
  failWrites = false;
  write(chunk: string): boolean {
    if (this.failWrites) throw new Error('EPIPE');
    this.written.push(chunk);
    return !this.blocked;
  }
  end(): void {
    this.ended = true;
  }
}
const lease = (alive = true): Lease & { setAlive(v: boolean): void } => {
  let a = alive;
  return { id: 'l', deadline: 0, alive: () => a, setAlive: (v) => (a = v) };
};
const make = (l: Lease = lease()) => {
  const res = new FakeRes();
  return { res, stream: new SseStream(res as unknown as Response, l) };
};

describe('formatSse (S5 §4.2)', () => {
  it('변경 이벤트는 id·event·한 줄 JSON data와 빈 줄이고, ready·heartbeat에는 id가 없다', () => {
    expect(
      formatSse({ id: 12, event: 'transaction.created', data: { roomId: 'r', revision: 12 } }),
    ).toBe('id: 12\nevent: transaction.created\ndata: {"roomId":"r","revision":12}\n\n');
    expect(formatSse({ event: 'ready', data: { roomId: 'r' } })).toBe(
      'event: ready\ndata: {"roomId":"r"}\n\n',
    );
  });
});

describe('SseStream (PD-6)', () => {
  it('ready 전에 도착한 이벤트는 붙잡아 두었다가 ready 뒤에 순서대로 보낸다', () => {
    const { res, stream } = make();
    stream.send({ event: 'a', id: 1, data: {} });
    stream.send({ event: 'b', id: 2, data: {} });
    expect(res.written).toHaveLength(0);
    stream.sendReady({ revision: 0 });
    expect(res.written.map((c) => c.match(/event: (\w+)/)![1])).toEqual(['ready', 'a', 'b']);
    stream.send({ event: 'c', id: 3, data: {} });
    expect(res.written).toHaveLength(4);
  });

  it('쓰기 직전에 임대 마감이 지났으면 쓰지 않고 닫는다(마감 뒤 데이터 수신 금지)', () => {
    const l = lease();
    const { res, stream } = make(l);
    stream.sendReady({});
    l.setAlive(false);
    stream.send({ event: 'secret', id: 9, data: { v: 1 } });
    expect(res.written.join('')).not.toContain('secret');
    expect(res.ended).toBe(true);
    expect(stream.isClosed).toBe(true);
  });

  it('소켓이 막혀 전송 대기 이벤트가 100개를 넘으면 닫는다(역압)', () => {
    const { res, stream } = make();
    stream.sendReady({});
    res.blocked = true;
    stream.send({ event: 'first', data: {} }); // 이 쓰기가 막힘을 알린다
    for (let i = 0; i < MAX_PENDING_EVENTS; i++) stream.send({ event: 'e', id: i, data: {} });
    expect(stream.isClosed).toBe(false); // 정확히 100개까지는 유지
    stream.send({ event: 'e', id: 999, data: {} });
    expect(stream.isClosed).toBe(true);
    expect(res.ended).toBe(true);
  });

  it('drain되면 대기열을 순서대로 비운다', () => {
    const { res, stream } = make();
    stream.sendReady({});
    res.blocked = true;
    stream.send({ event: 'a', data: {} });
    stream.send({ event: 'b', data: {} });
    stream.send({ event: 'c', data: {} });
    expect(res.written).toHaveLength(2); // ready, a
    res.blocked = false;
    res.emit('drain');
    expect(res.written.map((c) => c.match(/event: (\w+)/)![1])).toEqual(['ready', 'a', 'b', 'c']);
  });

  it('쓰기 오류·소켓 close·error는 스트림을 닫고 whenClosed 콜백을 한 번 부른다', () => {
    for (const trigger of ['write', 'close', 'error'] as const) {
      const { res, stream } = make();
      let calls = 0;
      stream.whenClosed(() => calls++);
      stream.sendReady({});
      if (trigger === 'write') {
        res.failWrites = true;
        stream.send({ event: 'x', data: {} });
      } else res.emit(trigger);
      stream.close(); // 중복 호출은 무시된다
      expect(stream.isClosed, trigger).toBe(true);
      expect(calls, trigger).toBe(1);
    }
  });

  it('이미 닫힌 스트림에 whenClosed를 걸면 즉시 호출된다', () => {
    const { stream } = make();
    stream.close();
    let called = false;
    stream.whenClosed(() => (called = true));
    expect(called).toBe(true);
  });

  it('ready 전에 붙잡은 이벤트가 100개를 넘으면 닫는다', () => {
    const { stream } = make();
    for (let i = 0; i <= MAX_PENDING_EVENTS; i++) stream.send({ event: 'e', id: i, data: {} });
    expect(stream.isClosed).toBe(true);
  });
});
