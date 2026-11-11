import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { ApiError } from '../errors/api-error.js';

/** 본문 파싱에 실패한 요청. 응답은 서비스가 정해진 검증 차례에서 정한다(PD-8). */
const parseFailedRequests = new WeakSet<object>();

export function markBodyParseFailed(req: object): void {
  parseFailedRequests.add(req);
}

/**
 * JSON 본문 파서. 실패해도 예외를 던지거나 즉시 응답하지 않고 요청에 실패만 표시한 채 `next()`로
 * 정상 흐름을 이어 간다(PD-8). 인증(401)·존재(404)·권한(403)·상태(409) 판정이 먼저 응답되어야 하고
 * 입력 검증(422)은 마지막 쪽이기 때문이다.
 */
export function jsonBodyParser(): RequestHandler {
  const parse = express.json();
  return (req: Request, res: Response, next: NextFunction) => {
    parse(req, res, (err?: unknown) => {
      if (err) markBodyParseFailed(req);
      next();
    });
  };
}

export interface BodyInput {
  /** 본문 파싱이 실패했다 */
  parseFailed: boolean;
  /** 파싱된 본문(없으면 `undefined`) */
  body: unknown;
}

/** 컨트롤러 매개변수로 본문과 파싱 실패 표시를 함께 받는다. */
export const JsonBody = createParamDecorator((_data: unknown, ctx: ExecutionContext): BodyInput => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { parseFailed: parseFailedRequests.has(req), body: req.body as unknown };
});

/**
 * 서비스가 정해진 검사 차례(S1 §3.3 7번, S2 §3.4 10번, S4 §3.3 8번)에서 호출한다.
 * 파싱 실패이면 `422 VALIDATION_FAILED`(Spec이 `details`를 정하지 않아 `[{ field: 'body', code: 'INVALID_VALUE' }]`로 둔다).
 */
export function requireJsonBody(input: BodyInput): unknown {
  if (input.parseFailed) {
    throw new ApiError('VALIDATION_FAILED', {
      details: [{ field: 'body', code: 'INVALID_VALUE' }],
    });
  }
  return input.body;
}
