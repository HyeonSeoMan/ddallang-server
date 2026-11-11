import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

/**
 * BE-F8 다중 프로세스 하네스: 서버 인스턴스를 별도 OS 프로세스 여러 개로 같은 DB에 붙인다.
 * 실행 대상은 vitest globalSetup이 만든 `dist-test`다. 종료는 PID를 지정한 신호로만 한다(pkill 금지).
 */
export interface Instance {
  readonly pid: number;
  readonly port: number;
  readonly baseUrl: string;
  /** 지금까지 캡처한 stdout·stderr */
  output(): string;
  isRunning(): boolean;
  /** 이 프로세스에만 신호를 보낸다(예: SIGSTOP/SIGCONT). */
  signal(sig: NodeJS.Signals): void;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** SIGTERM 후 5초 안에 끝나지 않으면 SIGKILL. 멈춘(SIGSTOP) 프로세스는 먼저 재개한다. */
  stop(): Promise<void>;
}

export interface StartOptions {
  /** 시험 스키마가 고정된 DATABASE_URL(`createIsolatedDb().databaseUrl`) */
  databaseUrl: string;
  /** probe: 프로브 컨트롤러가 얹힌 시험 진입점(기본). main: 운영 진입점과 같은 `src/main`. */
  entry?: 'probe' | 'main';
  /** 인스턴스에 더하거나 덮어쓸 환경 변수 */
  env?: Record<string, string>;
  readyTimeoutMs?: number;
}

const ENTRY: Record<NonNullable<StartOptions['entry']>, string> = {
  probe: join('dist-test', 'test', 'fixtures', 'probe-main.js'),
  main: join('dist-test', 'src', 'main.js'),
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function startOne(opts: StartOptions): Promise<Instance> {
  const port = await freePort();
  const chunks: string[] = [];
  // 부모 환경을 그대로 넘기지 않는다(필요한 값만 명시).
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'test',
    PORT: String(port),
    CORS_ORIGINS: 'http://localhost:3000',
    DATABASE_URL: opts.databaseUrl,
    DB_POOL_MAX: '3',
    ...opts.env,
  };
  const child: ChildProcess = spawn(process.execPath, [ENTRY[opts.entry ?? 'probe']], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => chunks.push(d.toString()));
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exitPromise = new Promise<void>((resolve) =>
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      resolve();
    }),
  );

  const instance: Instance = {
    pid: child.pid!,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    output: () => chunks.join(''),
    isRunning: () => exited === undefined,
    signal: (sig) => void child.kill(sig),
    fetch: (path, init) => fetch(`${instance.baseUrl}${path}`, init),
    async stop() {
      if (exited) return;
      child.kill('SIGCONT');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exitPromise;
      clearTimeout(timer);
    },
  };

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 20_000);
  for (;;) {
    if (exited) {
      throw new Error(
        `인스턴스가 기동 중 종료됐다(code=${exited.code}, signal=${exited.signal}).\n${instance.output()}`,
      );
    }
    try {
      const res = await instance.fetch('/health', { signal: AbortSignal.timeout(1_000) });
      if (res.status === 200) return instance;
    } catch {
      // 아직 listen 전이다.
    }
    if (Date.now() > deadline) {
      await instance.stop();
      throw new Error(
        `인스턴스 준비 시간 초과(${opts.readyTimeoutMs ?? 20_000}ms).\n${instance.output()}`,
      );
    }
    await sleep(100);
  }
}

/** n개의 인스턴스를 띄운다. 하나라도 실패하면 이미 뜬 것을 정리하고 던진다. */
export async function startInstances(n: number, opts: StartOptions): Promise<Instance[]> {
  const started: Instance[] = [];
  try {
    for (let i = 0; i < n; i++) started.push(await startOne(opts));
    return started;
  } catch (err) {
    await Promise.all(started.map((s) => s.stop()));
    throw err;
  }
}

export async function stopAll(instances: Instance[]): Promise<void> {
  await Promise.all(instances.map((i) => i.stop()));
}
