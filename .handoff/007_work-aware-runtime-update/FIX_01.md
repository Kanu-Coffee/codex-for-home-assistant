# FIX_01 — 실패 실험의 전송 규약 수정과 실제 작업 기반 업데이트 구현

작성일: 2026-10-30, Reviewer: Codex
판정: **REQUEST CHANGES — 핵심 기능 미구현, 기술적 구현 불가 입증 없음**

## 1. 검토 기준과 현재 상태

[PLAN](PLAN.md), [REPORT](REPORT.md), 현재 Git diff/status, progress의 후속 실패 기록, task 006의 rollback 및 FIX_11/12/17 이력을 검토했다. 현재 제품 변경은 pending server-request gauge 추가뿐이다. CLI·stdio 생존 blocker와 loaded idle conversation blocker는 그대로다. 116개 테스트 통과 기록은 기존 동작 회귀이며 목표 달성의 증거가 아니다.

이번 Reviewer는 제품 코드를 수정하지 않았다. 운영 인증·HA 구성·서비스를 사용하지 않고 격리된 공식 binary로 전송 실험을 수행했다. 이전 PLAN/REPORT는 수정하지 않는다. 다음 Executor는 이 FIX를 수행하고 `FIX_01_REPORT.md`를 새로 작성한다.

## 2. P1 — 초기화 실패의 직접 원인: proxy 전송 규약 오해

### 소스와 재현

공식 `rust-v0.165.0`, commit `360319d8dee62d87e2d59fc0c21805d79519cfed`의 다음 파일을 확인했다.

