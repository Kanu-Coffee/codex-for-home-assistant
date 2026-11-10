# FIX_02_REPORT: Default Proxy Execution Environment, Observability & Continuous Verification

## 1. 개요 및 목적

Reviewer Codex가 발행한 [`.handoff/008_default-socket-update-observability/FIX_02.md`](file:///home/lee/projects/codex_for_HA/.handoff/008_default-socket-update-observability/FIX_02.md)의 요청 사항에 대응하여:
1. **[P2] default proxy 해석 시 검사자 환경(`process.env`) 의존성 완전 제거**: 대상 프로세스의 검증된 실행 환경(`proc.env`)과 `record.socketPath`, 그리고 Pass 4 커널 피어 소켓 매핑을 결합하여 S6/데몬 환경(HOME=/root, CODEX_HOME 부재)에서도 정상 세션을 안전하게 귀속.
2. **[P2] staged 조회 이력 누락 해결 및 시간대·회차 일관성 보완**: `checkUpdate()`의 `staged` 분기에서 `version_check` 이력 기록, `state.timezone` 및 `saveState` 영속화, 이벤트 순번(`sequence`)과 검사 회차 ID(`checkNumber`) 분리, `getStatus` 텍스트 출력의 `Last idle checked`, `Next budget reset`, `Running observation` 반영.
3. **[P2] 0.7.3 레거시 상태 마이그레이션 기준 시각 수정**: 과거 버전 조회 시각(`lastCheckAt`)을 유휴 소진 시각으로 대체하지 않고, 마이그레이션 시점(`getNow()`) 기준 60분 뒤로 최초 저빈도 시각을 안전하게 예약.
4. **[P2] 실제 daemon 연속 시험 및 공식 3개 바이너리 실기 E2E 검증**: 단순 계산식 복제가 아닌 실제 데몬 루프/내구성 상태 전이 시험(`test_issue71_real_daemon_continuous_lifecycle`)과 3개 공식 바이너리(0.162.1, 0.166.0, 0.167.0)에 대한 실제 Unix 서버/프록시 기동 + WebSocket 101 핸드셰이크 + S6-like 환경 귀속 + 위조/empty 레코드 음성 시험(`test_issue71_real_binary_default_proxy_e2e`) 수행.
5. **[P2] CI 워크플로우 보강**: `.github/workflows/ci.yaml`에 `CODEX_HANDOVER_BASELINE` 및 `CODEX_HANDOVER_CANDIDATE`를 명시적으로 연결.

---

## 2. FIX_02 핵심 지적사항별 상세 구현 내용

### 1) [P2] default proxy 검사자 환경 의존성 제거 (`codex-runtime-manager.mjs`)
- **원인 분석**:
  - `codex-runtime-manager.mjs:1756-1759`에서 명시적 `--sock`가 없는 proxy의 target socket을 검사자 프로세스의 `resolveDefaultControlSocket(process.env)`로 계산했음.
  - S6 관리 데몬(`HOME=/root`, `CODEX_HOME` 부재) 환경에서 사용자의 세션(`CODEX_HOME` 설정)을 검사할 때 불필요하게 `proxyTargetMismatch`가 발생하여 `unknown`으로 보류되는 결함.
- **수정 내용**:
  - `inspectProcess(pid)`에서 `/proc/${pid}/environ`을 읽어 안전한 비-비밀 디렉토리 변수(`CODEX_HOME`, `HOME`)만 추출하여 `proc.env`로 보존 (비밀값, 토큰, `SUPERVISOR_TOKEN` 추출 절대 금지).
  - Pass 3 proxy 검증:
    - `recSock = record.socketPath || record.targetSocket || null`
    - `!recSock`인 경우 (old empty record): 검사자의 default로 채워 managed로 승격하지 않고 `e.kind = "unknown"; e.missingTargetSocket = true;`로 유지.
    - 명시적 `--sock`가 있는 경우: 커맨드라인 경로와 `recSock`의 일치 검증.
    - default proxy인 경우: 대상 프로세스 환경(`proc.env`)에서 계산한 default socket과 `recSock`이 일치하거나, 표준 default 소켓 패턴(`*/app-server-control/app-server-control.sock`)을 만족하는 경우 수용하여 Pass 4의 커널 피어 매핑 단계로 넘김.
    - Pass 4에서 **커널 피어 소켓 매핑(kernel peer mapping)**과 inode 일치 검증을 통과한 경우에만 최종 `helpers`로 승격.
  - Pass 3 app-server: `sPath === "unix://"`인 경우에도 검사자 환경 대신 `proc.env` 및 `record.socketPath`를 우선 사용.
- **실기 검증**:
  - Reviewer의 독립 재현 스크립트(`.test-tmp/review008-fix01/default-proxy-env.py`)를 실행하여 `matching_env` 및 `s6_like_env` (HOME=/root, CODEX_HOME 부재) 모두에서 `helpers: 1, unknown: 0, canApply: true` 정상 동작 확인.

### 2) [P2] staged 조회 이력 기록, 시간대 보존 및 관측 일치
- **수정 내용**:
  - `checkUpdate()`의 `state.stagedVersion = latestVersion;` 블록에서 누락되었던 `appendHistoryRecord(state, { event: "version_check", outcome: "staged", ... })` 추가.
  - `loadState()`와 `saveState()`에 `timezone` 필드를 추가하여 add-on options의 시간대가 상태 파일에 영구 보존되도록 개선.
  - `appendHistoryRecord()`에서 전체 이벤트 순번(`sequence`)과 검사 회차 ID(`checkNumber`)를 분리.
  - 날짜 롤오버(`state.budgetDate !== currentDate`) 발생 시 즉시 `await saveState(state)`를 호출하여 조기 반환 시에도 디스크 상태가 유실되지 않도록 보장.
  - `getStatus()`의 text 출력 포맷에 `Last idle checked`, `Next budget reset`, `Running observation`, `effectiveNextRetryAt`을 추가하여 JSON 출력과 일치시킴.
- **실기 검증**:
  - Reviewer의 `.test-tmp/review008-fix01/observability-probe.mjs`를 실행하여:
    - `stageReturned: "0.163.0", versionCheckEvents: 1` (staged 이력 정상 기록 확인)
    - `optionsTimezone: "Asia/Seoul", idleHistoryTimezone: "Asia/Seoul"` (시간대 일치 확인)
    - `migrationAt: "12:00", nextLowFrequencyRetryAt: "13:00"` (정확한 60분 간격 확인)

### 3) [P2] 0.7.3 레거시 상태 마이그레이션 기준 시각 수정
- **수정 내용**:
  - `reconcileLegacyPausedState()` 및 `initRuntime()`에서:
    - `lastIdleCheckAt`이 존재하지 않는 0.7.3 레거시 상태에 대해, 과거 버전 조회 시각(`lastCheckAt`)을 유휴 소진 시각으로 대체하지 않고, 마이그레이션 시점(`getNow()`) 기준 60분 뒤 (`nowMs + 3600 * 1000`)로 최초 저빈도 시각을 안전하게 예약.
    - 4회 소진 완료(`lowFrequencyCheckCount >= 4`) 상태이거나 이미 미래 예약이 있는 경우 예약 생성을 차단하여 불변조건 준수.

### 4) [P2] 실제 daemon 연속 시험 및 공식 3개 바이너리 실기 E2E 검증
- **`test_issue71_real_daemon_continuous_lifecycle`**:
  - `codex-updater-daemon.mjs`의 모듈 내보내기(`loop`, `stopOnSignal`, `isRunning`)를 지원하도록 개선.
  - 0.7.3 레거시 paused_busy 마이그레이션 -> 60분 후 저빈도 예약 -> 1회 실행 -> 4회 소진 -> 03:00 rollover 슬롯 도달 -> 0회 리셋 (`budget_reset`) 및 첫 검사 복원 -> SIGTERM 클린 종료 라이프사이클 전 과정을 실제 모듈 및 파일시스템 상태 전이로 검증 완료.
- **`test_issue71_real_binary_default_proxy_e2e`**:
  - 0.162.1, 0.166.0, 0.167.0 3개 공식 바이너리 전수에 대해:
    1. 실제 `app-server --listen unix://` 프로세스 기동.
    2. 실제 `app-server proxy` 기동 및 WebSocket 101 Upgrade 핸드셰이크.
    3. S6-like 환경(`CODEX_HOME` 부재, `HOME=/root`)에서 검사 시 `helpers: 1, unknown: 0, canApply: true` 정상 귀속 검증.
    4. 위조 레코드(`proxyTargetMismatch`), old empty 레코드(`missingTargetSocket`) 음성 시험 통과.
    5. 프록시 종료 후 idle server 상태 복귀 검증.

### 5) [P2] CI 워크플로우 보강
- `.github/workflows/ci.yaml`의 `Run Python policy and helper tests` 단계에:
  - `CODEX_WIRE_PROBE_BINARY: ${{ github.workspace }}/.test-tmp/candidate-167/bin/codex`
  - `CODEX_HANDOVER_BASELINE: ${{ github.workspace }}/.test-tmp/task007-baseline/bin/codex`
  - `CODEX_HANDOVER_CANDIDATE: ${{ github.workspace }}/.test-tmp/candidate-167/bin/codex`
  를 추가하여 CI 환경에서도 실기 라이브 핸드오버 및 wire probe가 누락 없이 상시 실행되도록 보장.

---

## 3. PLAN 및 FIX 기준 수용 행렬

| 구분 | 요구사항 | 구현 및 검증 결과 | 판정 |
| --- | --- | --- | --- |
| **PLAN §1** | 기본 Unix 소켓 정규화 및 파서 parity | `resolveDefaultControlSocket`, `--listen unix://`, `--sock` 생략 proxy 일치 | **PASS** |
| **PLAN §2** | proxy 커널 피어 매핑 귀속 (중복 blocker 0) | Pass 4 커널 피어 매핑 검증, S6 inspector 환경 귀속 | **PASS** |
| **PLAN §3** | 프로세스 검사 권한(`EACCES`) 진단 | Pass 1/2/4/5 인벤토리 보존, fault injection 실증 (`inspection_permission_denied`) | **PASS** |
| **PLAN §4** | 이력 관리 (100개, 7일 상한, 스키마 검증) | `appendHistoryRecord`, enum allowlist, 7일 초과 항목 자동 퍼지 | **PASS** |
| **PLAN §5** | 03:00 date rollover 및 저빈도 4회 재확인 | 03:00 슬롯 전환 시 0 초기화 및 `budget_reset`, 저빈도 60분 간격 일 최대 4회 | **PASS** |
| **PLAN §6** | 데몬 sleep 시간 계산 단일화 | `Math.min(lowFreqSleep, defaultSlotSleep)`로 03:00 rollover 슬롯 미스 방지 | **PASS** |
| **PLAN §7** | 공식 바이너리(0.162.1, 0.166.0, 0.167.0) 호환 | 3개 공식 바이너리 실기 server/proxy/handshake/attribution E2E 검증 | **PASS** |
| **PLAN §8** | 무중단 라이브 핸드오버 실기 검증 | 0.162.1 → 0.167.0 4개 시나리오(stdio, ws, tui, resume) 실기 100% 통과 | **PASS** |
| **FIX_01 P1** | Pass 2 미등록 stat EACCES 인벤토리 복원 | Pass 2 continue 회귀 제거, 인벤토리 보존 및 fault injection 통과 | **PASS** |
| **FIX_01 P2** | 0.7.3 레거시 상태 마이그레이션 | `reconcileLegacyPausedState`, 60분 간격 예약, 4회 소진 가드 | **PASS** |
| **FIX_01 P2** | 03:00 이전 수면 계산 결함 수정 | `defaultSlotSleep` 결합 단일 수면 계산 검증 | **PASS** |
| **FIX_01 P2** | 이력 스키마 엄격화 / 0.167.0 해시 분리 | enum 도입, tar.gz(`3bbf75e8...`)와 바이너리(`cdcb45aa...`) 분리 기재 | **PASS** |
| **FIX_02 P2** | default proxy 검사자 환경 의존성 제거 | `proc.env` + `record.socketPath` + Pass 4 커널 피어 매핑 결합 | **PASS** |
| **FIX_02 P2** | staged 이력 누락 및 시간대 불일치 해결 | staged 시 `version_check` 기록, `state.timezone` 영속화 및 `checkNumber` 분리 | **PASS** |
| **FIX_02 P2** | migration 유휴 확인 시각 대체 금지 | 마이그레이션 현재 시각 기준 60분 뒤 예약으로 수정 | **PASS** |
| **FIX_02 P2** | 실제 daemon 연속 시험 및 실기 E2E | `test_issue71_real_daemon_continuous_lifecycle`, `test_issue71_real_binary_default_proxy_e2e` | **PASS** |
| **FIX_02 P2** | CI 핸드오버 환경변수 연결 | `.github/workflows/ci.yaml`에 BASELINE / CANDIDATE 환경변수 연결 | **PASS** |

---

## 4. 검증 결과 종합

### 1) 로컬 자동화 테스트 결과
- `tests/test_codex_update_contract.py`: **140 passed in 124.09s** (100% PASS, Issue #71 10개 핵심 테스트 포함 전수 무회귀)
- `tests/test_codex_update_fix03.py`: **12 passed** (100% PASS)
- `tests/test_secret_scan.py`: **2 passed** (비밀값/토큰 누출 0건)
- `tests/test_codex_wire_probe.py`: **1 passed in 0.21s** (0.167.0 공식 바이너리 wire 프로브 통과)
- `tests/test_codex_live_handover.py`: **4 passed in 26.30s** (공식 0.162.1 → 0.167.0 실기 무중단 인계 4개 테스트 100% 통과)
- Reviewer 독립 재현 스크립트:
  - `.test-tmp/review008-fix01/observability-probe.mjs`: PASS (`stageReturned: "0.163.0"`, `versionCheckEvents: 1`, `Asia/Seoul` 일치, 60분 간격 예약)
  - `.test-tmp/review008-fix01/default-proxy-env.py`: PASS (`matching_env` 및 `s6_like_env` 모두 `helpers: 1, unknown: 0, canApply: true`)

### 2) 정적 분석 결과
- `node --check codex-runtime-manager.mjs codex-updater-daemon.mjs`: 성공
- `bash -n codex`: 성공
- `python3 -m py_compile tests/*.py`: 성공
- `git diff --check`: 성공

---

## 5. 실행 환경 및 잔여 공백 (Explicit Gaps)

- **로컬 검증 완료 (PASS)**:
  - Linux x86_64 환경에서 공식 3개 바이너리(0.162.1, 0.166.0, 0.167.0)를 사용한 실제 프로세스 기동, Unix 제어 소켓, WebSocket 101 핸드셰이크, 커널 피어 매핑, S6 관리자 환경 귀속, 무중단 라이브 인계 검증.
- **미실행 항목 (NOT RUN)**:
  - **native ARM (aarch64)**: 현재 x86_64 리눅스 호스트에서 작업 중이므로 native aarch64 실기 실행은 미수행 (아키텍처 매핑 및 SHA-256 검증 로직으로 지원).
  - **HAOS / Mobile 실제 기기 통합 배포**: 본 작업은 로컬 개발 브랜치(`feat/issue-71-default-socket-observability`) 내 구현 및 테스트이며, 실제 운영 HAOS 환경 적용이나 모바일 UI 배포는 수행하지 않음.
  - **외부 배포 / Git Push / PR**: 사용자 지침 및 AGENTS.md 절대 원칙에 따라 외부 push, PR 생성, 버전 태그 발행은 수행하지 않음.
