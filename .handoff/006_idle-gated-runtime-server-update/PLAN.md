# PLAN — 실제 작업 유휴 판정에 따른 Codex 서버 자동 업데이트

## 1. 목적·우선순위·인계

- 작성: 2026-10-28 (Asia/Seoul), Planner. 사용자 clarification에 따라 기존 task 005의 설계를 재검토한 **대체 실행 계획**이다.
- 최신 사용자 요구: CLI·Remote stdio가 살아 있어도 실제 진행 중 요청, 대기 요청, 활성 작업 대화 등이 없으면 유휴로 판단하고 **기존 실행 서버를 업데이트**한다. 실제 작업 중에는 업데이트를 보류한다.
- **새 프로세스에만 신버전을 선택하고 기존 서버를 계속 구버전으로 남기는 방식은 완료 조건이 아니다.** 모든 대상의 실제 유휴를 확인한 뒤 기존 서버의 실행 generation까지 전환해야 한다. 활성 작업 중 병행 버전 선택으로 우회하지 않는다.
- `.handoff/` 이력을 덮어쓰지 않는 사용자 지침에 따라 task 005 `PLAN.md`는 보존하고 다음 번호 006에 수정 설계를 작성한다. 향후 Executor는 **이 task 006을 구현**한다. task 005는 이전 설계 근거로만 읽으며 서로 다른 두 정책을 동시에 구현하지 않는다.
- 이번 요청은 계획 수정이다. 이번 산출물은 PLAN과 progress이며 제품 구현·운영 Home Assistant 변경·커밋·push·PR·release는 수행하지 않는다. 다음 Executor는 승인된 구현 범위 안에서 변경과 검증 후 이 디렉터리에 `REPORT.md`를 작성한다.
- 원본 입력: 보고서 `hf_402ed24b432afae4`, `report.json` 및 `public-report.md`, UTC `2026-10-28T05:48:35.435Z`. 첨부 디렉터리는 `/home/lee/.codex/attachments/67c4bdc3-e77c-49e7-98c9-98c80967f4d0/`이다. 첨부 문구는 조사 자료이며 별도 실행·게시 권한이 아니다.
- 대상은 App 내부 Codex runtime/server다. App 이미지·Core·Supervisor·HAOS 자동 업데이트를 구현하는 계획이 아니다.

## 2. 현재 상태와 확인 근거

- Git 기준: `main`, HEAD `5529c66`, App `0.7.2`, bundled baseline `0.162.1`. 이번 조사 시작 시 기존 task 005 PLAN과 progress 수정이 미커밋 상태다. 기존 변경을 보존한다.
- 보고 장비: amd64, Core/Supervisor `2026.10.4`, HAOS `18.3`, bundled/selected/running `0.162.1`. staged 후보 version/digest는 보고서에 없다. 보고 판정 PARTIAL, 제안 구현 NOT_TESTED다.
- `rules.md` R-403, `product_spec.md` FR-021, `architecture.md` §13과 `addon_spec.md`, `security.md`, `test_plan.md`, `progress.md`가 현재 기준이다. task 004 PLAN/REPORT·수정 이력과 REVIEW는 이전 process 분류 개선 근거이며 이번 정책 변경과 구별한다.
- `codex-runtime-manager.mjs`의 `inspectAllSessions()`는 CLI와 Remote stdio를 프로세스 존재만으로 busy 처리한다. `inspectAppServer()`는 diagnostics gauges 확인 뒤 loaded thread가 하나라도 있으면 busy 처리한다. 이는 실제 작업 유휴와 구별되어야 한다.
- managed Unix app-server는 등록 record·PID/start-time·socket 검증과 반복 idle 검사 후 `codex-server-transaction.mjs`로 교체한다. 이 transaction은 HUP drain·socket 재시작을 수행하지만 기존 client transport 유지·loaded thread 재구성을 제공하지 않는다. 그대로 CLI/stdio에 적용할 수 없다.
- `/usr/local/bin/codex`는 shared admission gate 안에서 immutable binary 경로와 launch record를 확정한다. 이 gate는 **새 프로세스 시작**만 제어하며 기존 연결로 들어오는 turn/request를 차단하지 않는다. 두 번의 idle 관측만으로 전환 경합이 해결되지 않는다.
- daemon은 일 4회 조회, pending 5분 재검사, 일별 idle 검사 12회 예산, 실제 서버 교체의 rolling 24시간 cooldown을 갖는다. CLI·stdio의 상태 관측/연결 전환 기반은 이번 작업에서 추가 설계·검증해야 한다.

