# G4 증거 묶음 (BE-Z1 v1.x, BE-Z2 v2.0.0)

> §1~§6은 v1.x(BE-Z1, 2026-11-13) 기록이며 수정하지 않았다. v2.0.0(Spec v0.3.0, 접속자·참여자 통합)의 증거는 **§7**이다.

- 기준: `ddallang` `origin/main` `2f5f455`, Plan/Tasks v1.2.0. Spec은 S1 v0.2.3, S2 v0.2.2, S3 v0.2.4, S5 v0.2.3, S4 v0.2.0(모두 확정, PRD v0.5.2).
- 대상: 로컬 `main` `ce579ff` + 이 Task의 변경. 환경: macOS, Node 로컬, 로컬 PostgreSQL 16, 같은 호스트.
- **Codex 독립 검수는 이 묶음 시점까지 BE-F1(1/3), BE-F2·F8(3/3), S5(1/3 REVISE 후 R1·R2 수정, 재검수 없음)만 받았다.** 나머지 묶음은 자체 검수 또는 검수 없음이며, 백엔드 개발 완료 뒤 묶음별 Codex 검수가 남아 있다. 어떤 묶음도 Codex PASS를 받지 않았다.

## 1. 실행한 검증(직접 실행, exit 0)

| 명령                                                                             | 결과                                                            |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                               | 통과                                                            |
| `pnpm deps:check`                                                                | 위반 없음(75 모듈, 252 의존)                                    |
| `pnpm build`                                                                     | 통과                                                            |
| `pnpm test:ac`(전체 시험 + AC 통과 확인)                                         | 53 파일, 631 시험 통과, 실패·skip 0                             |
| `pnpm ac:check`(static) / results 모드                                           | 필수 191개 중 시험 191, 누락 0(둘 다 통과)                      |
| `test/swagger.spec.ts`, `test/openapi-parity.spec.ts`, `test/readme-api.spec.ts` | Swagger 경로·메서드 집합 = 구현 경로(PD-19), README API 표 일치 |

AC가 없는 기반 Task(BE-S5-1·5·6, BE-S4-6 등)는 `ac:check --allow-empty`로 확인했다.

## 2. 다중 인스턴스 시험(프로세스 2~3개, 같은 DB)

