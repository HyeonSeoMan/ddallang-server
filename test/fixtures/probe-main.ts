import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module.js';
import { EnvValidationError, loadEnv, type Env } from '../../src/common/config/env.js';
import { ProbeModule } from './probe.module.js';

@Module({})
class ProbeRootModule {
  static register(env: Env): DynamicModule {
    return { module: ProbeRootModule, imports: [AppModule.register(env), ProbeModule] };
  }
}

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const app = await NestFactory.create(ProbeRootModule.register(env));
  await app.listen(env.PORT);
}

main().catch((err: unknown) => {
  console.error(err instanceof EnvValidationError ? err.message : err);
  process.exit(1);
});
