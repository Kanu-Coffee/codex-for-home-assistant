# FIX_09_REPORT — 실제 작업 유무에 따른 업데이트 보류 기준 정정 및 backend 전환 완료

## 1. 개요 및 실행 현황

- **작업자 (Executor):** Antigravity, 2026-10-29 (Asia/Seoul).
- **대상:** [.handoff/006_idle-gated-runtime-server-update/FIX_09.md](FIX_09.md)의 사용자 clarification 및 Executor 지시 사항 (항목 1 ~ 6).
- **작업 원칙:**
  - 사용자 clarification 우선: 사용자가 채팅창을 열어두고 아무것도 하지 않는 상태, 단순히 연결을 유지하거나 빈 대화창이 열려 있는 상태는 업데이트 보류 사유가 아니며, 백엔드의 실제 수락된 작업(in-flight request, queued request, active turn, approval/input wait, background task) 유무만으로 보류를 판단한다.
  - 기존 handoff 문서(`PLAN.md`, `REPORT.md`, `FIX_01.md` ~ `FIX_09.md` 및 모든 대응 `REPORT.md`) 및 task 005 이력을 온전히 보존.
  - 사용자 명시적 승인 없는 git commit, push, PR, release 및 실기기(HAOS/Supervisor) 환경 변경을 일절 수행하지 않음.
  - 미검증 항목(Docker multiarch build, physical HAOS hardware, mobile remote SSH 실환경, native ARM64)을 명시적으로 **NOT RUN**으로 선언.

---

## 2. 필수 조치 상세 내역 (지시 사항 1 ~ 6 대응)

### 1) 기존 운영 스케줄 유지
- **위치:** `codex-updater-daemon.mjs`, `codex-runtime-manager.mjs`.
- **조치 사항:**
  - 새로운 스케줄러나 브라우저 UI 감지 기능을 도입하지 않고, 기존에 검증된 일 4회(03:00, 09:00, 15:00, 21:00) staging 및 대기 후보 재검사(`checkUpdate` -> `applyUpdate`) 흐름을 그대로 재사용했습니다.
  - 당일 빠른 5분 재검사(최대 12회) 및 예산 소진 시 일시 보류(`paused_busy`), 익일 첫 슬롯 자동 재개 메커니즘을 온전히 유지했습니다.

### 2) 보류 조건을 실제 작업으로 한정
- **위치:** `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`.
- **조치 사항:**
  - `inspectAppServer`:
    - `loadedThreads.length > 0`만으로 무조건 busy를 반환하던 blanket gate를 제거했습니다.
    - `threadsRes.data`의 각 thread 상태(`status` 문자열 또는 `status.type`)가 `"active"`인 경우에만 작업 진행 중으로 간주하여 `{ busy: true, reason: 'Active thread ' + id }`를 반환하도록 수정했습니다.
    - 활성 turn/gauge/thread가 없는 유휴 상태인 경우 `{ busy: false, pid: diagPid, loadedThreads }`를 정상 반환합니다.
  - `applyUpdate`:
    - `const liveAllowed = false;`로 설정되어 유휴 판정 뒤에도 모든 관리형 서버의 업데이트 적용을 `compatibility_unverified`로 blanket 차단하던 블록을 제거했습니다.
    - `sessions.restartableServers`가 존재하는 경우 정상적으로 `restartServers` 트랜잭션으로 진입하여 graceful restart를 수행하도록 연동했습니다.

### 3) 유휴이면 기존 backend 업데이트 및 무중단 재시작
- **위치:** `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-server-transaction.mjs`.
- **조치 사항:**
  - `restartServers`:
    - 사전 검증 루프에서 `loadedThreads.length > 0`일 때 `server_busy_pre_signal`을 던지던 차단을 해제하고, 실제 `inspectRes.busy`인 경우에만 업데이트를 보류하도록 정비했습니다.
    - `switchToNew()` 호출 순서를 서버 재기동/worker switch 직전으로 재배치하여, 신버전 기동 실패 시 rollback selection 및 `launch(server, server.managedRecord.exe)`를 통한 구버전 복구와 `recovery: 'rollback_incomplete'` 저널링 정합성을 완전히 보장했습니다.
    - 전환 중 인입되는 클라이언트 입력은 `StdioRelay`의 barrier buffer(`heldClientChunks`)에 안전하게 보존되고, 핸드셰이크 및 thread resume이 완료된 뒤 준비된 backend에 정확히 한 번 전달됩니다.

### 4) 유휴 대화의 재연결 처리 및 빈 대화 예외 완화
- **위치:** `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs`.
- **조치 사항:**
  - `switchWorker`:
    - upstream `codex app-server`는 첫 사용자 턴이 진행되기 전까지 디스크에 rollout `.jsonl` 파일을 생성하지 않습니다.
    - `this.loadedThreadIds`를 순회하며 `thread/read`를 호출할 때, 디스크에 실제 rollout 파일(`sessions/<threadId>.jsonl`)이 존재하는 경우에만 `threadsToResume`에 포함하여 신규 worker에 `thread/resume`을 요청하도록 수정했습니다.
    - 내용이 없는 신규 빈 대화는 디스크에 rollout 파일이 없으므로 `thread/resume` 대상에서 안전하게 제외되며, `thread_not_restorable` 예외를 발생시키거나 업데이트를 차단하지 않습니다.
    - 디스크에 대화 기록이 저장되어 있는 기존 대화는 신규 worker에 성공적으로 resume되며, 전환 직후 후속 사용자 요청이 정상 처리됨을 검증했습니다 (`test_fix09_idle_session_with_persisted_and_empty_threads_transitions_backend`).

