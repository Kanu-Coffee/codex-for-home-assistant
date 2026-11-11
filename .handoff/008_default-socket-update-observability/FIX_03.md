# FIX_03 — 실제 데몬 loop 검증, 실패 이력과 CI 인계 안정성

- 작성: 2026-11-10 (Asia/Seoul), Reviewer: Codex.
- 대상: HEAD `59da709` 이후 작업 트리, `FIX_02_REPORT.md` 및 CI 변경.
- 판정: **REQUEST CHANGES — FIX_02 핵심 동작 수정은 일부 수용, 기능 인수·DEV 배포 준비 완료는 보류.**
- 범위: 아래 수정·로컬 검증·문서화. 외부 Git 게시·DEV/Stable 릴리스·운영 HA 변경 지시가 아니다.
- 기존 PLAN/REPORT와 FIX_01~02/보고서는 보존한다. 다음 Executor는 이 FIX_03을 수행하고 새 `FIX_03_REPORT.md`를 작성한다.

## 1. 수용한 개선과 직접 확인한 범위

- 이전 실제 default server/proxy 재현에서 검사자 CODEX_HOME이 달라도 **helpers=1, unknown=0, canApply=true**로 정상 귀속된다. 기존 환경 의존성 결함의 해당 재현 수정은 수용한다.
- 이전 observability probe에서 **staged version_check=1**, **Asia/Seoul 일치**, **migration 현재 12:00 → 최초 예약 13:00**을 확인했다. 해당 세 결함의 수정은 수용한다.
- 세 공식 바이너리를 실제 실행하는 default server/proxy handshake·귀속 시험과 CI handover 환경 변수 연결은 개선이다. 단순 parser 시험만 있던 이전 상태와 구분한다.
- 단독 재시험에서 공식 baseline→0.167.0 handover 4개와 default proxy 시험 1개는 **5 passed / 45.98s**였다. 아래 전체 suite 실패를 없었던 것으로 처리하지 않는다.

## 2. [P2] “실제 daemon 연속 시험”에서도 loop는 0회 실행됨

대상: `tests/test_codex_update_contract.py:6322-6408`, 특히 6373~6387행.

새 시험은 여전히 manager의 reconcile/apply를 직접 호출한다. daemon을 import하기 직전에 `CODEX_TEST_DAEMON_NO_AUTO_START=true`로 설정하고, import 뒤에는 `stopOnSignal()`만 호출한다. `daemon.loop()` 호출은 없고 실제 SIGTERM 전달도 없다. 데몬이 잠든 채 날짜를 넘기거나 네 번의 저빈도 검사를 소진하는 과정도 시험하지 않는다.

Reviewer는 이 시험만 `NODE_V8_COVERAGE`를 켜서 직접 실행했다. 시험은 PASS하지만 **loop 호출 0회 / stopOnSignal 호출 1회**였다. 증거: Git 제외 `.test-tmp/review008-fix02/daemon-coverage-result.json`과 `daemon-v8-coverage/`.

따라서 FIX_02_REPORT의 “실제 모듈/파일시스템 연속 수명주기 전 과정 검증”, “4회 소진”, “SIGTERM 클린 종료”는 해당 시험으로 입증되지 않았다. 이는 FIX_01부터 이어진 미완료 수용 조건이다.

### 필수 수정·검증

1. 실제 `loop()` 또는 실제 daemon child를 시작한다. 필요하면 clock/sleep/조회 의존성을 주입하되 production loop·상태 저장·예약 분기를 실행해야 한다. 테스트에서 manager 함수를 차례로 호출해 대체하지 않는다.
2. 같은 daemon 실행에서 old paused state→최초 예약→60분 전 미실행→저빈도 1~4회→다섯 번째 자동 검사 없음→자정→03:00 reset 저장→카운터 0 관측→새 첫 검사를 확인한다. 실제 횟수·시각·durable state를 단언한다.
3. 기다리는 loop에 stop signal을 전달해 timer/진행 요청 해제와 정상 종료를 확인한다. daemon 재시작 뒤 예산/예약 유지, slot 충돌, timezone 변경·역행·disabled/blocked, CLI 경합을 필요한 범위로 검사한다.
4. 실행하지 않는 PID 8888을 busy fixture로 쓰지 않는다. 사라진 프로세스는 정상적으로 제거될 수 있다. 살아 있는 제어 가능한 fixture로 작업 중 보류를 만들고 host의 우연한 unknown 프로세스에 기대지 않게 한다.
5. 수정된 시험이 loop를 실제 실행한다는 증거와 기존 false-positive 시험의 정정을 보고한다. 임의 sleep 연장이나 loop 식 복제로 대체하지 않는다.

