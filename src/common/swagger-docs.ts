import { applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiParam, ApiResponse } from '@nestjs/swagger';
import { ERROR_CODES, type ErrorCode } from './errors/error-codes.js';
import { ERROR_SCHEMA } from './swagger-schemas.js';

/**
 * 문서용(비권위, PD-19): 이 엔드포인트가 돌려줄 수 있는 오류 코드를 상태별로 묶어 문서화한다.
 * 응답 본문은 모두 공통 형식 `{ error: { code, message, details[] } }`이다.
 */
export function ApiErrors(...codes: ErrorCode[]) {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const status = ERROR_CODES[code].status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return applyDecorators(
    ...[...byStatus]
      .sort(([a], [b]) => a - b)
      .map(([status, list]) =>
        ApiResponse({
          status,
          description: list.map((c) => `\`${c}\` — ${ERROR_CODES[c].message}`).join('\n\n'),
          schema: ERROR_SCHEMA,
        }),
      ),
  );
}

/** 신원 키 인증이 필요한 엔드포인트(`Authorization: Bearer <신원 키>`). */
export const ApiIdentityKey = () => ApiBearerAuth('identity-key');

export const ApiRoomIdParam = () =>
  ApiParam({
    name: 'roomId',
    description: '방 ID(입장 응답이 처음 알려 준다). 비멤버에게는 없는 방과 같은 404다',
  });
