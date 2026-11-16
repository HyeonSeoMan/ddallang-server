# 백엔드 진행 현황과 프론트엔드 연동 가이드

작성: 2026-11-16, 기준 Spec S1~S5 **v0.3.0**(접속자·참여자 통합, `ddallang` `main` `c52ec81`), `ddallang-server` 브랜치 `HyeonSeoMan/new-policy`. 이 문서는 **프론트엔드 작업을 하는 사람과 AI**가 백엔드를 이해하고 올바르게 붙이도록 만든 요약이다.

> **배포본은 v2.0.0이다(2026-11-16 22:32 KST 전환).** 배포 DB의 v1.x 데이터는 지웠다(백업 보관). 지금 배포된 프론트엔드 1.x는 응답 모양이 달라 동작하지 않으며, 사용자 결정으로 프론트엔드 2.0.0과 시점을 맞추지 않았다. 실서버 점검(FE-M8)은 배포본으로 할 수 있다. 전환 기록은 [`g4-evidence.md`](./g4-evidence.md) §7.10.

## 0. 이 문서를 읽는 법 (AI 에이전트용)

- **계약의 원본은 `ddallang` 저장소의 Spec이다**(`docs/specs/S1~S5/spec.md`, `origin/main`). 이 문서와 Spec이 다르면 **Spec이 옳다**. 이 문서는 요약이며 Spec을 대체하지 않는다. 읽을 때는 `git -C ~/Documents/ddallang show origin/main:<경로>`를 쓴다.
- 구현된 API의 정확한 요청·응답 스키마는 개발 모드에서 Swagger(`/api-docs`, `/api-docs-json`)로 볼 수 있다(비권위 참고용). 배포본(`NODE_ENV=production`)에는 없다.
- 프론트 쪽 계획은 `ddallang`의 `docs/plans/web/`이다.
- 이 저장소의 비밀값(`.env`, 연결 문자열, `CURSOR_KEY`)은 어디에도 붙이지 않는다.

## 1. 한눈에 보는 상태

| 항목             | 상태                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| v1.x(BE-F1~Z1)   | 구현·배포 완료(Render + Supabase, `https://ddallang-api.onrender.com`)                                                  |
| v2.0.0(BE-M1~Z2) | **배포 완료(2026-11-16)**. 시험 714개 통과, 백엔드 담당 AC 215/215에 통과한 시험이 있음, 배포본 점검 21개 통과          |
| 검수             | 묶음 [M1~M3] Codex 2/3 PASS, [M4] 1/3 PASS, [M5] 1/3 PASS, [M6~M8] 3/3 PASS(정적 검수, Codex는 DB 시험을 실행하지 못함) |
| 기술             | NestJS 12(ESM), TypeScript, PostgreSQL 16, Prisma 7, REST + SSE                                                         |
| 허용 출처(CORS)  | 배포본은 `http://localhost:3000`만. 프론트를 배포하면 Render의 `CORS_ORIGINS`를 바꿔 재배포해야 함                      |

### v1.x에서 바뀐 것 (프론트가 고쳐야 할 곳)

| v1.x                                                          | v2.0.0                                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 접속자(`RoomMember`)와 정산 참여자(`Participant`)가 별개      | **참여자 하나**. 방 생성·입장이 참여자를 만들고 신원 키는 참여자에 연결된다                                 |
| `me`는 RoomMember `{id, roomId, nickname, isHost, createdAt}` | `me`는 **Participant** `{id, roomId, nickname, status, order, isHost, createdAt}`                           |
| 참여자 객체에 `isHost` 없음                                   | 모든 참여자 객체에 `isHost`(방 생성자만 `true`, 바뀌지 않음)                                                |
| 초대 조회 `{room, isMember}`                                  | `{room, identity, claim, claimableNicknames}`                                                               |
| 종료된 방에도 새 입장 가능                                    | 종료된 방의 **새 입장은 `409 GAME_ENDED`**(같은 키 복원·이어받기는 된다)                                    |
| 입장은 이벤트 없음                                            | 새 입장(201)은 `participant.created`. 복원(200)은 이벤트 없음                                               |
| 한도: RoomMember 10명 + Participant 10명                      | **참여자 10명 하나**. `MEMBER_LIMIT_EXCEEDED` 없음                                                          |
| 거래 `authorId`는 RoomMember ID                               | 거래 `authorId`는 **참여자 ID**                                                                             |
| 거래 요청자는 방 멤버 누구나                                  | **활성 참여자**만. 비활성 참여자는 조회만 하고 거래 변경은 `403 REQUESTER_INACTIVE`                         |
| 방장도 비활성화 가능                                          | 방장 비활성화는 `409 HOST_CANNOT_BE_DEACTIVATED`                                                            |
| (없음)                                                        | **이어받기**: 키를 잃은 사람이 방장 승인으로 기존 참여자를 되찾는다(API 7개, §5.2). 이전 키는 접근을 잃는다 |
| SSE 이벤트 6종                                                | `claim.created`·`claim.canceled`·`claim.resolved`, `access.revoked` 추가                                    |
| 방장 갱신 5개 조회                                            | 방장은 **대기 중인 이어받기 요청 목록을 더한 6개**                                                          |