| 시험                                                                       | 내용                                                                                                                                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/s1`, `test/s2` 동시성                                                | 마지막 슬롯·닉네임·같은 키·거래 경쟁                                                                                                                                 |
| `test/s4/concurrency.spec.ts`                                              | 종료 12개 동시(같은 키 6·다른 키 6): 전이 1회, `revision`+1, `room.ended` 1회, 성공은 전이 요청과 같은 키 재전송뿐. 종료 vs 거래 12회, 종료 vs 참여자 등록·상태 10회 |
| `test/s5/multi-instance.spec.ts`, `limits.spec.ts`, `stream-lease.spec.ts` | 인스턴스 간 이벤트 전달, 통지 차단 뒤 하트비트 revision 복구, 100건 연속 변경, 연결 한도(RoomMember 5·방 50) 인스턴스 합산, 프로세스 종료·정지 시 임대 정리          |

## 3. 지연 측정 결과(S5 §6.7 표 그대로, 로컬 단일 호스트, 인스턴스 2개)

`test/s5/latency.spec.ts`: 방마다 접속자 10명(방장+9명)이 SSE로 연결, 변경은 한 번에 하나, T0=요청 송신 시각(보수 기준). 변경 종류별 초기 상태와 횟수는 표를 따른다(거래 생성 900→1,000건에서 100건, 수정·삭제 1,000건에서 100건씩, 상태 변경 100건, 참여자 등록·게임 종료 방 10개). 화면 반영은 5개 조회(방·참여자·순손익·목록 첫 페이지·정산) 완료까지다.

| 변경                       | 변경 수 | 전달 p95 / 최대 | 화면 반영 p95 / 최대 |
| -------------------------- | ------- | --------------- | -------------------- |
| transaction.created        | 100     | 8 / 14 ms       | 35 / 54 ms           |
| transaction.updated        | 100     | 6 / 7 ms        | 31 / 35 ms           |
| transaction.deleted        | 100     | 6 / 9 ms        | 32 / 54 ms           |
| participant.created        | 10      | 5 / 6 ms        | 29 / 32 ms           |
| participant.status_changed | 100     | 4 / 6 ms        | 29 / 36 ms           |
| room.ended                 | 10      | 5 / 5 ms        | 31 / 33 ms           |
| 전체                       | 320     | 7 / 14 ms       | 32 / 54 ms           |

화면 반영은 변경마다 접속자 10명이 각자 이벤트를 받은 뒤 5개 조회를 모두 끝낸 시각이다(변경 수 × 10건을 측정).

- 판정: 종류별·전체 모두 전달 p95 ≤ 1초·최대 ≤ 3초, 화면 반영 p95 ≤ 3초·최대 ≤ 5초(§6.7 목표) 충족(시험이 종류별로 단언).
- 유실 시 수렴(`test/s4/realtime.spec.ts`): 통지 차단 → 하트비트 → 5개 조회 15.0초(기준 20초).

**한계**: 같은 호스트·로컬 DB·왕복 지연 거의 0이라 왕복 150ms 망 조건은 재현하지 않았다. 화면 반영은 서버 측 5개 조회 완료이며 브라우저 렌더링은 포함하지 않는다(AC-VIEW-005-8은 프론트엔드 Plan의 측정과 합쳐야 완료). 공유 CI·전용 환경 수치는 아니다.

### 배포본(Render 무료 + Supabase 무료) 점검, 2026-11-13

방 생성 → 참여자 2명 → SSE 연결 → 거래 → 정산 → 종료 → 종료 후 정산을 한 번 실행했다. 모두 성공(HTTP 201/200)했고 SSE로 `ready`, `transaction.created`, `room.ended`, `heartbeat`가 도착했다. 이벤트 도착 시각이 해당 요청의 응답 도착 시각과 같아 프록시(Cloudflare·Render)의 버퍼링은 관찰되지 않았다. 쓰기 요청은 서버(싱가포르)와 DB(시드니) 왕복 때문에 1.4~1.9초 걸렸고, 이는 §3의 로컬 측정과 다른 환경 수치다. 1회 실행이며 S5 §6.7 표의 규모·횟수로 측정한 것이 아니다. 이 점검이 만든 시험 방 1개가 DB에 남아 있다.

## 4. 저장 모델 의존성 이행표(Plan §7) 증거

| 의존성                                          | 구현           | 증명 시험                                                                           |
| ----------------------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `Transaction.seq` 유일·증가, `createdAt` 비감소 | BE-S2-1·2      | `test/s2` 동시 생성, `test/s3` 정렬·커서                                            |
| `seq` 비노출, 커서 AEAD                         | BE-S3-2        | `test/s3/list.spec.ts` 변조·교체                                                    |
| `Room.revision` 잠금 안 증가, 커밋 뒤 이벤트    | BE-F7          | `test/db`, `test/s1`·`s2`·`s4`·`s5`                                                 |
| 멱등 `END`, 기록 보관                           | BE-F6, BE-S4-3 | `test/idempotency`, `test/s2/idempotency.spec.ts`, `test/s4/end-settlement.spec.ts` |
| 참여자 `status`를 같은 잠금 안에서 읽기         | BE-S2-2        | `test/s2/concurrency.spec.ts`                                                       |
| SSE 연결 한도 인스턴스 합산                     | BE-S5-2·6      | `test/s5/limits.spec.ts`, `multi-instance.spec.ts`                                  |
| 거래·참여자·종료 단일 직렬화                    | BE-F2·F7       | `test/s1`, `test/s2`, `test/s4/concurrency.spec.ts`                                 |
| CORS `Date`·`Idempotent-Replayed` 노출          | BE-F3          | `test/http/cors.spec.ts`, `test/s2`, `test/s5`                                      |

## 5. 남은 위험과 실행하지 못한 검증

- Claude 독립 검수(Codex 아님, 정적, 시험 미실행): S3·BE-F3+F5·S5 수정분 PASS(Major 이상 없음). Codex 한도 소진 때문에 사용자가 승인한 대체 검수이며 Codex PASS가 아니다.
- 일부 시험이 전체 실행 중 간헐적으로 실패하던 원인을 찾아 고쳤다: 시험 파일 하나가 일부러 보낸 형식이 틀린 통지(`not json`)가 DB 전체가 공유하는 `room_events` 채널로 다른 시험 파일의 리스너에 들어가 `JSON.parse` 예외와 이벤트 유실을 일으켰다. 리스너를 방어적으로 고쳤고(`parseNotification`), 동시에 도는 시험 파일 수를 4개로 제한했다(`vitest.config.ts`). 수정 뒤 전체 시험을 연속 두 번 돌려 631/631 통과(exit 0, 처리되지 않은 오류 없음)를 확인했다. 반복 안정성 통계는 내지 않았다.

- Codex 독립 검수: 위 범위를 제외하면 받지 않았다(최대 3회/묶음, 개발 완료 뒤 진행). 검수 지적은 미반영 상태일 수 있다.
- 전용 환경·릴리스 전 측정(왕복 150ms 조건 포함), 프론트엔드 화면 반영 측정은 하지 않았다.
- 장시간 운용, 대규모 부하, 실제 배포 환경(프록시·로드밸런서의 SSE 버퍼링), 브라우저 `EventSource` 실측은 하지 않았다.
- 전체 시험은 한 번의 로컬 실행 결과이며 반복 안정성(flaky) 측정은 하지 않았다.
- `ddallang` 문서 PR 대기 항목(Spec 침묵 구간의 기본값 선택): BE-F1 개발 CORS 기본값 vs PD-18, `INTERNAL_ERROR`, 잘못된 JSON의 `details`, 금액 소수·범위 초과 `INVALID_VALUE`, `RequestTimeoutError` HTTP 매핑, S5 `late` 임대 → `INTERNAL_ERROR`, 하트비트 15초·갱신 T/3 기본값, 종료 요청 만료 메시지 문구, 디코딩할 수 없는 경로(`%`)의 404 `ROUTE_NOT_FOUND` 응답, 22자가 아닌 거래 ID의 `ROUTE_NOT_FOUND`(Spec은 `TRANSACTION_NOT_FOUND`).

## 7. v2.0.0 개정 (BE-M1~M8, BE-Z2)

- 기준: `ddallang` `origin/main` `c52ec81`, Plan/Tasks/AC 매핑표 v2.0.0(`plan.md` §11, `tasks.md` §J·§K). Spec S1~S5 v0.3.0(PRD v0.6.0).
- 대상: 브랜치 `HyeonSeoMan/new-policy`(기준 `main` `89b5c34`). 커밋: BE-M1 `9f32ac4`, BE-M2 `679603f`, BE-M3 `efb6a27`, BE-M4 `4148a18`, BE-M5 `d91ef63`, BE-M6 `7ecaea6`, BE-M7 `da9dbfd`, BE-M8 `1311720`, 검수 반영 `1eef161`·`8fa0635`, BE-Z2(이 문서).
- 환경: macOS, Node 로컬, Docker PostgreSQL 16, 같은 호스트. **배포 DB에는 적용하지 않았다**(§7.6).

### 7.1 G4 검수 (묶음별, Codex 읽기 전용 `--sandbox read-only --ask-for-approval never`, 추론 강도 medium)

| 묶음 | Task     | 시도와 판정                            | 지적과 처리                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | -------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | M1·M2·M3 | 1/3 REVISE → 2/3 **PASS**              | MEDIUM 1: 이어받기 경로(§4.8)의 405가 M3 커밋에 없음. 라우트 레지스트리는 컨트롤러에서 경로를 모으므로(PD-9) 이어받기 컨트롤러가 생긴 M4(`4148a18`)에서 채워졌고 405 시험이 있다. 2/3에서 이 처리가 수용됨                                                                                                                                                                                                                     |
| 2    | M4       | 1/3 **PASS**                           | 지적 없음                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 3    | M5       | 1/3 **PASS**                           | 지적 없음                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 4    | M6·M7·M8 | 1/3 REVISE → 2/3 REVISE → 3/3 **PASS** | 1/3 HIGH 1: 하트비트가 질의 도중 붙은 정상 스트림을 닫을 수 있음 → 스냅샷 판정으로 수정, 단위 시험이 수정 전 실패·수정 후 통과. MEDIUM 4: 경합 시나리오 누락(같은 키 이어받기 N개, 비활성화 대 요청자 수정·삭제), 같은 키 입장의 revision 단언, 처리 순서 관찰 단언, 요청자 조회 성공 조건 → 모두 반영. 2/3 MEDIUM 1: 승인 대 이전 키 거래의 직렬 순서 미확인 → revision 순서 단언과 잠금으로 순서를 통제하는 결정적 시험 추가 |
| 5    | Z2       | 이 문서·README·인계 문서               | 아래 §7.8                                                                                                                                                                                                                                                                                                                                                                                                                      |

Codex PASS는 정적 검수다. Codex 샌드박스에서는 DB 시험을 실행할 수 없어 시험 결과는 아래 직접 실행 기록이 근거다. Codex PASS는 사용자 승인이 아니다.

### 7.2 실행한 검증 (직접 실행, exit 0)

| 명령                                                                              | 결과                                                       |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                                | 통과                                                       |
| `pnpm deps:check`                                                                 | 위반 없음(83 모듈, 295 의존)                               |
| `pnpm build`                                                                      | 통과                                                       |
| `pnpm test`(`vitest run`)                                                         | 59 파일, 714 시험 통과                                     |
| `pnpm test:ac`(results 모드)                                                      | 필수 215개 중 통과한 태그 시험 215개(v0.3.0 AC 249개 기준) |
| `pnpm ac:check`(static), `--task BE-M2~M7`                                        | 누락 0                                                     |
| `test/swagger.spec.ts`, `test/openapi-parity.spec.ts`, `test/readme-api.spec.ts`  | Swagger·README API 표 = 구현 경로(이어받기 7개 포함)       |
| 마이그레이션 드리프트(`prisma migrate diff --from-config-datasource --to-schema`) | 마이그레이션 적용 DB와 `schema.prisma` 차이 없음           |

`ac:check`는 `DDALLANG_REPO=~/Documents/ddallang`으로 실행했다(기본값 `../ddallang`은 이 worktree 위치에서 없다).

### 7.3 마이그레이션 (BE-M1, PD-21·PD-22)

`test/db/v2-migration.spec.ts`: 빈 DB에 처음부터 적용, 데이터 없는 v1.x 스키마에 적용, **v1.x 데이터가 있으면 실패하고 아무것도 바뀌지 않음**(테이블·열 이름·행 그대로), `prisma/reset-v1-data.sql` 실행 뒤 적용. 제약 시험(`test/db/s1-schema.spec.ts`): 같은 방 같은 해시 두 참여자, 방장 둘, 같은 키 PENDING 둘, RevokedIdentity 중복, CHECK 값 밖(상태·사유·상태-사유-처리자 정합·방장 비활성) 거부.

### 7.4 다중 프로세스 시험

| 시험                                  | 내용                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/s1/v2-concurrency.spec.ts`(3개) | S1 §7 1~9, S2 §7 5·5b·5c: 같은 닉네임(입장·직접 추가 섞어서), 마지막 슬롯, order와 커밋 순서, 같은 키 입장·이어받기 요청·둘의 조합, 같은 요청 승인·거절·취소, 같은 대상 두 승인, 대기 키 승인 대 입장, 종료 대 입장, 비활성화 대 거래(당사자·요청자 생성·수정·삭제), 승인 대 이전 키 거래(재전송 포함, 잠금으로 순서 통제한 결정적 시험 포함). 라운드마다 시작 지연을 돌려 각 시나리오의 두 처리 순서가 모두 관찰됐는지 단언한다. 모든 시나리오에서 S1 §2.3 불변식과 `revision` 증가 = 커밋된 변경 수 = 이벤트 수 |
| `test/s1/concurrency.spec.ts`(2개)    | v1.x 동시성 시험을 v2 한도(참여자 10명 하나)로 개정                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `test/s5/access-revoked.spec.ts`(2개) | 같은·다른 인스턴스의 `access.revoked`(3초 이내, 같은 키의 다른 탭 포함)와 닫힘·임대 반납, LISTEN을 끊어 통지를 버린 뒤 하트비트로 20초 이내 수렴, 스트림 연결 401/404, `participant.created`·`claim.*` 전달                                                                                                                                                                                                                                                                                                       |

