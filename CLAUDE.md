# ddallang-server — Claude Code 규칙

이 저장소는 DDALLANG 백엔드다. 문서(Policy·PRD·Spec·Plan·Tasks)의 단일 원본은 `~/Documents/ddallang`이며 이 저장소에 복사하지 않는다.

- 거버넌스: `~/Documents/ddallang/.agents/governance.md`와 `CLAUDE.md` §1~§7을 그대로 적용한다. 새 거버넌스·Hook·Skill은 만들지 않는다.
- 기준 문서: `docs/plans/server/plan.md`, `tasks.md` v1.1.0(`ddallang`의 `main`). 충돌하면 중단하고 ID·버전을 인용해 보고한다.
- 역할: Claude Code는 구현, Codex는 읽기 전용 검수, 사용자는 최종 승인이다.
- 커밋은 사용자가 요청할 때만 한다. push·병합·main 직접 커밋·force push는 하지 않는다.
- `.env`와 비밀값은 커밋·출력하지 않는다.
- 전역 `ValidationPipe`를 쓰지 않는다(PD-8). 범위 밖 Task(예: Prisma는 BE-F2)를 선행 구현하지 않는다.
