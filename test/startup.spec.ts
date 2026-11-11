import { createServer } from 'node:net';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { EnvValidationError } from '../src/common/config/env.js';
import { runMain, startServer } from '../src/server.js';

const valid = {
  NODE_ENV: 'test',
  CORS_ORIGINS: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://u:secret-pw@localhost:5432/db',
  CURSOR_KEY: Buffer.alloc(32, 1).toString('base64'),
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const invalidCases: [string, Record<string, string | undefined>][] = [
  ['NODE_ENV 미설정', { ...valid, NODE_ENV: undefined }],
  ['NODE_ENV 허용 밖', { ...valid, NODE_ENV: 'staging' }],
  ['DATABASE_URL 누락', { ...valid, DATABASE_URL: undefined }],
  ['CORS_ORIGINS 누락', { ...valid, CORS_ORIGINS: undefined }],
];

describe('기동 진입점 (PD-18)', () => {
  it.each(invalidCases)('%s이면 startServer가 listen하지 않고 던진다', async (_n, raw) => {
    await expect(startServer(raw)).rejects.toBeInstanceOf(EnvValidationError);
  });

  it.each(invalidCases)(
    '%s이면 runMain이 exit(1)을 호출하고 값을 출력하지 않는다',
    async (_n, raw) => {
      const exit = vi.fn();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await runMain(raw, exit);
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(String(errSpy.mock.calls[0]?.[0])).not.toContain('secret-pw');
      } finally {
        errSpy.mockRestore();
      }
    },
  );

  it('정상 환경이면 listen하고 /health에 응답하며 exit하지 않는다', async () => {
    const port = await freePort();
    const exit = vi.fn();
    const app = await startServer({ ...valid, PORT: String(port) });
    try {
      const res = await request(`http://127.0.0.1:${port}`).get('/health');
      expect(res.status).toBe(200);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
