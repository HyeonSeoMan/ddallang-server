import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testEnv } from './helpers/env.js';

// 43자 base64url 신원 키 형태의 시험용 값
const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function sink() {
  const lines: string[] = [];
  return { lines, stream: { write: (s: string) => void lines.push(s) } };
}

describe('구조적 로깅 마스킹', () => {
  // nestjs-pino는 프로세스 안에서 첫 앱의 로거를 공유하므로 한 앱으로 모두 확인한다.
  it('요청 로그와 앱 로그 어디에도 Authorization·신원 키 값이 남지 않는다', async () => {
    const { lines, stream } = sink();
    app = await createApp(testEnv(), { logStream: stream });
    await app.init();
    await request(app.getHttpServer()).get('/health').set('Authorization', `Bearer ${KEY}`);
    await new Promise((r) => setImmediate(r));
    const requestLog = lines.join('');
    expect(requestLog.length).toBeGreaterThan(0);
    expect(requestLog).not.toContain(KEY);
    expect(requestLog).toContain('[REDACTED]');
    expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow();

    lines.length = 0;
    const logger = app.get(Logger);
    logger.log({ authorization: `Bearer ${KEY}` }, 'a');
    logger.log({ identityKey: KEY }, 'b');
    logger.log({ ctx: { identityKey: KEY, headers: { authorization: KEY } } }, 'c');
    const appLog = lines.join('');
    expect(appLog).not.toContain(KEY);
    expect((appLog.match(/\[REDACTED\]/g) ?? []).length).toBe(4);
  });
});
