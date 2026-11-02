# FIX_01_REPORT — 실제 유휴 판정 및 기존 서버 자동 전환 보완 구현 보고

## 1. 개요 및 실행 현황

- **작업자 (Executor):** Antigravity, 2026-10-28 (Asia/Seoul).
- **대상:** [.handoff/006_idle-gated-runtime-server-update/FIX_01.md](FIX_01.md)에 명시된 필수 correction 9건 (F1~F9).
- **작업 원칙:**
  - 기존 handoff 문서(`PLAN.md`, `REPORT.md`, `FIX_01.md`) 및 task 005 이력을 온전히 보존.
  - 사용자 명시적 승인 없는 git commit, push, PR, release 및 실기기(HAOS/Supervisor) 환경 변경을 수행하지 않음.
  - 미검증 항목(Docker multiarch build, physical HAOS hardware, mobile remote SSH 실환경)을 명시적으로 NOT RUN으로 선언.

---

## 2. 필수 Correction 상세 조치 내역 (F1 ~ F9)

### F1 — CLI/TUI 세션의 비중단 안전 불변조건 보존 및 모드 분리
- **분석 및 조치:**
  - 대화형 TUI/CLI 프로세스는 터미널 I/O 상태 및 curses 화면 렌더링을 독점하므로, 중간에 백엔드 child worker를 임의로 교체할 경우 화면 깨짐이나 uncoordinated state가 발생할 수 있습니다.
  - 이에 따라 대화형 CLI/TUI는 프로세스 생명주기를 존중하여 활성 중단 없이 안전하게 "다음 세션 기동 시 신버전 적용(next session pickup)" 원칙을 확고히 유지하도록 계약을 명문화했습니다.
  - 관리형 전환 대상은 장기 연결을 유지하면서도 무상태 RPC/프로토콜 계층으로 안전한 worker 교체가 가능한 `remote-stdio` 및 `app-server` stdio 세션으로 명확히 한정했습니다.

### F2 — Relay 시작 시각(start-time) 동기화 및 Worker 자식 프로세스 귀속 처리
- **위치:** `codex-session-host.mjs`, `codex-runtime-manager.mjs`, `codex` wrapper.
- **분석 및 조치:**
  - `_writeSessionFile()`에서 기존 `String(process.uptime())`으로 덮어쓰던 버그를 수정하여, wrapper가 넘겨준 `/proc/<pid>/stat`의 22번째 필드(kernel start-time)를 보존하도록 수정했습니다.
  - `codex-runtime-manager.mjs`의 Pass 4 프로세스 분류에서, 관리형 relay(`session.managed === true`)의 child worker PID를 추적하여 해당 child worker가 독립된 미관리 `remote_stdio` blocker로 오탐되지 않고 부모 relay 세션에 올바르게 귀속되도록 수정했습니다.

### F3 — 공식 Turn 이벤트 추적 및 Bounded Hold 원장 일관성 확보
- **위치:** `codex-session-host.mjs`.
- **분석 및 조치:**
  - 공식 App Server 프로토콜에 맞추어 `turn/start` RPC 요청 발행 후 `pendingTurnStarts`에 등록하고, 서버의 `turn/started` notification 수신 시 `activeTurnIds`로 승격하여 턴 진행 동안 `busy=true`를 일관되게 유지하도록 구현했습니다.
  - 서버의 `turn/completed` 또는 `turn/interrupted` notification 수신 시에만 `activeTurnIds`에서 제거되어 `busy=false`로 복귀합니다.
  - admission barrier 해제(`_flushHeldClientChunks`) 시 보관된 청크들을 단순 forward하지 않고 내부 파서 및 원장(`_processAndForwardClientChunk`)을 거치도록 재주입하여, 전환 도중 들어온 요청이 누락되지 않고 정확히 1회 처리되도록 구현했습니다.

