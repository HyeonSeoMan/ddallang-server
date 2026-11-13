# 백엔드 진행 현황과 프론트엔드 연동 가이드

작성: 2026-11-13, 기준 `ddallang-server` `main`(배포본). 이 문서는 **프론트엔드 작업을 하는 사람과 AI**가 백엔드를 이해하고 올바르게 붙이도록 만든 요약이다.

## 0. 이 문서를 읽는 법 (AI 에이전트용)

- **계약의 원본은 `ddallang` 저장소의 Spec이다**(`docs/specs/S1~S5/spec.md`, `ddallang`의 `origin/main`). 이 문서와 Spec이 다르면 **Spec이 옳다**. 이 문서는 요약이며 Spec을 대체하지 않는다. 읽을 때는 `git -C ~/Documents/ddallang show origin/main:<경로>`를 쓴다(작업 트리가 낡았을 수 있다).
- 구현된 API의 **정확한 요청·응답 스키마**는 개발 모드에서 Swagger(`/api-docs`, `/api-docs-json`)로 볼 수 있다(비권위 참고용). 배포본(`NODE_ENV=production`)에는 없다.
- 프론트 쪽 계획은 `ddallang`의 `docs/plans/web/`(`plan.md`, `tasks.md`, `ac-matrix.md`)이다.
- 이 저장소의 비밀값(`.env`, 연결 문자열, `CURSOR_KEY`)은 어디에도 붙이지 않는다.

## 1. 한눈에 보는 상태

| 항목                  | 상태                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| 백엔드 Task(BE-F1~Z1) | **모두 구현 완료** (공통 기반, S1 방·신원·참여자, S2 거래, S3 목록·손익, S5 실시간, S4 종료·정산) |
| 시험                  | 622개 통과, 백엔드 담당 AC 191/191에 통과한 시험이 있음                                           |
| 기술                  | NestJS 12(ESM), TypeScript, PostgreSQL 16, Prisma 7, REST + SSE                                   |
| 배포                  | Render 무료 플랜(Docker, 싱가포르) + Supabase 무료 PostgreSQL(시드니, Session pooler)             |
| 배포 주소             | `https://ddallang-api.onrender.com` (`GET /health` → `{"status":"ok"}`)                           |
| 허용 출처(CORS)       | 현재 `http://localhost:3000`만. 프론트를 배포하면 Render의 `CORS_ORIGINS`를 바꿔 재배포해야 함    |

### 검수 이력 (정직하게)

| 묶음     | Codex 독립 검수                                | 비고                                                 |
| -------- | ---------------------------------------------- | ---------------------------------------------------- |
| BE-F1    | 1/3                                            | 수정 반영                                            |
| BE-F2·F8 | 3/3 소진                                       |                                                      |
| BE-F3·F5 | 1/3 BLOCKED(Codex 샌드박스에서 시험 실행 불가) | 지적 반영, Claude 독립 검수 PASS                     |
| S1 계열  | 2/3 **PASS**                                   |                                                      |
| BE-F6·S2 | 2/3 **PASS**                                   |                                                      |
| S3       | 1/3 REVISE                                     | 지적 반영, Claude 독립 검수 PASS                     |
| S4       | 3/3 **PASS**                                   |                                                      |
| S5       | 3/3 소진                                       | 마지막 수정은 Claude 독립 검수 PASS(Codex 확인 없음) |
| BE-Z1    | 받지 않음                                      | 문서 위주                                            |

- **Claude 독립 검수는 Codex 검수가 아니다**(정적, 시험 미실행). 어떤 묶음도 시험을 직접 실행한 Codex PASS는 받지 않았다.
- 검증 결과와 남은 위험의 상세는 [`docs/g4-evidence.md`](./g4-evidence.md), 배포 방법은 [`docs/deploy-free.md`](./deploy-free.md).

### 알려진 한계

- **무료 플랜**: Render는 15분 요청이 없으면 잠들고 다음 요청이 50초 넘게 걸릴 수 있다. 잠들면 SSE가 끊긴다. Supabase 무료 프로젝트도 오래 쓰지 않으면 일시 정지될 수 있다.
- **배포본의 DB 연결 오류(수정 중)**: 2026-11-13에 배포본에서 DB를 쓰는 모든 API가 `self-signed certificate`로 500이었다. `DB_SSL_REJECT_UNAUTHORIZED=false` 설정과 재배포로 해결한다. 이 문서의 API 동작 설명은 로컬·시험 기준이며, 배포본 동작은 재배포 뒤 확인한다.
- **SSE가 Render/Cloudflare 프록시를 거쳐 바로 오는지는 아직 확인하지 않았다**(로컬 컨테이너에서는 확인함). 프론트에서 처음 붙일 때 이벤트가 지연 없이 오는지 본다.
- 지연 측정(전달 p95 7ms 등)은 같은 호스트·로컬 DB 기준이며 왕복 150ms 망과 브라우저 렌더링은 포함하지 않는다.
- `HEAD` 요청은 모든 경로에서 405다(의도). 상태 점검은 `GET /health`를 쓴다.
- 문서 PR 대기 항목(Spec이 정하지 않아 구현 기본값을 고른 것)이 `g4-evidence.md` §5에 있다.
- 시간 의존 시험 몇 개가 시스템 부하가 클 때 간헐적으로 실패한다(단독 실행은 통과).