### 7.5 지연 측정 (S5 §6.7 v0.3.0 표, 로컬 단일 호스트, 인스턴스 2개)

`test/s5/latency.spec.ts`. T0 = 요청 송신 시각(보수 기준). 화면 반영은 S5 §6.4 갱신 대상 전체(일반 참여자 5개, **방장 6개**)가 모두 성공한 시각이다. 요청자 화면(이어받기 결과)은 2초 주기 내 요청 조회를 흉내 내 결과를 담은 조회 응답을 받은 시각이다(BE-C8, 브라우저 표시 제외).

| 변경                             | 측정 건수(클라이언트 기준) | 전달 p95 / 최대 | 화면 반영 p95 / 최대 |
| -------------------------------- | -------------------------- | --------------- | -------------------- |
| transaction.created              | 1,000                      | 9 / 15 ms       | 39 / 65 ms           |
| transaction.updated              | 1,000                      | 7 / 8 ms        | 32 / 37 ms           |
| transaction.deleted              | 1,000                      | 6 / 7 ms        | 30 / 35 ms           |
| participant.created(입장)        | 90(방 10개)                | 7 / 7 ms        | 28 / 31 ms           |
| participant.created(직접 추가)   | 90(방 10개)                | 6 / 7 ms        | 33 / 37 ms           |
| participant.status_changed       | 1,000                      | 5 / 7 ms        | 30 / 40 ms           |
| room.ended                       | 100(방 10개)               | 6 / 7 ms        | 34 / 37 ms           |
| claim.created(방장 화면)         | 450(50건 × SSE 9개)        | 5 / 7 ms        | 28 / 35 ms           |
| claim.canceled(방장 화면)        | 450                        | 6 / 8 ms        | 29 / 35 ms           |
| claim.resolved 승인(요청자 화면) | 10(방 10개)                | 해당 없음       | 1,889 / 1,889 ms     |
| claim.resolved 거절(요청자 화면) | 10(방 10개)                | 해당 없음       | 1,660 / 1,660 ms     |
| access.revoked(이전 브라우저)    | 10(방 10개)                | 9 / 9 ms        | 해당 없음            |
| 전체                             |                            | 7 / 15 ms       | 33 / 1,889 ms        |

