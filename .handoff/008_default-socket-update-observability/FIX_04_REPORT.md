# FIX_04_REPORT: Durable Completion State, Fail-Closed Rollout Validation & Full Suite Verification

> **Task ID**: 008 (Default Socket Update Observability & Lifecycle Hardening)  
> **Role**: Executor  
> **Target Document**: `.handoff/008_default-socket-update-observability/FIX_04.md`  
> **Working Branch**: `feat/issue-71-default-socket-observability`  
> **Date**: 2026-11-10  

---

## 1. 개요 및 목적

Reviewer Codex가 `FIX_04.md`에서 지적한 5가지 핵심 결함(관리 세션 적용 성공 후 `activeCheck` 잔류, `blocked_integrity`/`blocked_policy` 등의 터미널 이력 누락, `rolloutReady`의 RPC error/thread mismatch fail-open 결함, `Unreleased` changelog 추가로 인한 버전 일치 계약 실패, 2단계 예산 정책 문서 불일치, 데몬 수명주기 시험의 가변 버전 단언)을 전수 분석·수용하여 구현 및 실증 검증을 완료하였다.

이번 검증에서는 Reviewer가 지적한 환경과 동일한 조건 하에서 **저장소 전체 pytest suite 21개 테스트 파일 339개 전수 검증을 수행하여 337 passed, 2 skipped, 0 failed (191.48s)**를 달성하였다.

---

## 2. 주요 수정 및 구현 상세

### §2. 관리 세션 적용 성공 뒤 `activeCheck` 잔류 제거 및 종료 계약 원자성 보장
- **문제 진단**:
  - `codex-runtime-manager.mjs`의 `finishSelection` 콜백이 `status = "applied"`와 성공 이력을 `saveState`하지만 `state.activeCheck = null`을 호출하기 전에 디스크에 저장하여, 디스크 상에는 `activeCheck`가 남아있는 상태로 영속화됨.
  - 다음 부팅/`initRuntime()` 시 미완료 검사로 오인되어 `unclean_shutdown` 실패가 잘못 누적됨.
  - 또한 `blocked_integrity`, `blocked_policy`, `blocked_verification` 등 검사 시작 후 차단/실패 분기에서 `activeCheck`만 null로 만들고 터미널 이력을 남기지 않아 검사 번호와 이력 간 불일치 발생.
- **해결 및 구현**:
  1. `finishSelection` 내부에서 `await saveState(state)` 호출 직전에 `state.activeCheck = null;`을 명시하여 적용 성공 commit과 함께 디스크에 `activeCheck: null`이 원자적으로 저장되도록 수정.
  2. `LAST_BLOCKER_CODES`에 `"blocked_integrity"`, `"blocked_policy"`, `"blocked_verification"`을 추가.
  3. `applyUpdate()` 내 무결성 차단(3110행), 정책 차단(3208행, 3225행), 바이너리 검증 실패(3240행, 3373행) 등 모든 조기 종료 분기에서 `state.lastBlocker` 설정, `appendHistoryRecord(state, { outcome: "blocked"|"failed", blocker: ... })` 호출 및 `saveState(state)`를 수행하도록 보강.
  4. 사전 가드(옵션 비활성화, staged 파일 부재 등)는 실제 검사 착수 전 스킵이므로 checkNumber를 낭비하지 않도록 분리하고, 실제 검사 시작 시점에만 `currentCheckNumber` 증가 및 `activeCheck` 생성을 일원화.
- **실증 증거**:
  - Reviewer 독립 재현 프로브(`.test-tmp/review008-fix03/managed-active-check-probe.py`) 실행:
    ```text
    PERSISTED_AFTER_SUCCESS {'activeCheck': None, 'status': 'applied'}
    ```
    (성공 후 디스크 상 `activeCheck`가 깨끗하게 null임을 확인)
  - Reviewer 무결성 차단 프로브(`.test-tmp/review008-fix03/integrity-history-probe.mjs`) 실행:
    ```json
    {"reason":"blocked_integrity","historyBefore":1,"historyAfter":2,"lastHistory":{"event":"apply_result","sequence":2,"checkNumber":2,"blocker":"blocked_integrity","outcome":"blocked"},"activeCheck":null}
    ```
    (무결성 차단 시 1회의 검사 회차와 `blocked_integrity` 이력이 디스크에 정확히 영속화됨을 확인)
  - `tests/test_codex_live_handover.py`에 `assert persisted['activeCheck'] is None`을 정규 단언으로 통합하여 회귀를 원천 차단.

