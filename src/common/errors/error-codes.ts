/**
 * 오류 코드 레지스트리: S1 §3.4, S2 §3.6, S5 §3.3. `message`는 클라이언트가 그대로 보여 줄 수 있는
 * 한국어 사용자 안내 문구다(분기는 `code`로 한다). 호출자가 사정에 맞는 문구로 덮어쓸 수 있다.
 */
export const ERROR_CODES = {
  // S1 §3.4
  UNAUTHENTICATED: { status: 401, message: '인증 정보가 없거나 올바르지 않습니다.' },
  IDENTITY_REVOKED: {
    status: 401,
    message: '다른 브라우저가 이 참여자를 이어받아 이 브라우저는 방에 접근할 수 없습니다.',
  },
  HOST_ONLY: { status: 403, message: '방장만 할 수 있는 동작입니다.' },
  ROOM_NOT_FOUND: { status: 404, message: '방을 찾을 수 없습니다.' },
  INVITE_NOT_FOUND: { status: 404, message: '초대 링크를 찾을 수 없습니다.' },
  PARTICIPANT_NOT_FOUND: { status: 404, message: '참여자를 찾을 수 없습니다.' },
  CLAIM_NOT_FOUND: { status: 404, message: '이어받기 요청을 찾을 수 없습니다.' },
  ROUTE_NOT_FOUND: { status: 404, message: '요청한 경로가 없습니다.' },
  NOT_SUPPORTED: { status: 405, message: '지원하지 않는 요청입니다.' },
  GAME_ENDED: { status: 409, message: '이미 종료된 방입니다.' },
  NICKNAME_TAKEN: { status: 409, message: '이미 사용 중인 닉네임입니다.' },
  PARTICIPANT_LIMIT_EXCEEDED: { status: 409, message: '등록할 수 있는 참여자 수를 넘었습니다.' },
  HOST_CANNOT_BE_DEACTIVATED: { status: 409, message: '방장은 비활성화할 수 없습니다.' },
  ALREADY_PARTICIPANT: { status: 409, message: '이미 이 방의 참여자입니다.' },
  CLAIM_PENDING: {
    status: 409,
    message: '방장의 승인을 기다리는 이어받기 요청이 있습니다. 먼저 요청을 취소해 주세요.',
  },
  CLAIM_ALREADY_RESOLVED: { status: 409, message: '이미 처리된 이어받기 요청입니다.' },
  CLAIM_REQUESTER_LINKED: {
    status: 409,
    message: '요청한 브라우저가 이미 다른 참여자로 연결되어 있어 요청을 거절했습니다.',
  },
  VALIDATION_FAILED: { status: 422, message: '입력 값을 확인해 주세요.' },
  // S2 §3.6
  REQUESTER_INACTIVE: {
    status: 403,
    message: '비활성 참여자는 거래를 등록·수정·삭제할 수 없습니다.',
  },
  NOT_AUTHOR_OR_HOST: { status: 403, message: '작성자나 방장만 할 수 있는 동작입니다.' },
  TRANSACTION_NOT_FOUND: { status: 404, message: '거래를 찾을 수 없습니다.' },
  TRANSACTION_DELETED: { status: 409, message: '이미 삭제된 거래입니다.' },
  PARTICIPANT_INACTIVE: { status: 409, message: '비활성 참여자는 선택할 수 없습니다.' },
  TRANSACTION_LIMIT_EXCEEDED: { status: 409, message: '기록할 수 있는 거래 수를 넘었습니다.' },
  IDEMPOTENCY_CONFLICT: { status: 409, message: '같은 요청 키로 다른 내용을 보낼 수 없습니다.' },
  IDEMPOTENCY_KEY_EXPIRED: { status: 409, message: '요청 키의 유효 기간이 지났습니다.' },
  // S5 §3.3
  CONNECTION_LIMIT_EXCEEDED: { status: 429, message: '동시에 연결할 수 있는 수를 넘었습니다.' },
  // Spec에 없는 서버 내부 오류(예상하지 못한 예외). 스택·내부 정보는 응답에 싣지 않는다.
  INTERNAL_ERROR: {
    status: 500,
    message: '서버에서 문제가 발생했습니다. 잠시 뒤에 다시 시도해 주세요.',
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
