# FIX_02_REPORT — 자동 업데이트 기간별 복구 및 보안 결함 조치 보고서

## 1. 개요 및 판정

- **역할**: Executor (2026-10-13, Asia/Seoul)
- **대상**: `.handoff/002_codex-auto-update/FIX_02.md`
- **목적**:
  - 일 단위 idle 검토 버짓(최대 12회) 및 다음 날짜 첫 슬롯 자동 재개 (`paused_busy`) 구현
  - 24시간 당 동일 후보 자동 restart transaction 최대 1회 및 durable 저널/롤백 구현
  - 실행 패키지 트리 재귀 검증 (`validateCandidatePackageTree`), 격리 HOME 사전 호환성 검증
  - `flock` 부재 시 fail-closed 잠금, 래퍼 baseline 정확 일치, app-server 필수 게이지 strict 검증
  - 문서 경로 정합성 (`product_spec.md`), 정확한 테스트 이름/명령어 정정
  - 외부 push, git commit, PR 생성 및 실운영 HA 변경은 규칙에 따라 일절 수행하지 않음

---

## 2. 세부 조치 내역

### 2.1 P1: 일일 유휴 버짓, 일시 보류 및 다음 날짜 자동 재개
- **`budgetDate` 및 날짜별 12회 한도**:
  - `codex-runtime-manager.mjs`의 `getCurrentSlotInfo`가 `slotDate` (`YYYY-MM-DD`)를 반환하도록 수정.
  - `applyUpdate` 및 `checkUpdates`에서 `state.budgetDate !== currentDate`일 때 `idleCheckCount`를 0으로 리셋.
  - 일일 12회(`MAX_IDLE_CHECKS = 12`) 초과 시 `state.status = "paused_busy"`로 전환.
  - 날짜가 바뀌어 새로운 날짜 버짓이 초기화되면 `paused_busy` 상태를 `ready_to_apply`로 자동 복구하여 당일 첫 예약 슬롯에서 적용 재개.
  - `saveState`와 `loadState`에 `budgetDate`, `lastRestartAt`, `nextRestartAllowedAt`, `nextRetryAt` 필드를 영속화하여 데몬 재시작이나 컨테이너 리부트 후에도 상태 보존.
- **슬롯 원자적 기록 (`lastCheckSlot`)**:
  - `checkUpdates` 수행 시 정상, blocked, prerelease 등 모든 상태에서 현재 `slotKey`를 `state.lastCheckSlot`에 즉시 기록하여 같은 슬롯의 중복 호출 방지.
- **문서 동기화**:
  - `codex_home_assistant/DOCS.md` 및 `DOCS.en.md`에 일일 12회 idle 검토 한도, `paused_busy` 일시 보류 동작, 다음 날짜 첫 슬롯 자동 재개 원칙 명시.

### 2.2 P1: 24시간 당 1회 서버 재시작 트랜잭션 및 안전 드레인
- **durable 저널 및 쿨다운**:
  - `MAX_RESTART_ATTEMPTS = 1` 상수와 24시간 쿨다운(`24 * 3600 * 1000`) 적용.
  - SIGTERM 시그널 전송 직전 `state.lastRestartAt`, `state.nextRestartAllowedAt`, `state.restartAttemptCount`를 파일에 기록(durable 저널링).
  - 쿨다운 활성 시 `paused_restart`로 전환하고 세션 자연 종료 대기.
- **안전한 Graceful 드레인 및 새 서버 검증**:
  - 시그널 직전 `inspectAppServer`로 유휴 상태 재확인.
  - SIGTERM 전송 후 최대 5초간 100ms 주기로 프로세스 종료 대기 (강제 SIGKILL 사용 금지).
  - 정상 종료 후 atomic symlink 교체(`current -> staged`).
  - 새 바이너리로 app-server spawn 후 5초간 readiness 검증.
  - readiness 실패 시 이전 target으로 심볼릭 링크 원자적 롤백(`rollback`), 실패 프로세스 SIGTERM 종료, `blocked_restart` 기록.

### 2.3 P1: 패키지 실행 트리 검증 및 적용 전 정책 호환성 사전 확인
- **`validateCandidatePackageTree` 구현**:
  - `candidateDir` 내의 모든 파일/디렉터리를 재귀적으로 탐색.
  - 블록/캐릭터 디바이스, FIFO, 소켓 등 비정상 특수 파일 거부.
  - 심볼릭 링크의 상대/절대 경로가 패키지 루트 밖을 가리키거나, 대상의 `realpath`가 패키지 밖으로 탈출하는 경우 즉시 거부 (`Escaping symlink in package`).
  - `bin/codex`가 외부를 가리키는 escaping symlink인 경우 즉시 거부.
  - `validateSymlinkContainment` 내부에서도 `validateCandidatePackageTree`를 호출하여 패키지 무결성 보장.
- **추출 디렉터리 클린 덮어쓰기**:
  - 기존 destination이 존재하더라도 무조건 재사용하지 않고, 검증된 추출본으로 완전히 교체하여 변조 방지.
- **격리 HOME 사전 호환성 검증**:
  - 다운로드 및 압축 해제 후 임시 격리 디렉터리(`HOME=tempHome`)에서 새 바이너리 검증:
    1. `codex --version`
    2. `codex --help`
    3. `codex -c 'approval_policy="safe"' --help`

### 2.4 P1: 페일클로즈드 락킹 및 프로세스/소켓 안전성
- **`flock` 부재 시 fail-closed**:
  - `withGateLock`에서 `PATH` 내 `flock` 실행 파일이 없을 경우 무잠금 콜백 실행을 금지하고 예외 발생.
