import { Inject, Module, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { Env } from '../common/config/env.js';
import { ENV } from '../common/config/env.token.js';
import { IdempotencyService } from './idempotency.service.js';

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/** BE-F6 멱등 기반(S2 §5, S4 종료 `END`가 같은 규칙을 쓴다). 정리 작업은 test 환경에서는 돌리지 않는다. */
@Module({ providers: [IdempotencyService], exports: [IdempotencyService] })
export class IdempotencyModule implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly service: IdempotencyService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(
      () => void this.service.cleanupExpired().catch(() => undefined),
      CLEANUP_INTERVAL_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
}