### 알려진 한계

- **무료 플랜**: Render는 15분 요청이 없으면 잠들고 다음 요청이 50초 넘게 걸릴 수 있다. 잠들면 SSE가 끊긴다.
- 지연 측정(전달 p95 수 ms 등)은 같은 호스트·로컬 DB 기준이며 왕복 150ms 망과 브라우저 렌더링은 포함하지 않는다. 요청자 화면(이어받기 결과)은 서버 쪽 2초 주기 조회 흉내까지만 쟀다(BE-C8).
- `HEAD` 요청은 모든 경로에서 405다(의도). 상태 점검은 `GET /health`를 쓴다.
- 문서 PR 대기 항목(Spec이 정하지 않아 구현 기본값을 고른 것)이 `g4-evidence.md` §5·§7.7에 있다.

## 2. 접속 정보

- **Base URL**: 배포본 `https://ddallang-api.onrender.com`(v2.0.0), 로컬 `http://localhost:3001`.
- **배포본 지연(2026-11-16 측정, 한국 → Render 싱가포르 → Supabase 시드니)**: `GET /health`(DB 없음) 중앙값 133ms, 읽기(`GET balances`) 약 0.8초, 쓰기(`POST transactions`) 약 1.8~2.0초. 대부분 서버와 DB 사이 왕복이다(DB 지역 이전은 무료 슬롯 한도로 보류). 쓰기 응답을 기다리는 동안 로딩 상태를 보여 준다.
- **형식**: JSON(`Content-Type: application/json`), 시각은 RFC 3339 UTC 문자열, 금액은 정수(방의 `unit`과 환산 없음).
- **CORS**: 사전 요청(OPTIONS)에 허용 헤더 `Authorization`, `Content-Type`, `Idempotency-Key`, `Idempotency-First-Attempt-At`를 허용하고, 응답 노출 헤더는 `Date`, `Idempotent-Replayed`, `Retry-After`다.

## 3. 신원·참여자·권한

- 로그인·회원가입이 없다. **신원 키**는 브라우저가 만든 32바이트 난수의 base64url(43자)이며 `Authorization: Bearer <키>`로 보낸다. 서버는 SHA-256 해시만 저장하고 응답·로그에 내지 않는다.
- 키는 **초대 코드별**로 저장하고, 생성·저장·재확인은 Web Locks 배타 구간에서 한다(S1 §3.1). 방 생성은 "생성 대기" 항목(시도 ID, 키)으로 시작하고 `201`의 `inviteCode`에 연결한다.
- 키는 방마다 의미가 있다. 한 방에서 키의 상태는 넷 중 하나다(S1 §2.2).

| 상태(`identity`) | 뜻                                            | 방 경로(`/rooms/{roomId}/…`)의 응답 |
| ---------------- | --------------------------------------------- | ----------------------------------- |
| `PARTICIPANT`    | 참여자에 연결됨(서버 내부명 LINKED)           | 그 참여자가 요청자(`me`)            |
| `PENDING`        | 대기 중인 이어받기 요청이 있음(아직 비참여자) | `404 ROOM_NOT_FOUND`                |
| `REVOKED`        | 이어받기 승인으로 끊김                        | **`401 IDENTITY_REVOKED`**          |
| `NONE`           | 처음 보는 키, 또는 요청이 모두 끝난 키        | `404 ROOM_NOT_FOUND`                |

