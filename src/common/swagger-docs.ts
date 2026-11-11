import { applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse } from '@nestjs/swagger';

const ERROR_DESCRIPTIONS: Record<number, string> = {
  401: 'UNAUTHENTICATED: 신원 키 누락·형식 오류',
  403: 'HOST_ONLY 등: 권한 없음',
  404: 'ROOM_NOT_FOUND · INVITE_NOT_FOUND · PARTICIPANT_NOT_FOUND',
  405: 'NOT_SUPPORTED (Allow 헤더)',
  409: 'GAME_ENDED · NICKNAME_TAKEN · MEMBER_LIMIT_EXCEEDED · PARTICIPANT_LIMIT_EXCEEDED',
  422: 'VALIDATION_FAILED (details[])',
};

/** 문서용(비권위, PD-19): 인증 방식과 공통 오류 응답 `{ error: { code, message, details[] } }`. */
export function ApiErrorResponses(...statuses: number[]) {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({ status, description: ERROR_DESCRIPTIONS[status] ?? '오류' }),
    ),
  );
}

export const ApiIdentityKey = () => ApiBearerAuth('identity-key');
