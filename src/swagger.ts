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
    .setDescription(
      '개발 환경 전용 **비권위 참고 문서**다. 계약 원본은 `ddallang` 저장소의 Spec(S1~S5)이며 이 문서가 Spec과 다르면 Spec이 옳다. ' +
        '인증은 `Authorization: Bearer <신원 키>`(32바이트 난수를 패딩 없는 base64url로 인코딩한 43자)이며 방마다 따로 식별한다. ' +
        '모든 오류 응답은 `{ error: { code, message, details[] } }` 형식이다.',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: '신원 키(43자 base64url)',
        description: '브라우저가 만든 난수. 서버는 SHA-256 해시만 저장한다',
      },
      'identity-key',
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