## 2. 접속 정보

- **Base URL**: `https://ddallang-api.onrender.com` (로컬 개발은 `http://localhost:3001`)
- **형식**: JSON(`Content-Type: application/json`), 시각은 RFC 3339 UTC 문자열, 금액은 정수(원 단위 아님, 방의 `unit`과 환산 없음).
- **CORS**: 허용 출처만 통과한다. 사전 요청(OPTIONS)에 허용 헤더 `Authorization`, `Content-Type`, `Idempotency-Key`, `Idempotency-First-Attempt-At`를 허용하고, 응답 노출 헤더는 `Date`, `Idempotent-Replayed`, `Retry-After`다.
- **무료 플랜 대응**: 첫 요청이 매우 느릴 수 있으므로 시간 초과를 넉넉히(60~90초) 두고, 로딩 상태를 보여 준다. 시연 직전에 `GET /health`로 깨워 두면 좋다.

## 3. 인증과 권한

- 로그인·회원가입이 없다. **신원 키**를 브라우저가 만들어 저장한다: 32바이트 난수의 base64url(43자). 모든 요청에 `Authorization: Bearer <신원 키>`로 보낸다. 서버는 SHA-256 해시만 저장한다.
- **신원 키는 브라우저에 묶인다.** 잃어버리면 복구할 수 없다(방장 권한도). 안전하게 보관하고 URL·로그·분석 도구에 넣지 않는다.
- 방에 입장하면 **RoomMember**가 생긴다(같은 키는 같은 RoomMember로 복원). 정산에 참여하는 **Participant**는 별개다(방장이 등록·활성/비활성 변경).
- 비멤버는 방이 없는 것과 같은 응답(404 `ROOM_NOT_FOUND`)을 받는다. 정보를 구분하지 않는다.

| 역할    | 할 수 있는 것                                                                   |
| ------- | ------------------------------------------------------------------------------- |
| 방장    | 참여자 등록·상태 변경, 모든 거래 수정·삭제, 게임 종료, 그리고 방 멤버의 모든 것 |
| 방 멤버 | 조회, 거래 생성, 자기 거래 수정·삭제, SSE 연결                                  |
| 공개    | `GET /invites/{inviteCode}`(키가 있으면 `isMember` 포함)                        |

## 4. 공통 규약

### 오류 형식

