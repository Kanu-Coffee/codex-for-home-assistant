# FIX_01 — 이슈 #71 안전성 회귀와 관측·검증 공백 수정

- 작성: 2026-11-10 (Asia/Seoul), Reviewer: Codex.
- 대상: `feat/issue-71-default-socket-observability`, HEAD `59da709` 이후 미커밋 구현과 `REPORT.md`.
- 판정: **REQUEST CHANGES — 기능 인수 및 DEV 배포 준비 완료로 수용할 수 없음.**
- 범위: 아래 수정과 로컬 검증. 이 문서 자체는 외부 게시·버전 승격·운영 Home Assistant 변경 지시가 아니다.
- `PLAN.md`와 원 `REPORT.md`는 이력으로 보존한다. Executor는 아래를 수행한 뒤 새 `FIX_01_REPORT.md`에 정정된 수용 행렬과 실제 검증 결과를 기록한다.

## 1. [P1] 검사 불가 프로세스를 inventory에서 제거하는 안전성 회귀

대상: `codex-runtime-manager.mjs:1622-1635`의 Pass 2.

기존 코드는 `inspectProcess()`가 unknown을 반환하면 unknown entry를 보존했다. 이번 변경은 `if (!proc || proc.unknown) continue`로 바꿔 미등록 프로세스의 stat 검사 실패를 조용히 제외한다. 등록되지 않은 기존 Codex나 관측 불가 프로세스가 살아 있어도 전체 검사는 적용 가능으로 판정할 수 있다. 실제 작업과 신원을 확인하지 못한 상태에서 교체를 허용하므로 불변조건 위반이다.

Reviewer 독립 재현: `/proc/424242/stat`에 synthetic EACCES를 주입하고 `/proc` inventory에 해당 PID를 제공했다. `inspectProcess`는 `{unknown:true,error:"EACCES"}`인데 `inspectAllSessions({readOnly:true})`는 **unknown=0, blockers=[], canApply=true**를 반환했다. 운영 프로세스를 건드리지 않은 fault injection이다. 재현 파일: Git 제외 `.test-tmp/review008/permission-probe.mjs`.

### 수정과 수용

- 사라진 프로세스와 살아 있으나 검사 불가인 프로세스를 구분하고 후자의 불확실성을 보존한다. unknown을 무시해서 적용 가능으로 만드는 변경을 제거한다. 무관 프로세스를 이름/argv만으로 Codex에 편입하는 해결도 금지한다.
- 등록/미등록, stat/exe/cmdline 각각의 EACCES·EPERM, ENOENT 경쟁과 PID 재사용을 실제 inventory 결과로 시험한다. 권한 불가일 때 canApply=false와 정확한 blocker를 단언한다.
- 현재 등록 분기의 exe/cmdline 진단은 EACCES만 보며 EPERM은 빠져 있다. proxy socket stat/fd/readlink/owner fd/peer 검사도 기존 catch에서 원인이 사라진다(예: 1741~1766행). 이 경로들을 구분된 검사 범위·실행 주체와 allowlist 사유로 보존한다. 현재 shell 관측과 저장된 daemon 판정을 혼동하지 않는다.
- 신규 `test_issue71_permission_denied_diagnosis`는 LAST_BLOCKER_CODES 포함 여부만 확인한다. 이를 위 동작 시험으로 보강한다. 현재 테스트의 PASS는 EACCES 안전 진단 PASS의 증거가 아니다.

## 2. [P2] 0.7.3에서 이미 소진된 상태는 저빈도 재확인을 시작하지 않음

대상: daemon 160~166행과 `applyUpdate`의 nextLowFrequencyRetryAt 초기화.

기존 0.7.3 state는 `paused_busy`, idleCheckCount=12이며 새 nextLowFrequencyRetryAt 필드가 없다. loadState에서 null이 되고, daemon은 paused_busy의 일반 pending 분기를 건너뛴다. 저빈도 분기는 nextLowFrequencyRetryAt이 있을 때만 실행한다. 같은 후보의 새 slot check도 paused로 반환하므로 날짜 전환/수동 조작 전에는 예약을 만드는 applyUpdate에 도달하지 못한다. 이슈를 보고한 사용자의 기존 상태에서 당일 재기회 기능이 동작하지 않는다.

Reviewer daemon loop harness에서 legacy paused state를 제공하자 **applyCalls=0, lowFrequencyRetry=null**로 수면했다. harness는 실제 daemon 소스의 import만 stub으로 치환해 분기와 sleep 계산을 검사했으며 실제 다운로드/적용 수용 시험의 대체물이 아니다. 재현: `.test-tmp/review008/{daemon-under-review,stub-manager}.mjs`, `SCENARIO=legacy`.

### 수정과 수용

- 기존 paused state를 처음 읽을 때 exclusive state 변경으로 제한된 최초 재시도를 예약하는 호환 경로를 구현한다. 임의 과거 검사 시각을 만들어 내거나 빠른 예산을 초기화하지 않는다.
- 이미 4회 소진한 상태·미래 예약·재시작·복수 CLI/daemon 접근에서는 재예약으로 예산/간격이 우회되지 않아야 한다.
- 실제 연속 daemon harness에서 old state → 최초 예약 → 60분 전 보류 → 재확인 → 정상 종료/재시작 후 예약 유지까지 검증한다.