- `IDENTITY_REVOKED`를 받으면 방 화면을 닫고 접근을 잃었다고 안내한 뒤, 저장된 키가 그 요청에 쓴 키와 **같을 때만** 지우고(같은 잠금 안에서) 초대 화면의 `NONE` 상태로 보낸다(S1 §3.1, §9).

| 요청자                   | 할 수 있는 것                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| 방장(항상 활성)          | 직접 추가·상태 변경, 이어받기 목록·단건·승인·거절, 모든 거래 수정·삭제, 게임 종료, 그리고 아래 전부 |
| 활성 참여자              | 조회, 거래 생성(당사자가 아니어도), 자기 거래 수정·삭제, SSE                                        |
| 비활성 참여자            | 조회와 SSE만. 거래 생성·수정·삭제는 `403 REQUESTER_INACTIVE`                                        |
| 비참여자(신원 없음·대기) | 초대 조회, 입장, 이어받기 요청·내 요청 조회·취소                                                    |

## 4. 공통 규약

### 오류 형식

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "입력 값을 확인해 주세요.",
    "details": [{ "field": "nickname", "code": "LENGTH_OUT_OF_RANGE" }]
  }
}
```

분기는 `code`로 하고 `message`는 한국어 사용자 문구다.

| HTTP | code                                                                                                                                                                                                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401  | `UNAUTHENTICATED`(키 없음·형식 오류), `IDENTITY_REVOKED`(이 방에서 접근을 잃은 키)                                                                                                                                                                                                                                     |
| 403  | `HOST_ONLY`, `NOT_AUTHOR_OR_HOST`, `REQUESTER_INACTIVE`                                                                                                                                                                                                                                                                |
| 404  | `ROOM_NOT_FOUND`(비참여자 포함), `INVITE_NOT_FOUND`, `PARTICIPANT_NOT_FOUND`, `CLAIM_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `ROUTE_NOT_FOUND`                                                                                                                                                                            |
| 405  | `NOT_SUPPORTED`(`Allow` 헤더)                                                                                                                                                                                                                                                                                          |
| 409  | `GAME_ENDED`, `NICKNAME_TAKEN`, `PARTICIPANT_LIMIT_EXCEEDED`, `HOST_CANNOT_BE_DEACTIVATED`, `ALREADY_PARTICIPANT`, `CLAIM_PENDING`, `CLAIM_ALREADY_RESOLVED`, `CLAIM_REQUESTER_LINKED`, `TRANSACTION_LIMIT_EXCEEDED`, `PARTICIPANT_INACTIVE`, `TRANSACTION_DELETED`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_KEY_EXPIRED` |
| 422  | `VALIDATION_FAILED`(`details[]`에 `{field, code}`)                                                                                                                                                                                                                                                                     |
| 429  | `CONNECTION_LIMIT_EXCEEDED`(`Retry-After: 30`)                                                                                                                                                                                                                                                                         |
| 500  | `INTERNAL_ERROR`                                                                                                                                                                                                                                                                                                       |

- 검사 순서는 Spec마다 다르다. 처음 걸린 오류 하나를 돌려준다.
  - **S1(방·참여자·이어받기, §3.3)**: 라우트(404/405) → 인증(401) → 방·초대 존재(404) → 신원 상태(401 `IDENTITY_REVOKED`, 비참여자 404) → 방장(403) → 방 상태(409 `GAME_ENDED`) → 대상 존재(404) → 입력(422) → 상태 충돌(409) → 한도(409). 이어받기 요청은 대상을 본문 닉네임으로 찾으므로 입력(422) 뒤에 대상(404)을 본다.
  - **S2(거래, §3.4)**: 라우트 → 인증 → 방·요청자(404, 접근 상실 401) → 멱등 헤더(422) → 만료(409) → 재전송 판정 → 비활성 요청자(403 `REQUESTER_INACTIVE`) → (수정·삭제) 대상 거래(404) → 작성자·방장(403 `NOT_AUTHOR_OR_HOST`) → 방 상태(409 `GAME_ENDED`) → (수정·삭제) 삭제된 거래(409) → 입력(422) → (생성) 비활성 당사자(409) → 거래 한도(409). 그래서 종료된 방에서도 없는 거래는 `TRANSACTION_NOT_FOUND`, 남의 거래는 `NOT_AUTHOR_OR_HOST`가 먼저다.
  - **S4(종료, §3.3)**: 라우트 → 인증 → 방·요청자 → 멱등 헤더 → 만료 → 재전송 → 방장(403) → 이미 종료(409, 기록됨) → 본문(422).
- `CLAIM_REQUESTER_LINKED`는 **거부하면서 요청을 `REJECTED`로 바꾸는** 유일한 경우다(승인 시점에 요청 키가 이미 다른 참여자에 연결됨). 방장 화면은 단건 조회로 현재 상태를 다시 본다.
- 입장의 `NICKNAME_TAKEN`·`PARTICIPANT_LIMIT_EXCEEDED` 문구는 "기존 참여자라면 이어받기를 요청할 수 있다"를 안내한다.
- 허용되지 않은 필드는 422(`NOT_ALLOWED_FIELD`)다.

### 멱등성 (거래 생성·수정·삭제, 게임 종료)

두 헤더가 필수다(없으면 422).

| 헤더                           | 값                                                         |
| ------------------------------ | ---------------------------------------------------------- |
| `Idempotency-Key`              | `^[A-Za-z0-9_-]{16,64}$` 난수. 재시도 때 같은 값           |
| `Idempotency-First-Attempt-At` | 처음 시도한 시각(RFC 3339 UTC 밀리초). 재시도 때도 처음 값 |

- 키의 효력 범위는 **(방, 참여자)**다. 이어받은 새 브라우저도 같은 참여자 범위를 쓴다(이전 브라우저의 키 값은 모르므로 보통 겹치지 않는다).
- 같은 키·같은 내용이면 저장된 결과와 `Idempotent-Replayed: true`. 다른 내용이면 `409 IDEMPOTENCY_CONFLICT`. 처음 시도 후 24시간이 지나면 `409 IDEMPOTENCY_KEY_EXPIRED`. 5분을 넘는 미래 시각은 422(`Date` 헤더로 보정).
- 접근을 잃은 이전 브라우저의 재전송은 재전송 판정보다 먼저 `401 IDENTITY_REVOKED`다.
- 비활성 참여자의 새 요청은 기록되지 않는다(`REQUESTER_INACTIVE`). 비활성화 전에 기록된 요청의 재전송은 최초 결과를 받는다.

## 5. 엔드포인트 요약

`{roomId}`, `{participantId}`, `{transactionId}`, `{claimId}`는 서버가 만든 ID다(거래 ID는 22자 base64url, 형식이 다르면 404 `ROUTE_NOT_FOUND`).

### 5.1 방·참여자·거래·정산

| 요청                                                      | 본문                                          | 성공 응답                                                            | 비고                                                                                             |
| --------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /rooms`                                             | `{name, unit, nickname}`                      | 201 `{room, me}`                                                     | `me`는 방장 참여자(`order` 1, `isHost`). 이 키에 연결. `room`에 `inviteCode`                     |
| `GET /invites/{inviteCode}`                               | —                                             | 200 `{room:{name,unit,status}, identity, claim, claimableNicknames}` | 키 선택. `claim`은 이 키의 가장 최근 요청(`MyClaim`) 또는 `null`. 후보는 `NONE`·`REVOKED`일 때만 |
| `POST /invites/{inviteCode}/members`                      | `{nickname}`(새 입장만)                       | 201 새 참여자 / 200 복원, `{room:{id,name,unit,status}, me}`         | 대기 키 `CLAIM_PENDING`, 접근 상실 `IDENTITY_REVOKED`, 종료된 방의 새 입장 `GAME_ENDED`          |
| `GET /rooms/{roomId}`                                     | —                                             | 200 `{room, me}`                                                     | 활성·비활성 참여자                                                                               |
| `GET /rooms/{roomId}/participants`                        | —                                             | 200 `{participants:[…]}`                                             | `order` 오름차순, 비활성·직접 추가 포함                                                          |
| `POST /rooms/{roomId}/participants`                       | `{nickname}`                                  | 201 `{participant}`                                                  | 방장, 신원 없는 참여자(이어받기 대상이 될 수 있음)                                               |
| `PATCH /rooms/{roomId}/participants/{participantId}`      | `{status:'ACTIVE'\|'INACTIVE'}`               | 200 `{participant}`                                                  | 방장. 방장 대상 `INACTIVE`는 `HOST_CANNOT_BE_DEACTIVATED`. 같은 값이면 변경·이벤트 없음          |
| `POST /rooms/{roomId}/transactions`                       | `{payerId, payeeId, amount, reason?, round?}` | 201 `{transaction}`                                                  | 활성 참여자, 멱등 헤더. 지급자≠수취자, 둘 다 활성                                                |
| `PUT /rooms/{roomId}/transactions/{transactionId}`        | `{amount, reason?, round?}`                   | 200 `{transaction}`                                                  | 활성 작성자 또는 방장. 통째 교체, 값이 같으면 변경 없음                                          |
| `DELETE /rooms/{roomId}/transactions/{transactionId}`     | 없음                                          | 200 `{transactionId, deletedAt}`                                     | 활성 작성자 또는 방장                                                                            |
| `GET /rooms/{roomId}/transactions?participantId=&cursor=` | —                                             | 200 `{transactions:[…], nextCursor}`                                 | 유효 거래, 최신순 20건                                                                           |
| `GET /rooms/{roomId}/balances`                            | —                                             | 200 `{balances:[{participantId,nickname,status,order,balance}]}`     | 모든 참여자(방장 포함), `balance` 내림차순                                                       |
| `POST /rooms/{roomId}/end`                                | 없음 또는 `{}`                                | 200 `{roomId, status:'ENDED'}`                                       | 방장, 멱등 헤더                                                                                  |
| `GET /rooms/{roomId}/settlement`                          | —                                             | 200 `{settlement:{kind, items:[…]}}`                                 | `EXPECTED`/`FINAL`. 종료 뒤 복원·이어받기한 참여자도 조회                                        |
| `GET /rooms/{roomId}/events`                              | —                                             | `text/event-stream`                                                  | §6                                                                                               |
| `GET /health`                                             | —                                             | 200 `{status:'ok'}`                                                  | 인증·DB 없음                                                                                     |

