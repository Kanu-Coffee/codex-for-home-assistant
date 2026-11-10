# FIX_06 — 예산 기간 전이·레거시 초기화와 상태 표시 일치

- 작성: 2026-11-10 (Asia/Seoul), Reviewer: Codex.
- 대상: HEAD `59da709` 이후 작업 트리, `FIX_05_REPORT.md`.
- 판정: **REQUEST CHANGES — 기존 시계 역행/단순 timezone 토글 수정은 수용, 새 기간 전이 경로 3건 보완 필요.**
- 범위: FIX_05의 기간 처리와 해당 검증·문서 보완. 외부 Git/DEV·Stable 게시/실제 HA 변경 지시가 아니다.
- 이전 handoff와 인수된 수정은 보존한다. Executor는 FIX_06을 수행한 뒤 새 `FIX_06_REPORT.md`를 작성한다.

## 1. 수용한 변경 및 독립 전체 검증

- 기존 독립 clock/timezone probe는 이제 역행·원래 날짜 복귀·같은 instant의 UTC↔Asia/Seoul 토글에서 **fast=12/low=4, resetEvents=0**을 유지한다. 이전 P2의 해당 재현 수정은 수용한다.
- 세 reset 경로를 공통 reconcileDailyBudget으로 모으고 경계를 영속화한 방향은 적절하다. 다만 기존 상태/시간대의 의미와 새 경계가 일치하지 않는 아래 전이가 남았다.
- 새 CI binary 환경, 짧은 전용 basetemp의 독립 전체 pytest는 **335 passed, 2 skipped, 0 failed / 189.26s**였다. 로그: Git 제외 `.test-tmp/review008-fix05/ci-env-full-pytest.log`.
- 이전 activeCheck 완료·이력·rolloutReady·버전 계약·두 단계 예산 수정의 수용은 유지한다. 이번 요구를 근거로 보호 정책이나 기존 수동 apply 의미를 바꾸지 않는다.

## 2. [P2] 레거시 상태와 시간대 이동에서 첫 정상 경계를 하루 더 미룸

대상: `codex-runtime-manager.mjs:241-303`, 특히 nextBudgetResetAt 보충과 `currentDate > state.budgetDate` 조건.

### A. 레거시 상태를 03:00 이후 처음 읽은 경우

0.7.3에는 nextBudgetResetAt이 없다. 현재 helper는 이 필드가 없으면 **조회 시점 기준 다음 03:00**을 채운다. 기존 budgetDate가 어제이고 이미 오늘 03:00 초기화가 도래했어도 미래 경계를 만들어 오늘 reset을 거부한다.

Reviewer가 실제 checkUpdate를 호출한 결과:

| 기존 상태 / 조회 시각 (UTC) | 실제 결과 |
| --- | --- |
| budgetDate=11월 10일, 소진 12/4, nextRetryAt=11월 11일 03:00, 새 필드 없음 / 11월 11일 03:05 조회 | budgetDate는 11월 10일 유지, 12/4 유지, nextBudgetResetAt=11월 12일 03:00 |

즉 정상 초기화 기회를 24시간 더 미룬다. 과거 시각으로 되돌아간 사례가 아니라 실제 새 날의 정상 첫 검사다. 기존 소진 상태의 일반 업그레이드/재시작 복구와 관련된다.

### B. 서쪽 시간대로 이동한 후 다음 경계

Asia/Seoul에서 budgetDate=11월 11일인 소진 상태를 11월 10일 19:00Z에 UTC로 전환했다. helper는 UTC의 다음 경계를 **11월 11일 03:00Z**로 설정한다. 그러나 그 다음 03:05Z에 실제로 호출하면 UTC의 currentDate가 기존 Seoul budgetDate와 같은 문자열이라 reset=false다.

```text
scheduled=2026-11-11T03:00:00.000Z
03:05Z 결과: reset=false, budgetDate=2026-11-11, fast=12, low=4
```

서로 다른 시간대의 날짜 label을 같은 기간 순서로 비교하여, 스스로 예약한 첫 미래 경계를 거부한다. 이는 시간대 변경 시 현재 소비량을 보존하는 것과 별개의 문제다.

### 수정·수용 조건

- 새 필드 없는 상태의 기존 budgetDate·유효한 기존 nextRetryAt·당시 timezone 등 검증 가능한 정보를 이용해 **기존 기간의 실제 경계**를 해석한다. `필드 없음 → 현재 기준 다음 날로 연기`로 대체하지 않는다. 불확실한 legacy 형식은 보수적 사유/정책을 설명한다.
- 기간의 authoritative 경계와 표시용 local date를 구별한다. 다른 시간대의 날짜 문자열만 비교하여 합법적 첫 미래 경계를 건너뛰지 않는다. 이전에 소진한 같은 기간으로 돌아갔을 때는 재충전하지 않아야 한다.
- 실제 checkUpdate/applyUpdate/연속 daemon에서 03:00 이전·직후·여러 날 정지 후의 legacy 시작, UTC↔Asia/Seoul 양방향 전환 뒤 첫 허용 03:00, DST·시계 역행·미래 점프 후 복귀를 검사한다. 현재 순방향 회귀와 같은 instant 재충전 음성 시험도 유지한다.

