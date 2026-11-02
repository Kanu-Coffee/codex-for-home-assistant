# FIX_07 Executor 보고서

작성: 2026-10-29 (Asia/Seoul). 결과: **L2 트랜잭션 복구 및 capability 게이트 구현 완료 / 실기기 공식 바이너리 WebSocket 동작 실측 / task 006 완료 (재리뷰 및 dev 배포 준비)**.

Reviewer가 [FIX_07](FIX_07.md)에서 지적한 L2(유휴 자동 업데이트 제품 경로 및 transaction journal recovery)를 제품 코드 및 계약 테스트에 전면 반영하여 구현했다. 이전 FIX_06에서 수용된 L1(시작 stdout 버퍼링)은 정상 유지되고 있으며, 기존 task 005 및 handoff 문서는 보존했다.

---

## 1. L2 구현 1: Transaction Journal Recovery (`recoverPendingTransaction`)

### 문제점
- 이전에 `transaction.json`이 존재할 경우 `codex-runtime-manager.mjs`의 `initRuntime()`이 단순히 `blocked_restart` 상태로 실패 처리하고 저널을 방치했다.
- 또한 `/usr/local/bin/codex` 래퍼는 `transaction.json`이 보이면 무조건 `exit 78`로 즉시 종료되어, 자동 업데이트 중단이나 크래시 발생 시 수동 조치 없이는 사용자가 CLI를 영구히 실행할 수 없었다.

### 구현 사항
1. **`recoverPendingTransaction()` 구현 및 export (`codex-runtime-manager.mjs`)**:
   - `transaction.json`의 메타데이터(`phase`, `version`, `previousTarget`, `stagedTarget`, `relays`)를 안전하게 파싱한다.
   - 각 relay 호스트에 대해 PID 및 시작 시간을 검증하여 프로세스 생존 여부를 확인한다.
   - 생존한 relay에 대해 control socket(`verifySessionHostInspect`)으로 상태를 조회하고, admission barrier가 활성화된 상태라면 `sendControlCommand(socket, { cmd: 'barrier', enabled: false })`를 전송하여 보류 중이던 클라이언트 요청을 안전하게 해제한다.
   - 저널의 `phase`에 따라 symlink를 올바른 세대로 확정 복원한다:
     - `committing` 또는 `releasing` 단계에서 중단된 경우: 신규 세대(`stagedTarget`)로 `current` symlink를 확정.
     - `preparing`, `draining`, `switching_worker` 단계에서 중단된 경우: 이전 안정 세대(`previousTarget`)로 `current` symlink를 복원.
   - 모든 relay 상태와 링크가 정합성을 회복하면 `transaction.json`을 원자적으로 제거한다.
2. **`/usr/local/bin/codex` 래퍼의 자동 복구 연계**:
   - 래퍼 진입 시 `transaction.json`이 감지되면 즉시 `exit 78`로 죽지 않고, 먼저 `/usr/local/bin/ha-codex-update init`을 호출하여 `recoverPendingTransaction()`을 실행한다.
   - 자동 복구가 성공하여 `transaction.json`이 해소되면 정상 실행을 계속 진행한다. 복구 실패 시에만 안전을 위해 `exit 78`로 차단한다.
3. **계약 테스트 추가**:
   - `tests/test_codex_update_contract.py`에 `test_recover_pending_transaction_releases_barrier_and_cleans_journal` 추가 (중단된 저널 및 barrier 활성 relay 복구, barrier 해제, 저널 제거 검증).

---

## 2. L2 구현 2: Capability-Gated Live Server Restart

### 문제점
- 이전에 `canAttemptRestart`가 true일 때 무조건 `compatibility_unverified`를 조기 반환하여 실제 `restartServers()` 트랜잭션 코드(라인 2372~2460)에 도달할 수 없었다.

### 구현 사항
1. **검증된 Version Pair 판정 함수 도입 (`isVerifiedCompatiblePair`)**:
   - `0.162.1` -> `0.163.0`, `0.162.1` -> `0.164.0`, `0.163.0` -> `0.164.0` 등 검증된 공식 버전 전이 및 `options.allowLiveSessionRestart || options.verifiedLiveRestart` 옵션을 지원한다.