### F4 — 신규 Worker 초기화 핸드셰이크 및 Thread 복원 격리
- **위치:** `codex-session-host.mjs`.
- **분석 및 조치:**
  - `switchWorker` 시 새 child worker spawn 직후 `initialize` RPC 요청 및 `initialized` notification 핸드셰이크를 필수로 완료하도록 구현했습니다.
  - `_sendInternalRpc`를 구현하여 내부 RPC ID를 `__internal_<timestamp>_<rand>`로 채번하고, child stdout 처리 시 내부 ID 응답을 가로채어(`internalPendingRpcs`) resolve하며 클라이언트 stdout으로 절대 누출되지 않도록 완전 격리했습니다.
  - 핸드셰이크 완료 후 기존 `loadedThreadIds`에 대해 `thread/resume`을 순차적으로 안전하게 복원한 뒤에만 admission barrier를 해제하도록 수정했습니다. 만약 `initialize` 실패 시 이전 버전 worker로 롤백을 수행합니다.

### F5 — Admission Barrier 사전 설정 및 원자적 전환/Rollback 보장
- **위치:** `codex-server-transaction.mjs`, `codex-session-host.mjs`.
- **분석 및 조치:**
  - `codex-server-transaction.mjs`의 `restartServers()` 진입 시, 모든 대상 relay 세션에 대해 즉시 `{ cmd: 'barrier', enabled: true }`를 브로드캐스트하여 클라이언트 입력 유입을 원천 차단하고 보관(hold)하도록 선행 조치했습니다.
  - `switchWorker` 시작 시 내부 ledger를 재검사하여 그 사이 턴이 시작되었으면 `worker_busy` 에러를 반환하고 즉시 취소하도록 이중 가드를 적용했습니다.
  - 전환 실패 또는 drain timeout 발생 시, barrier를 해제하고 보관된 입력을 안전하게 이전 worker로 전달하도록 롤백 핸들러를 정비했습니다.

### F6 — Phased Drain 및 Worker 실제 종료 검증
- **위치:** `codex-session-host.mjs`.
- **분석 및 조치:**
  - `_drainAndStopChild(timeoutMs = 6000)`에서 단계적 종료(Phased termination)를 적용했습니다:
    - Phase 1 (최대 3초): SIGHUP 전송 후 종료 대기.
    - Phase 2 (최대 2초): SIGTERM 전송 후 종료 대기.
    - Phase 3 (최대 1초): SIGKILL 전송 후 최종 종료 확인.
  - `/proc/<pid>`의 실제 소멸 여부 및 `child.exitCode`를 반복 확인하며, 제한 시간 내에 종료되지 않을 경우 신규 worker를 기동하지 않고 `drain_timeout` 에러를 throw하여 구버전/신버전 writer 중복을 원천 차단했습니다.

### F7 — Loaded Unix Domain Socket 서버의 안전 조건 복원
- **위치:** `codex-runtime-manager.mjs`, `codex-server-transaction.mjs`.
- **분석 및 조치:**
  - Unix domain socket 기반 app-server는 프로세스를 교체할 경우 소켓 fd가 재생성되어 연결된 클라이언트와의 세션 및 인메모리 대화 상태가 즉시 단절됩니다.
  - 따라서 Unix domain socket 서버는 loaded thread가 존재할 경우 유휴 상태라 하더라도 강제 교체하지 않고, 기존의 안전한 불변조건인 `requiresSessionRestart: true` 및 next session pickup을 적용하도록 안전 경계를 복원했습니다.

### F8 — Wrapper `set -u` (Nounset) 안전성 및 Stdio 전용 분기 엄격화
- **위치:** `codex_home_assistant/rootfs/usr/local/bin/codex`.
- **분석 및 조치:**
  - 스크립트 최상단에 `control_sock=""`, `start_time="0"`, `selected_version="0.162.1"` 변수를 기본값으로 사전 선언하여, maintenance 디렉터리 부재 또는 flock 경합/실패 시 `set -u` 환경에서 `unbound variable`로 비정상 종료되는 문제를 해결했습니다.
  - stdio relay 호출 조건을 `[[ -z "${socket_path}" ]]`로 엄격화하여, `--listen ws://...` 등 WebSocket/Unix socket 인자가 주어진 경우에는 stdio relay를 거치지 않고 직접 app-server를 기동하도록 분리를 명확히 했습니다.

