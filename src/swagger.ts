import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { Env } from './common/config/env.js';

export const SWAGGER_UI_PATH = 'api-docs';
export const SWAGGER_JSON_PATH = 'api-docs-json';

/** PD-19: 비권위 참고용. NODE_ENV=development에서만 등록한다. YAML 경로는 만들지 않는다. */
export function setupSwagger(app: INestApplication, env: Env): OpenAPIObject | undefined {
  if (env.NODE_ENV !== 'development') return undefined;
  const config = new DocumentBuilder()
    .setTitle('DDALLANG API (참고용, 계약 원본은 Spec)')
    .setVersion('0.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'identity-key')
    .addGlobalParameters(
      { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } },
      {
        name: 'Idempotency-First-Attempt-At',
        in: 'header',
        required: false,
        schema: { type: 'string' },
      },
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(SWAGGER_UI_PATH, app, document, {
    jsonDocumentUrl: SWAGGER_JSON_PATH,
    yamlDocumentUrl: undefined,
    raw: ['json'],
  });
  return document;
}
