import { ERROR_CODES, type ErrorCode } from './error-codes.js';

/** 공통 오류 본문 `{ error: { code, message, details[] } }`(S1 §3.4). */
export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details: Record<string, unknown>[] };
}

export interface ApiErrorOptions {
  /** 검증·한도 오류의 상세(S1 §3.4: `[{ field, code }]`, `[{ limit }]`). 없으면 빈 배열. */
  details?: Record<string, unknown>[];
  /** 기본 문구를 덮어쓴다. */
  message?: string;
  /** 응답에 더할 헤더(예: `Allow`, `Retry-After`) */
  headers?: Record<string, string>;
}

/** 서비스가 던지는 도메인 오류. 전역 예외 필터가 공통 형식으로 바꾼다. */
export class ApiError extends Error {
  readonly status: number;
  readonly details: Record<string, unknown>[];
  readonly headers: Record<string, string>;

  constructor(
    readonly code: ErrorCode,
    options: ApiErrorOptions = {},
  ) {
    super(options.message ?? ERROR_CODES[code].message);
    this.name = 'ApiError';
    this.status = ERROR_CODES[code].status;
    this.details = options.details ?? [];
    this.headers = options.headers ?? {};
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export function errorBody(code: ErrorCode, options: ApiErrorOptions = {}): ApiErrorBody {
  return new ApiError(code, options).toBody();
}