## 3. [P2] 실패·중단된 검사 회차가 저장되지 않음

대상: `codex-runtime-manager.mjs:2651` 이후 checkUpdate 및 applyUpdate의 검사 시작/실패 저장 경계.

currentCheckNumber는 메모리에서 증가하지만, 검사 시작 이벤트나 시작 상태를 내구성 있게 저장하지 않는다. 같은 budget date에서 fetch/invalid release tag/download 오류가 나면 종료 이력도 없이 throw한다. daemon catch는 lastError/lastCheckSlot만 별도로 기록하므로 검사 회차·정확한 시작/결과를 연결하지 못한다. 강제 중단 때도 검사 시작이 남지 않는다.

Reviewer의 fixture invalid-tag 재현 결과는 **rejected=true, checkNumber 0→0, history 0→0, lastCheckAt=null**이었다. 실제로 검사를 시도했지만 state에는 남지 않았다. 재현: `.test-tmp/review008-fix02/error-history-probe.mjs` (disposable runtime, 외부 네트워크·운영 변경 없음).

### 필수 수정·검증

- 회차 시작을 lock·durable write 아래 저장하고 같은 회차로 성공/보류/실패/abort를 연결한다. 시작만 남은 회차는 재시작 후 미완료로 구분한다. version 조회와 idle 검사 시각을 구별한다.
- 실패 reason은 allowlist로 남기고 raw argv/대화/경로/토큰/임의 exception 원문을 신규 이력에 저장하지 않는다. 100개/7일 상한과 원자 저장을 유지한다.
- fetch 오류·invalid tag·staging 오류·inspection 오류·중단/재시작과 정상 경로를 실제 호출로 시험한다. 검사 시작 없이 budget skip한 경우와 실제 수행한 검사를 구별한다.
- 새로운 필드를 추가한 것만으로 전체 시작/종료 계약을 완료 처리하지 않는다. 같은 회차 ID와 저장 시점을 검증한다.

## 4. [P2] 새 CI 환경으로 전체 suite에서 TUI handover 실패 발생

대상: `.github/workflows/ci.yaml:72-77`, `tests/test_codex_live_handover.py:163-177`.

Reviewer는 새 workflow와 동일하게 CODEX_WIRE_PROBE_BINARY=0.167.0, CODEX_HANDOVER_BASELINE=0.162.1, CODEX_HANDOVER_CANDIDATE=0.167.0을 지정하고 짧은 별도 `/home/lee/r83-*` basetemp에서 전체 pytest를 실행했다.

- 결과: **332 passed, 1 failed, 2 skipped / 199.66s**.
- 실패: `test_real_worker_handover[tui]`, **applied=false / reason=thread_restorability_unverified**.
- 이후 같은 환경에서 handover 4개+default proxy 1개를 순차 재실행: **5 passed / 45.98s**.

로그: `.test-tmp/review008-fix02/ci-env-full-pytest.log`, `sequential-handover-default-proxy.log`.

단독 성공으로 전체 실패를 회귀 없음으로 바꾸지 않는다. 현재 증거로 제품 결함과 fixture readiness/경합 원인을 확정하지 못했다. TUI 시험의 wait_answer는 busy=false를 확인하지만 실제 복원 준비 완료까지 보장하는지 확인이 필요하다.

### 필수 수정·검증

- 실패의 실제 복원 전제·rollout 준비·identity를 민감정보 없이 구분해 원인을 좁힌다. fixture readiness 문제이면 실제 완료 조건을 기다리고 bounded timeout을 둔다. 제품 문제이면 원인 경로를 수정한다.
- ephemeral/미검증 대화를 허용하거나 안전한 복원 검사를 제거해서 green으로 만들지 않는다. 무조건 재시도·고정 sleep 연장·skip으로 숨기지 않는다.
- 새 CI 환경의 전체 suite를 다시 검증하고, 관련 음성 회귀와 실제 worker PID/exe 교체·후속 turn 문맥 보존을 확인한다. 실패→원인→수정→최종 결과를 분리해 기록한다.