모든 오류가 같은 모양이다. **분기는 `code`로 하고 `message`는 한국어 사용자 문구**다.

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "입력 값을 확인해 주세요.",
    "details": [{ "field": "nickname", "code": "LENGTH_OUT_OF_RANGE" }]
  }
}
```

| HTTP | code                                                                                                                                                                                                                  | 의미                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 401  | `UNAUTHENTICATED`                                                                                                                                                                                                     | 신원 키 없음·형식 오류                                                                                                                                                         |
| 403  | `HOST_ONLY`, `NOT_AUTHOR_OR_HOST`                                                                                                                                                                                     | 권한 없음                                                                                                                                                                      |
| 404  | `ROOM_NOT_FOUND`, `INVITE_NOT_FOUND`, `PARTICIPANT_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `ROUTE_NOT_FOUND`                                                                                                             | 없음. 비멤버도 `ROOM_NOT_FOUND`                                                                                                                                                |
| 405  | `NOT_SUPPORTED`                                                                                                                                                                                                       | 없는 메서드. `Allow` 헤더 포함                                                                                                                                                 |
| 409  | `GAME_ENDED`, `NICKNAME_TAKEN`, `MEMBER_LIMIT_EXCEEDED`, `PARTICIPANT_LIMIT_EXCEEDED`, `TRANSACTION_LIMIT_EXCEEDED`, `PARTICIPANT_INACTIVE`, `TRANSACTION_DELETED`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_KEY_EXPIRED` | 상태 충돌                                                                                                                                                                      |
| 422  | `VALIDATION_FAILED`                                                                                                                                                                                                   | 입력 오류. `details[]`에 `{field, code}`(예: `REQUIRED`, `INVALID_TYPE`, `INVALID_VALUE`, `NOT_ALLOWED_FIELD`, `LENGTH_OUT_OF_RANGE`, `OUT_OF_RANGE`, `PARTICIPANT_NOT_FOUND`) |
| 429  | `CONNECTION_LIMIT_EXCEEDED`                                                                                                                                                                                           | SSE 연결 한도. `Retry-After: 30`                                                                                                                                               |
| 500  | `INTERNAL_ERROR`                                                                                                                                                                                                      | 서버 오류(내부 정보 없음)                                                                                                                                                      |

- 검사 순서가 있다: 라우트(404/405) → 인증(401) → 방·멤버(404) → 헤더 검증(422) → 권한(403) → 상태(409) → 입력 검증(422). 그래서 **종료된 방에서 잘못된 본문을 보내도 422가 아니라 409 `GAME_ENDED`가 먼저** 올 수 있다.
- **허용되지 않은 필드는 422**(`NOT_ALLOWED_FIELD`)다. 정의된 필드만 보낸다.

### 멱등성 (거래 생성·수정·삭제, 게임 종료)

이 네 요청에는 **두 헤더가 필수**다(없으면 422).

| 헤더                           | 값                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `Idempotency-Key`              | `^[A-Za-z0-9_-]{16,64}$` 난수. **재시도 때 같은 값을 다시 보낸다**                   |
| `Idempotency-First-Attempt-At` | 이 요청을 **처음 시도한 시각**(RFC 3339 UTC, 밀리초). 재시도 때도 처음 값을 유지한다 |

- 같은 키·같은 내용을 다시 보내면 **저장된 결과**가 그대로 오고 `Idempotent-Replayed: true`가 붙는다(성공이든 `GAME_ENDED` 같은 영구 거부든). 같은 키로 다른 내용이면 409 `IDEMPOTENCY_CONFLICT`.
- 처음 시도 후 **24시간**이 지나면 409 `IDEMPOTENCY_KEY_EXPIRED`다(저장 여부를 방 상태에서 확인해야 한다).
- 5분을 넘는 **미래 시각**은 422다. 기기 시계가 틀릴 수 있으므로 응답의 `Date` 헤더로 보정한 시각을 보낸다.
- **새 사용자 의도마다 새 키**를 만든다. 네트워크 오류로 재시도할 때만 같은 키를 쓴다. 응답을 못 받았다면 자동 재제출하지 말고 **재조회로 저장 여부를 확인**하는 것이 계약이다(Spec S2/S5).

## 5. 엔드포인트 요약

경로의 `{roomId}`, `{participantId}`, `{transactionId}`는 서버가 만든 ID다(거래 ID는 22자 base64url). 형식이 다른 거래 ID는 404 `ROUTE_NOT_FOUND`다.

| 요청                                                      | 본문                                          | 성공 응답                                                                               | 비고                                                                         |
| --------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `POST /rooms`                                             | `{name, unit, nickname}`                      | 201 `{room, me}`                                                                        | 만든 사람이 방장. `room`에 `inviteCode` 포함                                 |
| `GET /rooms/{roomId}`                                     | —                                             | 200 `{room, me}`                                                                        | `room.status`: `IN_PROGRESS`/`ENDED`                                         |
| `GET /invites/{inviteCode}`                               | —                                             | 200 `{room:{name,unit,status}, isMember}`                                               | 키는 선택                                                                    |
| `POST /invites/{inviteCode}/members`                      | `{nickname}`                                  | 201 `{room, me}` 또는 같은 키면 200 복원                                                | 닉네임 중복 409, 인원 10명 초과 409                                          |
| `GET /rooms/{roomId}/participants`                        | —                                             | 200 `{participants:[…]}`                                                                | `order` 오름차순, 비활성 포함                                                |
| `POST /rooms/{roomId}/participants`                       | `{nickname}`                                  | 201 `{participant}`                                                                     | 방장만, 최대 10명                                                            |
| `PATCH /rooms/{roomId}/participants/{id}`                 | `{status:'ACTIVE'\|'INACTIVE'}`               | 200 `{participant}`                                                                     | 방장만                                                                       |
| `POST /rooms/{roomId}/transactions`                       | `{payerId, payeeId, amount, reason?, round?}` | 201 `{transaction}`                                                                     | 멱등 헤더 필수. 지급자≠수취자, 둘 다 활성                                    |
| `PUT /rooms/{roomId}/transactions/{id}`                   | `{amount, reason?, round?}`                   | 200 `{transaction}`                                                                     | 통째 교체, 작성자·방장, 값이 같으면 변경 없음                                |
| `DELETE /rooms/{roomId}/transactions/{id}`                | 없음                                          | 200 `{transactionId, deletedAt}`                                                        | 작성자·방장                                                                  |
| `GET /rooms/{roomId}/transactions?participantId=&cursor=` | —                                             | 200 `{transactions:[…], nextCursor}`                                                    | 유효 거래만, 최신순 20건, 커서는 불투명 문자열                               |
| `GET /rooms/{roomId}/balances`                            | —                                             | 200 `{balances:[{participantId,nickname,status,order,balance}]}`                        | `balance` 내림차순, 비활성 포함. 쿼리 없음                                   |
| `POST /rooms/{roomId}/end`                                | 없음 또는 `{}`                                | 200 `{roomId, status:'ENDED'}`                                                          | 방장만, 멱등 헤더 필수                                                       |
| `GET /rooms/{roomId}/settlement`                          | —                                             | 200 `{settlement:{kind, items:[{payerId,payerNickname,payeeId,payeeNickname,amount}]}}` | `kind`는 `EXPECTED`(진행 중)/`FINAL`(종료 후). 쿼리 없음, 순서는 서버가 정함 |
| `GET /rooms/{roomId}/events`                              | —                                             | `text/event-stream`                                                                     | 아래 §6                                                                      |
| `GET /health`                                             | —                                             | 200 `{status:'ok'}`                                                                     | 인증·DB 없음                                                                 |

- **거래 객체**: `{id, payerId, payeeId, amount, reason|null, round|null, authorId, createdAt, updatedAt}`. 내부 값(`seq`, 원본 값, 삭제 정보)은 노출되지 않는다.
- **참여자 객체**: `{id, roomId, nickname, status, order, createdAt}`. **방 멤버**: `{id, roomId, nickname, isHost, createdAt}`.
- **정산 항목이 없으면** `items: []`이고 `kind`는 방 상태를 따른다(화면 문구 "정산할 내역이 없습니다."는 프론트 책임).
- **정산 단위·방 이름**은 정산 응답에 없다. 방 조회의 `room.unit`·`room.name`을 쓴다(생성 뒤 바뀌지 않음).

### 입력 한도·검증

| 필드                     | 규칙                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 닉네임·방 이름·정산 단위 | 최대 12자(코드포인트), 원본 64자 상한, NFC 정규화, 앞뒤 공백·제어·서식 문자 등 제한(Spec S1 §3.2)          |
| 금액                     | **정수** 1 ~ 999,999,999                                                                                   |
| `reason`                 | 선택, 최대 50자(원본 200자 상한), `round`는 최대 12자(원본 48자 상한). 없음·`null`·`""`는 같은 "입력 없음" |
| 방당 한도                | RoomMember 10명, Participant 10명, 거래 1,000건(삭제한 거래도 센다)                                        |

## 6. 실시간 (SSE)과 재동기화

### 연결

- **브라우저의 `EventSource`는 `Authorization` 헤더를 보낼 수 없어서 쓸 수 없다.** `fetch`로 `GET /rooms/{roomId}/events`를 열고 응답 본문 스트림을 직접 파싱한다(`Accept: text/event-stream`, `Authorization` 헤더).
- 한도: RoomMember당 5개, 방당 50개 동시 연결(인스턴스 합산). 초과하면 **새 연결만** 429(`Retry-After: 30`)다.
- `Last-Event-ID`는 무시한다. **이벤트를 저장하거나 재전송하지 않는다.**

### 이벤트

| `event`                                         | `data`                                          | 뜻                                   |
| ----------------------------------------------- | ----------------------------------------------- | ------------------------------------ |
| `ready`                                         | `{roomId, revision, serverTime}`                | 연결 직후 한 번. **현재 `revision`** |
| `transaction.created` / `.updated` / `.deleted` | `{roomId, revision, serverTime, transactionId}` | 거래 변경                            |
| `participant.created` / `.status_changed`       | `{roomId, revision, serverTime, participantId}` | 참여자 변경                          |
| `room.ended`                                    | `{roomId, revision, serverTime}`                | 게임 종료                            |
| `heartbeat`                                     | `{roomId, revision, serverTime}`                | 15초마다. **DB의 현재 `revision`**   |

- 변경 이벤트에는 `id: <revision>`이 붙고, **금액·사유·닉네임 같은 내용은 싣지 않는다.** 이벤트는 "다시 조회하라"는 신호다. **정산 이벤트는 없다**(정산은 순손익에서 계산되므로 위 이벤트 뒤에 다시 조회한다).
- `revision`은 방마다 1씩 증가하는 변경 번호다. 같은 이벤트가 두 번 올 수 있으므로(`seen`: 이미 처리한 `revision`은 무시) 중복을 걸러야 하고, **도착하지 않을 수도 있다.**

### 재동기화 규칙 (프론트가 반드시 구현)

1. 다음 중 하나가 생기면 **5개 조회를 모두** 다시 한다: ① 변경 이벤트 수신 ② 하트비트의 `revision`이 내가 본 값보다 큼(알림 유실) ③ 연결이 끊겼다 다시 붙음 ④ 화면 복귀·온라인 복귀.
   - 5개: 방(`GET /rooms/{id}`), 참여자, 순손익(`balances`), 거래 목록 첫 페이지, 정산(`settlement`).
2. **5개가 모두 성공한 뒤에만 화면에 반영**한다(일부만 반영하면 섞여 보인다).
3. **방 `status`와 정산 `kind`가 일치할 때만 반영**한다: `IN_PROGRESS`↔`EXPECTED`, `ENDED`↔`FINAL`. 어긋나면 반영하지 말고 다시 조회한다(종료는 되돌릴 수 없어 곧 일치한다).
4. 종료 여부는 `room.ended`를 받았는지가 아니라 **방 조회의 `status`**로 판단한다(재연결 후에는 `room.ended`가 다시 오지 않는다).
5. 연결이 끊긴 동안의 오래된 화면을 "최신"으로 보여 주지 않는다. 끊김 중에 미제출한 거래를 **자동으로 재제출하지 않는다.**
6. 재연결은 지수 백오프로 하고 429면 `Retry-After`를 따른다. 무료 서버가 깨어나는 동안(수십 초) 실패할 수 있다.

## 7. 프론트 구현 체크리스트와 함정

- [ ] 신원 키 생성·보관(브라우저 저장소), 모든 호출에 Bearer 헤더, 키 분실 시 복구 불가 안내.
- [ ] 모든 오류는 `error.code`로 분기, 사용자 문구는 `message`를 그대로 보여 줘도 된다.
- [ ] 멱등 키는 **사용자 의도 단위**로 생성하고 재시도에 재사용, `First-Attempt-At`은 처음 시각 유지, `Date` 헤더로 시계 보정.
- [ ] 거래·종료 요청의 응답을 못 받았을 때 자동 재전송 대신 **재조회로 확인**하고, 확인 못 하면 "저장 여부를 확정할 수 없다"고 표시한다.
- [ ] SSE는 `fetch` 스트림으로, 위 재동기화 규칙을 그대로.
- [ ] 정산 복사 텍스트: 진행 중(`EXPECTED`)에는 복사 기능이 없고, 종료 후(`FINAL`)에 항목이 있을 때만(Spec S4 §6.5).
- [ ] 정산 순서는 서버가 정한 `items` 순서 그대로 쓴다(다시 정렬하지 않는다).
- [ ] 종료 후에는 입력·수정·삭제 UI를 잠근다(서버도 `GAME_ENDED`로 거부).
- [ ] API 주소는 환경변수로 분리하고, 배포 후 Render의 `CORS_ORIGINS`에 프론트 주소를 추가한다.
- 함정: `GET`/`POST` 외 `HEAD`는 405, `OPTIONS`는 사전 요청에만 CORS가 응답한다, 허용되지 않은 필드나 쿼리는 422, 목록의 `cursor`는 방·필터에 묶여 있어 다른 방·필터에서 쓰면 422다.

## 8. 환경별 실행

| 환경      | 방법                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 배포본    | `https://ddallang-api.onrender.com` (무료 플랜, 첫 요청 느림)                                                                                     |
| 로컬      | 저장소 README "시작하기": `docker compose up -d`로 PostgreSQL, `pnpm build` 후 `NODE_ENV=development node dist/main.js`(Swagger `/api-docs` 열림) |
| 배포 갱신 | `main`에 push하면 Render가 다시 빌드·배포(자동 배포 설정에 따름). 환경변수는 Render 대시보드에서 관리                                             |

## 9. 참조

- 계약: `ddallang` 저장소 `docs/specs/S1-room-identity-participant`, `S2-transaction-crud`, `S3-view-balance`, `S4-settlement-end`, `S5-realtime-connection`
- 백엔드 Plan·Tasks·AC 매핑: `ddallang` `docs/plans/server/`
- 프론트 Plan: `ddallang` `docs/plans/web/`
- 이 저장소: [`README.md`](../README.md)(API 표), [`docs/g4-evidence.md`](./g4-evidence.md)(검증·위험), [`docs/deploy-free.md`](./deploy-free.md)(배포)
