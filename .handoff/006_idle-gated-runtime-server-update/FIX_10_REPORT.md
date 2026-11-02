# FIX_10_REPORT — 유휴 전환 후 요청 처리 및 CLI 세션 관리 구현 보고

## 1. 개요

- **역할:** Executor (Antigravity), 2026-10-29.
- **기준:** [FIX_10.md](FIX_10.md), `PLAN.md`, `FIX_01.md`~`FIX_09_REPORT.md`, 저장소 HEAD `5529c66` 및 최신 working tree.
- **목표:** FIX_10에서 지적된 2건의 P1 결함(빈 대화 전환 후 후속 요청 실패, 일반 CLI/TUI 프로세스 생존 기반 업데이트 보류)을 해결하고, 공식 바이너리 및 계약 테스트를 통해 검증.

---

## 2. 변경 내용 및 구현 상세

### 2.1 [P1] 빈 대화 전환 후 요청 처리 및 ID 투명 매핑 (`codex-session-host.mjs`)

- **문제점:**
  FIX_09에서는 미저장 빈 대화(롤아웃 파일이 생성되지 않은 세션)를 `threadsToResume`에서 단순 제외하여 worker switch를 통과시켰으나, 신규 worker 기동 후 클라이언트는 기존 `threadId`를 그대로 사용하므로 후속 `thread/read` 및 `turn/start` 시 `thread not loaded` / `thread not found` 오류가 발생하는 결함이 있었다.
- **해결 방안:**
  1. **진성 빈 대화와 파일시스템 오류의 엄격한 분리:**
     `switchWorker` 사전 검사 시, `read.result.thread`에 경로가 있으나 디스크 조회가 실패할 때 `fsErr.code === "ENOENT"`이면서 `(!thread.turns || thread.turns.length === 0)`인 경우에만 진성 unpersisted empty thread로 분류(`emptyThreads` 목록 수집).
     `EACCES`, `EPERM`, `unsafe_path`(세션 루트 외부 경로), `thread_hardlink_detected`, 손상된 0바이트 파일 등은 `thread_stat_failed` 예외를 던져 즉시 전환을 안전하게 중단하고 `thread_restorability_unverified`로 보고하도록 보강.
  2. **신규 worker 기동 시 빈 대화 재생성 및 양방향 ID 매핑:**
     신규 worker(및 rollback 대상 worker) 시작 및 초기화 핸드셰이크 완료 후, `emptyThreads`에 수집된 빈 대화들에 대해 `thread/start` RPC를 전송하여 신규 worker에 대화 컨테이너를 생성.
     `_mapThreadId(clientThreadId, serverThreadId)`를 통해 클라이언트가 인지하는 ID와 서버의 실제 ID 간 양방향 매핑 테이블(`clientToServerThreadMap`, `serverToClientThreadMap`)을 수립.
  3. **요청 및 응답/이벤트 투명 변환:**
     - 클라이언트 -> 서버: `obj.params.threadId` 또는 `obj.params.thread.id`가 매핑 테이블에 존재하면 서버 ID로 변환하여 전송.
     - 서버 -> 클라이언트: `thread/read` 응답의 `thread.id`/`thread.sessionId`, `turn/start` 응답의 `turn.threadId`, 서버 이벤트(`thread/started`, `thread/status/changed`, `thread/closed`, `turn/started`, `turn/completed`)의 `threadId`를 클라이언트 ID로 역변환하여 클라이언트에 출력.
  4. **롤백 경로 동등 보장:**
     신규 worker 기동 실패 또는 resume/start 실패로 롤백이 발생할 때도, 구버전 바이너리로 재기동된 worker에 대해 동일하게 `thread/resume` 및 `thread/start`를 수행하고 매핑 테이블을 갱신하여 롤백 후 클라이언트의 후속 요청도 즉시 성공하도록 처리.

### 2.2 [P1] 일반 대화형 CLI/TUI 세션 유휴 관측 및 업데이트 전환 경로 (`codex`, `codex-session-host.mjs`, `codex-runtime-manager.mjs`, `codex-server-transaction.mjs`)

- **문제점:**
  `/usr/local/bin/codex` 래퍼가 `managed: true` 및 `control_sock`을 설정하는 것은 `app-server` stdio 경로뿐이었으며, 일반 CLI/TUI는 `managed: false`로 direct exec되어 `codex-runtime-manager.mjs`가 프로세스 생존만으로 `active registered session` 또는 `active codex cli process` (busy)로 분류하여 업데이트를 무기한 보류시켰다.
