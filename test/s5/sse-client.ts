import type { Instance } from '../helpers/instances.js';

export interface SseEvent {
  event: string;
  id?: string;
  data: Record<string, unknown>;
  /** 클라이언트가 받은 시각(ms, Date.now) */
  receivedAt: number;
}

export interface OpenedStream {
  status: number;
  headers: Headers;
  /** status가 200일 때만 이벤트가 쌓인다 */
  events: SseEvent[];
  body?: Record<string, unknown>;
  /** 스트림이 끝나면(서버가 닫거나 abort) resolve */
  closed: Promise<void>;
  isClosed(): boolean;
  /** 지금까지 받은 원문 바이트 수 */
  bytes(): number;
  close(): void;
  waitFor(pred: (events: SseEvent[]) => boolean, timeoutMs?: number): Promise<SseEvent[]>;
}

/** `fetch`로 SSE를 연다(브라우저 `EventSource`가 아니다, S5 §3.2). 오류 응답이면 본문을 JSON으로 읽고 끝난다. */
export async function openStream(
  base: string | Instance,
  roomId: string,
  key: string | undefined,
  extraHeaders: Record<string, string> = {},
  query = '',
): Promise<OpenedStream> {
  const baseUrl = typeof base === 'string' ? base : base.baseUrl;
  const ctl = new AbortController();
  const res = await fetch(`${baseUrl}/rooms/${roomId}/events${query}`, {
    headers: {
      Accept: 'text/event-stream',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...extraHeaders,
    },
    signal: ctl.signal,
  });
  const events: SseEvent[] = [];
  let received = 0;
  let done = false;
  const waiters: Array<() => void> = [];
  const notify = () => waiters.splice(0).forEach((w) => w());
  const opened: OpenedStream = {
    status: res.status,
    headers: res.headers,
    events,
    closed: Promise.resolve(),
    isClosed: () => done,
    bytes: () => received,
    close: () => ctl.abort(),
    async waitFor(pred, timeoutMs = 10_000) {
      const end = Date.now() + timeoutMs;
      while (!pred(events)) {
        if (done && !pred(events))
          throw new Error(
            `스트림이 조건 전에 끝났다: ${JSON.stringify(events.map((e) => e.event))}`,
          );
        const left = end - Date.now();
        if (left <= 0)
          throw new Error(
            `시간 초과: 받은 이벤트 ${JSON.stringify(events.map((e) => `${e.event}:${e.data.revision ?? ''}`))}`,
          );
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, Math.min(left, 100)).unref();
        });
      }
      return events;
    },
  };
  if (res.status !== 200) {
    opened.body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    done = true;
    return opened;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  opened.closed = (async () => {
    try {
      const reader = res.body!.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        received += value.length;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev: Partial<SseEvent> = { receivedAt: Date.now() };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('id: ')) ev.id = line.slice(4);
            else if (line.startsWith('data: '))
              ev.data = JSON.parse(line.slice(6)) as Record<string, unknown>;
          }
          if (ev.event) events.push(ev as SseEvent);
        }
        notify();
      }
    } catch {
      // abort 또는 연결 끊김
    } finally {
      done = true;
      notify();
    }
  })();
  return opened;
}