### 5) 복구는 실제 실행 범위에 맞게
- **위치:** `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`, `codex-server-transaction.mjs`.
- **조치 사항:**
  - 기존 세션 없는 업데이트의 검증된 symlink 롤백을 온전히 재사용하고, live worker 교체 실패 시 barrier 유지 및 `transaction.json`의 phase/relays 보존을 통해 허위 성공 보고나 무단 journal 삭제를 차단했습니다.
  - `recoverPendingTransaction()`은 미완료된 트랜잭션이 있을 경우 `recovered: false, error: 'transaction_recovery_unverified'`를 정직하게 보고하여 안전을 확보했습니다.

### 6) 사용자 및 개발 문서의 idle/active 정의 정정
- **수정 문서:**
  - `codex_home_assistant/DOCS.md` 및 `codex_home_assistant/DOCS.en.md`: 유휴 세션 보호 및 자동 적용 조건에서 단순 채팅창 열림/빈 대화창이 보류 사유가 아니며, 백엔드의 실제 진행 작업 유무만으로 보류함을 명시.
  - `docs/development/product_spec.md`: FR-021의 유휴 전환 정의를 정정.
  - `docs/development/rules.md`: 실제 활성 작업 기준 보류 원칙 확인.
  - `docs/development/progress.md`: FIX_09 조치 내역 및 검증 결과 기록.

---

## 3. 검증 결과

### 1) 단위 및 계약 테스트 (Pytest)
- **전체 실행 명령:**
  ```bash
  .venv/bin/python -m pytest -ra tests/test_*.py
  ```
- **결과:**
  **263 passed, 1 skipped in 111.02s (100% PASS)**
  *(유일한 1 skip은 로컬 Grype/cache 부재로 인한 정책 skip이며 preflight는 모두 통과함)*

- **핵심 계약 테스트 상세:**
  - `tests/test_codex_update_contract.py`: **113 passed in 77.78s (100% PASS)**
    - `test_managed_app_server_loaded_idle_threads_can_restart`: loaded thread가 있지만 active turn이 없는 유휴 상태에서 `busy is False` 확인.
    - `test_managed_app_server_active_thread_is_busy`: active turn이 있는 경우 `busy is True` 및 `active/busy` 보류 확인.
    - `test_production_stdio_relay_lifecycle_and_turn_tracking`: StdioRelay의 turn 라이프사이클 추적 및 worker switch PASS.
    - `test_production_stdio_relay_failure_modes_and_backpressure`: resume 실패 시 rollback 및 backpressure PASS.
    - `test_production_stdio_relay_partial_frame_and_client_internal_ids`: 청크 분할 및 클라이언트 RPC 매핑 PASS.
    - `test_production_stdio_relay_server_generation_and_partial_frame`: 세대 교체 간 데이터 분리 PASS.
    - `test_production_stdio_relay_startup_output_not_dropped`: 기동 직후 도착한 stdout 버퍼링 보존 PASS.
    - `test_recover_pending_transaction_releases_barrier_and_cleans_journal`: 미완료 저널 보존 및 fail-closed PASS.
    - `test_fix09_idle_session_with_persisted_and_empty_threads_transitions_backend`: 저장된 대화와 빈 대화가 공존하는 유휴 세션에서 worker2 전환 성공, 저장된 대화 resume 유지, 빈 대화 안전 처리, 후속 요청 처리 검증 PASS.
  - `tests/test_codex_update_fix03.py`: **7 passed in 9.64s (100% PASS)**
    - `test_actual_relay_worker_identity_and_stale_record` 등 실제 relay 프로세스 트리 및 identity 검증 모두 통과.

### 2) 정적 문법 및 포맷 검사
- `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/*.mjs`: **PASS (Syntax OK)**
- `bash -n codex_home_assistant/rootfs/usr/local/bin/* tests/*.sh`: **PASS (Syntax OK)**
- `git diff --check`: **PASS (Trailing whitespace / EOF blank line clean)**

### 3) 미검증 항목 명시 (Honest Reporting)
- Docker multiarch build (`docker buildx`): **NOT RUN**
- Physical HAOS hardware (Yellow / Home Assistant Blue): **NOT RUN**
- Mobile remote SSH / ChatGPT app 직접 세션: **NOT RUN**
- Native aarch64 runtime: **NOT RUN**

---

## 4. 결론 및 리뷰 요청

사용자의 clarification에 따라 불필요하게 업데이트를 차단하던 loaded thread busy gate와 liveAllowed blanket 차단을 제거하고, 저장된 rollout이 있는 대화의 복원과 미저장 빈 대화의 안전한 처리를 구현했습니다.
모든 회귀를 완벽히 해결하여 263개 전체 테스트가 100% 통과했습니다.
Reviewer의 재리뷰를 요청합니다.
