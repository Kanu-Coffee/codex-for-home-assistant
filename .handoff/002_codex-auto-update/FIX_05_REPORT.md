# FIX_05_REPORT — FIX_05 구현 및 검증 보고서

## 1. 개요 및 역할

- **작성 주체**: Executor
- **일시**: 2026-10-13 Asia/Seoul
- **대상 작업**: `.handoff/002_codex-auto-update/FIX_05.md`에 지시된 4가지 문제(P1 GC 실행 참조 보존, P2 부분 drain 실패 시 개별 서비스 복구, P2 쿨다운 재검토 정책 probe 생략 및 일일 버짓 상한, P2 IANA timezone DST 슬롯 계산) 전수 해결 및 계약 테스트 추가.
- **원칙 준수**: 기존 handoff 파일 보존, git commit/push/tag/release 미수행, 운영 Home Assistant 변경 없음.

---

## 2. 세부 변경 사항

### 2.1 P1 — GC 실행·companion/resource 참조 보존 (`codex-runtime-manager.mjs`)
- **원인 분석**:
  - 기존 `cleanupOldReleases`는 `/proc/*/exe`만 검사하여 Node/시스템 인터프리터가 구버전 패키지의 리소스 파일(FD, mmap, cwd 등)을 열고 있는 경우 참조를 인지하지 못하고 경로를 삭제하는 문제가 존재했음.
  - `/proc` 열람 실패 시 빈 목록으로 취급하여 삭제를 진행할 위험이 있었음.
- **구현 내용**:
  - `cleanupOldReleases`에서 `/proc` 전체 프로세스의 다음 항목을 전수 검사하도록 확장:
    1. `/proc/<pid>/exe`: 실행 바이너리
    2. `/proc/<pid>/cwd`: 작업 디렉터리
    3. `/proc/<pid>/fd/*`: 열려 있는 모든 파일 디스크립터
    4. `/proc/<pid>/maps`: 메모리 매핑 영역
    5. `/proc/<pid>/cmdline`: 실행 인자
  - `releasesDir`뿐만 아니라 `realpath(releasesDir)`를 함께 확인하는 `matchRelease()` 헬퍼를 도입하여 심볼릭 링크나 정규화 경로 차이 없이 정확히 디렉터리 일치 판정.
  - `/proc` 읽기 실패 시 즉시 반환(fail-closed)하여 안전하게 GC 중단.
  - 외부 테스트 및 호출 가능하도록 `export async function cleanupOldReleases`로 export.
- **회귀 테스트**:
  - `tests/test_codex_update_contract.py`에 `test_cleanup_old_releases_preserves_live_fd_and_resource_references` 추가:
    - 독립 Node 프로세스가 구버전(0.160.0) 리소스 파일을 stdin으로 경로를 받아 `fs.openSync`로 열고 있는 상태에서 `applyUpdate()`를 실행.
    - `applied: true`로 신규 버전(0.163.0)이 적용되었으나, 프로세스가 FD를 물고 있는 0.160.0 디렉터리는 삭제되지 않고 보존됨을 확인 (`existsWhileOpen: true`).
    - 프로세스 종료 후 FD가 닫힌 뒤 `cleanupOldReleases`를 실행하면 정상적으로 0.160.0이 정리됨을 확인 (`existsAfterClose: false`).

### 2.2 P2 — 부분 drain 실패 시 개별 서비스 복구 분리 (`codex-server-transaction.mjs`)
- **원인 분석**:
  - 여러 서버 중 두 번째 서버의 drain이 실패(timeout)했을 때, `unresolvedDrain = true`로 인해 catch 블록에서 `allRestored = false`가 되고, 이미 정상 drain되어 중단된 첫 번째 서버의 복구마저 건너뛰어 서비스 가용성을 잃는 문제가 발생했음.
- **구현 내용**:
  - 전체 트랜잭션의 롤백 완료 여부(`allRestored = !unresolvedDrain`)와 개별 소켓의 복구 가능 여부를 엄격히 분리.
  - 새로운 generation(`replacements`)을 중지 처리할 때 중지 실패한 소켓을 `unstoppedSockets` Set에 등록.
  - `stopped` 목록에 기록된 기존 서버들(이미 정상 drain 완료되어 프로세스가 종료된 서버)에 대해, 해당 소켓이 `unstoppedSockets`에 속하지 않는 한 개별적으로 이전 바이너리/버전/소켓/설정으로 즉시 복구(`launch`) 실행.
  - 아직 살아 있는 미완료 서버(drain timeout된 서버)에는 추가/반복 HUP이나 강제 kill을 가하지 않고 소켓 중복 점유를 방지.
  - 트랜잭션 결과로 `applied: false`, `reason: "drain_timeout"`, `recovery: "rollback_incomplete"`를 반환하여 상태를 투명하게 보고.
