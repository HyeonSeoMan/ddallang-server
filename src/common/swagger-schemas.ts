import type { SchemaObject } from '@nestjs/swagger';

/**
 * 문서용(비권위, PD-19) 응답 스키마. 계약 원본은 각 Spec이며 여기와 다르면 Spec이 옳다.
 * 서버 내부 필드(`revision`, 신원 키 해시, `seq`, 원본 값, 삭제 정보)는 응답에 없다.
 */
const str = (description?: string, extra: SchemaObject = {}): SchemaObject => ({
  type: 'string',
  ...(description ? { description } : {}),
  ...extra,
});
const iso = (description: string): SchemaObject =>
  str(description, { format: 'date-time', example: '2026-11-11T03:21:45.123Z' });

export const ROOM_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['id', 'name', 'unit', 'status', 'inviteCode', 'createdAt'],
  properties: {
    id: str('불투명 ID(128비트 base64url)'),
    name: str('방 이름(1~12자)'),
    unit: str('정산 단위(1~12자)', { example: '원' }),
    status: str(undefined, { enum: ['IN_PROGRESS', 'ENDED'] }),
    inviteCode: str('초대 코드(128비트 URL-safe)'),
    createdAt: iso('방 생성 시각'),
  },
};

export const ROOM_SUMMARY_SCHEMA: SchemaObject = {
  type: 'object',
  description: '입장 응답의 방 요약(초대 코드 없음)',
  required: ['id', 'name', 'unit', 'status'],
  properties: {
    id: str(),
    name: str(),
    unit: str(),
    status: str(undefined, { enum: ['IN_PROGRESS', 'ENDED'] }),
  },
};

export const ROOM_MEMBER_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['id', 'roomId', 'nickname', 'isHost', 'createdAt'],
  properties: {
    id: str(),
    roomId: str(),
    nickname: str(),
    isHost: { type: 'boolean' },
    createdAt: iso('입장 시각'),
  },
};

export const PARTICIPANT_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['id', 'roomId', 'nickname', 'status', 'order', 'createdAt'],
  properties: {
    id: str(),
    roomId: str(),
    nickname: str(),
    status: str(undefined, { enum: ['ACTIVE', 'INACTIVE'] }),
    order: {
      type: 'integer',
      minimum: 1,
      description: '방 안에서 유일, 한 번 부여되면 바뀌지 않는다',
    },
    createdAt: iso('등록 시각'),
  },
};

export const TRANSACTION_SCHEMA: SchemaObject = {
  type: 'object',
  required: [
    'id',
    'payerId',
    'payeeId',
    'amount',
    'reason',
    'round',
    'authorId',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: str(),
    payerId: str('지급자 Participant ID'),
    payeeId: str('수취자 Participant ID'),
    amount: { type: 'integer', minimum: 1, maximum: 999999999 },
    reason: str('사유(최대 50자)', { nullable: true }),
    round: str('라운드(최대 12자)', { nullable: true }),
    authorId: str('작성자 RoomMember ID'),
    createdAt: iso('원본 서버 생성 시각'),
    updatedAt: iso('마지막으로 값이 바뀐 시각(생성 시 createdAt과 같다)'),
  },
};

export const BALANCE_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['participantId', 'nickname', 'status', 'order', 'balance'],
  properties: {
    participantId: str(),
    nickname: str(),
    status: str(undefined, { enum: ['ACTIVE', 'INACTIVE'] }),
    order: { type: 'integer' },
    balance: { type: 'integer', description: '수취 합 − 지급 합(유효 거래만). 음수일 수 있다' },
  },
};

export const ERROR_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'details'],
      properties: {
        code: str('분기 기준(예: VALIDATION_FAILED, ROOM_NOT_FOUND)'),
        message: str('한국어 사용자 안내 문구'),
        details: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: '검증·한도 오류의 상세',
        },
      },
    },
  },
  example: {
    error: {
      code: 'VALIDATION_FAILED',
      message: '입력 값을 확인해 주세요.',
      details: [{ field: 'nickname', code: 'REQUIRED' }],
    },
  },
};

export const obj = (
  properties: Record<string, SchemaObject>,
  required = Object.keys(properties),
): SchemaObject => ({
  type: 'object',
  required,
  properties,
});
export const arrayOf = (items: SchemaObject): SchemaObject => ({ type: 'array', items });
