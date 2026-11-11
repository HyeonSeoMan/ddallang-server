import {
  Controller,
  Delete,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CurrentMember,
  RoomMemberGuard,
  type RoomMemberContext,
} from '../common/auth/room-member.guard.js';
import { JsonBody, type BodyInput } from '../common/http/json-body.js';
import { ApiErrorResponses, ApiIdentityKey } from '../common/swagger-docs.js';
import { TRANSACTION_SCHEMA, obj } from '../common/swagger-schemas.js';
import { TransactionsService, type Reply, type Requester } from './transactions.service.js';

type Headers_ = Record<string, string | string[] | undefined>;

const idempotencyHeaders = () => [
  ApiHeader({ name: 'Idempotency-Key', required: true, description: '^[A-Za-z0-9_-]{16,64}$' }),
  ApiHeader({
    name: 'Idempotency-First-Attempt-At',
    required: true,
    description: 'RFC 3339 UTC 밀리초, 이 요청을 처음 시도한 시각',
  }),
];
const apply =
  (...decorators: MethodDecorator[]): MethodDecorator =>
  (target, key, descriptor) => {
    for (const d of decorators) d(target, key, descriptor);
  };

function requester(m: RoomMemberContext): Requester {
  return { memberId: m.memberId, roomId: m.roomId, isHost: m.isHost };
}

/** 재전송이면 `Idempotent-Replayed: true`를 더하고 저장된 상태 코드·본문을 그대로 돌려준다(S2 §5.3). */
function send(res: Response, reply: Reply): unknown {
  res.status(reply.status);
  if (reply.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return reply.body;
}

@ApiTags('transactions')
@Controller('rooms/:roomId/transactions')
@UseGuards(RoomMemberGuard)
@ApiIdentityKey()
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Post()
  @HttpCode(201)
  @apply(...idempotencyHeaders())
  @ApiOperation({ summary: '거래 생성 (S2 §4.1)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['payerId', 'payeeId', 'amount'],
      properties: {
        payerId: { type: 'string' },
        payeeId: { type: 'string' },
        amount: { type: 'integer', minimum: 1, maximum: 999999999 },
        reason: { type: 'string', nullable: true },
        round: { type: 'string', nullable: true },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: '생성된 거래. 같은 키 재전송이면 Idempotent-Replayed: true와 최초 결과',
    schema: obj({ transaction: TRANSACTION_SCHEMA }),
  })
  @ApiErrorResponses(401, 404, 409, 422)
  async create(
    @CurrentMember() member: RoomMemberContext,
    @Headers() headers: Headers_,
    @JsonBody() body: BodyInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return send(res, await this.transactions.create(requester(member), headers, body));
  }

  @Put(':transactionId')
  @apply(...idempotencyHeaders())
  @ApiOperation({
    summary: '거래 수정 (S2 §4.2): amount·reason·round를 통째로 교체. 작성자 또는 방장',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['amount'],
      properties: {
        amount: { type: 'integer', minimum: 1, maximum: 999999999 },
        reason: { type: 'string', nullable: true },
        round: { type: 'string', nullable: true },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: '수정된(또는 값이 같아 그대로인) 거래',
    schema: obj({ transaction: TRANSACTION_SCHEMA }),
  })
  @ApiErrorResponses(401, 403, 404, 409, 422)
  async update(
    @CurrentMember() member: RoomMemberContext,
    @Param('transactionId') transactionId: string,
    @Headers() headers: Headers_,
    @JsonBody() body: BodyInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return send(
      res,
      await this.transactions.update(requester(member), transactionId, headers, body),
    );
  }

  @Delete(':transactionId')
  @apply(...idempotencyHeaders())
  @ApiOperation({ summary: '거래 삭제 (S2 §4.3): 행을 지우지 않는다. 작성자 또는 방장' })
  @ApiResponse({
    status: 200,
    description: '삭제 결과',
    schema: obj({
      transactionId: { type: 'string' },
      deletedAt: { type: 'string', format: 'date-time' },
    }),
  })
  @ApiErrorResponses(401, 403, 404, 409, 422)
  async remove(
    @CurrentMember() member: RoomMemberContext,
    @Param('transactionId') transactionId: string,
    @Headers() headers: Headers_,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return send(res, await this.transactions.remove(requester(member), transactionId, headers));
  }
}