## 3. [P2] 저빈도 sleep이 03:00 초기화와 정기 슬롯을 지나침

대상: daemon 197~206행.

저빈도 대기 분기는 `Math.min(msUntilLowFreq, 3600s)`만 계산하고 다음 정기 슬롯까지의 시간을 포함하지 않는다. 02:50에 다음 저빈도 시각이 03:50이면 03:00이 아닌 03:50까지 잠들어 예산 초기화와 버전 조회가 50분 늦어진다. 다른 정기 슬롯도 같은 문제가 있다.

Reviewer loop harness의 출력: **sleepMs=3600000, untilNextSlot=600000** (`SCENARIO=rollover`). 이 재현은 sleep 결정의 오류를 확인한 것이며 연속 날짜 전환 전체를 검증한 결과는 아니다.

### 수정과 수용

- next scheduled slot/budget reset, low-frequency deadline, restart cooldown과 stop signal 중 필요한 가장 이른 기회를 계산한다. 동일 시각의 slot check와 low-frequency 기회가 겹칠 때 중복 적용하거나 5초 반복하지 않아야 한다.
- 가상 시계로 같은 daemon 프로세스를 계속 실행해 12회 소진→자정→02:59→03:00 reset 저장→카운터 0 관측→새 첫 검사를 확인한다. reset 전 local state의 재사용, DST/timezone 변경·역행, abort, disabled/blocked 상태도 검증한다.
- 현재 날짜 테스트는 daemon을 실행하지 않고 `checkUpdate()`를 다음 날 직접 호출한다(`test_codex_update_contract.py:6012-6022`). 보고서의 “연속 daemon 날짜 전환 PASS”를 뒷받침하지 못하므로 별도 실제 loop 시험이 필요하다.

## 4. [P2] 버전 조회 이력과 회차 관측 계약이 아직 구현되지 않음

대상: `checkUpdate`, `appendHistoryRecord/sanitizeHistory`, `getStatus`, daemon scheduling/status.

- version_check가 event allowlist에만 있고 실제 `checkUpdate()`에서는 기록되지 않는다. Reviewer가 disposable runtime에서 정상 up-to-date 조회를 실행하자 **lastCheckAt은 갱신됐지만 history=[], versionCheckEvents=0**였다. 재현: `.test-tmp/review008/history-probe.mjs`.
- 별도 lastIdleCheckAt·검사 시작/완료 회차 ID·당시 timezone·다음 budget reset 시각이 없다. 기존 idleCheckCount는 보류 예산이라 전체 검사 회차를 대신할 수 없다. 이력은 보류/일부 적용 결과만 기록하며 중단된 검사를 식별하지 못한다.
- low-frequency 재시도가 더 이른데도 nextRetryAt 및 history.nextRetryAt은 다음 날로 남을 수 있다. autoApplyReady도 기존 빠른 12회 제한을 그대로 쓰므로 실제 daemon의 새 적용 기회와 일치하지 않는다.
- sanitizeHistory는 source/outcome을 단순 절단하고 nextRetryAt은 길이·날짜 검증 없이 통과시킨다. synthetic source/outcome 문자열과 ISO 날짜가 아닌 nextRetryAt이 그대로 보존되는 것을 확인했다. 현재 고정 caller에 실제 비밀 유출이 발생했다고 확정하는 것은 아니지만 PLAN의 닫힌 필드·길이 계약을 충족하지 못한다.

### 수정과 수용

- 실제 version query와 idle 검사 시작/결과를 연결해 기록하고 별도 시각·회차를 status에 제공한다. 정상/보류/실패/미완료를 구분하며 과거 이력을 추산해서 채우지 않는다.
- 실제 다음 기회와 정책별 예산/상한을 JSON·text·daemon에서 일관되게 표시한다. canApply의 세션 안전성 의미는 유지하고 autoApplyReady의 새 정책 의미를 명확하게 정의한다.
- source/outcome 등은 enum, 시각은 유효한 bounded ISO/date, 숫자는 유한한 비음수 정수로 검사한다. 100개/7일과 1 MiB 상한, 0700/0600 및 원자 저장을 유지한다.
- 실 호출의 버전 조회 이벤트·idle 회차, 7일 만료, 중단/재시작, CLI/daemon 경합과 금지 필드/임의 문자열을 시험한다. 현재 history test는 100개 cap과 추가 secret_token 필드 제거만 확인하며 7일 경과 자료를 넣지 않는다.

## 5. [P2] 수용 행렬을 실제 시험 범위에 맞추고 누락된 회귀·문서를 완성할 것

원 REPORT는 수용 기준 1~8을 모두 PASS로 기재했지만 다음 근거가 부족하다.

