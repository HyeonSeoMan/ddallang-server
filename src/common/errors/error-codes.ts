/**
 * 오류 코드 레지스트리: S1 §3.4, S2 §3.6, S5 §3.3. `message`는 클라이언트가 그대로 보여 줄 수 있는
 * 한국어 사용자 안내 문구다(분기는 `code`로 한다). 호출자가 사정에 맞는 문구로 덮어쓸 수 있다.
 */
export const ERROR_CODES = {
  // S1 §3.4
  UNAUTHENTICATED: { status: 401, message: '인증 정보가 없거나 올바르지 않습니다.' },
  HOST_ONLY: { status: 403, message: '방장만 할 수 있는 동작입니다.' },
  ROOM_NOT_FOUND: { status: 404, message: '방을 찾을 수 없습니다.' },
  INVITE_NOT_FOUND: { status: 404, message: '초대 링크를 찾을 수 없습니다.' },
  PARTICIPANT_NOT_FOUND: { status: 404, message: '참여자를 찾을 수 없습니다.' },
  ROUTE_NOT_FOUND: { status: 404, message: '요청한 경로가 없습니다.' },
  NOT_SUPPORTED: { status: 405, message: '지원하지 않는 요청입니다.' },
  GAME_ENDED: { status: 409, message: '이미 종료된 방입니다.' },
  NICKNAME_TAKEN: { status: 409, message: '이미 사용 중인 닉네임입니다.' },
  MEMBER_LIMIT_EXCEEDED: { status: 409, message: '방에 입장할 수 있는 인원을 넘었습니다.' },
  PARTICIPANT_LIMIT_EXCEEDED: { status: 409, message: '등록할 수 있는 참여자 수를 넘었습니다.' },
  VALIDATION_FAILED: { status: 422, message: '입력 값을 확인해 주세요.' },
  // S2 §3.6
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
