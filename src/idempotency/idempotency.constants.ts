/** S2 §5.4: 유효 기간은 최초 시도 시각부터 24시간. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** 서버 수신 시각보다 이만큼(5분)을 넘는 미래의 firstAttemptAt은 거부한다. */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
/** 기록은 expiresAt이 지나고도 이 시간 동안 보관한다(요청 대기·인스턴스 시각 차이 흡수, PD-7). */
export const CLEANUP_GRACE_MS = 60 * 60 * 1000;
