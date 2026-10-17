# PLAN — 지속 helper·Remote 서버에 의한 런타임 업데이트 보류 개선

## 1. 목적과 인계 범위

- 작성: 2026-10-17 (Asia/Seoul), 역할: Planner.
- 입력: 사용자 제공 진단 `hf_ac764d25d7a492e5` (생성 UTC 2026-10-16T22:08:19.584Z, 전체 PARTIAL, privacy PASS).
- 목표: persistent helper를 독립 사용자 작업으로 오인하지 않도록 프로세스 분류를 고치고, 안전하게 교체할 수 있는 관리형 app-server의 업데이트를 진행하며, 실제 Remote 연결 때문에 보류되는 경우 이유와 해소 조건을 정확하게 제공한다.
- 이번 작업은 소스 조사와 계획 작성까지다. 제품 구현·버전 변경·프로세스 종료·런타임 업데이트·HA 변경·commit/push/PR/release는 수행하지 않는다. 이 계획은 외부 발행이나 실제 HA 변경 승인이 아니다.
- 후속 Executor는 현재 Git과 지침을 다시 확인하고 아래 단계의 구현·로컬 검증 후 같은 디렉터리에 `REPORT.md`를 새로 작성한다. Remote stdio 무중단 교체는 검증 관문이 있는 별도 단계이며, 근거 없이 구현 완료로 간주하지 않는다. 기존 handoff 문서와 이 PLAN은 덮어쓰지 않는다.

## 2. 기준 상태와 먼저 읽을 자료

- 저장소: `/home/lee/projects/codex_for_HA`, branch `main`, HEAD `11b883996b9bc1694640b25fcc7f24b192973b71`.
- 시작 당시 tracked 변경은 `docs/development/progress.md`의 2026-10-15 정리 기록과 기준일 변경이다. 사용자 기존 변경으로 보존한다. Planner는 여기에 이번 계획 기록만 추가한다.
- 현재 배포 기준: App `0.7.1`, bundled Codex `0.162.1`, amd64/aarch64 musl. 보고서의 staged `0.163.0`은 해당 관측 시점의 후보이며 다음 실행의 최신 버전으로 고정하지 않는다.
- 입력 환경: Core `2026.10.1`, Supervisor `2026.10.2`, HAOS `18.3`, amd64. 해당 장비에 재접속하거나 상태를 재측정하지 않았다.
- 루트 및 적용 디렉터리의 `AGENTS.md`/`GEMINI.md`, `docs/development/rules.md` → `progress.md` → 관련 `product_spec.md`, `architecture.md`, `addon_spec.md`, `security.md`, `test_plan.md` 순으로 확인한다.
- `.handoff/002_codex-auto-update/PLAN.md`와 관련 fix/report의 idle 12회·rolling 24시간 cooldown·Remote stdio 보호 결정을 참고하되 실제 코드와 최신 지침을 기준으로 삼는다. `003_s6-startup-permission-denied`의 종료·시작 회귀도 보존한다. 과거 승인된 DEV 발행 범위를 이번 작업에 승계하지 않는다.

## 3. 문제 현황과 증거 수준

| 항목 | 판단 | 근거와 한계 |
| --- | --- | --- |
| 후보가 적용되지 않음 | 사용자 보고 사실 | running 0.162.1 / staged 0.163.0 / autoUpdate true / paused_busy / 12회 소진. 로컬에서 해당 실환경 상태를 재확인하지 않음 |
| helper가 CLI로 집계될 가능성 | 소스 동작 확인, 실환경 기여 미확정 | `inspectAllSessions()`가 executable 외 전체 argv 문자열의 `/bin/codex`, `codex-real`, `app-server`, runtime 경로도 매칭하고 app-server가 아니면 CLI busy 처리 |
| Remote stdio가 업데이트를 막음 | 소스 동작 확인 | Unix socket을 찾지 못하면 무조건 `active remote stdio app-server`로 보류. 해당 Remote가 stale인지, 실제 turn이 있었는지는 미확정 |
| 관리형 서버 자체가 항상 업데이트를 막음 | 성립하지 않음 | 검증된 launch record + Unix socket + 두 번의 idle 진단을 통과한 서버는 restartable. 다른 busy reason이 없고 cooldown이 끝나면 `applyUpdate()`가 교체 가능 |
| loaded conversation | 의도된 보수적 제한 | `inspectAppServer()`는 `thread/loaded/list`가 비어 있지 않으면 busy. 단순 loaded 수와 active turn 수는 다르지만 현재 계약이 이 상태도 보호함 |
| 프로세스 수가 대화 수로 해석됨 | 표현 개선 필요 | `activeSessions`는 프로세스 기반 `sessionCount`이며 등록 CLI가 registry와 process scan에서 중복 집계될 수도 있음. 관리형 idle 서버도 이 수에 포함됨 |
| 12회 소진 이후 보류 | 정책상 증폭 요인 | daemon은 `paused_busy`에서 빠른 재검사를 멈추고 날짜 전환 시 예산을 회복. 12회는 대화 수·평생 시도 제한이 아님 |

