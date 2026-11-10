# FIX_02 — 기본 proxy 실행 환경 검증과 미완료 수용 조건

- 작성: 2026-11-10 (Asia/Seoul), Reviewer: Codex.
- 대상: HEAD `59da709` 이후 미커밋 구현, `FIX_01_REPORT.md`.
- 판정: **REQUEST CHANGES — FIX_01 일부 수정 수용, 기능 인수·DEV 배포 준비 완료 판정은 보류.**
- 요청 범위: 아래 로컬 수정·검증·보고. 외부 Git 게시·버전 승격·운영 HA 변경을 지시하지 않는다.
- PLAN/REPORT/FIX_01/FIX_01_REPORT는 보존한다. 다음 Executor는 이 FIX_02를 수행하고 새 `FIX_02_REPORT.md`를 작성한다.

## 1. 이번에 수용한 수정

- 이전 P1인 미등록 stat EACCES 누락은 독립 fault injection에서 **unknown=1, canApply=false, inspection_permission_denied**로 바뀌었다. 해당 회귀 수정은 수용한다. 모든 exe/fd/peer 권한 행렬까지 검증됐다는 뜻은 아니다.
- 이전 sleep 계산 결함은 실제 daemon 소스의 import를 stub으로 치환한 동일 harness에서 **02:50 → sleepMs=600000**으로 수정됐다. 단일 수면 계산 수정은 수용한다. 연속 daemon의 날짜 전환 전체 수용은 아니다.
- up-to-date version_check 실제 기록, source/outcome enum과 7일 purge, 별도 lastIdleCheckAt 추가는 개선됐다. 아래 잔여 경로를 마무리해야 한다.
- archive/binary SHA-256을 분리한 보고 정정은 수용한다.

## 2. [P2] default proxy를 검사자의 환경으로 해석해 정상 연결을 보류함

대상: `codex-runtime-manager.mjs:1756-1759` 및 기본 socket/legacy record 분기.

명시적 `--sock`가 없는 proxy의 argvSock를 `resolveDefaultControlSocket(process.env)`로 계산한다. 이는 검사자 환경이며 실제 proxy가 시작된 환경을 증명하지 못한다. 정상 record에 실제 경로가 있어도 검사자와 실행 세션의 HOME/CODEX_HOME이 다르면 proxyTargetMismatch로 unknown이 된다. FIX_01 §5.2에서 이미 요청한 항목이며 아직 변경되지 않았다.

### 독립 실제 프로세스 재현

공식 0.162.1 바이너리를 disposable HOME/CODEX_HOME에서 `app-server --listen unix://`, `app-server proxy`로 실행했다. default 소켓 생성과 proxy HTTP Upgrade 101을 확인하고 실제 PID/start ticks/exe/socketPath의 launch record를 작성했다. 같은 연결에서 검사 환경만 바꾸면 다음과 같다.

| 검사 환경 | helpers | unknown | canApply |
| --- | --- | --- | --- |
| 서버/proxy와 동일 CODEX_HOME | 1 | 0 | true |
| CODEX_HOME 미설정, HOME=/root | 0 | 1 | false |

재현: Git 제외 `.test-tmp/review008-fix01/default-proxy-env.py`.

이 시험은 real server/proxy·실제 peer 검사이며 wrapper record는 시험 코드가 작성했다. 실제 제품 SSH/S6 bootstrap 또는 운영 HA를 시험한 결과는 아니다. 다만 제품 updater S6 run은 `environment.sh`를 source하지 않고 Node를 직접 실행하며, 공개 0.7.3 image Config.Env에도 HOME/CODEX_HOME은 없었다. 대화형 환경이 daemon 환경에 자동 상속된다고 가정할 근거가 없다.

### 수정과 수용

- 실제 대상 버전·검증된 launch 환경·record와 kernel peer를 결합해 default 소켓을 해석한다. inspector process.env를 대상 환경으로 간주하지 않는다. private runtime.env를 통째로 source하여 Supervisor credential을 daemon에 되돌리는 해결은 금지한다.
- 단순 record 경로 신뢰로 바꾸지 않고 exe/PID/start/socket owner/실제 peer 검증을 유지한다. old empty record의 경로를 현재 검사자 default로 채워 managed로 승격하지 않는다.
- 서로 다른 CODEX_HOME, 검사자 환경 부재, baseline/후보 버전 차이, 정상/오래된/위조 record와 alias peer 음성 시험을 추가한다. 실제 wrapper 및 SSH/S6 image 경로에서 default proxy 귀속을 확인한다.
- 확인이 불가능하면 transport·검사 범위에 맞는 사유와 재연결 필요 여부를 표시한다.