### §3. `rolloutReady` fail-closed 강화 및 RPC/Thread 불일치 대응
- **문제 진단**:
  - `codex-session-host.mjs`의 `_checkRolloutReady()`가 `thread/read`의 RPC error나 thread ID 불일치 시 아무런 if문도 만족하지 않고 `ready: true`를 반환하는 심각한 fail-open 결함 존재.
- **해결 및 구현**:
  1. `_checkRolloutReady()`를 fail-closed 원칙으로 전면 재작성:
     - `if (!read || typeof read !== "object" || read.error)` -> `return { ready: false, reason: "thread_read_rpc_error" };`
     - `if (!thread || typeof thread !== "object" || thread.id !== serverThreadId)` -> `return { ready: false, reason: "thread_id_mismatch" };`
     - ephemeral thread 검사: turns가 남아 있으면 `return { ready: false, reason: "ephemeral_turns_present" };`
     - 영속 thread 검사: 경로 부재 시 `return { ready: false, reason: "missing_rollout_path" };`
     - 파일 검증: `!file.isFile() || file.isSymbolicLink()` 시 `return { ready: false, reason: "thread_rollout_not_regular_file" };`
  2. `tests/test_codex_live_handover.py`의 `wait_answer`:
     - 기존 `state.get('rolloutReady', True)`의 fallback True를 제거하고 `state.get('rolloutReady') is True`로 명시적 엄격 단언 적용.
- **실증 증거**:
  - Reviewer 재현 프로브(`.test-tmp/review008-fix03/rollout-ready-probe.mjs`) 재실행 결과:
    ```json
    {"ready":false,"reason":"thread_read_rpc_error"}
    {"ready":false,"reason":"thread_id_mismatch"}
    ```
    (기존에 둘 다 `{"ready":true}`로 잘못 통과하던 두 비정상 케이스가 안전하게 fail-closed 거부됨을 확인)

### §4. `Unreleased` changelog 추가로 인한 버전 일치 계약 해결
- **문제 진단**:
  - `CHANGELOG.md` 맨 위에 `## [Unreleased]` heading을 추가함에 따라, `tests/test_addon_contract.py:572`의 `test_app_and_dockerfile_versions_match`에서 첫 번째 heading을 파싱할 때 `assert 'Unreleased' == '0.7.3'`로 실패.
- **해결 및 구현**:
  - `tests/test_addon_contract.py`의 `test_app_and_dockerfile_versions_match`를 수정하여, `CHANGELOG.md`의 heading 중 `[Unreleased]`를 제외한 첫 번째 유효한 릴리스 버전 heading(`0.7.3`)을 찾아 `addon_config["version"]`, `Dockerfile`, `package.json`과 일치하는지 엄격히 단언하도록 개선.
- **실증 증거**:
  - `pytest tests/test_addon_contract.py -k "test_app_and_dockerfile_versions_match"` -> **1 passed in 0.06s**.

### §5. 사용자 문서 2단계 예산 정책 및 Netlink 기술 현행화
- **문제 진단**:
  - 문서에서 기존 5분/12회 빠른 확인 설명을 삭제하고 "1시간 간격 최대 4회"로만 잘못 기술했으며, 같은 날짜의 paused 후보가 다음 6시간 정기 슬롯에서 자동 재개된다고 잘못 안내함.
- **해결 및 구현**:
  - `codex_home_assistant/DOCS.md` 및 `DOCS.en.md`:
    1. **빠른 재확인**: 작업 직후 5분 간격, 날짜별 최대 12회 (약 1시간).
    2. **저빈도 재확인**: 빠른 확인 소진 후 최소 60분 간격, 날짜별 최대 4회 (약 4시간).
    3. **소진 및 재개**: 16회 모두 소진 시 당일(`budgetDate`) 동안 일시 보류(`paused_busy`)를 유지하며, 익일 03:00 슬롯의 date rollover로 카운터가 초기화되면서 적용이 자동 재개되거나 관리자가 `ha-codex-update apply`를 수동 호출하여 즉시 적용 가능.
    4. **피어 식별**: 커널 `UNIX_DIAG` Netlink 피어 소켓 매핑을 통해 AppArmor의 `/proc/*/environ` 거부 환경에서도 안전하게 helper로 귀속됨을 명시.
  - `codex_home_assistant/CHANGELOG.md`: `## [Unreleased]` 섹션에 동일 내용 정밀 반영.

