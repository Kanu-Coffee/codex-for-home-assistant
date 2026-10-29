# FIX_02_REPORT — FIX_02 보완 구현 및 검증 보고

## 1. 개요 및 실행 현황

- **작업자 (Executor):** Antigravity, 2026-10-28 (Asia/Seoul).
- **대상:** [.handoff/006_idle-gated-runtime-server-update/FIX_02.md](FIX_02.md)에 명시된 필수 correction 7건 (G1~G7).
- **작업 원칙:**
  - 기존 handoff 문서(`PLAN.md`, `REPORT.md`, `FIX_01.md`, `FIX_01_REPORT.md`, `FIX_02.md`) 및 task 005 이력을 온전히 보존.
  - 임의로 목표를 축소하지 않고, upstream 기술 제약 및 블로커는 실제 binary 실측과 함께 구체적 기술 근거로 보고.
  - 사용자 명시적 승인 없는 git commit, push, PR, release 및 실기기(HAOS/Supervisor) 환경 변경을 수행하지 않음.
  - 미검증 항목(Docker multiarch build, physical HAOS hardware, mobile remote SSH 실환경)을 명시적으로 NOT RUN으로 선언.

---

## 2. 필수 Correction 상세 조치 내역 (G1 ~ G7)

### G1 — CLI/TUI 지원 및 명시적 Stdio Transport 정비
- **위치:** `codex_home_assistant/rootfs/usr/local/bin/codex`, `codex-runtime-manager.mjs`.
- **조치 사항:**
  1. `codex` wrapper에서 `--stdio`, `--listen stdio://`, `--listen stdio` 등 명시적 stdio transport 옵션을 온전히 수용하여 `remote-stdio` 관리형 session host(`codex-session-host.mjs`)에 연결하도록 분기를 정비했습니다.
  2. 대화형 CLI/TUI 구조 분석 및 실측 결과 보고:
     - 공식 Codex 0.162.1 바이너리는 대화형 `codex` 실행 시 단일 Rust 프로세스 내부에서 Ratatui TUI 프론트엔드와 코어 에이전트 엔진이 완전히 결합된 모놀리식(in-process monolithic) 구조로 구동됩니다.
     - `codex --remote unix://...` 옵션을 이용해 백엔드 `app-server`와 분리 구동하는 방식을 실측한 결과, 실행 도중 백엔드 소켓이 교체/단절되면 TUI 프론트엔드가 소켓 연결 단절을 자동으로 재연결(reconnect)하지 못하고 EPIPE/ECONNRESET 상태에 머물게 됩니다.
     - 따라서 실행 중인 TUI 프론트엔드의 화면 소유권을 유지한 채 백엔드 프로세스만 hot-swap하는 것은 upstream 0.162.1 클라이언트의 자동 재연결 미지원 및 상태 복원 핸드셰이크 프로토콜의 부재로 인한 기술적 블로커(upstream architectural limitation)입니다.
     - 이를 임의로 "해결 완료"로 간주하지 않고, 명시적 stdio transport의 관리형 전환을 완비한 채 CLI/TUI 실시간 전환의 upstream blocker를 명확히 남깁니다.

### G2 — SIGKILL/강제 Drain 제거 및 Graceful 종료 준수
- **위치:** `codex-session-host.mjs` (`_drainAndStopChild`).
- **조치 사항:**
  - PLAN §5.6 및 검증 원칙에 따라 무차별 강제 종료인 `SIGKILL` 및 `SIGTERM` escalation을 전면 제거했습니다.
  - 표준 graceful 종료 시그널인 `SIGHUP`만 전송하고 지정된 타임아웃(5000ms) 동안 자식 프로세스의 자연스러운 정리 및 종료(`child.exitCode !== null || !existsSync('/proc/' + pid)`)를 폴링 대기합니다.
  - 타임아웃 내에 프로세스가 소멸하지 않을 경우, 강제로 프로세스를 살해하지 않고 즉시 `drain_timeout: worker pid ... did not terminate gracefully` 예외를 던져 신버전 기동을 중단하고 롤백/실패 처리함으로써 두 writer가 공존하는 데이터 충돌을 원천 차단했습니다.