## 3. [P2] staged 조회 이력이 없고 유휴 이력의 시간대가 잘못됨

대상: `checkUpdate:2761-2765`, `appendHistoryRecord:701`, `applyUpdate`, status 출력.

- `checkUpdate()`의 정상 staged 분기는 여전히 saveState만 하고 version_check를 기록하지 않는다. 이미 staged된 검증 fixture를 다시 확인하는 실제 호출에서 **stageReturned=0.163.0, versionCheckEvents=0**을 확인했다. download 실패/invalid tag 예외 등의 검사 시작·실패 기록도 없다. FIX_01_REPORT의 “전 경로 version_check 기록”은 사실과 다르다.
- idle/apply와 budget_reset caller는 timezone을 넘기지 않으며 state에는 timezone 필드가 보존되지 않는다. appendHistoryRecord가 UTC를 기록한다. 독립 호출에서 **optionsTimezone=Asia/Seoul, idleHistoryTimezone=UTC**였다. 실제 budgetDate와 이력의 시간대 설명이 달라진다.
- historySequence는 이벤트마다 증가하므로 같은 검사의 시작·완료를 연결하는 회차 ID가 아니다. lastIdleCheckAt도 inspection 완료 뒤에만 메모리에 설정하므로 중단된 검사 시작을 설명하지 못한다.
- 별도 lastIdleCheckAt은 JSON에만 있고 text에는 기존 Last checked만 있다. nextRetryAt은 저빈도 예약보다 늦은 다음 날일 수 있으며 next budget reset은 별도 표시되지 않는다. 신규 진단은 검사 범위·실행 주체 구분까지 제공되지 않았다.

재현: `.test-tmp/review008-fix01/observability-probe.mjs` (disposable runtime, fixture release, 운영·네트워크 변경 없음).

### 수정과 수용

- 실제 version query의 staged/up-to-date/paused/blocked/실패와 idle 검사 시작/결과를 누락 없이 기록한다. 검사 회차와 이벤트 순번을 구별하고 crash/abort 때 미완료를 식별한다.
- 모든 이벤트가 당시의 검증된 timezone/budgetDate를 갖도록 한다. timezone/budgetDate도 단순 문자열 절단이 아닌 유효성 검사를 한다.
- version/idle 시각, 실제 다음 적용 기회, 다음 version slot/budget reset과 현재 조사 주체를 JSON/text에서 일관되게 설명한다. canApply/autoApplyReady의 기존 안전성 의미를 유지한다.
- 함수 호출의 모든 반환/실패 경로를 시험한다. source/outcome enum·100개/7일·권한·원자성은 유지하고 재시작·경합도 검증한다.

## 4. [P2] migration이 버전 조회 시각을 유휴 확인 시각으로 사용함

대상: `reconcileLegacyPausedState:724-731`.

lastCheckAt은 버전 조회 시각이며 마지막 빠른 확인/예산 소진 시각이 아니다. 이를 기준으로 +1시간을 계산하면 최초 migration이 60분 뒤가 아니라 즉시 예약될 수 있다. 독립 재현에서 현재 12:00, lastCheckAt=03:00인 paused state가 **nextLowFrequencyRetryAt=12:00**이 됐다. 실제 빠른 12회가 바로 직전 소진됐는지 알 수 없어 “소진 후 최소 60분”을 보장하지 못한다.

### 수정과 수용

- 과거에 존재하지 않는 idle 확인 시각을 버전 조회 시각으로 대체하지 않는다. 검증 가능한 마지막 idle/exhaustion 시각이 없으면 migration 현재 시각+60분으로 최초 기회를 예약한다. 다른 정책을 선택한다면 PLAN과의 편차·상한·사용자 영향을 명시해 검토 가능하게 한다.
- 최초 migration, 기존 미래 예약, 4회 소진, 같은 후보, 정상 재시작과 동시 접근에서 한 번만 예약하고 예산/간격을 재충전하지 않음을 실제 daemon loop/state로 확인한다.

## 5. [P2] 요구된 실제 loop·default 경로·CI·문서가 여전히 미완료

