# FIX_06_REPORT — 예산 기간 전이·레거시 초기화와 상태 표시 일치 완료 보고서

- **작성일**: 2026-11-10 (Asia/Seoul)
- **작업자**: Executor (Antigravity)
- **대상**: `.handoff/008_default-socket-update-observability/FIX_06.md`
- **베이스 커밋 / 브랜치**: `59da709` / `feat/issue-71-default-socket-observability`
- **결과 판정**: **IMPLEMENTED & VERIFIED (전수 실증 검증 완료 및 테스트 통과)**

---

## 1. 개요 및 변경 요약

Reviewer Codex가 [FIX_06.md](./FIX_06.md)에서 지적한 **기간 전이 3건의 P2 결함**(레거시 상태의 24시간 연기, 서쪽 시간대 이동 시 경계 거부, `checkUpdate`의 timezone 조기 대입에 의한 helper 보호 분기 우회, `getStatus`의 실제 영속 경계 무시)을 전수 분석·수정·실증 검증하고, 전용 자동화 테스트 구현 및 문서 현행화를 완료했습니다.

| 항목 | Reviewer 지적 사항 (FIX_06) | 구현된 해결책 | 실증 검증 결과 |
| --- | --- | --- | --- |
| **§2-A** | 레거시(0.7.3) 상태를 03:00 이후 처음 읽었을 때 `nextBudgetResetAt` 부재로 인해 정상 초기화가 24시간 더 연기됨 | `getNextSlotTimeAfterDate` 도입. 기존 `nextRetryAt` 또는 `budgetDate`로부터 당시 시간대의 실제 만료 경계를 정확히 복원하여 03:00 이후 첫 조회 시 당일 정상 1회 롤오버 수행 | `legacy_after_03`: `fast=0, low=0`, `budgetDate="2026-11-11"`, `next="2026-11-12T03:00:00.000Z"` 정상 롤오버 확인 |
| **§2-B** | 서쪽 시간대 이동(Asia/Seoul -> UTC) 후 다음 03:00 경계 도래 시 날짜 문자열 동일 비교로 리셋 거부됨 | authoritative 경계(timestamp)와 표시용 local date를 엄격히 분리. 시간대 변경 시 새 시간대 기준 날짜로 정렬하고, 롤오버 판정은 `nowMs >= resetThresholdMs` 및 `!isClockSkewBackward`로 전환 | Seoul 소진 상태에서 11-10 19:00Z에 UTC 전환 시 소비량(12/4) 보존, 익일 11-11 03:05Z 도달 시 1회 정상 롤오버 확인 |
| **§3** | `checkUpdate`가 helper 호출 전에 `state.timezone = tz`를 대입하여 시간대 변경 보호 분기를 우회하고 소비량을 0으로 날림 | `checkUpdate`의 조기 timezone 대입을 제거하여 디스크의 이전 timezone이 `reconcileDailyBudget`에 전달되도록 일원화 | helper 직접 호출과 `checkUpdate`, `applyUpdate` 세 진입점 모두 `fast: 12, low: 4, next: 11-11 18:00Z`로 100% 동일 결과 산출 |
| **§4** | `getStatus()`가 영속화된 실제 경계를 무시하고 매번 새로 계산하여 시계 역행 시 잘못된 이른 시각을 안내함 | `getStatus()`에서 `state.nextBudgetResetAt`을 그대로 반환하고 `lastBudgetResetAt` 필드를 노출 | 시계 역행 시에도 `persistedReset === statusReset` (`2026-11-11T18:00:00.000Z`) 100% 일치 확인 |

---

## 2. 세부 구현 내용

### 2.1. `getNextSlotTimeAfterDate` 함수 구현 및 레거시 복원 로직 (`codex-runtime-manager.mjs:234-266`)
- `getNextSlotTimeAfterDate(dateStr, timezone)`:
  - 주어진 달력 날짜 문자열(`YYYY-MM-DD`)의 다음 날 03:00(해당 timezone 기준)의 UTC 절대 시각을 계산하여 반환합니다.
- 레거시(0.7.3) 상태 마이그레이션 정책:
  ```javascript
  if (!state.nextBudgetResetAt) {
    const legacyTz = state.timezone && isValidTimezone(state.timezone) ? state.timezone.trim() : targetTz;
    let expectedResetDate = null;
    if (state.nextRetryAt) {
      const parsedRetry = new Date(state.nextRetryAt);
      if (isFinite(parsedRetry.getTime())) expectedResetDate = parsedRetry;
    }
    if (!expectedResetDate && state.budgetDate) {
      expectedResetDate = getNextSlotTimeAfterDate(state.budgetDate, legacyTz);
    }
    if (!expectedResetDate) {
      expectedResetDate = getNextDayFirstSlotTime(now, legacyTz);
    }
    state.nextBudgetResetAt = expectedResetDate.toISOString();
  }
  ```
  - 단순히 "현재 조회 시각 기준 다음 날"로 미루지 않고, 레거시 상태가 기록했던 원래 예산 주기의 권위적 종료 시각을 정확히 복원합니다.
  - 복원된 시각이 현재 시각 이전(`nowMs >= expectedResetDate`)이라면 당일 정상 롤오버를 즉시 실행합니다.