- 판정: 종류별·전체 모두 전달 p95 ≤ 1초·최대 ≤ 3초, 화면 반영 p95 ≤ 3초·최대 ≤ 5초 충족(시험이 단언, 초과 시 실패).
- 유실 시 수렴: 통지 차단 → 하트비트 → 5개 조회 15.0초(`test/s4/realtime.spec.ts`), 접근 상실(승인 직후 통지 차단 → 하트비트 `access.revoked`) 같은 인스턴스 15.0초·다른 인스턴스 15.0초(기준 20초).
- 한계: §3과 같다(왕복 150ms 망 미재현, 브라우저 렌더링 제외, 1회 실행). 요청자 화면 행은 방마다 1건이라 p95와 최댓값이 같다.

### 7.6 배포 DB 적용 절차 (PD-22, RK-20) — 실행은 사용자 승인 뒤

배포 DB(Supabase)에는 v1.x 데이터(점검용 시험 방 포함)가 있다. v2 마이그레이션은 데이터가 있으면 실패하고 데이터를 옮기지 않는다. 컨테이너가 시작할 때 `prisma migrate deploy`를 실행하고(`Dockerfile`), Render는 `main` push로 다시 배포한다. v1 서버는 v2 스키마에서 동작하지 않고(`RoomMember` 없음, 열 이름 변경) v2 서버는 v1 스키마에서 동작하지 않으므로, **초기화부터 v2 점검이 끝날 때까지 v1 서버가 DB에 접근하지 못하는 점검 시간**을 둔다. Render·Supabase 화면의 메뉴 이름은 직접 확인한다(이 절차는 실제 배포로 검증하지 않았다).