현재 증거는 “모든 설치가 영구 차단된다”거나 “실제 원인은 helper 하나다”라는 결론을 지지하지 않는다. 특히 별도 Remote stdio 하나만 살아 있어도 helper 오분류를 수정한 후 계속 보류될 수 있다. 이를 수정 실패나 자동 적용 성공으로 오보고하지 않는다.

### 공식 자료 확인

2026-10-17 [공식 Codex App Server 문서](https://learn.chatgpt.com/docs/app-server)를 열어 확인했다. 문서는 stdio와 Unix socket transport, thread/turn의 구분, thread runtime status, 실행 버전에 맞춘 schema 생성을 설명한다. 이 문서만으로 기존 SSH stdio 연결의 프로세스 교체·재연결 보장이나 `0.162.1`의 모든 진단 필드 지원을 입증할 수는 없다. 세부 API와 graceful signal은 실제 baseline/후보의 schema·공식 해당 버전 소스·격리 실행으로 검증한다. 본문·대화 history를 수집할 필요는 없다.

## 4. 설계 결정과 보호 조건

1. **프로세스 정체성과 사용자 작업을 구분한다.** helper라고 해서 일괄 무시하지 않고 검증된 executable/package 내 역할과 소유 관계를 확인한다. argv에 문자열이 등장했다는 이유만으로 독립 Codex 대화나 CLI로 확정하지 않는다.
2. **실제 CLI/TUI와 Remote stdio는 계속 보호한다.** CPU 0%, 오래된 start-time, SSH client UI가 닫혔다는 추정, helper의 존재만으로 idle/stale 판정을 내리지 않는다. 검증 불가 프로세스는 별도 unknown blocker로 보류한다.
3. **검증된 idle managed Unix app-server의 기존 교체 transaction을 사용한다.** process identity·launch record·후보 검증·signal 직전 재검사·graceful drain·실제 executable 확인·rollback을 우회하지 않는다.
4. **loaded conversation을 이번 수정에서 일괄 idle로 풀지 않는다.** active turn 부재만으로 background command, approval/user-input wait, queued work, goal/자동 후속 작업과 연결 상태까지 안전하다고 결론낼 수 없다. 이 정책 변경이 필요하면 추가 설계·회귀 근거를 별도로 제시한다.
5. **일별 12회, 5분 pending 재검사, 일 4회 네트워크 조회와 rolling 24시간 restart cooldown을 유지한다.** 자동 budget reset/무제한 polling/제한 해제로 문제를 숨기지 않는다. 수동 apply도 busy·integrity·policy·cooldown 보호를 우회하지 않는다.
6. `/config` 일반 RW, API manager, 보호 경로 deny, workspace-write+network, credential 비상속, package inventory·checksum·baseline 복구를 유지한다. 새 listener, App 전체 자동 restart, SIGKILL escalation, global process kill과 추가 권한을 도입하지 않는다.

## 5. 구현 순서

### A. 재현 fixture와 분류 규칙 확정

- 먼저 실패 fixture를 추가한다. 프로세스 관측 부분은 필요한 만큼 분리해 동일 분류 함수를 production과 fixture에서 사용한다. 현재 `CODEX_RUNTIME_DIR` 설정 시 다른 매칭 분기를 타므로 테스트 전용 분기만 통과하는 수정은 금지한다.
- 조사할 역할: 실제 Codex CLI/TUI/exec, managed Unix app-server, Remote stdio, `codex-code-mode-host` 및 package companion, Node/Python/셸 helper, updater 자체, wrapper/flock, argv에 Codex 경로가 데이터로 들어간 무관 프로세스.
- `/proc/<pid>/exe`의 실제 executable, canonical package 경계와 정확한 상대 경로, `(deleted)` 처리, PID+start-time, 등록 record의 유효성을 우선 사용한다. 필요 시 PPID/ancestor를 추가하되 PID 재사용과 관측 중 종료를 처리한다. 단순 prefix가 형제 경로까지 포함하지 않게 한다.
- 실제 baseline package에서 companion 이름·실행 형태를 확인하고 최소 allowlist를 정한다. 미지의 companion, 소유자 없는 helper는 독립 CLI라고 단정하지 말고 unknown으로 보류한다. 실제 프로세스 argv/environment 또는 대화 내용을 저장·출력하지 않는다.

### B. 세션 집계와 교체 가능성 수정

- PID+start-time 기준 inventory를 한 번 만들고 registry와 `/proc` 결과를 합쳐 중복을 제거한다. 종료된 PID·재사용 record 정리와 inspection 실패 시 fail closed를 유지한다.
- helper는 검증된 소유자에 종속시켜 독립 CLI/session 집계에서 제외한다. 소유자가 busy이면 전체도 busy다. 검증된 idle 관리형 서버의 상주 companion만 남아 있는 경우 독립 busy reason을 만들지 않는다.
- helper 제외는 release cleanup 제외가 아니다. 살아 있는 companion의 exe/fd/cwd/mmap/resource reference가 있는 generation은 계속 보존한다. 소유자 교체 뒤 helper가 남는 경우 실제 lifecycle을 확인하고 old package를 삭제하거나 무조건 종료하지 않는다. 귀속·유휴를 증명할 수 없는 경우 명시적으로 보류한다.
- `isIdle`(프로세스가 전혀 없는 유휴)과 `canApply`/동등한 판정(다른 blocker 없이 restartable만 있음)을 구분한다. helper 존재와 sessionCount 값만으로 적용 가능 여부를 결정하지 않는다. 기존 apply/restart 판정과 CLI 표시를 같은 분류 결과에 맞춘다.
- wrapper의 기록된 args와 runtime parser가 같은 subcommand/listen 구문을 이해하는지 확인한다. `--listen unix://...`, `--listen=unix://...`, 명시/기본 stdio와 옵션 값에 포함된 `app-server` 문자열을 구분한다. 옵션 값을 subcommand로 오인하지 않는다.

### C. 상태·진단·운영 안내 개선

- `ha-codex-update status --json`과 text status에 최소한 detected process, unique CLI/TUI, helper, managed restartable server, Remote stdio blocker, unknown blocker를 구분할 수 있는 정제된 요약을 제공한다. 필드명은 기존 소비자 조사 후 확정하며 기존 JSON key를 무조건 삭제하지 않는다.
- `activeSessions` 호환 필드를 유지한다면 의미를 문서화하고 text의 “Active sessions”를 대화 수로 읽히지 않도록 바꾼다. helper 개수·프로세스 개수로 대화 수를 추정하지 않는다. 재시작 가능한 idle 서버가 있는 상태도 정확히 설명한다.
- reason code와 정제된 count, `nextRetryAt`, budget 날짜/소진, `nextRestartAllowedAt`, `lastApplyAt`을 통해 “Remote 종료 대기”, “12회 소진”, “cooldown”, “진단 불가”를 구분한다. paused 이후에도 현재 blocker와 마지막 적용 시도의 reason을 혼동하지 않게 한다.
- 자동 적용은 모든 blocker가 해소되고 다음 허용 재검사 시점이 와야 가능하다고 안내한다. 수동 `ha-codex-update apply`는 즉시 재검사 경로이며 강제 종료 명령이 아니다. Remote는 사용자가 작업 저장 후 정상 연결을 종료하면 다음 실행에 새 버전을 사용할 수 있다고 설명하되 종료 자체를 성공 보장으로 표현하지 않는다.
- 출력에 full argv, cwd/project/socket 원문, 사용자 prompt·thread ID, 인증값을 새로 노출하지 않는다. 현재 내부 transaction에 필요한 launch record와 공개 status를 구분한다.

### D. Remote stdio 개선 가능성 검증과 후속 경계

- 1차 수정에서는 검증된 Remote stdio를 조용히 무시하거나 강제 교체하지 않는다. 현재 SSH transport를 updater가 다시 연결할 수 있다는 근거가 없다.
- 격리 환경에서 연결 생성·정상 종료·비정상 disconnect·서버 잔류·helper 잔류를 관측한다. EOF 뒤 실제 종료 동작과 parent/descriptor 관계를 확인하고, 단순 age/PPID만으로 stale임을 증명할 수 없음을 대조한다.
- 기존 transport를 방해하지 않는 진단 채널 또는 소유권을 검증할 방법이 해당 버전에 있는지 공식 version-specific 근거로 확인한다. 기존 stdin/stdout에 진단 요청을 끼워 넣지 않는다.
- 결과를 REPORT에 `지원 가능/지원 불가/미검증`과 근거로 남긴다. 안전한 연결 보존·활성 작업 보호·재연결·rollback을 모두 입증한 구체적 설계가 나오기 전에는 Remote proxy/relay나 대규모 lifecycle 변경을 이 버그 수정에 섞지 않는다. 필요 시 다음 번호의 별도 handoff 제안으로 남긴다.
- 따라서 1차 완료의 의미는 helper 오분류 해소와 보류 설명의 정확성이다. **장기 Remote stdio가 존재하는 모든 설치의 자동 적용까지 해결했다고 주장하지 않는다.**

## 6. 관련 파일

| 파일 | 작업 |
| --- | --- |
| `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs` | inspectProcess/inspectAllSessions, 분류·집계, apply eligibility, getStatus/text output |
| 같은 디렉터리 `codex-server-transaction.mjs` | 재시작 identity·pre-signal 검사·helper lifecycle 영향 검토, 필요 최소 수정 |
| 같은 디렉터리 `codex-updater-daemon.mjs` | 기존 budget·cooldown·슬롯 보존 및 reason 출력 검토 |
| `codex_home_assistant/rootfs/usr/local/bin/codex`, `ha-codex-update` | wrapper record/parser parity와 CLI 출력 소비 관계 |
| `tests/test_codex_update_contract.py`, `tests/codex-update-smoke.sh` | 분류·상태·재시작·cleanup 회귀와 실제 바이너리 격리 smoke |
| `docs/development/{rules,product_spec,architecture,addon_spec,security,test_plan,progress}.md` | 변경된 동작과 현재 보수적 loaded/Remote 제한을 일관되게 기록 |
| 루트 및 App의 한국어·영어 README, App `DOCS.md`/`DOCS.en.md`, `CHANGELOG.md` | 프로세스와 대화 구분, helper 처리, Remote 종료 대기, 예산/cooldown 설명 검토·필요 부분 갱신 |

신규 옵션·App/bundled Codex 버전 상승·baseline 변경은 기본 범위가 아니다. 배포 준비 요청이 있을 때만 버전·metadata 정책을 별도 적용한다.

## 7. 수용 기준과 검증 행렬

| 조건 | 기대 결과 |
| --- | --- |
| 무관 프로세스 argv에 `/bin/codex`, `app-server`, runtime 경로가 데이터로 존재 | Codex CLI/session으로 오분류하지 않음 |
| 실제 registered/unregistered CLI/TUI/exec 실행 중 | busy, symlink 변경·signal 없음 |
| CLI record와 `/proc`가 같은 PID+start | unique 1회 집계 |
| stale record, PID 재사용, 관측 중 정상 종료 | 살아 있는 다른 PID를 종료하지 않으며 정상 소멸과 검사 실패를 구분 |
| 검증된 관리형 idle 서버 + 상주 companion, 다른 blocker 없음 | helper가 독립 blocker가 되지 않음. cooldown 만료 시 실제 서버 교체·새 executable 확인 |
| 위 조건 + 실제 busy CLI 또는 Remote stdio | 적용 보류, 정확한 유형·reason 노출 |
| helper가 unknown/orphan이거나 신원 검사 실패 | 보수적 보류, CLI/대화로 단정하지 않음 |
| active turn/request/approval/input wait, queued work, loaded conversation | 기존 보호 지속, 교체 없음 |
| 진단 불량·PID/socket 불일치·접근 거부 | fail closed, signal 없음 |
| 최초 idle 관측 후 signal 직전 새 작업 유입 | 재검사/graceful drain으로 보호, 강제 종료 없음 |
| 후보 검증·신규 launch·readiness 실패 | 기존 rollback 증거 유지, incomplete recovery를 성공으로 기록하지 않음 |
| 12회 소진·같은 날 재진입·다음 날짜·24시간 cooldown | 기존 정책과 state persistence 유지, helper 수정으로 예산을 임의 해제하지 않음 |
| live old helper의 exe/fd/cwd/mmap/resource 참조 | old release 보존; 정리 기능이 작업을 훼손하지 않음 |
| 공개 JSON/text/log | count 의미 일치, secret/argv/prompt 원문 없음, selected/running/staged 구분 |

### 실행할 검사

1. 수정 전 실패 fixture와 수정 후 결과를 기록한다. production 분류 조건과 동일한 fixture 및 실제 subprocess를 함께 사용한다. 문자열 포함 여부만 검사하는 테스트로 끝내지 않는다.
2. `.venv/bin/pytest -q tests/test_codex_update_contract.py tests/test_runtime_contract.py`를 우선 실행한다. wrapper/security/문서 변경에 해당하는 기존 계약 테스트를 추가하고, 관련 검사가 통과하면 release 수준 작업 여부에 맞춰 전체 `.venv/bin/pytest -q`를 실행한다.
3. 변경된 Node 파일 `node --check`, 셸 변경 시 `bash -n`/ShellCheck, 문서 Markdown lint와 `git diff --check`, 변경 범위 secret scan을 수행한다. 도구가 없으면 임의 설치하지 않고 대체 검사·공백을 보고한다.
4. 새 격리 image를 빌드한 경우 `bash tests/codex-update-smoke.sh <local-test-image>`로 실제 wrapper/실제 Codex/Unix socket/실제 교체를 검증한다. fake policy probe만 통과한 결과와 구분한다. 사용자 `/data`·`/config`·인증 volume을 연결하지 않는다. 필요 시 기존 full/update smoke로 인증/config 보존과 S6 종료 회귀를 확인한다.
5. amd64/aarch64 공통 로직을 유지하고 native ARM build/runtime 미실행 시 NOT RUN으로 남긴다. 외부 CI 실행·push는 이번 계획 작성 승인에 포함되지 않는다.
6. 실제 HAOS 수용은 별도 요청/승인 후 수행한다. 작업이 없는 managed 서버+helper의 자동 적용, 활성 CLI/Remote 보호, Remote 정상 종료 이후 재검사, 버전과 `lastApplyAt`, 사용자 데이터 보존을 관측한다. 실제 대화·로그 원문 대신 정제된 전후 상태와 시각·아키텍처·검사 명령 결과를 기록한다.

## 8. 완료와 보고 규칙

- Executor REPORT에는 변경 파일·분류 기준·production 재현 경로·명령/실제 결과·계획 조정·미검증 항목을 포함한다. helper-only 성공과 Remote 동시 존재 시 정상 보류를 별도로 기록한다.
- 자동 fixture PASS, 실제 Codex container PASS, 실제 HAOS PASS는 각각 구분한다. 실제 적용이나 restart를 실행하지 않았다면 반드시 NOT RUN으로 남긴다.
- `progress.md`에 구현 완료 범위와 남은 Remote/HAOS/ARM 공백을 기록한다. 기존 사용자 변경과 이전 handoff 이력은 보존한다.
- 완료 전 status/diff를 검토하고 관련 문서와 changelog의 “모든 세션 유휴” 표현이 구현과 맞는지 확인한다. 실제 보호 조건보다 넓은 자동 적용 보장을 쓰지 않는다.
- Planner 검증 범위: 저장소 소스·기존 테스트/인계 문서 조사와 공식 문서 확인, 새 계획의 형식/diff 검사까지. 제품 테스트·image build·실환경 진단·update·restart는 이번 계획 단계에서 NOT RUN이다.
