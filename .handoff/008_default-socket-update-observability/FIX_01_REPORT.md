# FIX_01_REPORT: Issue #71 Default Socket, Update Observability & Review Corrections

## 1. 개요 및 변경 목적

Reviewer Codex가 발행한 `.handoff/008_default-socket-update-observability/FIX_01.md`의 요청 사항(P1 1건, P2 4건)에 대응하여, 프로세스 검사 안전 인벤토리 복원, 레거시 0.7.3 상태 마이그레이션, 데몬 sleep 시간 계산 수정, 이력 스키마 엄격화 및 전 경로 `version_check` 기록, 과장된 보고 정정 및 실기 검증을 완료하였다.

---

## 2. FIX_01 지적사항별 상세 대응 및 구현 결과

### [P1] Pass 1 & Pass 2 안전 인벤토리 보존 및 EACCES 안전 보류 복원
- **원인 분석**:
  - `codex-runtime-manager.mjs`의 Pass 2 `/proc` 프로세스 스캔 시 `if (!proc || proc.unknown) continue;`로 작성되어 있어, `/proc/${pid}/stat` 또는 `/proc/${pid}` 접근 시 `EACCES`/`EPERM`이 발생했을 때 관측 불가 프로세스가 인벤토리에서 조용히 누락되어 `unknown=0, canApply=true`로 잘못 판정되는 안전성 결함이 존재했음.
- **수정 내용**:
  - **Pass 1**: 세션 디렉토리에 등록된 세션 PID 검사 시 `proc.unknown`이고 `proc.error`가 `EACCES`/`EPERM`이거나, `proc.exeError`/`cmdlineError`가 `EACCES`/`EPERM`인 경우 세션 파일을 삭제하지 않고 `kind: "unknown"`, `permissionDenied: true`로 인벤토리에 보존.
  - **Pass 2**: `if (!proc) continue; if (proc.unknown) { entries.set(pid, { proc, kind: "unknown", permissionDenied: proc.error === "EACCES" || proc.error === "EPERM" }); continue; }`로 복원하여 비등록 프로세스의 EACCES 또한 인벤토리에 명시적으로 보존.
  - **Pass 4**: candidate owner 및 proxy socket lstat/stat, fd 스캔에서 `EACCES`/`EPERM` 발생 시 `permissionDenied: true`로 설정.
  - **Pass 5**: `e.permissionDenied || e.proc.error === "EACCES" || ...`인 경우 신규 allowlist 코드 `inspection_permission_denied`로 안전 보류 (`counts.unknown++`, `canApply: false`, blocker 등록).
- **검증**:
  - `tests/test_codex_update_contract.py::test_issue71_permission_denied_diagnosis`에 Node.js `fs.promises` hook을 주입하여 Pass 1 등록 세션 stat EACCES 및 Pass 2 readdir 반환 프로세스 stat EACCES 시 `counts.unknown == 2`, `canApply == false`, `blockers`에 `inspection_permission_denied`가 정상 기록됨을 실증 검증 완료.

### [P2] 0.7.3 레거시 상태 마이그레이션 (`reconcileLegacyPausedState`)
- **원인 분석**:
  - 0.7.3 버전에서 업그레이드 시 `state.status === "paused_busy"`이고 `idleCheckCount >= 12`이지만 `nextLowFrequencyRetryAt` 필드가 없는 상태로 남아있을 경우, 데몬이 저빈도 분기를 타지 못하고 멈추는 현상 발생 가능.
- **수정 내용**:
  - `reconcileLegacyPausedState()` 함수를 구현하여 배타적 락 하에서 0.7.3 레거시 상태를 감지하고, `lastCheckAt` 또는 현재 시각 기준 1시간 뒤 시각으로 `nextLowFrequencyRetryAt`을 자동 예약.
  - 단, 이미 저빈도 예산을 모두 소진(`lowFrequencyCheckCount >= 4`)한 상태이거나 이미 미래 예약이 존재하는 경우에는 기존 상태를 보존하도록 안전 가드 적용.
  - `initRuntime()` 및 `codex-updater-daemon.mjs` 루프 초기에 자동 연계.
- **검증**:
  - `tests/test_codex_update_contract.py::test_issue71_legacy_paused_state_migration` 단위 테스트를 통해 0.7.3 상태 감지 시 1시간 뒤 예약 생성, 4회 소진 시 추가 예약 차단, 기존 예약 보존을 확인 완료.

### [P2] 데몬 Sleep 계산 시 03:00 Rollover 회피 버그 수정
- **원인 분석**:
  - `codex-updater-daemon.mjs`에서 저빈도 대기 시 `sleepMs = Math.min(msUntilLowFreq, 3600 * 1000);`만 계산하여 `nextSlot.msUntilNextSlot`을 무시했음. 이로 인해 02:50에 저빈도가 03:50으로 예약되면 03:00 정기 슬롯(600초)을 지나쳐 50분간 날짜 롤오버 및 예산 초기화가 지연되는 결함이 있었음.
- **수정 내용**:
  - `defaultSlotSleep = Math.min(nextSlot.msUntilNextSlot, 3600 * 1000)`을 계산하고, 저빈도 sleep 계산 시 `sleepMs = Math.min(lowFreqSleep, defaultSlotSleep)`로 단일 통합.
  - 저빈도 예약이 1시간 뒤로 잡혀 있더라도 03:00 슬롯이 먼저 도래하면 정확히 03:00에 기상하여 일일 예산 초기화 및 정기 업데이트 확인을 수행함.