**사전 조건**

1. 사용자가 배포 DB 데이터 삭제를 승인하고, 프론트엔드 2.0.0 배포와 같은 시점으로 정한다. 그 전에는 `main`에 병합하지 않는다(병합하면 자동 배포가 가드에 걸려 실패한다).
2. Render의 자동 배포를 끈다(아래 7에서 v2 커밋을 직접 배포한다).

**점검 시간**

v1이 DB에 다시 쓰지 못하게 하는 장치는 Render의 재개 방식에 기대지 않는다. (1) **DB 자격 증명을 바꿔** Render에 저장된 v1 설정으로는 접속하지 못하게 하고, (2) **서버를 띄우기 전에 v2 마이그레이션을 직접 적용**한다. v2 스키마에는 `RoomMember`가 없어 v1 코드의 모든 변경 경로(방 생성, 입장, 인증 가드)가 실패하므로, 이후 어떤 경로로 v1 빌드가 떠도 데이터를 쓸 수 없다.

3. **v1 서버를 멈춘다**: Render 서비스를 일시 중지(suspend)해 인스턴스를 내리고, Supabase의 `pg_stat_activity`에서 서버 연결(`application_name`이 `ddallang-bus-…`인 LISTEN 연결 포함)이 없어졌는지 확인한다. 진행 중이던 요청은 이 시점에 끊긴다.
4. **DB 비밀번호를 바꾼다**(Supabase 설정). 남은 연결이 있으면 `pg_terminate_backend`로 끊고 다시 확인한다.
5. **백업(필수)**: 새 자격 증명으로 `pg_dump`를 실행해 DB 전체(`_prisma_migrations` 포함)를 받아 둔다. 적용 후 실패의 유일한 되돌림 수단이다. 연결 문자열은 터미널 기록·채팅에 남기지 않는다.
6. **초기화**: `psql "<새 Session pooler 주소>" -v ON_ERROR_STOP=1 -f prisma/reset-v1-data.sql`.
7. **v2 마이그레이션 직접 적용**: v2 브랜치 체크아웃에서 `DATABASE_URL="<새 주소>" pnpm exec prisma migrate deploy`. `prisma migrate status`로 7건 적용(`20261116000000_v2_participant_identity` 포함)을 확인한다. 4~7 사이에는 접속할 수 있는 서버가 없으므로 가드가 실패하지 않는다.
8. `main` 병합·push(자동 배포는 꺼져 있다).
9. **v2 배포**: Render의 `DATABASE_URL`을 새 비밀번호로 바꾸고 최신 커밋(v2)을 배포하며 서비스를 재개한다. 컨테이너의 `prisma migrate deploy`는 이미 적용된 것을 확인하고 넘어간다. 재개가 이전 v1 빌드를 띄우더라도 v2 스키마에서는 쓰기가 실패하므로 데이터가 생기지 않는다. 그 경우 다시 일시 중지하고 최신 커밋을 배포한다.
10. **점검**: 시작 로그의 v2 기동, `GET /health`, 방 생성 → 입장 → 이어받기 요청·승인 → 거래 → SSE(`ready`·`claim.resolved`·`access.revoked`) → 종료·정산. 점검 방은 사용자에게 알리고 남기거나 다시 초기화한다.
11. 프론트엔드 2.0.0을 배포하고 그 주소를 `CORS_ORIGINS`에 넣어 재배포한다. 여기까지가 점검 시간이며, 끝나면 자동 배포를 다시 켠다.

