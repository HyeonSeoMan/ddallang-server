# ddallang-server

DDALLANG(정산 보조 서비스) MVP의 **백엔드**입니다. NestJS(Express) 단일 앱, TypeScript(strict, ESM), PostgreSQL 16, Prisma 7, REST(변경)와 SSE(변경 알림)를 씁니다.

- 문서(Policy·PRD·Spec·Plan·Tasks)의 **단일 원본은 [`ddallang`](https://github.com/HyeonSeoMan/ddallang)** 저장소입니다. 이 저장소에 복사하지 않고 `main`의 문서를 따릅니다. 계약이 모호하면 Spec이 옳고 Swagger(`/api-docs`)는 비권위 참고용입니다.
- 작업 규칙은 [`CLAUDE.md`](./CLAUDE.md), 거버넌스는 `ddallang`의 `.agents/governance.md`를 따릅니다.

## 기준 문서

| 문서                     | 버전                                 |
| ------------------------ | ------------------------------------ |
| Plan / Tasks / AC 매핑표 | v1.2.0 (`ddallang` `main` `2f5f455`) |
| PRD                      | v0.5.2                               |
| S1 방·신원·참여자        | v0.2.3                               |
| S2 거래 CRUD             | v0.2.2                               |
| S3 조회·손익             | v0.2.4                               |
| S5 실시간·연결           | v0.2.3                               |
| S4 정산·종료             | v0.2.0                               |

## 개발 현황 (2026-11-12, 로컬 `main`)

| 묶음      | Task                                                                      | 상태 | 검수                                    |
| --------- | ------------------------------------------------------------------------- | ---- | --------------------------------------- |
| 공통 기반 | BE-F1 골격·설정·로깅·`/health`·Swagger                                    | 완료 | Codex 1/3 후 수정                       |
|           | BE-F2 DB 기반·방 단위 직렬화(`withRoomLock`)                              | 완료 | Codex 3/3 소진(마지막 수정은 검수 없음) |
|           | BE-F8 시험 기반(스키마 격리, 다중 프로세스 하네스, AC 태그 검사)          | 완료 | Codex 3/3 소진                          |
|           | BE-F3 오류 형식·라우트 레지스트리·CORS, BE-F5 검증 라이브러리             | 완료 | 검수 없음                               |
|           | BE-F4 신원 키 인증, BE-F7 변경 파이프라인(`revision`·`pg_notify`)         | 완료 | 검수 없음                               |
| S1        | BE-S1-1 데이터 모델                                                       | 완료 | 검수 없음                               |
|           | BE-S1-2~S1-7 방 생성·초대·입장·참여자·계약·동시성                         | 완료 | 자체 검수(변형 시험)                    |
| S2        | BE-F6 멱등 기반, BE-S2-1~7 거래 생성·수정·삭제                            | 완료 | 자체 검수(변형 시험)                    |
| S3        | BE-S3-1~4 거래 목록·누적 손익 조회                                        | 완료 | 자체 검수(변형 시험)                    |
| S5        | BE-S5-1~6 SSE·연결 한도·지연 측정                                         | 완료 | 자체 검수 후 Codex 1/3 REVISE 반영      |
| S4        | BE-S4-1~7 게임 종료·정산                                                  | 완료 | 검수 없음                               |
| 마무리    | BE-Z1 통합 검증·증거 묶음([`docs/g4-evidence.md`](./docs/g4-evidence.md)) | 완료 | 검수 없음                               |

**독립 Codex 검수는 백엔드 개발이 끝난 뒤에 받습니다**(사용자 결정 2026-11-11). 개발 중에는 짧은 자체 검수만 하며 Codex 검수·PASS로 표기하지 않습니다.

### 구현된 API

| 메서드·경로                                           | 설명                                                                                    | 인증        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------- |
| `GET /health`                                         | 환경 검증(DB 조회 없음, 비-Spec 경로)                                                   | 없음        |
| `POST /rooms`                                         | 방 생성(최초 RoomMember가 방장)                                                         | 신원 키     |
| `GET /rooms/{roomId}`                                 | 방 조회                                                                                 | 방 멤버     |
| `GET /invites/{inviteCode}`                           | 초대 링크 조회(공개 필드만, `isMember`)                                                 | 선택        |
| `POST /invites/{inviteCode}/members`                  | 입장(같은 키는 200 복원)                                                                | 신원 키     |
| `GET /rooms/{roomId}/participants`                    | 참여자 목록                                                                             | 방 멤버     |
| `POST /rooms/{roomId}/participants`                   | 참여자 등록                                                                             | 방장        |
| `PATCH /rooms/{roomId}/participants/{participantId}`  | 참여자 활성 상태 변경                                                                   | 방장        |
| `POST /rooms/{roomId}/transactions`                   | 거래 생성(`Idempotency-Key`·`Idempotency-First-Attempt-At` 필수)                        | 방 멤버     |
| `PUT /rooms/{roomId}/transactions/{transactionId}`    | 거래 수정(통째 교체, 값이 같으면 no-op, 멱등 헤더 필수)                                 | 작성자·방장 |
| `DELETE /rooms/{roomId}/transactions/{transactionId}` | 거래 삭제(행을 지우지 않고 표시, 멱등 헤더 필수)                                        | 작성자·방장 |
| `GET /rooms/{roomId}/transactions`                    | 거래 목록(유효 거래, 20건 키셋 커서, `participantId` 필터)                              | 방 멤버     |
| `GET /rooms/{roomId}/balances`                        | 누적 손익(모든 참여자, `balance` 내림차순)                                              | 방 멤버     |
| `GET /rooms/{roomId}/events`                          | 실시간 SSE 스트림(`ready` → 변경 이벤트·`heartbeat`, 연결 한도 RoomMember당 5·방당 50)  | 방 멤버     |
| `POST /rooms/{roomId}/end`                            | 게임 종료(`Idempotency-*` 필수, 재전송 `Idempotent-Replayed`, 이미 종료면 `GAME_ENDED`) | 방장        |
| `GET /rooms/{roomId}/settlement`                      | 정산 조회(`EXPECTED` 진행 중·`FINAL` 종료 후, 서버 정렬, 빈 `items: []` 가능)           | 방 멤버     |

인증은 `Authorization: Bearer <신원 키(43자 base64url)>`이며 서버는 SHA-256 해시만 저장합니다. 개발 환경(`NODE_ENV=development`)에서 `/api-docs`(Swagger UI)와 `/api-docs-json`이 열립니다.

## 시작하기

필요: Node.js ≥ 22.13, pnpm 12, Docker(PostgreSQL 16 컨테이너).

```sh
pnpm install                 # postinstall로 Prisma 클라이언트를 생성(src/generated, Git 제외)
cp .env.example .env         # 값을 확인한다(.env는 Git에 올리지 않는다)
docker compose up -d         # PostgreSQL 16
pnpm build && pnpm start     # 또는 개발 중: pnpm build 후 NODE_ENV=development node dist/main.js
```

환경 변수는 시작할 때 검증하며 누락되면 기동하지 않습니다(`.env.example` 참고): `NODE_ENV`(`development`|`test`|`production`), `PORT`(기본 3001), `CORS_ORIGINS`, `DATABASE_URL`, `CURSOR_KEY`(커서 AEAD 키, base64 32바이트), `DB_LOCK_TIMEOUT_MS`(5000), `DB_STATEMENT_TIMEOUT_MS`(10000), `REQUEST_TIMEOUT_MS`(30000), `DB_POOL_MAX`(10). 시간 제한은 `lock < statement < request < 1시간`이어야 합니다.

마이그레이션은 `prisma/migrations/*/migration.sql`(CHECK 제약·부분 인덱스 포함)이며 `pnpm exec prisma migrate deploy`로 적용합니다. `migrate reset`과 `--accept-data-loss`는 쓰지 않습니다.

## 스크립트

| 명령                                         | 설명                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `format:check`   | 정적 검사                                                                                                             |
| `pnpm deps:check`                            | 모듈 의존 방향·순환 검사(PD-1)                                                                                        |
| `pnpm test`                                  | 전체 시험(실제 PostgreSQL 필요: `docker compose up -d`)                                                               |
| `pnpm build`                                 | `dist/`로 빌드                                                                                                        |
| `pnpm ac:check [--task BE-S1-2] [--spec S1]` | `ac-matrix.md`의 백엔드 담당 AC마다 `[AC-…]` 태그 시험이 있는지 검사(매핑표는 `../ddallang`의 `origin/main`에서 읽음) |
| `pnpm test:ac`                               | 시험을 실행하고 태그 시험의 **통과**까지 확인(실패·`.only` 포함)                                                      |

## 구조

```
src/
  common/      오류·라우트·인증·검증·DB(withRoomLock/withRoomMutation)·로깅·ID
  rooms/ participants/ transactions/ idempotency/ balances/ realtime/ settlement/
  generated/   Prisma 클라이언트(자동 생성, Git 제외)
prisma/        스키마와 SQL 마이그레이션
scripts/       ac-check.mjs
test/          계약·동시성·제약 시험, 다중 프로세스 하네스(test/helpers), 시험 전용 fixture
```

모듈 의존 방향은 `common` ← 나머지, `idempotency`·`realtime` ← `transactions`·`participants`·`settlement`이며 순환을 만들지 않습니다.

### 핵심 설계

- **방 단위 직렬화**: 방을 바꾸는 요청은 `withRoomLock`에서 방 행에 `FOR UPDATE` 잠금을 하나만 잡습니다(커밋까지 유지, `lock_timeout`·`statement_timeout`). 요청 마감은 호출 시점부터의 절대 시각입니다.
- **변경 번호와 알림**: `withRoomMutation`은 변경이 실제로 있을 때만 `Room.revision`을 1 올리고 같은 트랜잭션에서 `pg_notify('room_events', …)`를 보냅니다(커밋될 때만 전달).
- **오류 형식**: `{ error: { code, message, details[] } }`. 라우트 판정(404 `ROUTE_NOT_FOUND`, 405 `NOT_SUPPORTED`+`Allow`)은 인증과 Swagger보다 앞서며, 본문 JSON 파싱 실패는 검증 차례(422)에서 판정합니다.
- **시험**: 시험마다 임시 스키마(`search_path`와 Prisma `schema`)를 만들고, 서버를 별도 프로세스 2개 이상 띄워 같은 DB에서 동시성을 검증합니다.

### 성능 측정 (BE-S3-4, 로컬 개발 환경, 방당 거래 1,000건·참여자 10명, 각 40회)

| 응답                   | p50   | p95   |
| ---------------------- | ----- | ----- |
| 목록 첫 페이지         | 2.5ms | 3.0ms |
| 목록 깊은 페이지(커서) | 2.7ms | 3.4ms |
| 목록 필터(참여자 1명)  | 2.8ms | 3.3ms |
| 누적 손익              | 3.1ms | 3.7ms |

(HTTP 왕복 시간이며 DB와 앱이 같은 기기에 있다. 목록 질의는 `(roomId, createdAt DESC, seq DESC)` 부분 인덱스로 정렬 없이 읽힌다.)

## Swagger

`NODE_ENV=development`에서 `/api-docs`(UI)와 `/api-docs-json`이 열린다. 구현된 모든 엔드포인트는 요약, 요청 본문·쿼리·헤더, 성공 응답 스키마, 공통 오류 응답 스키마, 인증 방식(`Authorization: Bearer`)을 갖고 시험이 이를 확인한다. **문서는 비권위 참고용이며 계약 원본은 Spec이다.** API가 바뀌면 같은 변경에서 Swagger와 이 README의 표를 함께 갱신한다.

## 알려진 한계와 보류 항목

- 멱등 기록 정리(`expiresAt + 1시간` 이후 삭제)는 10분 주기 작업이며 `test` 환경에서는 돌지 않습니다.
- `REQUEST_TIMEOUT_MS`는 DB 트랜잭션 마감에만 연결되어 있고 HTTP 서버의 요청 제한과는 아직 연결되지 않았습니다(오류 코드·소유 Task 미정).
- 배포 환경(PD-16)과 방 보관·삭제(OQ-034)는 정하지 않았습니다. 운영 배포 전에 정합니다.
- `prisma migrate deploy` 경로와 `_prisma_migrations` 이력은 아직 검증하지 않았습니다(시험은 SQL을 직접 적용).
- 문서에 반영할 목록(ddallang 문서 PR 예정): BE-F1 행의 "개발 기본 CORS" 문구(코드는 `CORS_ORIGINS` 필수), `INTERNAL_ERROR`(500)와 본문 JSON 파싱 실패의 `details`, 금액이 소수이면서 범위 밖일 때의 `INVALID_VALUE` 해석, `RequestTimeoutError`의 HTTP 매핑.
- 저장소 위치(`~/Documents`가 iCloud 동기화 대상일 수 있음)는 보류 중입니다.

## 계획

`S5(SSE) → S4(종료·정산) → BE-Z1(통합 검증, 개발 종료 뒤 Codex 독립 검수)`. 자세한 Task 표는 `ddallang`의 `docs/plans/server/tasks.md`를 봅니다.