- **참여자 객체**: `{id, roomId, nickname, status, order, isHost, createdAt}`. 신원 연결 여부는 담지 않는다.
- **거래 객체**: `{id, payerId, payeeId, amount, reason|null, round|null, authorId, createdAt, updatedAt}`. `authorId`는 참여자 ID다(작성자 닉네임은 참여자 목록에서 찾는다).

### 5.2 이어받기 (S1 §4.9~§4.15)

| 요청                                                 | 누가              | 성공 응답                                 | 주요 오류                                                                                                      |
| ---------------------------------------------------- | ----------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `POST /invites/{inviteCode}/claims` `{nickname}`     | 신원 없는 키      | 201 `{claim: MyClaim}`                    | 연결된 키 `ALREADY_PARTICIPANT`, 대기 `CLAIM_PENDING`, 접근 상실 401, 없는·방장 닉네임 `PARTICIPANT_NOT_FOUND` |
| `GET /invites/{inviteCode}/claims/{claimId}`         | 그 요청을 만든 키 | 200 `{claim: MyClaim}`                    | 다른 키·다른 방 `CLAIM_NOT_FOUND`                                                                              |
| `POST /invites/{inviteCode}/claims/{claimId}/cancel` | 그 요청을 만든 키 | 200 `{claim: MyClaim}`                    | 끝난 요청 `CLAIM_ALREADY_RESOLVED`                                                                             |
| `GET /rooms/{roomId}/claims`                         | 방장              | 200 `{claims: Claim[]}`(PENDING, 요청 순) | 비방장 `HOST_ONLY`                                                                                             |
| `GET /rooms/{roomId}/claims/{claimId}`               | 방장              | 200 `{claim: Claim}`(끝난 요청 포함)      | `CLAIM_NOT_FOUND`                                                                                              |
| `POST /rooms/{roomId}/claims/{claimId}/approve`      | 방장              | 200 `{claim: Claim, participant}`         | `CLAIM_ALREADY_RESOLVED`, `CLAIM_REQUESTER_LINKED`                                                             |
| `POST /rooms/{roomId}/claims/{claimId}/reject`       | 방장              | 200 `{claim: Claim}`                      | `CLAIM_ALREADY_RESOLVED`                                                                                       |

