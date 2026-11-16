import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../../src/common/db/prisma.service.js';
import type { RoomEventBus, RoomEventPayload } from '../../src/realtime/room-event-bus.js';
import { RoomStreamsService } from '../../src/realtime/room-streams.service.js';
import type { SseMessage, SseStream } from '../../src/realtime/sse-stream.js';
import { deferred, sleep } from '../helpers/util.js';

/** 메모리 안의 가짜 스트림: 보낸 메시지와 닫힘만 기록한다. */
function fakeStream() {
  const sent: SseMessage[] = [];
  const onClose: (() => void)[] = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose.splice(0).forEach((f) => f());
  };
  const stream = {
    get isClosed() {
      return closed;
    },
    send: (m: SseMessage) => void (closed || sent.push(m)),
    sendFinal: (m: SseMessage) => {
      if (closed) return;
      sent.push(m);
      close();
    },
    whenClosed: (f: () => void) => (closed ? f() : onClose.push(f)),
    close,
  };
  return { stream: stream as unknown as SseStream, sent, isClosed: () => closed };
}

function fakeBus() {
  let handler: ((e: RoomEventPayload) => void) | undefined;
  const bus = {
    subscribe: (_room: string, h: (e: RoomEventPayload) => void) => {
      handler = h;
      return () => (handler = undefined);
    },
    ready: async () => undefined,
  };
  return { bus: bus as unknown as RoomEventBus, emit: (e: RoomEventPayload) => handler?.(e) };
}

describe('RoomStreamsService 하트비트 신원 재확인 (BE-M6, S5 §6.2)', () => {
  it('질의 도중에 붙은 스트림은 조회 결과에 없다는 이유로 닫지 않는다(질의 대상과 판정 대상이 같은 스냅샷)', async () => {
    const gate = deferred<void>();
    let calls = 0;
    const prisma = {
      client: {
        $queryRaw: async () => {
          calls++;
          if (calls === 1) await gate.promise; // 첫 하트비트 질의를 붙잡아 둔다
          return [{ revision: 3, participantId: 'p1', keyHash: 'h1' }];
        },
      },
    } as unknown as PrismaService;
    const { bus } = fakeBus();
    const svc = new RoomStreamsService(bus, prisma, 40);
    const a = fakeStream();
    svc.attach('r', a.stream, { participantId: 'p1', keyHash: 'h1' });
    await sleep(60); // 첫 하트비트가 질의를 시작해 기다린다
    const b = fakeStream(); // 질의 도중에 다른 참여자가 연결된다
    svc.attach('r', b.stream, { participantId: 'p2', keyHash: 'h2' });
    gate.resolve();
    await sleep(10);
    expect(b.isClosed()).toBe(false);
    expect(b.sent.some((m) => m.event === 'access.revoked')).toBe(false);
    expect(a.sent.map((m) => m.event)).toContain('heartbeat');
    a.stream.close();
    b.stream.close();
    svc.onModuleDestroy();
  });

  it('연 키가 더 이상 연결되어 있지 않은 스트림은 하트비트 대신 access.revoked(revision 없음)를 받고 닫힌다', async () => {
    const prisma = {
      client: {
        $queryRaw: async () => [
          { revision: 5, participantId: 'p1', keyHash: 'new' },
          { revision: 5, participantId: 'p2', keyHash: 'h2' },
        ],
      },
    } as unknown as PrismaService;
    const svc = new RoomStreamsService(fakeBus().bus, prisma, 30);
    const old = fakeStream();
    const ok = fakeStream();
    svc.attach('r', old.stream, { participantId: 'p1', keyHash: 'old' });
    svc.attach('r', ok.stream, { participantId: 'p2', keyHash: 'h2' });
    await sleep(60);
    expect(old.isClosed()).toBe(true);
    expect(old.sent.map((m) => m.event)).toEqual(['access.revoked']);
    expect(old.sent[0]!.data).not.toHaveProperty('revision');
    expect(old.sent[0]!.id).toBeUndefined();
    expect(ok.isClosed()).toBe(false);
    expect(ok.sent.every((m) => m.event === 'heartbeat')).toBe(true);
    ok.stream.close();
    svc.onModuleDestroy();
  });

  it('승인 통지(revokedParticipantId)는 그 참여자의 스트림만 확인하고 data에서 내부 필드를 뺀다', async () => {
    const prisma = {
      client: {
        participant: { findUnique: async () => ({ identityKeyHash: 'new' }) },
        $queryRaw: async () => [],
      },
    } as unknown as PrismaService;
    const { bus, emit } = fakeBus();
    const svc = new RoomStreamsService(bus, prisma, 60_000);
    const old = fakeStream();
    const other = fakeStream();
    svc.attach('r', old.stream, { participantId: 'p1', keyHash: 'old' });
    svc.attach('r', other.stream, { participantId: 'p2', keyHash: 'h2' });
    emit({
      event: 'claim.resolved',
      roomId: 'r',
      revision: 9,
      serverTime: 't',
      claimId: 'c',
      revokedParticipantId: 'p1',
    });
    await sleep(10);
    expect(other.sent).toEqual([
      {
        event: 'claim.resolved',
        id: 9,
        data: { roomId: 'r', revision: 9, serverTime: 't', claimId: 'c' },
      },
    ]);
    expect(old.sent.map((m) => m.event)).toEqual(['claim.resolved', 'access.revoked']);
    expect(old.isClosed()).toBe(true);
    expect(other.isClosed()).toBe(false);
    other.stream.close();
    svc.onModuleDestroy();
  });
});