**실패했을 때**

- **7에서 가드에 걸림**(4 이후 남은 연결이 쓴 경우 등): Postgres가 마이그레이션 전체를 롤백하므로 스키마·데이터는 그대로지만 `_prisma_migrations`에 실패 기록이 남는다. 연결을 다시 확인하고(4), `prisma migrate resolve --rolled-back 20261116000000_v2_participant_identity`로 기록을 정리한 뒤 6부터 다시 한다.
- **적용 후 실패(7은 성공, 9의 기동이나 10의 점검이 실패)**: **v1 이미지로 되돌리지 않는다**(스키마가 맞지 않고, `migrate resolve --rolled-back`은 스키마를 되돌리지 않는다). 서비스를 멈춘 채로 둘 중 하나를 고른다. (a) v2를 고쳐 다시 배포한다(앞으로 고치기, 데이터는 이미 비어 있다). (b) 5의 백업으로 DB 전체(`_prisma_migrations` 포함)를 복원하고, Render `DATABASE_URL`을 맞춘 뒤 v1 커밋(`main` 병합 이전)을 배포한다. (b)는 `main`에서 v2 병합을 되돌리는 결정이므로 사용자 승인을 받는다.
- 프론트엔드 2.0.0은 10의 점검이 끝나기 전에 공개하지 않는다.

### 7.7 Spec이 정하지 않아 구현이 고른 것 (문서 PR 후보, 계약 변경 아님)

