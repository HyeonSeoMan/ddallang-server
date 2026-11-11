import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

/** PD-20: 인증·DB 조회 없음. 프로세스가 요청을 받을 수 있는지만 알린다. */
@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: '환경 검증용 헬스 체크 (Spec 밖 경로, PD-20)' })
  @ApiOkResponse({
    schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } },
  })
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