- [CLI proxy 분기](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/cli/src/main.rs): 약 1478행에서 `codex_stdio_to_uds::run` 호출.
- [stdio-to-uds 구현](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/stdio-to-uds/src/lib.rs): UnixStream에 연결하고 양방향 `tokio::io::copy`; JSON 파싱·WebSocket 변환·reconnect·thread 복원 없음.
- [Unix listener 구현](https://github.com/openai/codex/blob/360319d8dee62d87e2d59fc0c21805d79519cfed/codex-rs/app-server-transport/src/transport/unix_socket.rs): 약 193행 `accept_hdr_async_with_config`로 WebSocket Upgrade 요구.
- [OpenAI App Server 문서](https://learn.chatgpt.com/docs/app-server): stdio JSONL과 Unix socket의 WebSocket transport를 구별한다. 2026-10-30 열어 확인했다.

앞선 Executor 실험은 `app-server --listen unix://PATH`에 연결한 proxy stdin으로 initialize JSONL을 보냈다. 서버는 HTTP Upgrade를 기다리므로 JSONL 요청에 응답하지 않았다. socket 생성이나 remote-control 인증 경고만 보고 이 실패를 인증·HAOS 문제로 추정해서는 안 된다.

Reviewer가 같은 공식 binary로 다음 순서로 실행하자 성공했다.

1. Git 제외 `.test-tmp` 안에 임시 HOME과 CODEX_HOME 디렉터리를 생성.
2. 최소 환경에서 `codex app-server --listen unix://PATH` 실행.
3. `codex app-server proxy --sock PATH` 실행.
4. proxy stdin에 표준 HTTP WebSocket Upgrade 요청을 전송.
5. `HTTP/1.1 101 Switching Protocols` 수신.
6. initialize JSON을 **masked WebSocket text frame**으로 전송.
7. 응답 frame에서 동일 request ID와 `result` 확인.
8. 해당 시험 서버만 SIGHUP; exit 0 확인. 시험 proxy는 별도 정리.

실험 binary: `0.165.0`, `x86_64-unknown-linux-musl`, 실행 파일 SHA-256 `c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5`. 이는 로컬 파일 식별값이며 이번에 release archive의 공급망 전체를 재검증했다는 뜻은 아니다. 모델 호출·실사용 auth 없이 initialize가 가능했다.

### 수정 지시

- 위 실험을 재현 가능한 테스트 파일로 남긴다. HTTP Upgrade·frame·initialize를 각각 assert하고 timeout이면 정확한 단계와 정제된 오류를 기록한다.
- JSONL worker와 WebSocket Unix 서버를 테스트에서 명확히 분리한다. stdin/stdout이라는 이유로 JSONL이라고 가정하지 않는다.
- 실제 mobile Remote가 bootstrap하는 argv와 wire protocol도 확인한다. `app-server`와 `app-server proxy`를 같은 입력 규약으로 바꾸지 않는다.
- 공식 proxy는 transport byte bridge다. 서버 재시작 후 자동 연결 복구와 대화 복원을 제공하는 것으로 설계하지 않는다. `try_join!` 구조 때문에 server EOF 뒤 stdin이 열린 채로 proxy가 남는 현상도 가능하므로 프로세스 생존을 reconnect 증거로 쓰지 않는다.
- 이 실험 실패를 사용자에게 구현 불가라고 보고하지 않는다. 재연결 지원 여부는 별도 시험으로 확인한다.

## 3. P1 — 실행 중 교체를 책임질 구조와 관측 범위가 없음

단순 PID 분류 개선과 승인 gauge 한 개로는 목적을 달성할 수 없다. 독립 CLI 내부의 실행 상태는 외부 Unix 서버 진단으로 관측되지 않고, current symlink를 바꿔도 기존 worker는 구버전이다.

### 권장 구현

공식 TUI `--remote unix://PATH`로 frontend와 worker를 분리하고, 각 논리 세션에 image-managed lifecycle host를 둔다. 먼저 공식 frontend의 자동 reconnect/resume을 실제로 검증한다. 부족한 부분만 adapter가 맡는다. shared daemon을 채택하려면 모든 client의 작업 관측과 cwd·model·policy·approval 격리를 먼저 입증한다. 이를 입증하기 전에는 client별 worker가 더 단순한 선택이다.

필요 adapter는 다음 두 경로를 실제 client 규약에 맞춰 제공한다.

| 진입 | frontend 쪽 | 교체할 worker 쪽 |
| --- | --- | --- |
| 기본 `codex app-server` stdio | JSONL stream 유지 | 공식 stdio JSONL worker |
| `app-server proxy` 또는 TUI remote | WebSocket over Unix의 연결·frame 유지 | 검증된 Unix WebSocket worker 또는 명시적 JSONL 변환 |

기존 고정 `ws` 의존성을 사용할 수 있으므로 protocol framing을 직접 재작성하기 전에 image 경로에서 사용 가능성을 확인한다. 새로운 네트워크 listener나 host 포트는 만들지 않는다. wrapper가 관리형/직접실행/외부 remote/단발 명령을 구분하고 기존 global option·exit code·policy 강제·credential 비상속을 유지한다.

과거 task 006 구현을 설계 참고와 회귀 자료로 읽는 것은 가능하다. 그대로 복원하여 완료 처리하지 않는다. FIX_17의 대형 frame crash, FIX_12의 ephemeral 오분류와 FIX_01의 잘못된 request ID 복원 사례를 먼저 회귀로 만든다.

### 실제 작업 ledger

- authoritative diagnostics + 모든 loaded thread의 runtime status + 전체 background pagination + client/server 양방향 미완료 요청을 합친다.
- 요청 ACK 이후에도 실행되는 command/process, tool, queued input, approval/elicitation, child agent, 실제 자동 재개 producer를 포함한다.
- loaded 수·연결 수·helper 생존은 activity와 별도로 표시한다. `idle`, `busy`, `unknown`, `canTransition`을 분리한다.
- 알 수 없는 gauge/schema와 중복·malformed gauge, pagination 반복/누락, snapshot stale, identity 불일치는 unknown이다. 누락=0 예외는 정확한 baseline/후보 소스·시험으로 입증한다.
- 현재 추가한 pending gauge 양수 처리는 유지 가능하지만, 누락된 gauge를 무조건 0으로 보는 것을 전체 작업 관측의 완전성 증거로 쓰지 않는다.
- private thread ID와 최소 설정은 이관에 필요할 때 메모리에만 유지한다. prompt·tool 결과·token·command/cwd 원문을 공개 status/log에 기록하지 않는다.

## 4. P1 — admission·재시작·복원을 하나의 transaction으로 구현

1. baseline `0.162.1`과 후보 공식 패키지를 exact version/target/digest로 확보한다. 로컬 캐시가 없으면 공식 archive를 내려받아 검증한다. 운영 binary나 기존 home을 덮어쓰지 않는다.
2. 후보 checksum/inventory/policy/client compatibility와 CODEX_HOME migration/rollback 가능성을 사전 확인한다.
3. 모든 대상 작업 상태를 확인하고 하나라도 실제 busy면 전체 적용을 보류한다.
4. 신규 launch lock과 기존 세션 입력 admission barrier를 획득한다. snapshot revision/신원을 재확인한다. 두 번 poll하는 것으로 경합 봉쇄를 대신하지 않는다.
5. 이미 수락된 요청이나 내부 producer가 발견되면 전환 취소 또는 drain 완료까지 보호한다. barrier 뒤 입력은 bounded hold/backpressure로 보관하며 정확히 한 번 전달한다.
6. exact PID/start-time의 기존 worker만 graceful 종료한다. timeout을 강제 kill로 해결하지 않는다. 이전 writer 종료 후 replacement를 시작한다.
7. initialize와 해당 client capability를 검증하고 같은 persistent thread·model/cwd/policy·구독을 복원한다. 내부 RPC ID를 외부 ID와 분리하고 client가 요청하지 않은 응답을 노출하지 않는다.
8. 빈 ephemeral은 실제 용도를 확인해 재생성/매핑하되 사용자 내용이 있는 ephemeral을 임의의 빈 thread로 대체하지 않는다.
9. 실행 중 exe/version, thread 복원, readiness 확인 후 commit하고 hold 입력을 재개한다. selected/frontend/backend 버전을 구분한다.
10. 부분 실패·worker crash·journal write 실패 시 기존 generation으로 복구한다. 이미 전달한 요청을 자동 재실행하지 않는다. 복구 불완전은 명시적으로 표시한다.

기존 HA 03/09/15/21 슬롯, 5분 로컬 재검사, 일별 12회 예산과 날짜 회복, 24시간 cooldown을 유지한다. 제한으로 기다리는 상태는 작업 busy와 구분한다. 사용자가 idle이면 곧바로 적용될 것이라고 기대하는 시간과 이 제한이 충돌하면 nextRetryAt을 표시한다. 제한을 임의로 삭제하지 않는다.

## 5. 구현 순서와 완료 증거

| 단계 | 산출물 | 반드시 통과할 증거 |
| --- | --- | --- |
| 1 | 재현 가능한 공식 wire probe와 버전별 capability 표 | baseline/후보의 JSONL 및 Unix WebSocket initialize·thread 생성/조회 |
| 2 | 공통 activity 모델과 진단 tests | loaded idle 허용, queue/wait/tool/background 보호, 다른 client 및 마지막 페이지 관측 |
| 3 | wrapper→관리형 host→공식 worker 실제 연결 | TUI PTY와 stdio 각각 초기화·첫 요청, 단발 help/version은 backend 불필요 |
| 4 | admission·교체·복원·rollback | 유휴 교체 뒤 같은 client/대화의 다음 요청, stop 직전 입력 경합, 실패 복구 |
| 5 | 기존 scheduler/manual/status 통합 | 실제 daemon 스케줄 경로에서 교체, OFF·예산·cooldown 유지 |
| 6 | 문서와 image/HAOS 검증 | 신규 image의 CLI·Remote E2E, 인증·정책·browser·memory 회귀 |

각 단계가 끝나면 구체적인 코드/명령/관측 결과를 기록하고 다음으로 진행한다. 초기 probe 한 번이 timeout됐다는 이유로 작업을 종결하지 않는다. source·stderr·wire 단계별 진단을 통해 다음 구현을 결정한다. unsupported 상태를 지원 완료로 표시하지 않는다.

필수 실패 회귀: 대형 정상 JSONL/UTF-8 분할/복수 frame/backpressure, HTTP Upgrade·ping/pong·fragment, stale PID, 미지원 method, approval 대기, request ACK 후 실행 지속, worker 시작/복원 실패, 다중 worker 일부 실패, journal recovery, 내용 있는 ephemeral.

실모델 대신 disposable local mock provider를 사용할 수 있다. 실제 공식 worker가 응답을 생성·tool을 실행하고 다음 요청의 대화 연속성이 확인되어야 한다. 가짜 worker의 버전 문자열 변경만으로 완료 처리하지 않는다. 운영 auth·대화는 복사하지 않는다. 기존 updater pytest→전체 pytest, 변경 ShellCheck/Node syntax, 기존 update/full smoke와 policy/credential 회귀를 수행한다.

## 6. 운영 관점의 제약과 사용자 선택이 필요한 경우

아래는 현재 **구현 불가 확정**이 아니라 특정 요구 조합의 기술적 제약이다. Executor가 기능표와 실험으로 경계를 확정한다. 사용자 승인 전 요구를 변경하지 않는다.

| 항목 | 운영상 의미/제약 | 가능한 우회 또는 요건 조정 |
| --- | --- | --- |
| 살아 있는 TUI 실행 파일 자체 교체 | 실행 중 프로세스의 코드를 symlink 변경만으로 신버전으로 만들 수 없음 | 작업 backend만 갱신하고 frontend는 자연 종료 후 갱신. frontend까지 즉시 갱신하려면 TUI 자동 재실행과 편집 입력 복원이 필요 |
| 직접 실행된 구형·관리 밖 CLI | 외부 updater가 모든 내부 queue·approval을 신뢰성 있게 확인하거나 stream을 인계할 수 없음 | 새 App의 관리형 진입을 사용. 기존 unmanaged 세션은 1회 정상 종료 필요. 이를 영구 정상 경로 예외로 확대하지 않음 |
| 내용 있는 비영속 ephemeral | 디스크 resume 자료가 없으면 server 교체 시 문맥 소실 가능 | 안전한 export/이관 기능 구현, 또는 해당 대화를 영속화. 둘 다 미지원이면 이 대화에 한정한 전환 보류를 사용자와 합의해야 함 |
| mobile client가 재연결을 지원하지 않음 | server restart로 SSH/stdio가 끊기면 사용자가 다시 접속해야 할 수 있음 | stable transport adapter 구현. 이를 피하려면 자동 재연결/1회 재접속 허용으로 요구 변경 필요 |
| 업데이트 임계구간의 동시 입력 | 모든 순간 무지연 응답과 안전한 stop/start를 동시에 보장하기 어려움 | 수초의 입력 hold/자동 reconnect를 허용하고 유실·중복은 금지 |
| 비가역 CODEX_HOME DB migration | 후보 시작 뒤 구버전 rollback 불가 가능 | 지원 pair를 제한하거나 검증된 migration backup/restore. 자동 downgrade 금지 |
| 실제 작업이 계속 이어짐 | 안전 보류 요구상 정해진 시간에 강제 적용할 수 없음 | 다음 idle을 기다림. 유지보수 창 강제 중단은 별도 요구 변경이며 기본 구현에 넣지 않음 |

현재 핵심 요구인 ‘열린 연결만으로 차단하지 않고 실제 작업이 없으면 자동 교체 후 다음 요청 정상 처리’ 자체가 불가능하다는 증거는 없다. 다만 모든 과거/미래 버전·임의 외부 client·메모리 전용 상태까지 투명 교체하는 무제한 보장은 하지 않는다.

## 7. HAOS VM 필요성 및 시험 지시

이번 직접 원인은 Linux process/protocol 층에서 재현·해소됐다. 현재 제품 교체 구현도 없으므로 이번 Reviewer 단계에서 HAOS VM을 설치하지 않았다. VM 설치로 전송 규약 오류를 해결할 수는 없다.

단계 1~5 통과 뒤에는 사용자가 허용한 격리 HAOS VM 설치·테스트 범위에서 실행한다. 기존 개발 지침의 VM 설치 스크립트/방법을 먼저 찾고 프로젝트 전용 VM·disk·NAT를 사용한다. 운영 HA나 다른 VM/network를 변경하지 않는다. 정확한 HAOS/Core/Supervisor/App source·image digest를 기록한다.

VM 수용: 실제 AppArmor 활성 상태, Ingress TUI idle 열린 대화의 backend 변경, SSH Remote bootstrap 실제 wire, 응답/tool/approval/queue 중 보류, 작업 해소 후 자동 적용, 같은 대화 후속 요청, App restart 후 auth/SSH/browser/memory 보존. 스케줄 시험 시간을 조정하면 테스트 전용 구성과 실제 기본 스케줄 시험을 구분한다. mobile 물리 client 시험과 ARM 실기는 VM amd64 PASS로 대체하지 않는다.

## 8. Reviewer 검증과 보고 요구

- 공식 0.165.0 proxy→Unix WebSocket Upgrade/initialize: PASS. 시험 서버 SIGHUP exit 0: PASS.
- 이 결과는 live worker 교체·thread 복원·후속 모델 응답 시험이 아니다. baseline/후보 pair, TUI/mobile, HAOS VM은 NOT RUN.
- 현재 pending gauge 회귀를 Reviewer가 다시 실행한 결과와 Markdown/diff 검사는 progress에 기록한다.
- 다음 `FIX_01_REPORT.md`에 변경 파일, 정확한 명령·버전·digest, 단계별 결과, 지원/미지원 표, 계획 조정, 사용자 결정이 필요한 제약을 기록한다. 프로토콜 초기화 성공만으로 전체 완료라고 보고하지 않는다.