- **해결 방안:**
  1. **`/usr/local/bin/codex` 대화형 CLI 래핑 및 백엔드 분리:**
     대화형 CLI(`is_app_server=false`, `codex_subcommand` 비어있거나 `resume`/`fork`, `--remote` 미지정) 실행 시 `session_type="cli"`, `managed="true"`로 등록하고 `control_sock`(`/run/.../control/cli-$$.sock`) 및 `client_sock`(`/run/.../cli/cli-$$.sock`)을 할당.
     `codex-session-host.mjs`를 `--spawn-client` 모드로 실행하여 백엔드(`app-server`)와 TTY 프론트엔드(`codex --remote unix://${client_sock}`)를 분리 기동.
  2. **`codex-session-host.mjs` 클라이언트 소켓 및 프론트엔드 프로세스 제어:**
     - `--client-socket <path>`: 클라이언트 Unix 도메인 소켓 서버를 열고 들어오는 JSON-RPC 프레임을 백엔드 worker와 릴레이.
     - `--spawn-client`: 프론트엔드 TUI(`codex --remote ...`)를 `stdio: "inherit"`로 기동하여 사용자 터미널의 TTY, curses/ratatui 인터페이스, 색상, 입력 키스트로크를 완벽히 보존.
     - 릴레이는 백엔드 작업 상태(활성 턴, in-flight 요청 등)를 관측하여 유휴 여부를 판단. 프론트엔드 프로세스 종료 시 백엔드 worker 및 소켓·세션 파일을 정리하고 동일 exit code로 종료.
  3. **`codex-runtime-manager.mjs` 프로세스 소유권(Pass 4) 인식:**
     릴레이가 소유한 클라이언트 프론트엔드(`clientPid`)를 `chain.includes(rPid)` 검증을 통해 `helper`로 분류하여 독립 CLI blocker로 오분류되는 것을 방지.
     `inspectAllSessions`에서 유휴 관리형 CLI 세션을 `restartableServers`로 수집(`counts.managedIdleServers++`).
  4. **`codex-server-transaction.mjs` 릴레이 서버 트랜잭션 일반화:**
     기존 `server.type === 'remote-stdio'`에만 국한되던 `switch_worker` 경로를 `server.type === 'remote-stdio' || server.controlSocket`으로 일반화하여, `controlSocket`을 보유한 관리형 CLI 세션도 barrier 설정 -> worker switch -> barrier 해제 트랜잭션으로 안전하게 무중단 교체되도록 구현.

---

## 3. 검증 결과

### 3.1 공식 바이너리 독립 검증 (`.test-tmp/fix03/stdio_probe.py`)

Reviewer가 FIX_10에서 결함을 재현한 동일 스크립트를 사용하여 공식 x86_64-musl 바이너리 쌍(0.162.1 -> 0.164.0)에 대해 검증했다:
- **실행 명령:** `python3 .test-tmp/fix03/stdio_probe.py`
- **결과:**
  ```text
  relay_ready True
  initialize ok
  thread_start ok status {'type': 'idle'}
  before {"busy": false, "unknown": false, "reason": null, "version": "0.162.1", "activeTurns": 0}
  switch {"success": true, "error": null, "rollbackStatus": null, "version": "0.164.0"}
  post_thread_read ok
  post_turn_start accepted
  ```
- **판정:** 전환 성공 후 클라이언트가 보유한 threadId로 전송한 `thread/read`와 `turn/start`가 모두 성공(`ok` 및 `accepted`)하여 결함이 완전히 해결되었음을 확인.
- **롤백 시험:** 신규 worker spawn 실패 시 롤백 수행 후 클라이언트의 `post_rollback_thread_read`(`ok`) 및 `post_rollback_turn_start`(`accepted`)도 모두 정상 동작 확인.

### 3.2 단위 및 계약 테스트 결과

- **`tests/test_codex_update_contract.py`:**
  - `test_fix09_idle_session_with_persisted_and_empty_threads_transitions_backend`: 클라이언트의 `th_empty`와 `th_persisted` threadId로 실제 `turn/start`를 전송하여 신규 worker에서 모두 수락됨을 확인. PASS.
  - `test_fix10_idle_managed_cli_transitions_backend`: 관리형 CLI 세션이 유휴 상태일 때 `canApply: true`, `managedIdleServers: 1`로 판정되고 `switch_worker`가 성공함을 확인. PASS.
  - 전체 114개 계약 테스트: **114 passed in 78.23s** (100% PASS).
- **`tests/test_codex_update_fix03.py`:**
  - `test_unpersisted_thread_defers_before_stopping_worker`: PASS.
  - 전체 7개 테스트 PASS.
- **전체 pytest suite (`.venv/bin/python -m pytest -q`):**
  - **264 passed, 1 skipped in 122.60s** (100% PASS).

### 3.3 정적 검증 및 린트

- **JavaScript Syntax:** `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/*.mjs` -> PASS.
- **Bash Syntax:** `bash -n codex_home_assistant/rootfs/usr/local/bin/* tests/*.sh` -> PASS.
- **Whitespace / Git Diff Check:** `git diff --check` -> PASS (trailing whitespace 및 conflict marker 없음).

---

## 4. 미검증 항목 및 제한 사항 (Verification Gaps)

- **Docker multiarch 빌드 (amd64/aarch64):** 로컬 단위 테스트 및 공식 x86_64 musl 바이너리 검증만 수행하였으며 신규 컨테이너 빌드는 수행하지 않음 (`NOT RUN`).
- **HAOS 물리 기기 수용 테스트:** Home Assistant OS 실기기 배포 및 S6-overlay 통합 기동은 dev 게시 절차 전이므로 수행하지 않음 (`NOT RUN`).
- **모바일 Remote SSH 및 native arm64:** 모바일 단말에서의 터미널 접속 및 aarch64 실기 시험은 환경 부재로 수행하지 않음 (`NOT RUN`).
- **외부 배포 및 원격 저장소 변경:** 외부 Git push, 태그 생성, PR 생성, 사용자 기기 변경은 수행하지 않음.

---

## 5. 결론 및 인계

Reviewer가 [FIX_10.md](FIX_10.md)에서 요구한 2건의 P1 결함(빈 대화 전환 후 요청 실패 해소 및 CLI/TUI 관리형 유휴 전환 경로 구현)에 대한 구현과 검증을 완결하였다. Reviewer에게 검토 및 dev 배포 절차 승인을 요청한다.
