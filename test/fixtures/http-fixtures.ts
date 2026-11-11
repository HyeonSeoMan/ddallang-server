import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Headers,
  HttpCode,
  Injectable,
  NotFoundException,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '../../src/common/errors/api-error.js';
import { JsonBody, requireJsonBody, type BodyInput } from '../../src/common/http/json-body.js';

/** 시험 전용: 인증 헤더가 없으면 401. 라우트 단계가 이보다 앞서는지 확인하는 데 쓴다. */
@Injectable()
export class FixtureAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.headers['x-test-auth']) throw new ApiError('UNAUTHENTICATED');
    return true;
  }
}

/** S1 §4.4~4.8의 경로 모양을 흉내 낸 시험 전용 컨트롤러(실제 S1 경로는 S1 Task가 만든다). */
@UseGuards(FixtureAuthGuard)
@Controller('rooms')
export class RoomsShapeFixture {
  @Get(':roomId')
  room(): { ok: true } {
    return { ok: true };
  }

  @Get(':roomId/participants')
  list(): { ok: true } {
    return { ok: true };
  }

  @Post(':roomId/participants')
  create(): { ok: true } {
    return { ok: true };
  }

  @Patch(':roomId/participants/:participantId')
  patch(): { ok: true } {
    return { ok: true };
  }
}

/**
 * S1 §3.3의 검사 순서를 흉내 낸 시험 전용 엔드포인트:
 * 1 인증 → 4 방장 → 5 방 상태 → 7 입력 검증(본문 파싱 실패 포함). 헤더로 상황을 정한다.
 */
@Controller('__fixture')
export class OrderFixture {
  @Post('orders/:id')
  @HttpCode(200)
  order(
    @Headers() headers: Record<string, string | undefined>,
    @JsonBody() input: BodyInput,
  ): { ok: true; body: unknown } {
    if (!headers['x-test-auth']) throw new ApiError('UNAUTHENTICATED'); // 1
    if (headers['x-test-role'] !== 'host') throw new ApiError('HOST_ONLY'); // 4
    if (headers['x-test-state'] === 'ended') throw new ApiError('GAME_ENDED'); // 5
    return { ok: true, body: requireJsonBody(input) }; // 7
  }
}

/** 오류 형식·헤더·500 처리 시험용. */
@Controller('__errors')
export class ErrorFixture {
  @Get('api')
  api(): never {
    throw new ApiError('CONNECTION_LIMIT_EXCEEDED', {
      details: [{ limit: 5 }],
      headers: { 'Retry-After': '30' },
    });
  }

  @Get('message')
  message(): never {
    throw new ApiError('VALIDATION_FAILED', {
      message: '직접 정한 문구',
      details: [{ field: 'nickname', code: 'CONSECUTIVE_SPACES' }],
    });
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret-internal-detail');
  }

  @Get('http404')
  http404(): never {
    throw new NotFoundException('some framework message');
  }
}