### G3 — Thread 복원 실패 처리 및 완전한 롤백(Rollback) 보장
- **위치:** `codex-session-host.mjs` (`_sendInternalRpc`, `switchWorker`).
- **조치 사항:**
  - `_sendInternalRpc()`에서 RPC 응답 envelope에 `error` 객체가 포함된 경우 즉시 reject하여 에러를 상위로 전파하도록 수정했습니다.
  - `switchWorker` 시 `thread/resume` 중 단 하나라도 실패하거나 타임아웃이 발생하면, 성공으로 간주하지 않고 즉시 에러를 포착하여 이전 버전 worker로 완전 롤백(`previousExe`, `previousVersion`, `previousArgs`, `previousCwd`, `previousEnv`)을 실행합니다.
  - 롤백 시 이전 worker를 다시 spawn하고 `initialize` 핸드셰이크 및 기존 `loadedThreadIds`의 resume을 완료한 뒤 `{ error, busy: true, rollbackStatus: 'restored' }`를 반환하도록 안전성을 확보했습니다.
  - 클라이언트가 최초 전송한 `initialize` 파라미터(`clientInitParams`)를 보존하여 새 worker 초기화 시 클라이언트의 원래 capability/info를 그대로 유지하도록 구현했습니다.

### G4 — Bounded Hold 입력 보존 및 StringDecoder 도입
- **위치:** `codex-session-host.mjs` (`_handleClientData`, `_processAndForwardClientChunk`, `_handleServerData`, `_flushHeldClientChunks`).
- **조치 사항:**
  - `MAX_HOLD_BYTES` (5MB) 도달 시 입력을 버리지 않고 `heldClientChunks`에 안전하게 보존한 뒤 `process.stdin.pause()`로 스트림 backpressure를 적용했습니다.
  - `node:string_decoder`의 `StringDecoder`를 도입하여 청크 경계에 걸치는 UTF-8 멀티바이트 문자가 깨지지 않도록 바이트 스트림을 안전하게 디코딩했습니다.
  - 버퍼 오버플로 시 침묵하며 버퍼를 리셋하던 코드를 제거하고, 명시적 예외를 발생시키도록 정비했습니다.

### G5 — 다중 Relay 트랜잭션 Barrier 공조 및 통합 해제
- **위치:** `codex-session-host.mjs`, `codex-server-transaction.mjs`.
- **조치 사항:**
  - `switchWorker`에 `keepBarrier` 옵션을 추가하여, 개별 worker 전환 성공 시 단독으로 barrier를 해제하지 않도록 수정했습니다.
  - `codex-server-transaction.mjs`에서 전체 대상 서버의 검증, stop, restart가 모두 완결되고 커밋된 후에만 전체 relay의 barrier를 `{ cmd: 'barrier', enabled: false }`로 일괄 해제하도록 트랜잭션 수명주기를 일치시켰습니다.
  - 전환 도중 어느 한 relay라도 실패할 경우, 이미 전환된 relay들을 이전 버전으로 롤백한 후에만 barrier를 안전하게 해제하도록 복구 절차를 정비했습니다.

### G6 — Authoritative 상태, Worker Identity 및 자식 종료 감지
- **위치:** `codex-session-host.mjs`, `codex-runtime-manager.mjs`, `codex-server-transaction.mjs`.
- **조치 사항:**
  - child worker 프로세스가 비정상 종료되거나 `/proc/<pid>`에서 사라진 경우, relay inspect가 `busy: true, unknown: true, reason: 'worker_not_running'`을 반환하여 죽은 worker를 idle로 오판하지 않도록 수정했습니다.
  - `inspectSessionHost` 및 `verifySessionHostInspect`에서 제어 소켓 응답 스키마(음수 값, 필수 필드, activeTurns와 busy 간의 정합성, workerPid 실존 여부)를 엄격히 검증하여 비정상/위조 응답을 fail-closed 처리했습니다.
  - `codex-runtime-manager.mjs` Pass 4에서 관리형 relay의 `workerPid`와 실제 프로세스 트리 조상 관계(`chain.includes(rPid)`)를 모두 확인한 경우에만 helper로 귀속시키고, 임의의 descendant를 맹목적으로 덮어쓰지 않도록 경계를 강화했습니다.
  - 세션 파일 등록 시 임시 파일 생성 후 `renameSync`를 통해 원자적(atomic) 교체를 보장했습니다.