### §6. 실제 데몬 수명주기 결정론적 단일 버전 단언
- **문제 진단**:
  - `test_issue71_real_daemon_continuous_lifecycle`에서 date rollover 시 프로덕션 `checkUpdate()`가 외부 GitHub API를 호출하여 최신 버전(0.167.0)을 다운로드함으로써, 단언이 `assert res["finalVersion"] in ("0.163.0", "0.167.0")`로 가변적이던 문제.
- **해결 및 구현**:
  - `codex-updater-daemon.mjs`에 `setTestCheckHook` 및 `setTestCheckOptions` 주입점을 지원.
  - 테스트에서 고정된 0.163.0 staged 패키지를 유지하도록 hook을 주입하여, 외부 네트워크 의존성 및 버전 가변성을 완전히 배제.
  - `assert res["finalVersion"] == "0.163.0"` 단일 단언 달성 (실행 시간 12.04초 → 0.96초로 단축).

---

## 3. 검증 결과 요약

### 3.1. 전체 pytest suite 실행 결과 (저장소 21개 테스트 파일 전수)
```text
============================= test session starts ==============================
platform linux -- Python 3.13.15, pytest-8.4.1, pluggy-1.6.0
rootdir: /home/lee/projects/codex_for_HA
collected 339 items

tests/test_addon_contract.py ...................                         [  5%]
tests/test_api_client.py ..........                                      [  8%]
tests/test_browser_contract.py ............                              [ 12%]
tests/test_browser_user_provisioning_contract.py .......                 [ 14%]
tests/test_codex_activity.py ...............                             [ 18%]
tests/test_codex_live_handover.py ....                                   [ 19%]
tests/test_codex_update_contract.py .................................... [ 30%]
........................................................................ [ 51%]
.................................                                        [ 61%]
tests/test_codex_update_fix03.py ............                            [ 64%]
tests/test_codex_wire_probe.py s                                         [ 65%]
tests/test_codex_wrapper_proxy.py .........                              [ 67%]
tests/test_feedback_contract.py .............                            [ 71%]
tests/test_memory_contract.py ..........                                 [ 74%]
tests/test_multiarch_contract.py .......                                 [ 76%]
tests/test_remote_setup.py ............                                  [ 80%]
tests/test_runtime_contract.py .............                             [ 84%]
tests/test_secret_scan.py ..                                             [ 84%]
tests/test_sensitive_path_policy.py ...................                  [ 90%]
tests/test_token_boundary.py ......                                      [ 92%]
tests/test_user_files_update_contract.py ....                            [ 93%]
tests/test_vulnerability_gate_policy.py .....................s.          [100%]

================== 337 passed, 2 skipped in 191.48s (0:03:11) ==================
```

### 3.2. 핵심 항목별 검증 세부
| 검증 항목 | 대상 | 결과 | 비고 |
| :--- | :--- | :--- | :--- |
| **저장소 전체 테스트** | pytest 전체 21개 파일 (339 items) | **337 passed, 2 skipped in 191.48s** | 0 failures, 100% PASS |
| **실기 바이너리 핸드오버** | `tests/test_codex_live_handover.py` | **4 passed in 26.32s** | 0.162.1→0.167.0 실기 4종 + `activeCheck is None` 단언 통과 |
| **업데이트 계약 검증** | `tests/test_codex_update_contract.py` | **141 passed in 128.37s** | 데몬 수명주기/소켓/프록시 계약 100% 통과 |
| **결정론적 데몬 수명주기** | `test_issue71_real_daemon_continuous_lifecycle` | **1 passed in 0.96s** | `finalVersion == "0.163.0"` 단일 단언 통과 |
| **AppArmor Deny 귀속** | `test_issue71_default_proxy_apparmor_denied_environ` | **1 passed in 1.79s** | `/proc/*/environ` EACCES 격리 실증 통과 |
| **비밀값 및 토큰 검사** | `tests/test_secret_scan.py` | **2 passed in 1.15s** | 비밀값, 키, 토큰 누출 0건 |
| **정적 분석** | `node --check`, `bash -n`, `git diff --check` | **PASS (0 errors)** | Syntax 및 whitespace 무결성 확인 |
| **Rollout 음성 검증** | `.test-tmp/review008-fix03/rollout-ready-probe.mjs` | **PASS** | RPC error 및 thread ID mismatch 시 fail-closed 거부 |
| **성공 후 activeCheck 제거** | `.test-tmp/review008-fix03/managed-active-check-probe.py` | **PASS** | `persisted['activeCheck'] is None` 확인 |
| **무결성 차단 이력 영속화** | `.test-tmp/review008-fix03/integrity-history-probe.mjs` | **PASS** | `blocked_integrity` 이력 디스크 영속화 확인 |

