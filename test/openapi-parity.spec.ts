import { Controller, Get } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { setupSwagger } from '../src/swagger.js';
import { quietLog, testEnv } from './helpers/env.js';
import {
  collectControllerRoutes,
  collectDocumentRoutes,
  collectRegistryRoutes,
  diffRoutes,
} from './helpers/route-parity.js';

@Controller('hidden')
class HiddenController {
  @Get()
  @ApiExcludeEndpoint()
  hidden(): string {
    return 'x';
  }
}

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function bootDev(extraControllers: (new () => object)[] = []) {
  const env = testEnv('development');
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(env, quietLog)],
    controllers: extraControllers,
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  const document = setupSwagger(app, env);
  await app.init();
  if (!document) throw new Error('development에서는 문서가 만들어져야 한다');
  return { app, document };
}

describe('레지스트리 집합 = 컨트롤러 집합 = 문서 집합 (PD-19 (g), PD-9)', () => {
  it('현재 앱은 GET /health 하나로 일치한다', async () => {
    const { app, document } = await bootDev();
    const controllers = collectControllerRoutes(app);
    expect([...controllers]).toEqual(['GET /health']);
    expect(diffRoutes(controllers, collectDocumentRoutes(document))).toEqual({
      missingInDocument: [],
      extraInDocument: [],
    });
    expect([...collectRegistryRoutes(app)]).toEqual(['GET /health']);
    expect(diffRoutes(collectRegistryRoutes(app), controllers)).toEqual({
      missingInDocument: [],
      extraInDocument: [],
    });
  });

  it('레지스트리는 컨트롤러가 추가되면 같이 늘고, 문서와 어긋나면 비교기가 보고한다', async () => {
    const { app, document } = await bootDev([HiddenController]);
    const registry = collectRegistryRoutes(app);
    expect([...registry].sort()).toEqual(['GET /health', 'GET /hidden']);
    expect(registry).toEqual(collectControllerRoutes(app)); // 레지스트리 = 컨트롤러
    expect(diffRoutes(registry, collectDocumentRoutes(document)).missingInDocument).toEqual([
      'GET /hidden',
    ]);
  });

  it('레지스트리에 있는데 컨트롤러에 없는 경로(예: 잘못된 비-Spec 항목)는 보고한다', () => {
    const diff = diffRoutes(new Set(['GET /health', 'GET /ghost']), new Set(['GET /health']));
    expect(diff.missingInDocument).toEqual(['GET /ghost']);
  });

  it('문서에서 빠진 경로(@ApiExcludeEndpoint)가 있으면 비교기가 실패를 보고한다', async () => {
    const { app, document } = await bootDev([HiddenController]);
    const diff = diffRoutes(collectControllerRoutes(app), collectDocumentRoutes(document));
    expect(diff.missingInDocument).toEqual(['GET /hidden']);
    expect(diff.extraInDocument).toEqual([]);
  });

  it('컨트롤러에 없고 문서에만 있는 경로도 보고한다', async () => {
    const { app, document } = await bootDev();
    const doctored = { paths: { ...document.paths, '/ghost': { post: {} } } };
    const diff = diffRoutes(collectControllerRoutes(app), collectDocumentRoutes(doctored));
    expect(diff.extraInDocument).toEqual(['POST /ghost']);
    expect(diff.missingInDocument).toEqual([]);
  });

  it('/api-docs* 경로는 비교에서 제외한다', () => {
    const routes = collectDocumentRoutes({
      paths: { '/api-docs': { get: {} }, '/api-docs-json': { get: {} }, '/health': { get: {} } },
    });
    expect([...routes]).toEqual(['GET /health']);
  });
});
