# BE-Z1 통합 검증·G4 증거 묶음

- 기준: `ddallang` `origin/main` `2f5f455`, Plan/Tasks v1.2.0. Spec은 S1 v0.2.3, S2 v0.2.2, S3 v0.2.4, S5 v0.2.3, S4 v0.2.0(모두 확정, PRD v0.5.2).
- 대상: 로컬 `main` `ce579ff` + 이 Task의 변경. 환경: macOS, Node 로컬, 로컬 PostgreSQL 16, 같은 호스트.
- **Codex 독립 검수는 이 묶음 시점까지 BE-F1(1/3), BE-F2·F8(3/3), S5(1/3 REVISE 후 R1·R2 수정, 재검수 없음)만 받았다.** 나머지 묶음은 자체 검수 또는 검수 없음이며, 백엔드 개발 완료 뒤 묶음별 Codex 검수가 남아 있다. 어떤 묶음도 Codex PASS를 받지 않았다.

## 1. 실행한 검증(직접 실행, exit 0)

| 명령                                                                             | 결과                                                            |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                               | 통과                                                            |
| `pnpm deps:check`                                                                | 위반 없음(75 모듈, 252 의존)                                    |
| `pnpm build`                                                                     | 통과                                                            |
| `pnpm test:ac`(전체 시험 + AC 통과 확인)                                         | 52 파일, 608 시험 통과, 실패·skip 0                             |
| `pnpm ac:check`(static) / results 모드                                           | 필수 191개 중 시험 191, 누락 0(둘 다 통과)                      |
| `test/swagger.spec.ts`, `test/openapi-parity.spec.ts`, `test/readme-api.spec.ts` | Swagger 경로·메서드 집합 = 구현 경로(PD-19), README API 표 일치 |

AC가 없는 기반 Task(BE-S5-1·5·6, BE-S4-6 등)는 `ac:check --allow-empty`로 확인했다.

## 2. 다중 인스턴스 시험(프로세스 2~3개, 같은 DB)

| 시험                                                                       | 내용                                                                                                                                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/s1`, `test/s2` 동시성                                                | 마지막 슬롯·닉네임·같은 키·거래 경쟁                                                                                                                                 |
| `test/s4/concurrency.spec.ts`                                              | 종료 12개 동시(같은 키 6·다른 키 6): 전이 1회, `revision`+1, `room.ended` 1회, 성공은 전이 요청과 같은 키 재전송뿐. 종료 vs 거래 12회, 종료 vs 참여자 등록·상태 10회 |
| `test/s5/multi-instance.spec.ts`, `limits.spec.ts`, `stream-lease.spec.ts` | 인스턴스 간 이벤트 전달, 통지 차단 뒤 하트비트 revision 복구, 100건 연속 변경, 연결 한도(RoomMember 5·방 50) 인스턴스 합산, 프로세스 종료·정지 시 임대 정리          |

## 3. 지연 측정 결과(로컬 단일 호스트, 인스턴스 2개)

- `[S5-4]` 이벤트 전달(거래 생성, 구독자 5명, n=300): p50 8ms, p95 12ms, 최대 22ms.
- `[S4-7]` 변경 6종(거래 생성·수정·삭제, 참여자 등록·상태 변경, 게임 종료) 각 12회: 전달 p95 12ms/최대 15ms, 5개 조회(방·참여자·순손익·목록·정산) 완료 p95 19ms/최대 30ms.
- 통지를 끊은 유실 시나리오: 하트비트 → 5개 조회 수렴 15.0초(기준 20초).
- 기준(AC-VIEW-005-8): 전달·반영 p95 ≤ 1초, 최대 ≤ 3초. 서버 측은 충족.

**한계**: 측정 규모는 S5 §6.7 표의 초기 상태·횟수를 그대로 쓰지 않은 자체 구성이다(작은 방, 종류별 12회). 공유 CI·원격 DB·부하 상태의 수치가 아니다. 브라우저 렌더링 시간은 포함하지 않으며 AC-VIEW-005-8은 프론트엔드 Plan의 측정과 합쳐야 완료다.

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

- Codex 독립 검수: 위 범위를 제외하면 받지 않았다(최대 3회/묶음, 개발 완료 뒤 진행). 검수 지적은 미반영 상태일 수 있다.
- S5 §6.7 표를 그대로 따른 지연 측정, 전용 환경·릴리스 전 측정, 프론트엔드 화면 반영 측정은 하지 않았다.
- 장시간 운용, 대규모 부하, 실제 배포 환경(프록시·로드밸런서의 SSE 버퍼링), 브라우저 `EventSource` 실측은 하지 않았다.
- 전체 시험은 한 번의 로컬 실행 결과이며 반복 안정성(flaky) 측정은 하지 않았다.
- `ddallang` 문서 PR 대기 항목(Spec 침묵 구간의 기본값 선택): BE-F1 개발 CORS 기본값 vs PD-18, `INTERNAL_ERROR`, 잘못된 JSON의 `details`, 금액 소수·범위 초과 `INVALID_VALUE`, `RequestTimeoutError` HTTP 매핑, S5 `late` 임대 → `INTERNAL_ERROR`, 하트비트 15초·갱신 T/3 기본값, 종료 요청 만료 메시지 문구, 지연 하네스 규모.