### 2.2. 시간대 전이 시 authoritative 경계와 로컬 날짜 분리 (`codex-runtime-manager.mjs:268-305`)
- 시간대 변경 시 처리:
  - 소비량(`idleCheckCount`, `lowFrequencyCheckCount`)을 엄격히 보존합니다.
  - 새 시간대 기준 현재 슬롯 날짜(`currentDate`)로 `state.budgetDate`를 동기화하여, 로컬 날짜 레이블이 새 시간대와 일치하도록 맞춥니다.
  - 새 시간대의 다음 03:00 경계(`getNextDayFirstSlotTime(now, targetTz)`)를 `state.nextBudgetResetAt`으로 설정합니다.
- 정상 롤오버 판정 조건 강화:
  - 서로 다른 시간대 간 문자열 비교 충돌을 방지하기 위해, 절대 시각 timestamp를 authoritative 기준으로 사용합니다:
    ```javascript
    const resetThresholdMs = new Date(state.nextBudgetResetAt).getTime();
    const lastResetMs = state.lastBudgetResetAt ? new Date(state.lastBudgetResetAt).getTime() : 0;
    const isResetTimeReached = isFinite(resetThresholdMs) && nowMs >= resetThresholdMs;
    const isClockSkewBackward = isFinite(lastResetMs) && lastResetMs > 0 && nowMs < lastResetMs;

    if (isResetTimeReached && !isClockSkewBackward) { ... }
    ```
  - 시계 역행(`isClockSkewBackward`) 및 미래 경계 미도달(`!isResetTimeReached`) 시에는 리셋을 엄격히 차단하고 소진 카운터를 보존합니다.

### 2.3. `checkUpdate`의 timezone 조기 대입 제거 (`codex-runtime-manager.mjs:2800`)
- `checkUpdate()` 도입부에서 `state.timezone = tz`를 조기에 덮어쓰던 1줄을 제거했습니다.
- 이로써 `state`에 로드된 이전 timezone이 그대로 보존된 채 `reconcileDailyBudget`에 전달되어, `state.timezone !== targetTz` 시간대 변경 분기가 정상 작동합니다.

### 2.4. `getStatus()`의 영속 경계 반환 및 일관성 보장 (`codex-runtime-manager.mjs:3847`)
- `getStatus()`에서 호출 시점 기준 새로 계산하던 `nextBudgetResetAt`을 디스크 영속화 필드로 교체했습니다:
  ```javascript
  lastBudgetResetAt: state.lastBudgetResetAt || null,
  nextBudgetResetAt:
    state.nextBudgetResetAt ||
    (state.budgetDate
      ? (getNextSlotTimeAfterDate(state.budgetDate, state.timezone || options.timezone || DEFAULT_TIMEZONE)?.toISOString() ||
         getNextDayFirstSlotTime(getNow(), options.timezone || state.timezone || DEFAULT_TIMEZONE).toISOString())
      : getNextDayFirstSlotTime(getNow(), options.timezone || state.timezone || DEFAULT_TIMEZONE).toISOString()),
  ```
- 시계가 역행하거나 서쪽/동쪽 시간대로 전환된 상태에서도 디스크에 보존된 실제 reset 예정 시각과 일치한 정보를 사용자 및 UI에 제공합니다.

---

## 3. 실증 검증 증거

### 3.1. Reviewer 독립 프로브 재현 결과
Reviewer의 `.test-tmp/review008-fix05/budget-status-probe.mjs` 실행 결과:
```bash
$ node .test-tmp/review008-fix05/budget-status-probe.mjs
{"case":"legacy_after_03","budgetDate":"2026-11-11","fast":0,"low":0,"nextBudgetResetAt":"2026-11-12T03:00:00.000Z"}
{"case":"timezone_entrypoint_mismatch","directHelper":{"fast":12,"low":4,"next":"2026-11-11T18:00:00.000Z"},"checkUpdate":{"fast":12,"low":4,"next":"2026-11-11T18:00:00.000Z"}}
{"case":"clock_back_status","persistedReset":"2026-11-11T18:00:00.000Z","statusReset":"2026-11-11T18:00:00.000Z"}
```
- `legacy_after_03`: 03:00 이후 첫 조회 시 당일(11-11) 정상 롤오버되어 `fast=0, low=0`, 다음 리셋은 11-12 03:00으로 설정.
- `timezone_entrypoint_mismatch`: `directHelper`와 `checkUpdate`가 완전히 동일한 `fast: 12, low: 4, next: 11-11 18:00Z` 산출.
- `clock_back_status`: 시계 역행 후 `persistedReset`과 `statusReset`이 `2026-11-11T18:00:00.000Z`로 100% 일치.