- default-socket test는 resolver/parser 값과 wrapper 문자열 포함만 확인한다. 공식 세 버전의 실제 default server/proxy/SSH 귀속·실제 wrapper record 및 이전 empty record migration을 실행하지 않는다. 기존 explicit socket 시험 PASS를 새 default 경로 PASS로 합산하지 않는다.
- 로컬 real worker handover는 기존 session-host stdio/WebSocket/TUI 시험이다. 이 결과는 실제 Home Assistant/모바일 실기나 신규 default Unix 서버의 교체/재연결 수용을 의미하지 않는다.
- CI는 0.167.0을 준비하도록만 추가했고 `CODEX_HANDOVER_BASELINE/CANDIDATE`는 설정하지 않아 해당 handover 시험이 skip될 수 있다. 새 version이 default proxy fixture에 실제 사용되는지도 확인해야 한다.
- REPORT의 0.167.0 SHA-256(`86c5...`)과 provisioning의 architecture별 값(`3bbf...`, `0de2...`)이 다르다. archive/package/binary digest를 구분해 실제 대상과 명령·증거를 기록한다.
- Docker build/image smoke, custom AppArmor/native ARM/HAOS, 전체 suite와 사용자·개발 문서 갱신이 현재 변경에 없다. 이를 모두 완료한 것으로 읽히는 “구현 및 회귀/실기 인계 검증 완료” 상태를 정정한다. DEV metadata/버전 변경을 하지 않은 사실 자체는 이번 로컬 리뷰의 결함이 아니다.

### 수정과 수용

1. 공식 0.162.1/0.166.0/0.167.0 각각에서 실제 pathless Unix + default proxy + 소유자·record 일치와 active/idle/unknown·legacy 호환을 시험한다. 원래 테스트와 같은 식을 다시 계산하는 단언만 추가하지 않는다.
2. 기본 경로 해결에 검사자의 process.env만 사용하지 말고 실행 대상의 검증된 launch 환경/버전과 일치함을 입증한다. 다른 CODEX_HOME/버전·empty record를 현재 default로 조용히 승격하지 않는다. 재연결이 필요하면 사유와 사용자 영향을 명시한다.
3. 새 기능의 필수 CI 실행을 연결하고 필요한 fixture가 없을 때 무심코 skip하여 green이 되는 것을 방지한다. 로컬에서 실제 사용한 baseline/candidate/version/hash와 환경 변수를 기록한다.
4. 관련 pytest·전체 suite, syntax/ShellCheck·문서/설정 lint·secret scan, 가능한 이미지 build·default proxy/update/full smoke를 실행한다. native ARM·HAOS/mobile 등 실행 불가 항목은 정확한 사유와 NOT RUN을 남긴다. 보호 정책과 금지 권한을 완화하지 않는다.
5. 한국어·영어 README/DOCS, CHANGELOG, product_spec/architecture/addon_spec/security/test_plan/releasing/progress를 새 예약·이력·복구·호환 동작에 맞춘다. 배포 예정과 완료를 구별한다.
6. 원 REPORT는 보존하고 FIX_01_REPORT의 수용 행렬에서 이번 발견과 기존 과장된 PASS를 명시적으로 정정한다. 기능 인수 후 DEV 게시, DEV 수용 후 Stable 0.7.4 exact artifact 검증 순서를 유지한다.

## 6. 이번 Reviewer의 직접 검증과 한계

- 신규 issue71 pytest: **4 passed, 130 deselected / 2.03s**. 위에서 지적한 시험 범위의 한계를 포함한다.
- 관련 6개 파일 pytest: 첫 시도 **173 passed, 11 failed / 122.44s**. 별도 재현에서 `/tmp` 쓰기의 `Disk quota exceeded`를 확인했다. 최초 실패 전체를 제품 회귀로 단정하지 않는다.
- 실패가 있었던 wrapper_proxy/remote_setup 전체를 직접 만든 짧은 `/home/lee/r8-*` basetemp에서 재실행: **21 passed / 17.40s**. 임시 디렉터리는 종료 후 정리했다. 로그는 `.test-tmp/review008/proxy-remote-shortpath.log`에 있다.
- ShellCheck, Bash/Node syntax, `git diff --check`: PASS.
- 공식 로컬 binary 0.162.1/0.166.0/0.167.0을 disposable HOME/CODEX_HOME에서 각각 `app-server --listen unix://`로 시작해 기본 socket 생성 확인. 0.167.0은 초기 0.6초 관측에서 생성 전이었고 3초 재관측에서 정상 생성 확인했다. 이 검사는 세 버전의 default 경로 존재만 확인하며 실제 SSH/교체 수용은 아니다.
- 공식 [Codex App Server 문서](https://developers.openai.com/codex/app-server)의 default Unix transport 계약도 재확인했다.
- 전체 suite, 새 image build, 새 default 경로의 실제 SSH·worker 교체, native ARM, HAOS/mobile, 공개 CI/배포/서명 검증은 이번 리뷰에서 **NOT RUN**.
- Reviewer는 제품 코드·버전·원 REPORT·외부 Git·실제 HA를 변경하지 않았다. 다음 Executor는 이 FIX_01을 수행하고 matching report를 새로 작성한다.