- 새 오류 코드의 `message` 문구(`IDENTITY_REVOKED`, `CLAIM_*`, `ALREADY_PARTICIPANT`, `HOST_CANNOT_BE_DEACTIVATED`, `REQUESTER_INACTIVE`)와 입장의 `NICKNAME_TAKEN`·`PARTICIPANT_LIMIT_EXCEEDED` 이어받기 안내 문구.
- 이어받기 요청의 `nickname: ""`는 `REQUIRED`(S1 §3.2 0번과 같게). 문자 규칙은 보지 않는다(Spec대로).
- 초대 조회 `claim`의 "가장 최근"은 `createdAt` 내림차순, 같으면 `id` 내림차순.
- 승인 시 요청 키가 접근 상실 상태(REVOKED+PENDING, 정상 경로로는 생기지 않음)면 연결하지 않고 500(BE-C4의 연장, 불변식 보호).
- 승인·거절의 본문은 무시한다(Spec은 승인만 명시).
- `access.revoked`의 `data`는 `{roomId, serverTime}`. 하트비트 신원 재확인은 질의 시작 시점의 스트림만 판정하고, 질의 도중 붙은 스트림은 다음 하트비트에서 본다.
- v1.x 목록(§5)의 항목은 그대로 남아 있다.

### 7.8 바꾸거나 지운 v1.x 시험과 대체 (단언을 약하게 하지 않았다)

바뀐 계약(RoomMember 삭제, 방장 = 첫 참여자, 입장 = 참여자 생성, 한도 하나, 종료 뒤 새 입장 금지)에 맞춰 단언 대상을 바꿨다. 지운 시험은 대체 시험과 함께 적는다.