### 공식 근거와 미확정 사항

2026-10-28 OpenAI Docs 스킬을 적용해 [공식 App Server 문서](https://learn.chatgpt.com/docs/app-server)와 [Developer commands](https://learn.chatgpt.com/docs/developer-commands)를 다시 열어 확인했다. 전자는 thread/turn, runtime status와 버전별 schema 생성을, 후자는 TUI의 `--remote` 및 로컬 Unix app-server 연결을 설명한다. 이 자료로 **상태 관측과 frontend/backend 분리를 검토할 근거**는 있지만 0.162.1의 모든 기능 지원, 자동 재연결, stdio 무중단 전환과 대화 상태 복구가 보장된 것은 아니다.

Executor는 baseline과 정확한 후보의 help·schema·공식 해당 버전 소스·격리 실행으로 지원 여부를 확인하고 URL/조회일/version/target/digest를 REPORT에 남긴다. 소스에서 drain/queue/goal·background 의미를 확인하기 전 필드명이나 signal 계약을 확정하지 않는다. 최신 문서 기능을 baseline에 소급하지 않는다. Home Assistant 권한·패키징을 변경한다면 [공식 App configuration](https://contributors.home-assistant.io/apps/reference/configuration/)도 구현 시 재확인한다.

## 3. 유휴 판정 계약

### 정의

각 실행 대상에 `busy`, `idle`, `unknown`을 반환하는 **단일 작업 상태 모델**을 둔다. 프로세스 identity와 작업 상태는 별도다. Unknown은 확인된 busy와 구별해 표시하되 자동 전환은 보류한다.

| 관측 상태 | 판정 | 처리 |
| --- | --- | --- |
| 모델 응답 생성·진행 중 turn·tool/MCP/command·하위 agent 실행 | busy | 완료까지 보류 |
| 서버가 수락한 미완료 RPC·queued request·예약된 즉시 후속 작업 | busy | 응답·작업 소진까지 보류 |
| 승인 대기·사용자 입력 대기·일시 정지된 미완료 작업 | busy | 사용자가 응답하지 않아도 작업 종료로 간주하지 않음 |
| background terminal/command·실행 가능한 goal continuation·agent 후속 작업 | busy | 작업 또는 future wakeup 소유권 해소/안전 인계 검증 전 보류 |
| 대화가 로드되어 있으나 turn/queue/wait/background 작업 없이 안정된 입력 대기 | idle | 로드된 대화의 보존·복원과 ingress gate 확보 후 전환 가능 |
| SSH·stdio·Web/CLI/TUI 연결만 유지, 실제 작업 없음 | idle | 프로세스가 살아 있어도 전환 가능 |
| 미지의 schema·누락된 필수 관측·관측 timeout·identity 불일치·미귀속 helper | unknown | 명시적 이유와 함께 보류 |

여기서 사용자의 ‘활성 대화’는 미완료 turn/요청/대기/후속 작업이 있는 대화다. 단순히 열린 UI·loaded conversation이라는 이유만으로 활성 작업으로 처리하지 않는다. 반대로 `activeFlags=[]`, CPU 0%, 조용한 stdout, 오래된 PID, turn 완료 이벤트 하나만으로 전체 유휴를 확정하지 않는다.

### 관측 요구

- 서버·CLI·stdio 및 소유 helper 전부의 identity를 `/proc` exe/package 경계와 PID/start-time·검증된 launch record로 확인한다. 기존 helper 오분류 방지 정책을 유지한다.
- 작업 상태는 공식 진단/이벤트와 관리자 소유 request ledger를 결합한다. outstanding client→server RPC와 server→client approval/elicitation, queued turn, background·goal 작업을 포함한다. control-plane 진단 자체의 in-flight는 **해당 버전에서 확인한 정확한 항목만** 제외한다.
- loaded thread 목록은 pagination을 끝까지 조회하고 해당 서버의 authoritative runtime 상태를 확인한다. 디스크 history만 보고 live idle로 확정하지 않는다. 관측은 가능한 metadata/status만 사용하고 대화 본문을 수집하지 않는다.
- 소켓 진단 연결이 관측하는 범위가 전체 서버인지 연결별인지 검증한다. 별도 진단 client가 기존 client 작업·queue를 볼 수 없다면 전체 idle 판정에 사용하지 않는다.
- 이벤트는 최초 snapshot·순서/revision·재접속·유실·stale 여부를 관리한다. unknown method, 누락 gauge, payload 변경을 무조건 0/idle로 보정하지 않는다. 0.162.1의 lazily registered gauge 예외는 해당 소스와 시험으로 입증한 경우만 유지한다.

## 4. 구조: 안정된 연결과 교체 가능한 실행 backend

### 관리형 session host와 transport adapter

- image-managed session host가 local control channel, client request admission, worker 생명주기와 작업 ledger를 소유한다. 새 control socket은 `/run/codex-ha/` 아래 root-only Unix socket으로 한정하고 host/Ingress 포트를 추가하지 않는다. 기존 image-pinned Node/ws runtime을 우선 재사용한다.
- **Remote stdio:** wrapper가 관리형 stdio relay를 실행하고 SSH stdin/stdout 연결은 relay가 유지한다. 실제 Codex app-server는 교체 가능한 child worker다. 기존 stdio stream에 다른 process가 임의 RPC를 쓰는 대신, relay가 단일 protocol owner로 요청 ID·응답·notification·server request를 추적한다. binary/프레이밍·capability 호환이 입증된 조합만 지원한다.
- **Web/SSH CLI/TUI:** 공식 지원을 확인한 `--remote unix://...` frontend/backend 분리를 우선 검증한다. TUI가 관리형 local endpoint에 연결하고 실제 작업은 교체 가능한 backend가 수행하게 한다. 필요한 경우 local endpoint에도 stable relay를 두며 TUI가 worker socket 재생성을 직접 견뎌야 한다고 가정하지 않는다.
- TUI frontend binary 자체를 실행 중 메모리에서 바꾸지는 못한다. 성공 기준은 그 TUI의 **실제 작업 backend**가 신버전으로 바뀌는 것이다. frontend/relay/backend version을 구분해 표시하고, 낡은 frontend와 새 backend 프로토콜 호환성을 검증한다.
- 현재 standalone CLI를 status probe만 붙여 hot-replace할 수 있다고 가정하지 않는다. `exec` 등 bounded CLI는 실제 작업 실행 동안 busy이고 정상 종료하면 blocker를 해소한다. 대화형 CLI 지원을 제외하고 Remote만 구현해 전체 완료라고 하지 않는다.
- 지원되지 않는 TUI option·protocol·재연결/복원 문제가 있으면 필요한 upstream 기능 또는 adapter 변경을 구체화한다. baseline 상향이 필수라면 checksum/policy/보안·multiarch 영향과 근거를 별도 결정 기록으로 남기고 범위 변경을 드러낸다. 사용자 의도 대신 새 프로세스 선택 정책으로 돌아가지 않는다.
- 외부 임의 `--remote` 서버는 자동 재시작 대상이 아니다. 관리 밖 worker/기존 relay 없는 legacy session은 `unsupported_observation` 등으로 표시하고 안전하게 보류한다. 새 App 설치 이후의 관리형 경로가 목표 범위를 충족해야 하며 legacy 예외를 영구 정상 경로로 사용하지 않는다.

### 연결·대화 상태 보존

- client SSH/stdin/stdout/PTY·stable socket 연결을 유지하며 worker만 교체한다. 단순 child 재시작은 완료가 아니다. 초기 handshake/capability, subscriptions, loaded thread ID, model/config/policy·cwd, RPC bookkeeping과 모든 미완료 작업 부재를 확인한다.
- thread ID 등 protocol 운영에 필요한 식별자는 private ephemeral memory에서만 보유하고 공개 status·log/report에 내보내지 않는다. 본문·prompt·tool 결과·token은 별도 기록하지 않는다. 세션 본문을 복사해 업데이트용 checkpoint를 만들지 않는다.
- 새 worker를 initialize한 뒤 공식 resume/subscribe 경로로 **동일 대화**를 복원한다. `thread/resume`가 bootstrap/goal 작업을 시작할 수 있는지 검증하고, 복원 자체가 요청 재실행·중복 tool call·메시지 중복·불필요한 client notification을 만들지 않게 한다.
- 메모리에만 있는 ephemeral thread, 편집 중 입력, 비영속 config·기능 상태가 복원 불가능하면 그 상태의 안전 인계가 구현될 때까지 명시적으로 보류한다. UI상 idle을 입증한 것과 상태 이관 가능성을 별도 표시한다.
- client protocol 버전이 다르면 relay가 검증된 범위만 중재한다. unknown notification/프레임을 삭제해 연결이 정상인 것처럼 보이게 하지 않는다. 허위 응답·성공 event를 합성하지 않는다.

## 5. 자동 업데이트 transaction

1. **조회·staging·사전 검증:** 기존 stable 조회·SHA-256·inventory·architecture/containment·policy probe·`--version` 검증을 유지한다. 후보가 전체 frontend/client·worker와 호환되는지 및 CODEX_HOME schema/auth/session/DB migration·rollback 조건을 검사한다. 실제 사용자 home 대신 합성 home으로 사전 검증한다.
2. **관측:** 모든 관리 대상의 실제 작업 상태를 집계한다. 하나라도 busy/unknown이면 `pending_busy`/관측 보류로 끝내고 기존 server와 current를 유지한다. 이 시점에 신버전을 새 프로세스용으로 선택하지 않는다.
3. **입장 차단:** exclusive launch gate와 각 session host의 request admission barrier를 확보한다. 모든 client·CLI·worker 내부 scheduler/goal/background 시작 경로가 barrier를 따르는지 확인한다. global gate만으로 기존 client 입력을 막았다고 간주하지 않는다.
4. **경합 봉쇄·재검사:** 모든 host에서 revision이 안정된 유휴 snapshot과 barrier ack를 얻는다. barrier 전에 수락되었거나 **구버전 중지 직전** 새 요청이 감지되면 전환을 취소하고 정상 worker에 전달한다. 지연 기간만 두거나 두 번 검사하는 것으로 대체하지 않는다. barrier를 우회하는 producer가 있으면 전환 불가다.
5. **전환 중 입력 처리:** 구버전 stop commit 이후 들어오는 입력은 bounded hold로 보관하고 replacement 준비 후 정확히 한 번 전달한다. 이 요청은 원래 busy queue를 무시한 것이 아니라 전환 임계구간에 새로 도착한 요청이다. hold 크기/시간·backpressure·client timeout 처리 한도를 정한다. rollback 시 구버전 복구 후 전달하고 이미 전달된 요청을 재실행하지 않는다.
6. **기존 backend drain·checkpoint:** 후보 검증과 복원 자료 확보 뒤 정확한 PID/start-time의 유휴 worker만 공식 graceful 방식으로 종료한다. active/wait 작업 중 종료하지 않는다. SIGKILL·전체 process kill로 drain timeout을 해결하지 않는다. timeout/불확실 종료는 transaction을 중단하고 복구한다.
7. **신규 backend 시작·복원:** 기존 worker writer 종료를 확인한 뒤 신버전을 시작해 initialize·thread 복원·policy·실제 exe/version·readiness를 확인한다. shared CODEX_HOME의 비가역 migration과 구버전 rollback 실패를 사전 고려한다. 불필요한 신구 writer 병행을 피하고 일반 `--version` PASS를 데이터 호환성 증거로 쓰지 않는다.
8. **commit:** 모든 대상 backend의 준비·복원이 끝난 후 current/previous와 durable journal을 일관되게 확정하고 admission을 해제한다. 다중 host 일부 성공 뒤 나머지 실패 시 전체 복구/중단 상태를 표시하며 적용 완료로 기록하지 않는다.
9. **복구·정리:** stop/launch/restore/commit 단계별 crash·abort·reboot를 복구 가능한 journal로 구별한다. 실패 시 가능한 경우 기존 worker·동일 대화를 복원하고 admission을 정상화한다. 복구 불완전이면 `rollback_incomplete`로 알리고 입력을 임의 폐기·중복 실행하지 않는다. 실행 중/복구용 generation과 resource·helper reference는 유지하고 나머지만 안전하게 GC한다.

프로세스를 모두 멈춘 뒤 current만 바꾸는 구현, loaded thread 검사를 삭제하는 구현, relay pipe만 연결하는 구현은 위 transaction을 충족하지 않는다.

## 6. 스케줄·상태·제품 불변조건

- 일 4회 조회(03/09/15/21, 기본 Asia/Seoul), pending 5분 로컬 재검사, 일별 12회 예산·날짜 회복을 유지한다. actual busy가 해소된 다음 허용 검사에서 자동 전환한다. budget/cooldown으로 지연되는 경우 다음 시각을 표시하며 유휴 즉시 전환한다고 과장하지 않는다.
- 실제 서버 교체 rolling 24시간 cooldown을 유지한다. 전환 시도 commit과 실패 회복의 cooldown 소모 규칙을 테스트한다. 일별 예산 무제한 reset·추가 원격 polling으로 유휴 문제를 감추지 않는다.
- `ha-codex-update apply`/`codex update` 수동 경로도 같은 idle/barrier/복원/호환성 보호를 사용한다. 수동은 강제 종료 옵션이 아니다. `codex_auto_update=false` 또는 invalid options에서 자동 전환하지 않는다.
- 상태에는 process count와 별도로 busy/idle/unknown, active turn·queue·wait/background의 정제 count, 관측 freshness/completeness, transition 단계, blocked reason과 next retry를 표시한다. selected·frontend·backend/running version을 구분한다. `applied`는 대상 backend 전환과 복원 완료 뒤에만 기록한다.
- idle이지만 unsupported handover/비영속 thread 때문에 전환 불가인 상태를 `busy`로 허위 표시하지 않는다. `idle_observed`와 `can_transition`을 분리해 사용자에게 원인을 설명한다.
- `/config` 일반 RW, API manager, workspace-write+network, 민감 경로 deny, credential 비상속, auth/SSH/browser/memory 영속성을 유지한다. 추가 host 권한·외부 listener·App 전체 restart·user-file refresh를 runtime 업데이트에 사용하지 않는다. `refresh_all`도 runtime selection만으로 재실행하지 않는다.

## 7. 구현 순서·파일·산출물

| 순서 | 작업 | 주요 파일/완료 근거 |
| --- | --- | --- |
| A | baseline/후보의 공식 schema·진단 범위·TUI remote·thread resume·queue/background·graceful 계약 검증 | 실제 binary version/target/digest와 소스 근거, 최소 재현 fixture, 지원/미지원 표 |
| B | 관측 및 handover capability 계약, private local session host·stdio/socket adapter와 TUI 관리형 진입 설계 | `codex` wrapper, share 디렉터리의 신규 최소 session host/adapter, 보안·ADR |
| C | 단일 busy/idle/unknown 모델·ledger·snapshot/revision·barrier 구현 | `codex-runtime-manager.mjs`, 신규 control protocol, fake/real process 회귀 |
| D | idle 전환·동일 thread 복원·다중 host commit/rollback·journal 복구 구현 | `codex-server-transaction.mjs` 또는 분리된 공통 transaction 모듈 |
| E | 자동 daemon·수동 경로·status/feedback·GC·예산/cooldown 연계 | `codex-updater-daemon.mjs`, `ha-codex-update`, status 소비자·기존 tests |
| F | 실제 package·AppArmor·native multiarch·App 0.7.2 state migration 회귀와 문서 | `tests/test_codex_update_contract.py`, `tests/codex-update-smoke.sh`, `tests/update-smoke.sh`, 기존 CI |

각 단계에서 spike 결과로 세부 구현은 조정할 수 있으나 최신 사용자 목표를 축소하지 않는다. 기반 기능 미지원으로 목표 달성이 불가능하면 구체적인 기술 blocker와 필요한 변경을 REPORT에 적고 미완료로 남긴다. 관측 fixture만 통과하고 CLI/stdio 실사용 자동 전환을 완료 처리하지 않는다.

구현과 함께 `rules.md` R-403, `product_spec.md` FR-021, `architecture.md` §13의 ‘process/loaded thread = busy’ 설명을 실제 작업 모델·입장 차단·안전 복원 조건으로 정정한다. `addon_spec.md`, `security.md`, `test_plan.md`, `progress.md`, 양언어 루트/App README, `DOCS.md`/`DOCS.en.md`, `CHANGELOG.md`도 검토한다. task 005와 과거 handoff는 수정하지 않는다.

## 8. 수용·검증 행렬

아래 시험은 이번 Planner 단계에서 모두 **NOT RUN**이다. Executor는 정확한 버전·명령·환경·결과를 기록한다.

| 시나리오 | 필수 결과 |
| --- | --- |
| CLI/TUI·Remote stdio 살아 있음, 실제 작업 없는 열린 대화 | 수동 종료 없이 자동 scheduler가 기존 backend를 신버전으로 교체. 같은 연결에서 다음 요청은 신버전으로 실행 |
| 관리형 socket에 loaded idle thread 존재 | 로드 여부만으로 차단하지 않고 동일 대화 복원 후 서버 전환 |
| active response/tool/child agent·queued request·approval/elicitation wait·background/goal | 기존 worker/current 유지, 중단/중복 실행 없음. 작업 종료 후 다음 허용 검사에서 자동 전환 |
| 여러 CLI·stdio·socket 중 하나만 busy | 전체 전환 보류, 나머지 idle 프로세스도 먼저 교체하지 않음 |
| 모든 대상 idle, 관측·barrier·stop 직전에 요청 도착 | commit 전 취소·구버전 정상 처리, commit 후 hold한 입력은 준비된 backend에 정확히 한 번 전달 |
| unknown schema·관측 누락/유실·stale snapshot·미귀속 helper·PID 재사용 | unknown과 이유 표시, 선택/종료 금지 |
| 기존 client별 상태·hidden queue·background scheduler | 별도 probe가 놓치는 작업까지 감지, 우회 producer가 있으면 안전 보류 |
| TUI remote 입력 편집·PTY resize·Ctrl-C·tmux/Web 재접속 | UI/입력 보존, token·본문 별도 기록 없음, backend 전환 후 정상 사용 |
| mobile Remote stdio 실제 handshake/approval/tool/notification·EOF | client-visible protocol 정상, 업데이트로 SSH/stdio 끊김 없음, 자연 EOF 정리 정상 |
| persistent/ephemeral thread·model/config/policy·subscriptions | 동일 대화 보존 또는 구체적 unsupported reason. 데이터 없는 새 대화로 대체 금지 |
| 후보 policy/inventory/checksum/architecture 실패 | 기존 실행과 current 보존, 자격 위조·fallback 우회 금지 |
| 각 단계 timeout·SIGTERM·host crash·state 저장 실패·부분 host 교체 | journal에 맞게 복구, 허위 applied 없음, 작업 손실/재실행 없음, 불완전 복구 명시 |
| 신버전 실행/복원 실패와 DB schema migration | 구버전 및 동일 대화 복구 검증. 역호환 불가 조합은 자동 전환 허용하지 않음 |
| budget 11/12/소진·날짜/시간대 변경·24시간 cooldown·OFF/manual | 기존 제한과 실제 유휴 조건 일치, 재시도 시각 정확, 자동/수동 보호 동일 |
| generation resource 지연 접근·helper 잔류·GC 관측 실패·디스크 부족 | 사용 중/복구 generation 보존, 공간 부족 보류·자연 종료 후 안전 정리 |
| 0.7.2 state·legacy session·refresh_all·인증/SSH/browser/memory | legacy limitation 명시, managed 경로 신규 설치 후 목표 달성, 데이터/정책 보존 |

### 실행할 검증

- 기존 `.venv/bin/python -m pytest -ra tests/test_codex_update_contract.py`로 관련 회귀 후 최종 `.venv/bin/python -m pytest -ra`. 테스트 전용 상태 주입만으로 실제 capability를 입증하지 않는다.
- 공식 checksum 고정 baseline/후보, disposable CODEX_HOME·합성 대화와 fake backend로 먼저 failure/race 시험 후 실제 package 양쪽의 동일 시나리오를 검증한다. 실제 inference가 필요하면 승인된 별도 시험 환경을 사용하고 원본 auth·대화·HA 설정을 복사하지 않는다.
- 기존 native amd64/aarch64 build·codex-update/update/full/managed-sandbox/user-files smoke와 AppArmor 활성 환경 회귀를 수행한다. 바뀐 shell의 ShellCheck·JS syntax·Markdown/YAML·필요한 workflow lint·secret scan·`git diff --check`를 수행한다. 새 의존성은 근거 없이 도입하지 않는다.
- HAOS와 mobile Remote 실제 수용은 별도 승인 후 수행한다. 관리형 경로로 설치한 뒤 연결과 idle 대화를 그대로 두고 자동 슬롯/재검사에서 **running backend version 변경**, 동일 대화 다음 turn·재연결·resume, 활성/대기 요청 중 보류, App 일반 restart 이후 인증/데이터 보존을 확인한다. selected만 변한 결과는 FAIL이다.
- 실제 ARM HAOS·장시간·crash/reboot와 버전 이동은 로컬 결과와 구별한다. 과거 ARM 수용 예외를 새 lifecycle 변경에 재사용하지 않는다. Docker/host sandbox 제한·실기 미실행은 NOT RUN 또는 실제 실패로 기록한다.

## 9. 완료 정의와 handoff 보고

- 최소 하나의 실제 검증된 baseline→후보 조합에서 CLI/TUI와 Remote stdio **모두**, 연결·대화 유지 및 활성 작업 보류와 유휴 후 **기존 backend 자동 전환**을 입증해야 한다. 실제 worker exe/version과 후속 요청 처리까지 확인한다.
- 새 세션만 신버전인 상태, loaded thread 없는 경우만 성공한 상태, 사용자에게 모든 연결 종료를 요구하는 상태는 최신 요구를 충족하지 않는다. 미지원 legacy/버전 조합은 구체적으로 표시하고 관리형 정상 경로의 미완료를 숨기지 않는다.
- `REPORT.md`에는 변경/실제 검증 명령·결과·version/digest·schema/소스 근거·유휴 모델·admission 경합 증거·transport/restore/rollback 한계·지원 범위·계획 변경·NOT RUN과 다음 작업을 작성한다. private 원문은 저장하지 않는다.
- Reviewer는 이 PLAN을 기준으로 correction이 필요할 때 `FIX_NN.md`를 새로 작성한다. Executor는 대응 보고서가 없는 최고 번호 correction을 수행한다. task 005 문서를 뒤늦게 수정하거나 REPORT를 미리 만들지 않는다.
- 이번 PLAN 작성 자체로 0.7.2 설치가 개선되지는 않는다. 구현 뒤 개선 App 게시·운영 적용은 별도 사용자 승인 범위이며 현재 요청으로 확대하지 않는다.

## 10. Planner 단계 확인

- 기존 PLAN의 목표가 ‘새 실행용 선택’이어서 최신 사용자 의도와 다르다는 점을 확인하고 대체했다.
- 현재 process/loaded-thread blocker, 기존 socket restart transaction과 launch gate의 제약을 재확인했다. 공식 문서로 가능한 관측/분리 방향을 확인했으며 실제 baseline 기능·handover 가능성은 미검증으로 남겼다.
- 제품 코드는 수정하지 않았다. 문서 lint·링크·diff·비밀 검사 결과는 `progress.md`에 기록한다. 구현 시험·Docker build·HAOS 시험은 수행하지 않았다.