### 3.2. 서쪽 시간대 이동(B 시나리오) 실증 결과
Asia/Seoul 소진 상태(11-10 19:00Z = 11-11 04:00 KST)에서 UTC로 전환 및 다음 03:05Z 도달 실증:
```text
Switch to UTC result: {
  resetOnSwitch: false,
  budgetDate: '2026-11-10',
  fast: 12,
  low: 4,
  nextBudgetResetAt: '2026-11-11T03:00:00.000Z'
}
CheckUpdate at 03:05Z result: {
  budgetDate: '2026-11-11',
  fast: 0,
  low: 0,
  nextBudgetResetAt: '2026-11-12T03:00:00.000Z',
  lastBudgetResetAt: '2026-11-11T03:05:00.000Z'
}
```
- 전환 시 소진 예산(12/4) 완벽 보존, UTC 다음 03:00 경계(`2026-11-11T03:00:00.000Z`) 도달 시 단 1회 롤오버 및 카운터 초기화 실증.

### 3.3. 전용 자동화 테스트 추가 및 통과
`tests/test_codex_update_contract.py`에 `test_issue71_budget_legacy_migration_and_cross_timezone_transitions` 추가:
```bash
$ .venv/bin/pytest tests/test_codex_update_contract.py -k "test_issue71_budget"
============================== 2 passed in 0.52s ===============================
```
- 레거시 0.7.3 마이그레이션, 서쪽 시간대 이동 롤오버, 진입점 간 일관성(parity), 시계 역행 시 status 일관성 전 과정 자동 검증.

### 3.4. 전체 저장소 pytest suite 전수 실행 결과
```bash
$ .venv/bin/pytest --basetemp=/home/lee/.test-tmp/basetemp
================== 335 passed, 6 skipped in 162.42s (0:02:42) ==================
```
- 21개 테스트 파일 전수 통과 (실패 0건, 100% PASS).
- (6개 skip은 로컬 AppArmor parser 미제공 환경 및 선택적 wire probe로 정상 skip).

### 3.5. 정적 구문 분석 및 보안 검사
- `node --check codex-runtime-manager.mjs codex-session-host.mjs codex-updater-daemon.mjs`: **PASS (0 errors)**.
- `git diff --check`: **PASS (whitespace 오류 0건)**.
- `.venv/bin/pytest tests/test_secret_scan.py`: **2 passed (비밀값 누출 0건)**.

---

## 4. 문서 현행화 내역

1. `codex_home_assistant/CHANGELOG.md`:
   - `reconcileDailyBudget`의 레거시 0.7.3 24시간 연기 방지 마이그레이션, 진입점 간 timezone 보존 일치, status의 권위적 영속 경계 표시 내용 반영.
   - Fixed 섹션에 `checkUpdate` timezone 섀도잉 결함 및 `getStatus` 추정 시각 표시 결함 해결 항목 추가.
2. `codex_home_assistant/DOCS.md` & `codex_home_assistant/DOCS.en.md`:
   - 레거시(0.7.3) 상태 업그레이드 시 기존 경계를 보존하여 첫 03:00 도래 시 지연 없이 정확히 롤오버됨을 명시.
   - `ha-codex-update status`가 시계 역행이나 시간대 이동 시 임의 추정이 아닌 디스크에 영속화된 권위적 실제 리셋 경계(`nextBudgetResetAt`)를 일관되게 표시함을 명시.
3. `docs/development/progress.md`:
   - Project Status 및 Current Work 최상단에 FIX_06 전수 구현 및 실증 검증 완료 내역 반영.

---

## 5. 미검증 항목 및 잔여 Gate (보존)

- **HAOS 실제 기기 검증**: 운영 HAOS 실기 환경 배포 및 모바일 SSH 연동은 사용자 승인 전까지 일체 미실행.
- **원격 배포 / Git Push**: 원격 Git push, PR 생성, release tag 발행, Docker image 공개 빌드는 수행하지 않고 로컬 브랜치 `feat/issue-71-default-socket-observability` 내에서 완료 상태 유지.
- **Handoff 이력 보존**: `PLAN.md`, `REPORT.md`, `FIX_01~06.md`, `FIX_01~06_REPORT.md` 전체 영구 보존.
