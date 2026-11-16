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

export const PARTICIPANT_SCHEMA: SchemaObject = {
  type: 'object',
  description: '방의 유일한 사람 단위. 신원 연결 여부는 담지 않는다(S1-C6)',
  required: ['id', 'roomId', 'nickname', 'status', 'order', 'isHost', 'createdAt'],
  properties: {
    id: str(),
    roomId: str(),
    nickname: str(),
    status: str('방장은 항상 ACTIVE', { enum: ['ACTIVE', 'INACTIVE'] }),
    order: {
      type: 'integer',
      minimum: 1,
      description: '방 안에서 유일, 한 번 부여되면 바뀌지 않는다(방 생성자는 1)',
    },
    isHost: { type: 'boolean', description: '방을 만든 참여자만 true' },
    createdAt: iso('생성 시각'),
  },
};

const CLAIM_STATUS = str(undefined, { enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELED'] });
const REJECT_REASON = str('REJECTED일 때만 값이 있다', {
  enum: ['HOST_REJECTED', 'TARGET_CLAIMED', 'REQUESTER_LINKED'],
  nullable: true,
});

/** 요청자용 이어받기 요청(S1 §4, S1-C13): 대상 참여자 ID·처리한 방장 ID 없음. */
export const MY_CLAIM_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['id', 'nickname', 'status', 'rejectReason', 'createdAt', 'resolvedAt'],
  properties: {
    id: str(),
    nickname: str('이어받을 참여자의 닉네임'),
    status: CLAIM_STATUS,
    rejectReason: REJECT_REASON,
    createdAt: iso('요청 시각'),
    resolvedAt: str('승인·거절·취소 시각(대기 중이면 null)', {
      format: 'date-time',
      nullable: true,
    }),
  },
};

/** 방장용 이어받기 요청(S1 §4.12~§4.15). 요청 브라우저를 식별하는 정보는 없다. */
export const CLAIM_SCHEMA: SchemaObject = {
  type: 'object',
  required: [
    'id',
    'participantId',
    'nickname',
    'status',
    'rejectReason',
    'createdAt',
    'resolvedAt',
    'resolvedById',
  ],
  properties: {
    id: str(),
    participantId: str('이어받을 대상 Participant ID'),
    nickname: str('대상 참여자의 닉네임'),
    status: CLAIM_STATUS,
    rejectReason: REJECT_REASON,
    createdAt: iso('요청 시각'),
    resolvedAt: str('승인·거절·취소 시각(대기 중이면 null)', {
      format: 'date-time',
      nullable: true,
    }),
    resolvedById: str('처리한 방장 Participant ID(대기·취소는 null)', { nullable: true }),
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
    authorId: str('작성자 Participant ID'),
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

export const SETTLEMENT_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['kind', 'items'],
  properties: {
    kind: str('진행 중이면 EXPECTED(예상 정산), 종료 후 FINAL(최종 정산)', {
      enum: ['EXPECTED', 'FINAL'],
    }),
    items: arrayOf({
      type: 'object',
      required: ['payerId', 'payerNickname', 'payeeId', 'payeeNickname', 'amount'],
      properties: {
        payerId: str('지급자 Participant ID'),
        payerNickname: str(),
        payeeId: str('수취자 Participant ID'),
        payeeNickname: str(),
        amount: {
          type: 'integer',
          minimum: 1,
          description: '순손익의 합이라 단일 거래 상한을 넘을 수 있다',
        },
      },
    }),
  },
};