- `MyClaim`(요청자용): `{id, nickname, status, rejectReason, createdAt, resolvedAt}`. `Claim`(방장용)은 여기에 `participantId`, `resolvedById`(처리한 방장의 참여자 ID)를 더한다.
- `status`: `PENDING`·`APPROVED`·`REJECTED`·`CANCELED`. `rejectReason`(REJECTED만): `HOST_REJECTED`·`TARGET_CLAIMED`(같은 대상의 다른 요청이 승인됨)·`REQUESTER_LINKED`.
- 게임 상태·참여자 한도와 무관하고(종료된 방·10명 방에서도 된다) **만료가 없다**. Idempotency Key가 없다: 응답을 잃으면 다시 조회해 현재 상태를 확인한다(요청자는 초대 조회의 `claim`·내 요청 조회, 방장은 단건 조회). 그 상태가 내 요청의 결과라고 단정하지 않는다.
- 승인되면 요청한 키가 **그대로** 대상 참여자에 연결된다. 요청자는 입장 요청(`POST …/members`)으로 복원해 방에 들어간다. 대상의 닉네임·상태·`order`·`isHost`·거래는 바뀌지 않는다.
- 요청자는 방 비참여자라 SSE를 열 수 없다. `PENDING`인 동안 **2초 간격으로** 내 요청 조회를 하고(화면이 보일 때만, 복귀·온라인 시 즉시), 결과가 나오면 멈춘다(S5 §6.8).

