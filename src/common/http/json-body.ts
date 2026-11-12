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

/** 파싱 실패 중 문법은 올바른 JSON이지만 최상위가 객체·배열이 아닌 본문(`5`, `"x"`, `null`). */
const nonObjectJsonRequests = new WeakMap<object, unknown>();
const rawBodies = new WeakMap<object, string>();

/**
 * JSON 본문 파서. 실패해도 예외를 던지거나 즉시 응답하지 않고 요청에 실패만 표시한 채 `next()`로
 * 정상 흐름을 이어 간다(PD-8). 인증(401)·존재(404)·권한(403)·상태(409) 판정이 먼저 응답되어야 하고
 * 입력 검증(422)은 마지막 쪽이기 때문이다.
 */
export function jsonBodyParser(): RequestHandler {
  const parse = express.json({
    verify: (req, _res, buf) => {
      rawBodies.set(req, buf.toString('utf8'));
    },
  });
  return (req: Request, res: Response, next: NextFunction) => {
    parse(req, res, (err?: unknown) => {
      if (err) {
        markBodyParseFailed(req);
        try {
          const value: unknown = JSON.parse(rawBodies.get(req) ?? '');
          nonObjectJsonRequests.set(req, value); // 문법은 올바르다: 최상위가 객체가 아닌 JSON
        } catch {
          // 문법 오류
        }
      }
      next();
    });
  };
}

export interface BodyInput {
  /** 본문 파싱이 실패했다 */
  parseFailed: boolean;
  /** 파싱된 본문(없으면 `undefined`) */
  body: unknown;
  /** 파싱 실패 중, 문법은 올바른 JSON이지만 최상위가 객체가 아니다 */
  nonObjectJson: boolean;
  /** `nonObjectJson`일 때 파싱된 값(지문에 넣어 값이 다르면 다른 내용이 되게 한다) */
  nonObjectValue?: unknown;
  /** JSON이 아닌 Content-Type으로 본문 바이트가 왔다(파서가 건너뛰어 `body`가 비어 있다) */
  unparsedPayload: boolean;
  /** `unparsedPayload`일 때 Content-Type과 길이(본문 내용을 읽지 않으므로 이것으로 내용을 구분한다) */
  unparsedSignature?: string;
}

/** 컨트롤러 매개변수로 본문과 파싱 실패 표시를 함께 받는다. */
export const JsonBody = createParamDecorator((_data: unknown, ctx: ExecutionContext): BodyInput => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const parseFailed = parseFailedRequests.has(req);
  const length = Number(req.headers['content-length'] ?? 0);
  return {
    parseFailed,
    body: req.body as unknown,
    nonObjectJson: nonObjectJsonRequests.has(req),
    nonObjectValue: nonObjectJsonRequests.get(req),
    unparsedPayload:
      !parseFailed &&
      req.body === undefined &&
      (length > 0 || req.headers['transfer-encoding'] !== undefined),
    unparsedSignature: `${String(req.headers['content-type'] ?? '')}|${length}`,
  };
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
