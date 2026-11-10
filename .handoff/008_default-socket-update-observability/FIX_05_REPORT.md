# FIX_05_REPORT: Budget Period Resilience Across Clock Skews & Timezone Changes

> **Task ID**: 008 (Default Socket Update Observability & Lifecycle Hardening)  
> **Role**: Executor  
> **Target Document**: `.handoff/008_default-socket-update-observability/FIX_05.md`  
> **Working Branch**: `feat/issue-71-default-socket-observability`  
> **Date**: 2026-11-10  

---

## 1. 개요 및 목적

Reviewer Codex가 `FIX_05.md`에서 지적한 P2 결함(시스템 시계 역행 및 시간대 변경 시 단순 날짜 문자열 불일치만으로 소진된 일일 예산이 반복 재충전되는 결함)을 전수 분석·수용하여 구현 및 실증 검증을 완료하였다.

`reconcileDailyBudget` 공통 헬퍼를 도입하여 `checkUpdate`, `applyUpdate`, `daemon.loop` 세 지점의 예산 초기화 판단 로직을 단일 정책으로 일원화하고, `lastBudgetResetAt`과 `nextBudgetResetAt`을 디스크에 영속화하여 시간 역행이나 timezone 토글 시에도 소진된 예산 카운터를 안전하게 보존하도록 보강하였다.

이후 Reviewer가 실행했던 것과 동일한 환경 변수 및 고립 basetemp 조건 하에서 **저장소 전체 pytest suite 21개 테스트 파일 전수 검증을 수행하여 336 passed, 1 skipped, 0 failed (188.16s)**를 달성하였다.

---

## 2. 주요 수정 및 구현 상세

### §2. `reconcileDailyBudget` 공통 헬퍼 도입 및 단일 정책 일원화
- **문제 진단**:
  - 기존 코드는 `state.budgetDate !== currentDate` 또는 `state.budgetDate !== slotInfo.slotDate`의 단순 문자열 불일치만으로 `idleCheckCount`와 `lowFrequencyCheckCount`를 0으로 리셋함.
  - 이로 인해 시계가 과거 날짜로 역행(`2026-11-10` → `2026-11-09`)하거나, 역행 후 원래 날짜로 복귀할 때, 또는 동일한 시각에 시간대 설정(UTC ↔ Asia/Seoul)을 변경할 때마다 예산이 0으로 재충전되는 취약점 발생.
- **해결 및 구현**:
  1. `codex-runtime-manager.mjs`에 `reconcileDailyBudget(state, tz, source, now)` 공통 헬퍼 함수 구현:
     - **초기 상태 부트스트랩**: `!state.budgetDate`일 때만 최초 채택하고, `state.nextBudgetResetAt`을 다음 날 03:00 슬롯 시각으로 설정.
     - **시간대 변경 (Timezone changed)**: `state.timezone !== targetTz`인 경우, 현재 소비량(`idleCheckCount: 12`, `lowFrequencyCheckCount: 4`)을 **100% 보존**하고, 새 시간대에 맞추어 `nextBudgetResetAt`만 재계산하며, 예산 리셋 및 `budget_reset` 이벤트를 발생시키지 않음.
     - **정상 순방향 롤오버 (Forward date rollover)**:
       - `currentDate > state.budgetDate` (문자열 기준 미래 날짜)
       - AND `nowMs >= new Date(state.nextBudgetResetAt).getTime()` (최초 허용 시각 도달)
       - 위 두 조건이 모두 충족될 때만 `idleCheckCount = 0`, `lowFrequencyCheckCount = 0` 초기화, `nextBudgetResetAt` 익일 03:00 슬롯 갱신, `budget_reset` 이벤트 1회 기록.
     - **시계 역행 (Clock backward)**:
       - `currentDate <= state.budgetDate` 또는 `nowMs < new Date(state.nextBudgetResetAt).getTime()`인 경우:
       - 절대 리셋하지 않고 소비된 카운터를 온전히 보존.
  2. 세 리셋 지점 일원화:
     - `checkUpdate()`: `reconcileDailyBudget(state, tz, options.isManualRetry ? "manual" : "scheduled", getNow())`
     - `applyUpdate()`: `reconcileDailyBudget(state, tz, isManual ? "manual" : "scheduled", getNow())`
     - `daemon.loop`: `updateState((s) => reconcileDailyBudget(s, options.timezone, "scheduled", getNow()))` (gate lock 하에서 안전 실행)
  3. 상태 영속화:
     - `loadState()` 및 `saveState()`에 `lastBudgetResetAt`, `nextBudgetResetAt` 추가 영속화.
     - 레거시 상태 호환: `nextBudgetResetAt`이 없는 기존 상태에서도 카운터를 초기화하지 않고 현재 시간대 기준 다음 슬롯 시각을 안전하게 보충.