| v1.x 시험(파일)                                                                                                                                                    | v2.0.0                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/auth/room-member.spec.ts` RoomMember 가드(멤버·비멤버·다른 방·키 비노출)                                                                                     | **삭제** → `test/auth/participant-guard.spec.ts`: 상태 4가지(`resolveIdentity` 단위), 불변식 위반 500, 대기 키·신원 없음·없는 방 같은 404, 접근 상실 401, 키·해시 비노출(해시까지 확대)                                                       |
| `test/db/s1-schema.spec.ts` RoomMember 제약 8개, "RoomMember·Participant 닉네임 공존", 두 테이블 무연결 구조                                                       | Participant 신원·방장 제약 7개, ClaimRequest 6개, RevokedIdentity 2개, 구조(RoomMember 없음, 모든 참조가 Participant). 닉네임 공존 시험은 계약 폐기(I5 하나의 범위)로 삭제하고 입장·직접 추가 중복 409 시험으로 대체                          |
| `test/s1/invite-join.spec.ts` `isMember`, 종료 방 새 입장 성공, 입장은 revision 없음·Participant 없음, RoomMember·Participant 닉네임 공존, `MEMBER_LIMIT_EXCEEDED` | `identity`·`claim`·`claimableNicknames`, 종료 방 새 입장 `GAME_ENDED`(복원 200), 새 입장 `participant.created`(복원 없음), 공존 → `NICKNAME_TAKEN`(AC-ROOM-006-6 개정), `PARTICIPANT_LIMIT_EXCEEDED`. 대기 `CLAIM_PENDING`·접근 상실 401 추가 |
| `test/s1/create-room.spec.ts` `me`는 RoomMember, RoomMember 1명                                                                                                    | `me`는 방장 참여자(order 1·ACTIVE), 참여자 목록이 그 1명, 키 연결·`revision` 0                                                                                                                                                                |
| `test/s1/participants.spec.ts` order 1부터, "등록은 RoomMember를 만들지 않는다", 직접 추가 10명 한도                                                               | order 2부터(방장 1), 직접 추가는 신원 없는 참여자(AC-ROOM-004-2), 방장 포함 10명. `HOST_CANNOT_BE_DEACTIVATED`(AC-PART-002-10) 추가                                                                                                           |
| `test/s1/contract.spec.ts` AC-ROOM-004-3 "입장은 Participant를 만들지 않는다", AC-ROOM-004-4 "등록은 RoomMember를 만들지 않는다"                                   | **삭제**(계약 반대로 바뀜) → AC-ROOM-004-1 "방 생성·입장·직접 추가는 1명씩, 복원 0명"으로 대체. 004-4 태그는 "이어받기 밖 신원 연결·해제 경로 404"(경로 목록 확대)로 옮김. 004-3은 `claims.spec.ts`·`v2-concurrency.spec.ts`                  |
| `test/s1/concurrency.spec.ts` RoomMember 마지막 슬롯(`MEMBER_LIMIT_EXCEEDED`), 동시 등록 10개(order 1~10)                                                          | 입장 마지막 슬롯 `PARTICIPANT_LIMIT_EXCEEDED`, 입장·직접 추가 섞은 9개(order 2~10, revision 9)                                                                                                                                                |
| `test/s1/rooms-read.spec.ts`, `auth-scope.spec.ts`                                                                                                                 | 방장이 참여자 목록에 포함, `me` 전체 필드, 대기 키 404·접근 상실 401 추가                                                                                                                                                                     |
| `test/s2/create.spec.ts` "참여자와 무관한 RoomMember가 거래"                                                                                                       | "당사자가 아닌 활성 참여자가 거래, 신원 없는 참여자가 당사자"                                                                                                                                                                                 |
| `test/s2/schema.spec.ts`, `test/s5/stream-lease.spec.ts`                                                                                                           | RoomMember 픽스처 → Participant, `memberId` → `participantId`                                                                                                                                                                                 |
| `test/s3/balances.spec.ts` 순손익 목록(A·B·C), "참여자가 없으면 빈 목록"                                                                                           | 방장(0)을 포함한 순서. 방은 항상 방장 1명이므로 "거래가 없으면 방장 1명 0"으로 대체                                                                                                                                                           |
| `test/s3/list.spec.ts`, `test/s4/end-settlement.spec.ts` "종료 후 입장자도 조회"                                                                                   | 종료 뒤 새 입장 409, 종료 전에 입장한 참여자의 복원 조회(이어받기 참여자는 `test/s2/requester.spec.ts`)                                                                                                                                       |
| `test/s4/end-settlement.spec.ts` "참여자 0명도 종료 허용"                                                                                                          | "방장 외 참여자 0명도 종료 허용"(방은 항상 방장 참여자가 있다)                                                                                                                                                                                |
| `test/s4/concurrency.spec.ts`                                                                                                                                      | 참여자 수에 방장 포함                                                                                                                                                                                                                         |
| `test/s5/events.spec.ts` "입장은 이벤트 대상이 아니다"                                                                                                             | 새 입장 `participant.created`, 복원은 없음                                                                                                                                                                                                    |
| `test/s5/limits.spec.ts`, `test/s5/latency.spec.ts`                                                                                                                | 방장 + 입장 9명 = 10명. 지연 하네스는 §7.5                                                                                                                                                                                                    |
| `test/http/errors.spec.ts`, `test/swagger.spec.ts`                                                                                                                 | 오류 표 v0.3.0(`MEMBER_LIMIT_EXCEEDED` 삭제, 8개 추가), 엔드포인트별 오류 코드                                                                                                                                                                |

새 시험 파일: `test/db/v2-migration.spec.ts`, `test/auth/participant-guard.spec.ts`, `test/s1/claims.spec.ts`, `test/s1/v2-concurrency.spec.ts`, `test/s2/requester.spec.ts`, `test/s5/access-revoked.spec.ts`, `test/s5/room-streams.spec.ts`.

### 7.9 실행하지 못한 검증과 남은 위험

- **배포 DB 적용과 배포본 점검은 하지 않았다**(§7.6, 사용자 승인 대기). Render·Supabase 환경에서 v2 마이그레이션·이어받기·`access.revoked`가 동작하는지는 확인하지 않았다.
- 프론트엔드 실서버 점검(FE-M8)과 브라우저 화면 반영 측정은 프론트엔드 쪽 작업이다.
- 왕복 150ms 망, 장시간 운용, 대규모 부하는 측정하지 않았다. 전체 시험은 로컬 실행이며 경합 시험만 3회 연속 확인했다.
- 이어받기 남용(요청 수 상한 없음, BE-C9·RK-15)과 공개 API 요청 제한 없음은 그대로다.
- 방장 신원을 잃은 방의 대기 요청은 처리될 수 없고 만료도 없다(Spec 수용, P-9).