---

## 4. 수용 행렬

| 요구사항 (PLAN / FIX_01 ~ FIX_04) | 구현 상태 | 검증 증거 |
| :--- | :---: | :--- |
| **1. 기본 소켓 경로 및 피어 매핑 귀속** | **완료** | Pass 3/4 결합으로 default proxy의 helper 정상 귀속 (`helpers: 1, unknown: 0, canApply: true`) |
| **2. 검사자 환경(`process.env`) 완전 배제** | **완료** | 대상 프로세스 정보만 안전 참조, S6/데몬 격리 환경 호환 |
| **3. 저빈도 4회 예산 및 03:00 date rollover** | **완료** | 실제 `daemon.loop()` 하에서 4회 연속 실행 후 5회차 스킵 및 익일 리셋 실증 |
| **4. 회차별(Check Number) 내구성 이력 저장** | **완료** | 검사 시작 시 디스크 원자적 저장 및 모든 차단/실패 경로 영속화 |
| **5. 적용 성공 후 디스크 `activeCheck` 원자적 정리** | **완료** | `finishSelection` 내 `state.activeCheck = null` 명시 저장, 실기 단언 PASS |
| **6. 차단/실패 분기 터미널 이력 누락 방지** | **완료** | `blocked_integrity`, `blocked_policy`, `blocked_verification` 기록 실증 |
| **7. `rolloutReady` fail-closed 강화** | **완료** | RPC error 및 thread mismatch 차단 실증, live handover 단언 적용 |
| **8. Unreleased changelog 버전 일치 계약 해결** | **완료** | `test_app_and_dockerfile_versions_match` 통과 (337 passed) |
| **9. 2단계 예산 정책 및 Netlink 피어 문서화** | **완료** | DOCS.md, DOCS.en.md, CHANGELOG.md 반영 완료 |
| **10. 데몬 시험 결정론적 단일 버전 단언** | **완료** | `finalVersion == "0.163.0"` 단일 단언 달성 (0.96s) |

---

## 5. 정직한 잔여 미검증 범위 (Unverified Scope)

- **HAOS / Raspberry Pi ARM 실기 기기**: 로컬 리눅스 x86_64 환경에서 공식 바이너리(0.162.1, 0.166.0, 0.167.0)로 전수 검증을 완료하였으나, 실제 Raspberry Pi 4/5 하드웨어 및 native aarch64 실기기에서의 동작은 **NOT RUN**이다 (0.7.4-dev.N 배포 후 실기 수용 단계에서 진행 필요).
- **외부 배포 / GitHub PR / Release**: 절대 조건 및 프로젝트 규칙에 따라 로컬 브랜치 `feat/issue-71-default-socket-observability` 내에서만 작업을 완결하였으며, 원격 push나 릴리스 게시는 일체 수행하지 않았다.

---

## 6. 결론

Reviewer Codex가 `FIX_04`에서 지적한 5대 결함을 근본적으로 해결하고, 저장소 전체 테스트 스위트 339개 전수 실행에서 **337 passed, 2 skipped, 0 failed (100% PASS)**를 공식 입증하였다.
이에 `FIX_04_REPORT.md`를 제출하며 Reviewer의 최종 확인 및 인수를 요청한다.