- **회귀 테스트**:
  - `test_restart_failure_restores_actual_servers_or_reports_incomplete`에 `second_drain` 파라미터 케이스 추가:
    - 2개의 실제 Unix 소켓 서버를 구버전(0.162.1)으로 기동.
    - 서버 1은 SIGHUP 시 정상 종료(`process.exit(0)`), 서버 2는 SIGHUP을 수신하되 종료하지 않고 대기.
    - `restartServers` 실행 결과: `applied: false`, `reason: "drain_timeout"`, `recovery: "rollback_incomplete"`, `selected: "old"`.
    - 서버 1은 이전 바이너리로 정상 복구(새로운 PID로 0.162.1 기동), 서버 2는 원래 프로세스 유지(총 live 서버 수 2개 유지).
    - 각 프로세스가 수신한 SIGHUP은 정확히 1회씩이며 중복/반복 시그널 전송 없음.

### 2.3 P2 — 쿨다운 상태의 재검토 및 정책 실행 일일 상한 적용 (`codex-runtime-manager.mjs`, `codex-updater-daemon.mjs`)
- **원인 분석**:
  - 재시작 쿨다운(`nextRestartAllowedAt > now`) 상태에서도 `applyUpdate()` 초입에서 candidate policy probe 및 integrity 검사가 먼저 실행되어, 5분마다 무거운 managed policy probe app-server가 반복 실행되었음.
  - 쿨다운 경로에서 `idleCheckCount`가 증가하지 않아 일일 12회 상한(`MAX_IDLE_CHECKS`)이 적용되지 않았음.
- **구현 내용**:
  - `applyUpdate()`에서 `canAttemptRestart` 조건 충족 시 `cooldownActive` 검사를 candidate `policyProbe` 실행 **이전**으로 이동.
  - 쿨다운이 활성화된 상태(`cooldownActive == true`):
    - 무거운 `policyProbe`를 일절 실행하지 않고 즉시 스킵.
    - 비수동 실행 시 `idleCheckCount`를 정상 증가시키며, 12회 도달 시 `paused_busy` 상태로 전이하고 `nextRetryAt`을 다음 날 첫 슬롯으로 설정하여 5분 단위 반복 점검 중지.
    - 12회 미만인 경우 `paused_restart` 및 `reason: "restart_cooldown"`을 반환.
  - candidate managed policy probe는 쿨다운이 만료되었거나 완전 idle 상태여서 실제로 패키지 적용/재시작을 진행하기 직전에만 1회 실행.
  - `codex-updater-daemon.mjs`에서 결정론적 시계 주입(`getNow()`)을 적용하여 재시도 간격 및 슬롯 계산이 일관되게 동작하도록 보장.
- **회귀 테스트**:
  - `test_server_graceful_restart_transaction_with_fixture_process` 보강:
    - 첫 번째 apply로 0.163.0이 적용되고 24시간 쿨다운이 설정된 직후, 동일 후보를 staged에 재배치.
    - 쿨다운 중 `applyUpdate({ policyProbe })`를 13회 연속 호출.
    - 13회 호출 전체에 걸쳐 `probeCount`는 **0**으로 유지됨을 검증(쿨다운 중 정책 probe 절대 미실행).
    - 1~11회: `reason: "restart_cooldown"`, `idleCheckCount: 1~11`.
    - 12회: `idleCheckCount: 12`, `status: "paused_busy"`, `reason: "paused_busy"`.
    - 13회: `status: "paused_busy"` 유지, 추가 probe 없음.
    - 24시간 이후로 시계 전진 시 `cooldownExpired` 정상 확인.

### 2.4 P2 — IANA Timezone DST 전환 슬롯 시각 계산 정밀화 (`codex-runtime-manager.mjs`)
- **원인 분석**:
  - 시간 차이에 고정 3600초(1시간)를 곱하여 슬롯 시각을 계산하여, UTC 오프셋이 변경되는 DST 봄(Spring forward) 및 가을(Fall back) 전환 날짜에서 현지 03시가 UTC 기준 1시간씩 어긋나는 문제(04시 또는 02시)가 발생했음.