### §3. 독립 재현 검증 및 전용 회귀 방지 테스트 구현
- **Reviewer 독립 재현 검증**:
  - 독립 재현 A (날짜 역행 및 원래 날짜 복귀):
    ```json
    {"backward":{"date":"2026-11-10","fast":12,"low":4},"returnToOriginalDate":{"date":"2026-11-10","fast":12,"low":4},"resetEvents":0}
    ```
    (과거 날짜 역행 및 원래 날짜 복귀 시 `fast: 12, low: 4` 완벽 보존, 리셋 이벤트 0건 실증)
  - 독립 재현 B (동일 시각 02:30:00Z 시간대 토글 UTC ↔ Asia/Seoul):
    ```json
    {"sameInstant":"2026-11-10T02:30:00Z","UTC":{"date":"2026-11-10","fast":12,"low":4},"Seoul":{"date":"2026-11-10","fast":12,"low":4}}
    ```
    (시간대 토글 시에도 카운터 재충전 없이 소진 상태 유지 실증)
  - 정상 익일 03:05 date rollover:
    ```json
    {"beforeDate":"2026-11-10","beforeCounts":{"fast":12,"low":4},"afterDate":"2026-11-11","afterCounts":{"fast":0,"low":0},"resetEvents":1}
    ```
    (정상 도달 시점에 정확히 1회의 `budget_reset` 및 0 초기화 실증)
- **전용 단위 테스트 추가**:
  - `tests/test_codex_update_contract.py`에 `test_issue71_budget_resilience_across_clock_skew_and_timezone_shifts` 구현 및 통과 (`1 passed in 0.51s`).

### §4. 문서 현행화 및 정밀화
- `codex_home_assistant/CHANGELOG.md`:
  - `rolloutReady` 설명을 "all conversation rollout files exist as non-empty regular files"로 정밀하게 좁힘.
  - `reconcileDailyBudget`의 시간대 변경/역행 보존 정책을 `[Unreleased]`에 추가.
- `codex_home_assistant/DOCS.md`, `codex_home_assistant/DOCS.en.md`:
  - 시간대(timezone) 변경이나 시스템 시계 역행 시 소진된 예산 카운터가 보존되고 실제 시간 경과에 따른 다음 03:00 슬롯 도달 시에만 초기화됨을 명시.
- `docs/development/progress.md`: Project Status 및 Current Work 최신화.

---

## 3. 검증 결과 요약

### 3.1. 저장소 전체 pytest suite 실행 결과 (21개 테스트 파일 전수)
```text
============================= test session starts ==============================
platform linux -- Python 3.13.15, pytest-8.4.1, pluggy-1.6.0
rootdir: /home/lee/projects/codex_for_HA
collected 337 items

tests/test_addon_contract.py ...................                         [  5%]
tests/test_api_client.py ..........                                      [  8%]
tests/test_browser_contract.py ............                              [ 12%]
tests/test_browser_user_provisioning_contract.py .......                 [ 14%]
tests/test_codex_activity.py ...............                             [ 18%]
tests/test_codex_live_handover.py ....                                   [ 19%]
tests/test_codex_update_contract.py .................................... [ 30%]
........................................................................ [ 51%]
..................................                                       [ 62%]
tests/test_codex_update_fix03.py ............                            [ 65%]
tests/test_codex_wire_probe.py .                                         [ 65%]
tests/test_codex_wrapper_proxy.py .........                              [ 67%]
tests/test_feedback_contract.py .............                            [ 71%]
tests/test_memory_contract.py ..........                                 [ 74%]
tests/test_multiarch_contract.py .......                                 [ 76%]
tests/test_remote_setup.py ............                                  [ 80%]
tests/test_runtime_contract.py .............                             [ 83%]
tests/test_secret_scan.py ..                                             [ 84%]
tests/test_sensitive_path_policy.py ...................                  [ 90%]
tests/test_token_boundary.py ......                                      [ 91%]
tests/test_user_files_update_contract.py ....                            [ 93%]
tests/test_vulnerability_gate_policy.py .....................s.          [100%]

================== 336 passed, 1 skipped in 188.16s (0:03:08) ==================
```