### 입력 한도

| 필드                     | 규칙                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------ |
| 닉네임·방 이름·정산 단위 | 최대 12자(코드 포인트), NFC 정규화, 허용 문자·공백 규칙(S1 §3.2)                     |
| 금액                     | 정수 1 ~ 999,999,999                                                                 |
| `reason`·`round`         | 선택, 최대 50자·12자                                                                 |
| 방당 한도                | **참여자 10명**(방장·직접 추가·비활성 포함, 이어받기 요청은 세지 않음), 거래 1,000건 |

## 6. 실시간 (SSE)과 재동기화

### 연결

- `EventSource`는 쓸 수 없다(헤더 불가). `fetch`로 `GET /rooms/{roomId}/events`를 열고 본문 스트림을 파싱한다.
- 요청자는 이 방의 참여자(활성·비활성)다. 대기·신원 없음·다른 방 키는 `404`, 접근 상실 키는 `401 IDENTITY_REVOKED`(재연결하지 않고 접근 상실 처리).
- 한도: **참여자당 5개**, 방당 50개(인스턴스 합산). 초과하면 새 연결만 429.

### 이벤트

| `event`                                         | `data`                                          | 뜻                                                                     |
| ----------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `ready`                                         | `{roomId, revision, serverTime}`                | 연결 직후 한 번                                                        |
| `transaction.created` / `.updated` / `.deleted` | `{roomId, revision, serverTime, transactionId}` | 거래 변경                                                              |
| `participant.created` / `.status_changed`       | `{roomId, revision, serverTime, participantId}` | 참여자 생성(새 입장·직접 추가)·상태 변경                               |
| `claim.created` / `.canceled` / `.resolved`     | `{roomId, revision, serverTime, claimId}`       | 이어받기 요청·취소·승인·거절(모든 스트림에 간다)                       |
| `room.ended`                                    | `{roomId, revision, serverTime}`                | 게임 종료                                                              |
| `heartbeat`                                     | `{roomId, revision, serverTime}`                | 15초마다, DB의 현재 `revision`                                         |
| `access.revoked`                                | `{roomId, serverTime}`(id·revision 없음)        | 이 스트림을 연 키가 접근을 잃었다. 서버가 곧 닫는다. 재연결하지 않는다 |

- 변경 이벤트에는 `id: <revision>`이 붙고 내용(금액·닉네임 등)은 없다. 알 수 없는 이벤트 이름은 변경 이벤트로 취급해 재동기화한다.
- `access.revoked`는 승인 직후 오고, 놓쳐도 다음 하트비트(최대 15초)에 다시 온다.

### 재동기화 규칙 (프론트가 반드시 구현)