- **구현 내용**:
  - `zonedDateTimeToUtc(year, month, day, hour, minute, second, tz)` 함수 추가:
    - 표준 Node.js 내장 `Intl.DateTimeFormat`을 활용하여 목표 timezone의 현지 calendar 날짜/시간을 정확한 UTC 타임스탬프로 수렴 계산.
  - `getCurrentSlotInfo`와 `getNextDayFirstSlotTime`:
    - 목표 현지 calendar 날짜와 슬롯 hour를 확정한 뒤 `zonedDateTimeToUtc`를 통해 정확한 UTC instant를 계산.
- **회귀 테스트**:
  - `test_timezone_and_slot_calculations`에 DST 케이스 검증 포함:
    - America/New_York 2026-03-08T01:30:00-05:00 (06:30Z): 다음 03:00 EDT는 정확히 30분 뒤인 **07:00Z** (현지 03:00).
    - America/New_York 2026-11-01T00:30:00-04:00 (04:30Z): 다음 03:00 EST는 정확히 210분 뒤인 **08:00Z** (현지 03:00).
    - 한국(KST) 및 UTC 정상 케이스와 함께 모두 정확한 instant 산출 확인.

### 2.5 문서 보완 (`README.md`, `README.en.md`, `codex_home_assistant/README.md`, `codex_home_assistant/README.en.md`)
- 안정판 `0.7.0`의 Native ARM CI 통과 결과와, 현재 개발 브랜치(`0.7.1`)의 릴리스 전 미검증(NOT RUN) 상태를 명확히 구분하여 기술.
- `docs/development/progress.md`에 FIX_05 변경 및 검증 내역 갱신 완료.

---

## 3. 검증 결과 및 증거

### 3.1 Python 계약 및 전체 테스트
```bash
.venv/bin/pytest -q
```
- **결과**: `191 passed in 62.62s` (전체 191개 테스트 전원 통과).
- `test_codex_update_contract.py`: 77개 테스트 전원 통과 (DST 전환, 쿨다운 중 probe 0회 및 12회 budget 소진, 부분 drain 시 개별 서버 복구, open FD 리소스 GC 보존 포함).

### 3.2 Linter 및 정적 검사
1. **ShellCheck**:
   ```bash
   shellcheck codex_home_assistant/rootfs/usr/local/bin/codex \
              codex_home_assistant/rootfs/usr/local/bin/codex-ha-init \
              codex_home_assistant/rootfs/usr/local/bin/ha-codex-update \
              tests/docker-smoke.sh tests/update-smoke.sh tests/codex-update-smoke.sh \
              codex_home_assistant/rootfs/etc/s6-overlay/s6-rc.d/codex-updater/run
   ```
   - **결과**: PASS (0 errors, 0 warnings).
2. **Hadolint**:
   ```bash
   hadolint codex_home_assistant/Dockerfile
   ```
   - **결과**: PASS.
3. **actionlint**:
   ```bash
   actionlint .github/workflows/ci.yaml
   ```
   - **결과**: PASS.
4. **git diff --check**:
   ```bash
   git diff --check
   ```
   - **결과**: PASS (공백/포맷 결함 없음).
5. **Node syntax check**:
   ```bash
   node -c codex_home_assistant/rootfs/usr/local/share/codex-ha/*.mjs
   ```
   - **결과**: PASS (5개 파일 모두 문법 정상).

---

## 4. 계획 대비 편차 (Deviations)

- 없음. FIX_05에서 제기된 P1 1건 및 P2 3건을 누락 없이 충실히 구현하고, 회귀 테스트 케이스를 모두 통합하여 검증을 완료함.

---

## 5. 미검증 항목 및 잔여 위험 (Verification Gaps)

- **NOT RUN**:
  - Docker 전체 이미지 재빌드 / 개발 HAOS 18.2 VM 컨테이너 smoke 테스트는 이번 코드 수정 세션에서는 다시 실행하지 않음 (FIX_04_REPORT에서 기록된 실행 증거와 구분).
  - Native ARM CI run 및 실제 aarch64 Raspberry Pi 실기 검증은 실행하지 않음(기존 승인된 문서화 갭 유지).
  - 외부 Git commit / push / GitHub Release 발행은 Reviewer 인수 후 진행을 위해 일절 수행하지 않음.

---

## 6. 다음 단계 권고

- Reviewer가 본 보고서와 working tree의 4가지 수정 사항을 검증한 후 승인 시, 기존 사용자 승인에 따라 미사용 `0.7.1-dev.N`의 DEV identity/branch/tag/Builder/GHCR 발행 단계로 이행할 수 있습니다.
