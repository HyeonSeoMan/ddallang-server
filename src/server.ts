import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from './app.js';
import { EnvValidationError, loadEnv } from './common/config/env.js';

/** 환경 변수를 검증한 뒤 listen한다. 검증에 실패하면 listen하지 않고 던진다. */
export async function startServer(
  rawEnv: Record<string, string | undefined>,
): Promise<NestExpressApplication> {
  const env = loadEnv(rawEnv);
  const app = await createApp(env);
  await app.listen(env.PORT);
  return app;
}

/** 진입점 로직. 실패하면 오류 메시지를 남기고 exit(1)을 호출한다. */
export async function runMain(
  rawEnv: Record<string, string | undefined>,
  exit: (code: number) => void,
): Promise<void> {
  try {
    await startServer(rawEnv);
  } catch (err) {
    // 환경 변수 오류는 키 이름·사유만 출력한다(값은 출력하지 않는다).
    console.error(err instanceof EnvValidationError ? err.message : err);
    exit(1);
  }
}