1. 변경 이벤트·하트비트 뒤처짐·재연결·화면 복귀에서 **갱신 대상 전체**를 다시 조회한다: 방, 참여자, 순손익, 거래 목록 첫 페이지, 정산(5개). **방장은 대기 중인 이어받기 요청 목록(`GET /rooms/{roomId}/claims`)을 더해 6개**다(방장 여부는 직전 방 조회의 `me.isHost`).
2. 모두 성공한 뒤에만 화면에 반영한다. 방 `status`와 정산 `kind`가 일치할 때만 반영한다(`IN_PROGRESS`↔`EXPECTED`, `ENDED`↔`FINAL`).
3. 종료 여부는 방 조회의 `status`로 판단한다(재연결 후에는 `room.ended`가 다시 오지 않는다). 종료 뒤에도 `claim.*` 이벤트는 올 수 있다.
4. 갱신 중 `401 IDENTITY_REVOKED`면 접근 상실 처리, 그 밖의 `401`·`404 ROOM_NOT_FOUND`는 재시도하지 않고 안내한다.
5. 끊김 중에 미제출한 거래를 자동으로 재제출하지 않는다.

## 7. 프론트 구현 체크리스트

- [ ] 초대 코드별 신원 키, Web Locks 배타 구간(생성·저장·재확인, 조건부 삭제), 방 생성 대기 항목.
- [ ] 초대 화면은 `identity`로 분기: `PARTICIPANT`면 바로 복원 입장, `NONE`이면 입장(진행 중만)과 이어받기(후보가 있을 때), `PENDING`이면 대기 화면·취소·2초 주기 조회, `REVOKED`면 안내 뒤 키 삭제·`NONE`. 최근 `claim`이 `REJECTED`·`CANCELED`면 결과를 한 번 안내.
- [ ] 입장의 `NICKNAME_TAKEN`·`PARTICIPANT_LIMIT_EXCEEDED`는 입력 유지 + 이어받기로 이동, `CLAIM_PENDING`은 대기 화면, `GAME_ENDED`는 종료 안내.
- [ ] 방장 화면: 대기 요청 목록(대상 닉네임)과 승인·거절, 같은 대상에 요청이 여럿이면 하나만 승인됨을 표시, 종료 뒤에도 유지. `CLAIM_ALREADY_RESOLVED`·`CLAIM_REQUESTER_LINKED`는 단건 조회로 현재 상태와 처리자(`resolvedById` → 참여자 목록의 닉네임)를 안내.
- [ ] 방장 행에는 비활성화 컨트롤이 없다. 비활성 참여자 자신의 화면은 조회 전용(거래 컨트롤 비활성).
- [ ] 어떤 방 요청·SSE에서든 `IDENTITY_REVOKED`·`access.revoked`를 받으면 방 화면을 닫고 안내한다.
- [ ] 멱등 키는 사용자 의도 단위, 재시도에 재사용, `First-Attempt-At`은 처음 시각, `Date`로 시계 보정. 응답 유실은 재조회로 확인.
- [ ] SSE는 `fetch` 스트림, 위 재동기화 규칙(방장 6개).

## 8. 환경별 실행

| 환경             | 방법                                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 로컬(v2.0.0)     | 이 브랜치에서 `docker compose up -d`, `pnpm install`, `pnpm exec prisma migrate deploy`(빈 DB 또는 `prisma/reset-v1-data.sql`로 지운 DB), `pnpm build` 후 `NODE_ENV=development node dist/main.js`(Swagger `/api-docs`) |
| 배포본           | `https://ddallang-api.onrender.com` — v2.0.0(2026-11-16 전환)                                                                                                                                                           |
| v2.0.0 배포 순서 | [`g4-evidence.md`](./g4-evidence.md) §7.6(사용자 승인, 배포 DB 초기화, 프론트엔드 2.0.0과 같은 시점)                                                                                                                    |

## 9. 참조

- 계약: `ddallang` `docs/specs/S1-room-identity-participant`, `S2-transaction-crud`, `S3-view-balance`, `S4-settlement-end`, `S5-realtime-connection`(모두 v0.3.0)
- 백엔드 Plan·Tasks·AC 매핑: `ddallang` `docs/plans/server/`(v2.0.0, §11·§J)
- 이 저장소: [`README.md`](../README.md)(API 표), [`docs/g4-evidence.md`](./g4-evidence.md)(검증·위험·배포 절차), [`docs/deploy-free.md`](./deploy-free.md)