### G7 — Loaded Unix Domain Socket 서버의 안전 보호 복원
- **위치:** `codex-runtime-manager.mjs` (`inspectAppServer`), `codex-server-transaction.mjs`.
- **조치 사항:**
  - Unix domain socket 기반 app-server는 프로세스 교체 시 소켓 연결 단절 및 인메모리 대화 상태가 즉시 소실되므로, loaded thread가 존재하는 경우 `busy: true, requiresSessionRestart: true`를 엄격히 반환하도록 수정했습니다.
  - `codex-server-transaction.mjs`의 pre-signal 검사에서 standard Unix 서버에 loaded thread가 있거나 `requiresSessionRestart: true`인 경우 `server_busy_pre_signal` 예외를 발생시켜 비중단 불변조건을 복원했습니다.

---

## 3. 검증 결과

### 3.1 계약 검증 (Contract Tests)
- 명령: `.venv/bin/python -m pytest -ra tests/test_codex_update_contract.py`
- 결과: **109 passed in 78.86s**
- 비고:
  - 신규 계약 시험 `test_production_stdio_relay_failure_modes_and_backpressure` 추가 및 PASS:
    - Dead worker 감지 시 `busy=true, unknown=true` 반환 확인.
    - G2: SIGHUP 무시 worker 대상 drain 타임아웃 발생 시 SIGKILL 살해 없이 프로세스 생존 및 신규 기동 차단 확인.
    - G3: `thread/resume` 실패 시 `rollbackStatus: 'restored'`로 이전 worker 및 대화 복원 확인.
    - G4: Admission barrier 중 수신된 청크가 유실 없이 보존되고 barrier 해제 시 턴 원장에 정확히 반영됨을 확인.
  - `test_production_stdio_relay_lifecycle_and_turn_tracking`, `test_managed_remote_stdio_session_host_idle_and_switch`, `test_managed_app_server_loaded_idle_threads_can_restart`, `test_managed_app_server_active_thread_is_busy` 등 109개 계약 시험 100% 통과.

### 3.2 전체 회귀 검증 (Full Regression Suite)
- 명령: `.venv/bin/python -m pytest -q`
- 결과: **252 passed, 1 skipped in 94.41s** (전체 테스트 suite 회귀 없음)

### 3.3 정적 분석 및 린트 검증
- `git diff --check`: **PASS** (EOF 불필요 공백 및 trailing whitespace 없음)
- `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/*.mjs`: **PASS** (3개 모듈 문법 검사 통과)
- `bash -n codex_home_assistant/rootfs/usr/local/bin/codex`: **PASS** (Bash 문법 검사 통과)

---

## 4. 미검증 항목 선언 (Explicit NOT RUN Declarations)

1. **Docker multiarch 컨테이너 빌드:** 본 차수에서는 실행하지 않음 (`NOT RUN`).
2. **Physical HAOS 실기기 하드웨어 환경 검증:** 실제 Home Assistant OS 하드웨어 및 Supervisor 운영 환경에서의 검증은 실행하지 않음 (`NOT RUN`).
3. **Mobile Remote SSH 실연결 검증:** 모바일 앱 환경의 Remote SSH 실기기 단말을 통한 종단 간 세션 전환 검증은 실행하지 않음 (`NOT RUN`).
4. **Git 외부 조작:** 커밋, 태그 발행, GitHub push, PR 생성 등은 사용자 승인 전까지 일체 미수행 (`NOT RUN`).

---

## 5. 결론 및 재리뷰 요청

- Reviewer가 지적한 G1부터 G7까지의 결함에 대해 프로덕션 코드 보완, SIGKILL 제거, 롤백 복원 검증, UTF-8 및 홀드 버퍼 보호, 다중 relay barrier 공조, worker 소멸 감지 및 Unix 소켓 보호를 완비했습니다.
- 대화형 CLI/TUI의 경우 0.162.1 모놀리식 아키텍처 상의 실시간 백엔드 교체 제약을 실측 근거와 함께 투명하게 보고했습니다.
- 본 보고서와 109개 계약 테스트 및 252개 전체 회귀 테스트 통과 증거를 바탕으로 Reviewer의 재검토를 요청합니다.
