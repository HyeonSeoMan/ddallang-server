import { applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { ERROR_SCHEMA } from './swagger-schemas.js';

const ERROR_DESCRIPTIONS: Record<number, string> = {
  401: 'UNAUTHENTICATED: 신원 키 누락·형식 오류',
  403: 'HOST_ONLY · NOT_AUTHOR_OR_HOST: 권한 없음',
  404: 'ROOM_NOT_FOUND(비멤버 포함) · INVITE_NOT_FOUND · PARTICIPANT_NOT_FOUND · TRANSACTION_NOT_FOUND · ROUTE_NOT_FOUND',
  405: 'NOT_SUPPORTED (Allow 헤더)',
  409: 'GAME_ENDED · NICKNAME_TAKEN · MEMBER_LIMIT_EXCEEDED · PARTICIPANT_LIMIT_EXCEEDED · TRANSACTION_DELETED · PARTICIPANT_INACTIVE · TRANSACTION_LIMIT_EXCEEDED · IDEMPOTENCY_CONFLICT · IDEMPOTENCY_KEY_EXPIRED',
  422: 'VALIDATION_FAILED (details[])',
  429: 'CONNECTION_LIMIT_EXCEEDED (Retry-After)',
};

/** 문서용(비권위, PD-19): 인증 방식과 공통 오류 응답 `{ error: { code, message, details[] } }`. */
export function ApiErrorResponses(...statuses: number[]) {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: ERROR_DESCRIPTIONS[status] ?? '오류',
        schema: ERROR_SCHEMA,
      }),
    ),
  );
}

export const ApiIdentityKey = () => ApiBearerAuth('identity-key');