### F9 — 제어 소켓 프로토콜 스키마 검증 및 Serialization
- **위치:** `codex-runtime-manager.mjs`, `codex-session-host.mjs`.
- **분석 및 조치:**
  - `inspectSessionHost()`에서 제어 소켓의 JSON 응답을 엄격하게 검증합니다 (`typeof res.busy === "boolean"`, `typeof res.inFlight === "number"`, `Array.isArray(res.loadedThreads)` 등). 유효하지 않거나 빈 객체일 경우 fail-closed 원칙에 따라 `busy: true`로 간주하여 오탐 전환을 방지했습니다.
  - `codex-session-host.mjs`의 제어 소켓 요청 처리를 `this.commandQueue = this.commandQueue.then(...)` 프로미스 체인으로 엄격히 직렬화하여, 동시 명령(inspect, barrier, switch_worker) 간의 경합을 원천 차단했습니다.
  - `MAX_HOLD_BYTES` (5MB) 및 `MAX_BUFFER_BYTES` (5MB) 상한을 설정하고 초과 시 `process.stdin.pause()`로 backpressure를 부여하여 메모리 고갈 공격을 방지했습니다.

---

## 3. 검증 결과

### 3.1 계약 검증 (Contract Tests)
- 명령: `.venv/bin/python -m pytest -ra tests/test_codex_update_contract.py`
- 결과: **108 passed in 72.43s**
- 비고:
  - 신규 프로덕션 StdioRelay 수명주기 및 턴 추적 계약 시험 `test_production_stdio_relay_lifecycle_and_turn_tracking` 추가 및 PASS.
  - `test_managed_remote_stdio_session_host_idle_and_switch` 등 기존 107개 계약 시험 모두 회귀 없이 100% 통과.

### 3.2 전체 회귀 검증 (Full Regression Suite)
- 명령: `.venv/bin/python -m pytest -q`
- 결과: **251 passed, 1 skipped in 87.57s** (전체 테스트 suite 회귀 없음)

### 3.3 정적 분석 및 린트 검증
- `git diff --check`: **PASS** (EOF 불필요 공백 및 trailing whitespace 없음)
- `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/*.mjs`: **PASS** (3개 모듈 문법 검사 통과)
- `bash -n codex_home_assistant/rootfs/usr/local/bin/codex`: **PASS** (Bash 문법 검사 통과)

---

## 4. 미검증 항목 선언 (Explicit NOT RUN Declarations)

1. **Docker 컨테이너 빌드 및 multiarch 이미지 빌드:** 본 세션에서는 실행하지 않음 (`NOT RUN`).
2. **Physical HAOS 실기기 환경 검증:** 실제 Home Assistant OS 하드웨어 및 Supervisor 운영 환경에서의 검증은 실행하지 않음 (`NOT RUN`).
3. **Mobile Remote SSH 실연결 검증:** 모바일 앱 환경의 Remote SSH 실기기 단말을 통한 종단 간 세션 전환 검증은 실행하지 않음 (`NOT RUN`).
4. **Git 외부 조작:** 커밋, 태그 발행, GitHub push, PR 생성 등은 사용자 승인 전까지 일체 미수행 (`NOT RUN`).

---

## 5. 결론 및 재리뷰 요청

- Reviewer가 지적한 F1부터 F9까지의 모든 결함에 대해 프로덕션 코드 보완, 계약 테스트 추가, 정적 검사 및 251개 전체 단위/계약 테스트 통과를 완료했습니다.
- 본 보고서와 관련 diff를 바탕으로 Reviewer의 재검토 및 수용 판정을 요청합니다.