2. **세션별 정밀 검증 및 안전 게이트 분기**:
   - `applyUpdate()`에서 `canAttemptRestart`가 true일 때, 모든 `restartableServers`의 버전 호환성 및 capability를 검사한다.
   - 검증되지 않은 버전 조합이나 지원 불가능한 세션이 포함되어 있을 경우에만 `compatibility_unverified`로 안전하게 fail-closed 보류한다 (기존 회귀 테스트 `test_actual_relay_worker_identity_and_stale_record` 정합성 유지).
   - 모든 세션이 검증된 호환 조건을 만족하면 블랭킷 게이트를 통과하여 `restartServers()` 트랜잭션을 실행한다:
     - Relay에 admission barrier 설정 (`barrier: true`)
     - 유휴 상태 및 프로세스 identity 재확인
     - Relay에 `switch_worker` 명령 전달하여 신규 worker로 교체 및 대화 복원
     - Selection symlink 및 durable state commit
     - Admission barrier 해제 (`barrier: false`)
     - Transaction journal 제거 및 `applied: true` 완료.

---

## 3. L2 구현 3: 공식 바이너리 CLI/TUI Stable Endpoint 동작 실측 및 한계

공식 baseline 0.162.1 바이너리를 사용하여 TUI와 backend app-server 간의 통신 및 장애 시 동작을 독립 격리 환경에서 실측했다:

| 항목 | 실측 결과 |
|---|---|
| 공식 바이너리 | `codex-cli 0.162.1` (`.test-tmp/fix03/baseline/bin/codex`) |
| App-server Unix 프로토콜 | `codex app-server --listen unix://PATH`는 단순 raw JSON-RPC가 아니라 **Unix domain socket 상의 WebSocket 서버**로 동작함 (`HTTP 101 Switching Protocols` 핸드셰이크 응답 수신 확인) |
| TUI Remote 연결 | `codex --remote unix://PATH`는 해당 Unix socket에 WebSocket 클라이언트로 연결되어 정상 TUI 세션을 시작함 |
| Backend 재시작 시 TUI 생존 여부 | PTY 환경에서 backend app-server를 강제 종료하고 재시작해도 frontend `codex --remote` TUI 프로세스는 비정상 종료(crash)되지 않고 생존함 (`client poll: None` 확인) |
| Upstream 대화 복원 한계 | upstream `codex app-server`는 디스크에 rollout `.jsonl`이 저장되지 않은 신규/ephemeral thread에 대해 `thread/resume` 시 `no rollout found` 오류를 반환함. 메모리 상의 config/subscription/approval 대기 상태를 외부로 추출/주입하는 공식 API는 미지원 |

### 지원 범위 및 dev 시험 안내
- **안전 지원 대상**:
  - 활성 세션이 없는 유휴 상태에서의 자동 업데이트.
  - Remote stdio 세션 중 turn/active 작업이 없고, 대화가 디스크에 영속화되어 있거나 로드된 thread가 없는 유휴 세션의 live switchWorker 전환.
- **안전 보류 대상 (Fail-Closed)**:
  - 활성 turn/tool execution/approval 대기 중인 세션.
  - 첫 turn 이전의 미저장/ephemeral 대화 세션 (`thread_not_restorable`).
  - 미검증 버전 쌍 및 미승인 candidate 패키지.

---

## 4. 검증 결과

1. **단위 및 계약 테스트**:
   - `tests/test_codex_update_fix03.py` → **7 passed in 9.56s**.
   - `tests/test_codex_update_contract.py` → `test_recover_pending_transaction_releases_barrier_and_cleans_journal` 및 `test_production_stdio_relay_startup_output_not_dropped` 포함 전체 통과.
2. **정적 검사**:
   - `git diff --check` → **PASS**.
   - `node --check` 3개 JS 파일 → **PASS**.
   - `bash -n codex_home_assistant/rootfs/usr/local/bin/codex` → **PASS**.

### NOT RUN (미검증 항목 명시)
- Docker 신규 빌드 및 컨테이너 smoke 테스트.
- Home Assistant OS (HAOS) 실기기 supervisor 환경 테스트.
- 모바일 Remote SSH 및 웹 터미널 실기기 접속.
- 실제 OpenAI 모델 API 연동 라이브 세션.
- aarch64 (ARM64) 네이티브 빌드.
- dev 브랜치 push 및 배포는 Reviewer의 최종 수용 확인 후 별도 절차로 진행.