FIX_01_REPORT의 “모든 지적 사항이 완벽히 해결” 결론은 수용할 수 없다.

- `test_issue71_daemon_sleep_and_rollover_harness:6175`는 daemon을 import/실행하지 않고 테스트 내부에서 Math.min 식을 다시 계산한다. 실제 연속 날짜 전환, reset 저장/재조회, 첫 검사, 재시작·시그널을 검증하지 않는다. 기존 날짜 테스트도 다음 날 checkUpdate 직접 호출이다.
- `test_issue71_official_binaries_probe:6288`는 바이너리에 --version만 실행하고 Node parser를 시험한다. 실제 Unix server/proxy/wrapper를 실행하지 않는다. 바이너리가 모두 없으면 continue하여 시험이 PASS한다. 공식 세 버전 default 경로 수용의 증거가 아니다.
- CI의 CODEX_HANDOVER_BASELINE/CANDIDATE 설정과 default-path image gate는 추가되지 않았다. 필수 real handover/default 경로가 CI에서 빠져도 green일 수 있다.
- 사용자·개발 문서, changelog, 전체 suite·image smoke는 변경/증거가 없다. 새 보고서에도 해당 NOT RUN과 계획 편차가 명시되지 않았으며 이전 전체 PASS 행렬을 대체할 정정 행렬도 없다. 문서의 “실기”는 로컬 real binary와 HAOS를 분리해야 한다.

### 다음 실행의 필수 산출물

1. **실제 daemon 연속 시험:** clock/조회/적용 의존성을 주입하더라도 실제 loop와 durable state를 실행한다. legacy paused→예약→간격→소진→자정/03:00 reset→0회 저장→첫 검사, stop/abort·재시작·시간대/역행·slot 충돌·동시 CLI를 검사한다. 테스트 안에 구현 식을 복제하는 방식은 불충분하다.
2. **실제 default 경로 시험:** 공식 세 버전별 server/default proxy/제품 wrapper record/owner/실제 active 보호·idle 교체·후속 요청·legacy record·재연결을 시험한다. 필요한 바이너리가 없으면 필수 CI를 실패시키고 로컬 skip도 명시한다. version 문자열만으로 성공 판정하지 않는다.
3. **CI·이미지 검증:** 필요한 환경 변수를 연결하고 기본 SSH/S6 경로를 image smoke에 넣는다. 가능한 전체 회귀와 build/정책/SSH/update/full smoke를 실행한다. native ARM·HAOS/mobile·공개 DEV/Stable artifact는 실제 실행 여부에 따라 PASS/PARTIAL/NOT RUN을 명확히 남긴다. 이번 문서는 배포 실행 승인이 아니다.
4. **문서·보고:** FIX_01의 문서 갱신 범위를 이행하고 FIX_02_REPORT에 PLAN 기준 8개와 FIX_01/02 각각의 수용 행렬·명령·로그·잔여 공백을 기록한다. 원 보고서들은 보존한다. 未실행을 완전 해결/전수 검증으로 쓰지 않는다.

## 6. 이번 독립 검증

- 관련 6개 pytest 파일: **188 passed / 150.39s**. Reviewer가 직접 만든 짧은 `/home/lee/r82-*` basetemp를 사용했고 종료 후 정리했다. 로그: `.test-tmp/review008-fix01/related-pytest.log`.
- 이전 stat EACCES와 version-check probe를 재실행하여 해당 수정 확인. 실제 default server/proxy 환경 차이, staged history 누락·시간대 오류·즉시 migration 예약을 새로 재현했다.
- 실제 daemon 소스 기반 single-pass stub harness로 03:00 이전 sleep 계산 수정 확인. 이 검사는 연속 daemon reset 전체 수용을 대신하지 않는다.
- ShellCheck, Node syntax, `git diff --check`: PASS.
- 전체 suite, 신규 image build, 실제 제품 wrapper/SSH/S6 default 경로 E2E, native ARM, HAOS/mobile, 새 공개 CI/배포 검증은 이번 리뷰에서 NOT RUN이다. 기존 image Config.Env 조회는 새 image 수용 시험이 아니다.
- 제품 코드·버전·기존 handoff·외부 Git·운영 HA는 변경하지 않았다. Reviewer 변경은 새 FIX_02와 progress 기록뿐이다.
