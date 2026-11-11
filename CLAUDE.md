# ddallang-server — Claude Code 규칙

이 저장소는 DDALLANG 백엔드다. 문서(Policy·PRD·Spec·Plan·Tasks)의 단일 원본은 `~/Documents/ddallang`이며 이 저장소에 복사하지 않는다.

- 거버넌스: `~/Documents/ddallang/.agents/governance.md`와 `CLAUDE.md` §1~§7을 그대로 적용한다. 새 거버넌스·Hook·Skill은 만들지 않는다.
- 기준 문서: `docs/plans/server/plan.md`, `tasks.md` v1.1.0(`ddallang`의 `main`). 충돌하면 중단하고 ID·버전을 인용해 보고한다.
- 역할: Claude Code는 구현, Codex는 읽기 전용 검수, 사용자는 최종 승인이다.
- 작업 브랜치에서는 Claude Code가 필요할 때 커밋한다(사용자 상시 허용 2026-11-11). 검수 통과, 검수 한도 소진 또는 사용자 판단 뒤에는 로컬 `main`으로 병합할 수 있다(병합 직전 요약을 남긴다). push·원격 병합·`main` 직접 커밋·force push는 하지 않는다. Policy·PRD·Spec·Plan·PD 충돌, 네이티브 빌드·외부 다운로드가 따르는 런타임 의존성, 되돌리기 어려운 작업·비밀값은 멈추고 묻는다.
- `.env`와 비밀값은 커밋·출력하지 않는다.
- 전역 `ValidationPipe`를 쓰지 않는다(PD-8). 범위 밖 Task(예: Prisma는 BE-F2)를 선행 구현하지 않는다.
