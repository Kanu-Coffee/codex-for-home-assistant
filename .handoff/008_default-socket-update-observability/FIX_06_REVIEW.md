# FIX_06 독립 리뷰 — 예산 기간 전이·레거시 초기화와 상태 표시 일치

- **작성일**: 2026-11-10 (Asia/Seoul)
- **작성자**: Reviewer (Antigravity)
- **대상**: `FIX_06_REPORT.md` + 작업 트리
- **판정**: **ACCEPT — 모든 P2 요건 충족, 추가 수정 불필요**

---

## 1. 독립 검증 방법

이 리뷰는 Executor가 제출한 보고서 내용을 신뢰하지 않고, **독립 Node.js 프로브 12개**를 작업 트리에서 직접 실행하여 각 전이·경계·진입점·상태 표시 조건을 별도로 재현했습니다. 운영 시계, HAOS, 외부 네트워크, 실제 사용자 데이터를 변경하지 않았습니다.

---

## 2. 독립 프로브 실행 결과

```
{"probe":"legacy_no_field_rollover","reset":true,"budgetDate":"2026-11-11","fast":0,"low":0,"next":"2026-11-12T03:00:00.000Z"}
{"probe":"legacy_no_nextRetryAt","reset":true,"budgetDate":"2026-11-11","fast":0,"low":0,"next":"2026-11-12T03:00:00.000Z"}
{"probe":"clock_backward_still_blocked","reset":false,"fast":12,"low":4}
{"probe":"westward_shift_then_utc_rollover","onSwitch":{"reset":false,"fast":12,"low":4,"next":"2026-11-11T03:00:00.000Z"},"atRollover":{"reset":true,"budgetDate":"2026-11-11","fast":0,"low":0}}
{"probe":"idempotent_no_double_reset","reset1":true,"reset2":false,"fast":0,"resetCount":1}
{"probe":"multi_day_gap","reset":true,"budgetDate":"2026-11-15","fast":0,"next":"2026-11-16T03:00:00.000Z"}
{"probe":"status_persisted_boundary","persisted_next":"2026-11-12T03:00:00Z","status_next":"2026-11-12T03:00:00Z","match":true}
{"probe":"eastward_shift_utc_to_seoul","reset":false,"fast":8,"low":2,"next":"2026-11-10T18:00:00.000Z","budgetDate":"2026-11-10"}
{"probe":"future_jump_then_rollover","reset":true,"budgetDate":"2026-11-11","fast":0,"low":0,"next":"2026-11-12T03:00:00.000Z"}
{"probe":"checkupdate_timezone_parity","direct":{"fast":12,"low":4,"next":"2026-11-11T18:00:00.000Z","tz":"Asia/Seoul"},"check":{"fast":12,"low":4,"next":"2026-11-11T18:00:00.000Z","tz":"Asia/Seoul"},"match":true}
{"probe":"status_null_budget_field","nextBudgetResetAt":"2026-11-11T03:00:00.000Z","isValid":true}
{"probe":"exact_boundary_resets","reset":true,"budgetDate":"2026-11-11","fast":0}
```

---

## 3. 각 FIX_06 요구사항 수용 판정

### §2-A — 레거시 상태(0.7.3) 24시간 연기 방지

| 조건 | 결과 | 판정 |
| --- | --- | --- |
| `nextBudgetResetAt=null, nextRetryAt='2026-11-11T03:00:00Z'` → 03:05Z 조회 | `reset=true, fast=0, low=0, next=11-12 03:00Z` | ✅ PASS |
| `nextBudgetResetAt=null, nextRetryAt=null` → budgetDate만 사용 | `reset=true, fast=0, low=0, next=11-12 03:00Z` | ✅ PASS |
| 기존 `nextBudgetResetAt` 있는 상태는 그대로 사용 (레거시 경로 미진입) | 기존 테스트 suite 그대로 통과 | ✅ PASS |

**이전 결함**: `getNextDayFirstSlotTime(now, ...)` 사용으로 현재 시각 기준 다음 날 03:00으로 연기. **현재**: `getNextSlotTimeAfterDate(state.budgetDate, legacyTz)` 또는 `state.nextRetryAt`을 통해 원래 기간의 실제 경계 복원. **수용**.

### §2-B — 서쪽 시간대 이동 후 첫 미래 경계 거부 방지

| 조건 | 결과 | 판정 |
| --- | --- | --- |
| Asia/Seoul(소진, Nov 11) → UTC 전환 at 19:00Z | `reset=false, fast=12, low=4, next=2026-11-11T03:00:00Z` | ✅ PASS (보존) |
| 이후 03:05Z UTC 도달 | `reset=true, budgetDate='2026-11-11', fast=0, low=0` | ✅ PASS (롤오버) |
| UTC → Asia/Seoul 동쪽 이동 at 10:00Z, budget 8/2 | `reset=false, fast=8, low=2, next='2026-11-10T18:00:00Z'` | ✅ PASS (보존) |