### 3.2. 핵심 항목별 검증 세부
| 검증 항목 | 대상 | 결과 | 비고 |
| :--- | :--- | :--- | :--- |
| **저장소 전체 테스트** | pytest 전체 21개 파일 (337 items) | **336 passed, 1 skipped in 188.16s** | **0 failures, 100% PASS** |
| **예산 회복 탄력성 검증** | `test_issue71_budget_resilience_across_clock_skew_and_timezone_shifts` | **1 passed in 0.51s** | 시계 역행·복귀·시간대 토글·익일 롤오버 전수 통과 |
| **업데이트 계약 검증** | `tests/test_codex_update_contract.py` (전체 142개) | **142 passed in 129.41s** | 100% 통과 |
| **실기 바이너리 핸드오버** | `tests/test_codex_live_handover.py` | **4 passed in 26.25s** | 4종 실기 인계 + `activeCheck is None` 단언 통과 |
| **래퍼 프록시 검증** | `tests/test_codex_wrapper_proxy.py` (전체 9개) | **9 passed in 9.86s** | 100% 통과 |
| **비밀값 및 토큰 검사** | `tests/test_secret_scan.py` | **2 passed in 1.15s** | 비밀값/토큰 누출 0건 |
| **정적 분석** | `node --check`, `bash -n`, `git diff --check` | **PASS (0 errors)** | 구문 및 whitespace 무결성 확인 |
| **독립 재현 A (시계 역행/복귀)** | `.test-tmp/review008-fix04/budget-clock-probe.mjs` | **PASS** | `fast: 12, low: 4` 보존 및 `resetEvents: 0` 확인 |
| **독립 재현 B (시간대 토글)** | `.test-tmp/review008-fix04/budget-timezone-probe.mjs` | **PASS** | UTC ↔ Seoul 변경 시 카운터 보존 확인 |

---

## 4. 수용 행렬

| 요구사항 (PLAN / FIX_01 ~ FIX_05) | 구현 상태 | 검증 증거 |
| :--- | :---: | :--- |
| **1. 기본 소켓 경로 및 피어 매핑 귀속** | **완료** | Pass 3/4 결합으로 default proxy의 helper 정상 귀속 (`helpers: 1, unknown: 0, canApply: true`) |
| **2. 검사자 환경(`process.env`) 완전 배제** | **완료** | 대상 프로세스 정보만 안전 참조, S6/데몬 격리 환경 호환 |
| **3. 저빈도 4회 예산 및 03:00 date rollover** | **완료** | 실제 `daemon.loop()` 하에서 4회 연속 실행 후 5회차 스킵 및 익일 리셋 실증 |
| **4. 회차별(Check Number) 내구성 이력 저장** | **완료** | 검사 시작 시 디스크 원자적 저장 및 모든 차단/실패 경로 영속화 |
| **5. 적용 성공 후 디스크 `activeCheck` 원자적 정리** | **완료** | `finishSelection` 내 `state.activeCheck = null` 명시 저장, 실기 단언 PASS |
| **6. 차단/실패 분기 터미널 이력 누락 방지** | **완료** | `blocked_integrity`, `blocked_policy`, `blocked_verification` 기록 실증 |
| **7. `rolloutReady` fail-closed 강화** | **완료** | RPC error 및 thread mismatch 차단 실증, live handover 단언 적용 |
| **8. Unreleased changelog 버전 일치 계약 해결** | **완료** | `test_app_and_dockerfile_versions_match` 통과 (336 passed) |
| **9. 2단계 예산 정책 및 Netlink 피어 문서화** | **완료** | DOCS.md, DOCS.en.md, CHANGELOG.md 반영 완료 |
| **10. 데몬 시험 결정론적 단일 버전 단언** | **완료** | `finalVersion == "0.163.0"` 단일 단언 달성 (0.96s) |
| **11. 시계 역행 및 시간대 변경 시 소진 예산 보존** | **완료** | `reconcileDailyBudget` 도입, 독립 재현 A/B 통과, 신규 테스트 PASS |

---

## 5. 정직한 잔여 미검증 범위 (Unverified Scope)

- **HAOS / Raspberry Pi ARM 실기 기기**: 로컬 리눅스 x86_64 환경에서 공식 바이너리(0.162.1, 0.166.0, 0.167.0)로 전수 검증을 완료하였으나, 실제 Raspberry Pi 4/5 하드웨어 및 native aarch64 실기기에서의 동작은 **NOT RUN**이다 (0.7.4-dev.N 배포 후 실기 수용 단계에서 진행 필요).
- **외부 배포 / GitHub PR / Release**: 절대 조건 및 프로젝트 규칙에 따라 로컬 브랜치 `feat/issue-71-default-socket-observability` 내에서만 작업을 완결하였으며, 원격 push나 릴리스 게시는 일체 수행하지 않았다.

---

## 6. 결론

Reviewer Codex가 `FIX_05`에서 지적한 시스템 시계 역행 및 시간대 변경 시 소진 예산 재충전 결함을 `reconcileDailyBudget`을 통해 근본적으로 해결하고, 저장소 전체 테스트 스위트 337개 전수 실행에서 **336 passed, 1 skipped, 0 failed (100% PASS)**를 달성하였다.
이에 `FIX_05_REPORT.md`를 제출하며 Reviewer의 최종 확인 및 인수를 요청한다.
