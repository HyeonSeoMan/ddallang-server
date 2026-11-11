import 'reflect-metadata';
import { createApp } from './app.js';
import { EnvValidationError, loadEnv } from './common/config/env.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv(process.env);
  const app = await createApp(env);
  await app.listen(env.PORT);
}

bootstrap().catch((err: unknown) => {
  // 환경 변수 오류는 키 이름·사유만 출력한다(값은 출력하지 않는다).
  console.error(err instanceof EnvValidationError ? err.message : err);
  process.exit(1);
});