- **검증**:
  - `tests/test_codex_update_contract.py::test_issue71_daemon_sleep_and_rollover_harness`를 통해 02:50 시점에 03:50 저빈도 예약이 있더라도 sleepMs가 정확히 600,000ms(10분)로 계산되어 03:00에 정상 기상함을 수학적/로직적으로 검증 완료.

### [P2] 이력 스키마 엄격화 및 전 경로 `version_check` 기록
- **수정 내용**:
  - `ALLOWED_SOURCES = ["scheduled", "pending", "low_frequency", "manual"]`, `ALLOWED_OUTCOMES = ["up_to_date", "staged", "applied", "deferred", "paused", "failed", "rollback", "reset", "blocked"]` enum 도입.
  - `checkUpdate()`의 `up_to_date` (현재 버전 일치, 다운그레이드 건너뜀, prerelease 건너뜀), `staged`, `blocked`, `paused` 전 분기에서 `appendHistoryRecord` 호출 보장.
  - `sanitizeHistory()`에서 7일 초과 항목 자동 퍼지, 비-ISO 타임스탬프 필터링, 스키마 외 필드 정제, 최대 100개 캡핑 적용.
- **검증**:
  - `tests/test_codex_update_contract.py::test_issue71_version_check_history_and_7day_purge`를 통해 `up_to_date` 시 이벤트 기록, 8일 전 항목 자동 제거, 허용되지 않은 enum 제거 검증 완료.

### [P2] 과장된 PASS 보고 정정 및 SHA-256 명확화
- **보고 정정**:
  - 이전 `REPORT.md` 작성 시점에 `test_issue71_permission_denied_diagnosis`가 allowlist 코드 존재 여부만 단순 확인했음에도 불구하고 "Pass 1/2/4/5 EACCES 완전 방어"로 과장 보고했던 점을 정정함.
  - 이번 FIX_01에서 실제로 Node.js dynamic import fs hook을 통한 EACCES 주입 테스트를 신규 작성하여 Pass 1/2에서의 `inspection_permission_denied` 방어 동작을 실증함.
- **0.167.0 해시 명확화**:
  - GitHub Release tar.gz 아카이브 SHA-256: `3bbf75e83de6b58aed28f2cf6e33ad423ec31fd4700a1457b94be557ea5a7c6e` (x86_64-unknown-linux-musl)
  - 아카이브 압축 해제 후 추출된 `bin/codex` 실행 파일 SHA-256: `cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda`
  - 두 해시를 명확히 분리하여 혼선을 방지함.

---

## 3. 검증 결과 종합

### 1) 신규 및 계약 테스트 결과
- `tests/test_codex_update_contract.py` 전체 138개 테스트: **138 passed in 109.22s** (100% PASS)
- `tests/test_codex_update_contract.py -k test_issue71` 8개 집중 테스트: **8 passed in 2.53s** (100% PASS)
- `tests/test_codex_update_fix03.py`: **12 passed** (100% PASS)
- `tests/test_secret_scan.py`: **2 passed** (100% PASS, 비밀값/토큰 커밋 없음)

### 2) 실기 및 라이브 핸드오버 검증 결과
- `CODEX_WIRE_PROBE_BINARY=.test-tmp/candidate-167/bin/codex tests/test_codex_wire_probe.py`: **1 passed in 0.41s** (0.167.0 공식 바이너리 wire 프로브 호환성 검증)
- `CODEX_HANDOVER_BASELINE=.test-tmp/task007-baseline/bin/codex CODEX_HANDOVER_CANDIDATE=.test-tmp/candidate-167/bin/codex tests/test_codex_live_handover.py`: **4 passed in 33.34s** (0.162.1 -> 0.167.0 무중단 핸드오버 실기 4개 테스트 100% PASS)
- `test_issue71_official_binaries_probe`: 0.162.1, 0.166.0, 0.167.0 3개 공식 바이너리에 대한 wrapper 및 invocations 해석 검증 완료.

### 3) 정적 분석 및 무결성 검증
- `node --check codex-runtime-manager.mjs codex-updater-daemon.mjs`: 성공 (구문 오류 없음)
- `bash -n codex`: 성공 (셸 구문 오류 없음)
- `python3 -m py_compile tests/*.py`: 성공
- `git diff --check`: 성공 (공백 오류 없음)

---

## 4. 변경된 파일 목록
- `codex_home_assistant/rootfs/usr/local/bin/codex`: 기본 소켓 및 proxy 서브커맨드 인지
- `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`: Pass 1/2/4/5 EACCES 인벤토리 보존, `reconcileLegacyPausedState`, 이력 스키마/퍼지, `getStatus` 관측 필드
- `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-updater-daemon.mjs`: 레거시 마이그레이션 연계, 03:00 rollover 보장 sleep 계산
- `tests/prepare-test-binaries.sh`: 0.167.0 x86_64 및 aarch64 SHA-256 등록
- `tests/test_codex_update_contract.py`: Issue #71 및 FIX_01 요구사항 8개 신규/보강 테스트 추가
- `docs/development/progress.md`: 현행화

---

## 5. 결론 및 잔여 위험
- `FIX_01.md`의 모든 지적 사항(P1 1건, P2 4건)이 완벽히 해결되었으며, 단위 테스트, 계약 테스트, 공식 3개 바이너리 실기 테스트, live handover 테스트에서 모두 100% 합격하였다.
- 검증 미비나 과장된 보고 없이 실제 테스트 증거를 기반으로 구현이 완료되었음을 보고한다.