- **래퍼 baseline 정확 일치 검사**:
  - `codex` 래퍼 스크립트에서 prefix 와일드카드(`*`) 매칭을 제거하고 정확한 경로 일치 검사 (`"${current_target}" == "/usr/local/lib/codex-ha/codex-baseline" || "${current_target}" == "/usr/local/share/codex-ha/codex-baseline"`).
  - `-evil` 등의 접미사가 붙은 변조 경로 거부.
- **App-Server 필수 게이지 strict 검증**:
  - `inspectAppServer`에서 필수 게이지 3종(`app.requests.in_flight`, `app.requests.queued`, `core.turns.active`)이 반드시 존재하고 유한한 음이 아닌 숫자(`typeof val === "number" && !isNaN(val) && val >= 0`)인지 검증.
  - 필수 게이지 누락, NaN, 음수, 빈 객체 진단 수신 시 fail-closed로 `busy: true` 처리.

### 2.5 P2: 문서 정합성 및 테스트 목록 정정
- **`product_spec.md` 경로 정정**:
  - `docs/development/product_spec.md:289-291`에 남아있던 구 경로 `/data/codex-runtime/versions/<ver>`를 표준 구조인 `/data/codex-runtime/releases/<version>-<target>`으로 수정.
  - 저장소 전체에서 `codex-runtime/versions` 검색 결과 0건 확인.
- **실제 계약 테스트 목록 정정**:
  - `tests/test_codex_update_contract.py` 내의 실제 존재하는 19개 테스트 명칭 및 검증 대상을 정확히 일치시킴.
  - mock WebSocket 서버의 바이너리 프레임 마스킹 해제(RFC 6455 unmasking)를 올바르게 처리하여 RPC 타임아웃 오류 해소.

---

## 3. 실제 검증 결과

### 3.1 Python 테스트 스위트
- **명령**: `.venv/bin/pytest tests/test_codex_update_contract.py`
  - **결과**: `19 passed in 3.70s`
  - **실제 테스트 19종 목록**:
    1. `test_addon_config_declares_auto_update_options`
    2. `test_translations_cover_auto_update_options`
    3. `test_timezone_and_slot_calculations`
    4. `test_semver_comparisons`
    5. `test_target_architecture_resolution`
    6. `test_options_validation_fail_closed`
    7. `test_session_inspection_and_admission_safety`
    8. `test_status_output_scrubs_secrets_and_reports_honest_versions`
    9. `test_gate_locking_contention`
    10. `test_gate_locking_fails_closed_without_flock`
    11. `test_stale_state_overwrite_prevention`
    12. `test_candidate_retry_caps_and_digest_mismatch`
    13. `test_daily_idle_budget_pause_and_next_day_recovery`
    14. `test_package_tree_containment_rejects_escaping_bin`
    15. `test_app_server_inspection_fails_closed_on_malformed_and_missing_gauges`
    16. `test_wrapper_exact_baseline_path_match`
    17. `test_wrapper_argument_parsing_distinguishes_subcommands`
    18. `test_codex_updater_s6_service_contract`
    19. `test_server_graceful_restart_transaction_with_fixture_process`

- **전체 테스트 스위트 명령**: `.venv/bin/pytest`
  - **결과**: `133 passed in 9.82s` (전체 통과)

### 3.2 린터 및 구문 검사
- `shellcheck codex_home_assistant/rootfs/usr/local/bin/codex codex_home_assistant/rootfs/usr/local/bin/codex-ha-init codex_home_assistant/rootfs/usr/local/bin/ha-codex-update tests/docker-smoke.sh tests/update-smoke.sh` -> **PASS (exit code 0)**
- `hadolint codex_home_assistant/Dockerfile` -> **PASS (exit code 0)**
- `actionlint` -> **PASS (exit code 0)**
- `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs && node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-updater-daemon.mjs` -> **PASS (exit code 0)**
- `git diff --check` -> **PASS (exit code 0, 공백/포맷 결함 없음)**

---

## 4. 미수행 및 검증 갭 (Explicit Non-run Items)

1. **Docker 컨테이너 전체 재빌드 및 update-smoke.sh**:
   - `docker build` 및 멀티아키텍처 smoke 테스트는 수행하지 않음 (로컬 단위/계약 테스트로 검증).
2. **실운영 HAOS 인스턴스 배포 및 UI 설치**:
   - 운영 환경 보호 및 보안 규칙에 따라 실운영 HAOS에 배포하거나 설정을 변경하지 않음.
3. **외부 Git Push / PR 생성 / GitHub Release / GHCR 이미지 발행**:
   - 사용자 명시적 요청 이전에는 원격 변경을 수행하지 않는 규칙에 따라 로컬 작업 트리에서만 완료함.
4. **Native ARM 하드웨어 실기 테스트**:
   - x86_64 리눅스 호스트 환경에서 교차 계약 테스트를 완료하였으며, 실제 aarch64 하드웨어 실행은 미수행.

---

## 5. 결론 및 핸드오프

FIX_02에서 제기된 P1(일일 12회 유휴 버짓, 다음 날짜 자동 재개, 24시간 당 1회 restart 트랜잭션, 패키지 트리 symlink 탈출 방지, flock fail-closed, 필수 게이지 strict 검증) 및 P2(문서 경로 정합성, 실제 테스트 증거 일치) 요구사항을 모두 해결하였습니다.
다음 단계로서 Reviewer의 검토를 요청합니다.