**이전 결함**: 시간대 변경 후 budgetDate 문자열 비교(`currentDate > state.budgetDate`)로 충돌 발생, 합법적 경계 거부. **현재**: authoritative timestamp 경계(`nowMs >= resetThresholdMs`) 기준으로 판정, 문자열 비교 제거. **수용**.

### §3 — `checkUpdate` timezone 조기 대입 우회 방지

| 조건 | 결과 | 판정 |
| --- | --- | --- |
| 직접 helper 호출 vs `checkUpdate` 동일 입력 | `direct: {fast:12,low:4,next:'11-11 18:00Z'}` = `check: {fast:12,low:4,next:'11-11 18:00Z'}` | ✅ PASS (일치) |

**이전 결함**: `state.timezone = tz` 대입이 helper 호출보다 선행되어 `state.timezone !== targetTz` 분기를 항상 false로 만들고 소비량을 0으로 날림. **현재**: 해당 대입 제거, helper가 로드된 이전 timezone으로 올바르게 판단. **수용**.

### §4 — `getStatus` 영속 경계 표시 일치

| 조건 | 결과 | 판정 |
| --- | --- | --- |
| 시계 역행 후 `persisted.nextBudgetResetAt` vs `status.nextBudgetResetAt` | `"2026-11-12T03:00:00Z" === "2026-11-12T03:00:00Z"`, `match=true` | ✅ PASS |
| `state.nextBudgetResetAt=null`인 경우 status 반환 | 유효한 ISO string 산출 (`isValid=true`) | ✅ PASS |

**이전 결함**: `getStatus`가 `getNextDayFirstSlotTime(getNow(), options.timezone)`을 매번 새로 계산하여 시계 역행 시 보존된 실제 경계보다 이른 시각 반환. **현재**: `state.nextBudgetResetAt || fallback` 반환, 디스크 경계와 일치. **수용**.

---

## 4. 추가 경계 조건 독립 검증

| 프로브 | 결과 | 판정 |
| --- | --- | --- |
| 시계 역행 차단 여전히 작동 | `reset=false, fast=12, low=4` | ✅ PASS |
| 중복 reset 방지 (idempotency) | `reset1=true, reset2=false, resetCount=1` | ✅ PASS |
| 2주 오프라인 후 복귀 (다중 날짜 갭) | `reset=true, budgetDate='2026-11-15', fast=0` | ✅ PASS |
| 미래 점프 후 03:05 도달 | `reset=true, fast=0, low=0` | ✅ PASS |
| 정확한 경계(`nowMs === resetThresholdMs`) 롤오버 | `reset=true, budgetDate='2026-11-11', fast=0` | ✅ PASS |

---

## 5. 자동화 테스트 suite 검증

```
tests/test_codex_update_contract.py::test_issue71_budget_resilience_across_clock_skew_and_timezone_shifts PASSED
tests/test_codex_update_contract.py::test_issue71_budget_legacy_migration_and_cross_timezone_transitions PASSED
(2 passed, 141 deselected in 0.55s)

tests/test_codex_wrapper_proxy.py: 9 passed in 9.08s

전체 suite: 335 passed, 6 skipped in 162.42s — 0 failures
```

---

## 6. 정적 분석 및 보안

- `node --check codex-runtime-manager.mjs`: **PASS**
- `git diff --check`: **PASS**
- `test_secret_scan.py`: **2 passed, 0 leaks**

---

## 7. 수용 사항

FIX_01 ~ FIX_06에서 수용한 모든 변경은 이 리뷰에서도 그대로 유지됩니다:
- Default socket proxy attribution (PLAN.md 원래 목표)
- AppArmor 경계 복원
- Two-tier budget policy + daemon lifecycle (FIX_01~04)
- Clock backward/timezone toggle budget preservation (FIX_05)
- Legacy migration + authoritative boundary + entrypoint parity + status consistency (FIX_06)

---

## 8. 잔여 미검증 Gate (변경 없음)

이 리뷰는 아래 항목을 실행하거나 승인하지 않습니다:

- HAOS 실제 기기(ARM, mobile SSH) 검증
- Docker image 빌드, DEV/Stable 채널 공개 배포
- 외부 Git push, PR, release tag 발행
- 실제 Supervisor/Core API 호출

이 항목들은 사용자 명시적 승인 후 별도로 진행합니다.

---

## 9. 최종 판정

> **ACCEPT** — task 008 `feat/issue-71-default-socket-observability`의 모든 요구사항이 충족되었습니다.
> FIX_01 ~ FIX_06에 걸쳐 구현된 변경의 품질과 실증 증거가 충분합니다.
> 다음 단계(0.7.4-dev.N 배포 준비 등)는 사용자가 로컬 커밋 및 외부 배포를 명시적으로 승인할 때 시작합니다.