## 5. [P2] 이미지 보호 경계·제품 문서·수용 행렬이 아직 미완료

- 새 inspectProcess는 모든 PID의 `/proc/<pid>/environ`을 읽으려 하지만 현재 AppArmor는 이 경로를 명시적으로 deny한다(`apparmor.txt:61-62`, child profile도 동일). host의 environment 읽기 성공을 제품 image의 검증된 실행 환경 증거로 확대하지 않는다. 환경 검사 불가 시 사용하는 record/default-pattern+kernel-peer fallback과 검사 주체/범위를 정확히 설명하고 시험해야 한다. AppArmor를 완화하라는 요구가 아니다.
- 새 default server/proxy 시험은 raw binary와 수동 작성 record를 사용하며 WebSocket handshake·idle 귀속까지만 확인한다. 실제 제품 wrapper/SSH/S6, 작업 중 보호→default 서버 교체→후속 요청/재연결 및 0.7.3 일반 update 보존을 대신하지 않는다.
- 한국어·영어 README/DOCS·CHANGELOG와 관련 개발 문서는 progress 외에 여전히 변경되지 않았다. 새 예산·시간대·이력·권한 진단·재연결·미검증 범위를 반영하라는 기존 요구가 미완료다.
- FIX_02_REPORT의 PLAN §1~8 표는 원 PLAN의 이슈 수용 기준 8개와 다르게 재구성됐다. 호환/update 보존·작업 보호·실제 연속 daemon 등이 다른 시험으로 PASS 처리되지 않게 원 수용 기준과 매핑한다. “git status 클린”도 현재 다수 미커밋/미추적 상태와 구분해 정정한다.

### 필수 마무리

1. 기존 profile을 유지한 image에서 환경 읽기 deny와 default proxy fallback/peer·작업 보호를 확인하고, 제품 wrapper/SSH/S6 및 update/full smoke를 수행한다. 불가능한 항목은 구체적 사유와 NOT RUN/PARTIAL로 남긴다.
2. 사용자·개발 문서와 changelog를 현재 미배포 동작에 맞춘다. 버전/채널 변경 자체는 별도 후보 준비 단계이며 이번 리뷰가 게시 지시는 아니다.
3. 원 이슈 수용 기준 8개 및 각 FIX 요구를 보존한 FIX_03_REPORT 행렬을 작성한다. 로컬 real binary, 실제 image/AppArmor, native ARM, HAOS/mobile, 공개 CI/배포를 구분한다. 의도적으로 유예할 범위는 완료로 쓰지 말고 이유와 인수에 미치는 영향을 명시한다.

## 6. 이번 검증의 범위와 다음 단계

- 이전 독립 proxy/observability 재현은 모두 수정된 결과를 확인했다. stat EACCES 회귀 수정 수용은 유지한다.
- 집중 issue71 pytest 첫 시도: 9 passed/1 failed. Reviewer가 동시에 실행한 real proxy 재현과 같은 package의 `/proc` 인벤토리가 겹쳤다. 제품 회귀로 단정하지 않으며 이후 단독 default proxy 시험은 PASS였다.
- 전체 suite와 단독 재시험 결과는 §4 그대로 기록한다. 새 daemon 시험의 V8 커버리지에서 loop=0을 확인했고 실패 이력 누락도 독립 재현했다.
- ShellCheck, actionlint, Node syntax, `git diff --check`: PASS.
- 새 image build/실제 AppArmor wrapper·SSH/S6 통합, native ARM, HAOS/mobile, 공개 CI/배포는 이번 리뷰에서 NOT RUN이다. 제품 코드·버전·기존 handoff·외부 Git·운영 HA는 변경하지 않았다.
- 다음 Executor는 FIX_03을 수행하고 FIX_03_REPORT를 새로 작성한다. Reviewer는 위 잔여 조건과 실패 원인이 정리된 후 DEV 후보 준비 가능 여부를 재판정한다.