## 3. [P2] checkUpdate가 이전 timezone을 덮어써 helper의 보호 분기를 우회함

대상: `checkUpdate()`의 `state.timezone = tz` 대입(약 2770행)과 뒤의 reconcileDailyBudget 호출.

helper는 `state.timezone !== targetTz`를 보고 시간대 변경을 판별한다. 그런데 checkUpdate는 helper를 부르기 전에 state.timezone을 새 값으로 덮어쓴다. 같은 입력 상태에서 helper 직접 호출과 실제 checkUpdate가 다른 정책으로 동작한다.

독립 실제 함수 재현: 기존 UTC budgetDate=11월 10일, 다음 경계=11월 11일 03:00Z, 소진 12/4. 현재 시각은 11월 11일 04:00Z이며 옵션을 Asia/Seoul로 변경한다.

| 경로 | 빠른 사용량 | 저빈도 사용량 | 다음 경계 |
| --- | --- | --- | --- |
| 동일 state의 reconcileDailyBudget 직접 호출 | 12 | 4 | 11월 11일 18:00Z |
| 실제 checkUpdate 호출 | 0 | 0 | 11월 11일 18:00Z |

두 경로 중 어느 정책을 채택하든 동일 입력에 다른 결과를 내서는 안 된다. 현재 문서/보고서의 “timezone 변경 시 소비량 보존”과 실제 checkUpdate가 불일치한다.

### 수정·수용 조건

- helper가 이전 기간/시간대 상태를 읽기 전에 caller가 판단 근거를 변경하지 않게 한다. 최종 이력 timezone 등 새 관측값 설정은 기간 판단과 구분한다.
- helper 단독뿐 아니라 세 실제 entrypoint에서 같은 전이 입력과 저장 결과를 비교한다. 기존 경계가 미래인 경우와 막 지난 경우를 모두 포함한다.
- lock 안 최신 상태에서 한 번만 판단·저장하고 daemon의 local snapshot도 저장된 결과와 일치시키며, CLI/daemon 경합 시 reset이 중복되지 않게 한다.

## 4. [P2] status가 영속화한 실제 경계를 무시하고 다른 시각을 표시함

대상: `getStatus()`의 nextBudgetResetAt(약 3817행).

helper는 실제 기간 경계를 state.nextBudgetResetAt으로 저장하지만 getStatus는 여전히 `getNextDayFirstSlotTime(now, options.timezone)`을 새로 계산한다. 시계 역행 시 실제 보존된 경계보다 하루 이른 잘못된 reset 기회를 안내한다.

독립 재현:

```text
persistedReset=2026-11-11T18:00:00.000Z
statusReset=2026-11-10T18:00:00.000Z
```

동일 state/옵션에서 실제 loadState와 getStatus를 호출한 결과다. reset을 안전하게 보류하면서 사용자에게는 더 이른 초기화를 약속하므로, 이슈 #71의 “실제 다음 기회 설명” 계약에 어긋난다.

### 수정·수용 조건

- JSON/text status가 실제 정책에 사용되는 영속화한 경계를 표시하게 한다. 레거시 fallback도 실제 migration과 같은 정책으로 계산하되 읽기 전용 status가 예산이나 과거 판정을 바꾸지 않게 한다.
- 저장된 경계가 지났지만 아직 reconciliation 전인 상태, 시계 역행, timezone 변경 보류, auto-update OFF/blocked에서 무엇을 표시하는지 명시한다. 임의로 미래 시각을 추정해 실제 예약처럼 표시하지 않는다.
- 상태 표시와 실제 daemon reset 시각/다음 적용 기회가 같은지 자동 검증한다.

## 5. 재현·검증 증거와 다음 단계

- A/§3의 실제 checkUpdate 재현: `.test-tmp/review008-fix05/budget-transition-probe.mjs`.
- 동일 실제 getStatus 비교: `.test-tmp/review008-fix05/budget-status-probe.mjs`.
- B는 독립 helper 호출로 위 상태와 시각을 입력했다. 운영 시계·HA·외부 네트워크·실제 사용자 데이터를 변경하지 않았다.
- 기존 clock/timezone probe의 원래 실패는 수정됐으며 전체 pytest도 green이다. 이번 문제는 기존 시험이 다루지 않은 **legacy 초기 채택·시간대 경계 전이·caller/status 일치** 조건이다. 기존 개선을 되돌리라는 요청이 아니다.
- ShellCheck, actionlint, Node syntax, `git diff --check`: PASS. 전체 pytest의 2 skips는 로컬 AppArmor parser·Grype/cache 가용성에 따른 선택 시험이다. 임시 basetemp는 정리했다.
- 새 image/실제 AppArmor·제품 wrapper/SSH/S6, native ARM, HAOS/mobile, 공개 DEV/Stable 산출물은 이번 리뷰에서 NOT RUN이며 기존 후속 gate로 유지한다. 이번 문서는 게시 실행 승인이 아니다.
- 제품 코드·버전·이전 handoff·외부 Git·운영 HA는 변경하지 않았다. 다음 Executor는 FIX_06_REPORT에 각 전이의 정책·저장 상태·실제 실행 시각·entrypoint 일치·전체 검증과 남은 배포 gate를 기록한다.
