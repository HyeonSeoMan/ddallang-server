import { ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ApiError } from './api-error.js';

/**
 * 전역 예외 필터: 모든 오류 응답을 공통 형식으로 만든다.
 * - `ApiError`는 그대로 옮긴다(`Allow`·`Retry-After` 같은 헤더 포함).
 * - 프레임워크의 404(라우터가 놓친 경로)는 `ROUTE_NOT_FOUND`, 405는 `NOT_SUPPORTED`로 맞춘다.
 * - 그 밖의 예외는 `500 INTERNAL_ERROR`이며 내부 정보를 응답에 싣지 않고 서버 로그에만 남긴다.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let error: ApiError;
    if (exception instanceof ApiError) {
      error = exception;
    } else if (exception instanceof HttpException && exception.getStatus() === 404) {
      error = new ApiError('ROUTE_NOT_FOUND');
    } else if (exception instanceof HttpException && exception.getStatus() === 405) {
      error = new ApiError('NOT_SUPPORTED');
    } else {
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
      );
      error = new ApiError('INTERNAL_ERROR');
    }
    if (res.headersSent) return;
    for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value);
    res.status(error.status).json(error.toBody());
  }
}
