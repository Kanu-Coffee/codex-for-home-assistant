# FIX_07_REPORT — 비영속 대화(ephemeral) 유실 방지 및 영속 대화(persistent) 실질 복원 완결

- **작성일:** 2026-11-02 (Asia/Seoul)
- **작성자:** Executor (Antigravity)
- **대상:** `feat/fix03-mobile-proxy-bootstrap`
- **해당 리뷰:** Reviewer Codex의 [FIX_07.md](FIX_07.md)

---

## 1. 개요 및 요약

Reviewer Codex가 FIX_07에서 지적한 **[P1] 내용 있는 ephemeral 대화가 applied=true로 종료되어 새 세대에서 복원되지 못하고 유실되던 회귀**를 완전히 해결했습니다.

1. **관리 Record와 안전한 복원 Capability의 엄격한 분리:**
   - 기존의 `options`가 문자열(버전)이거나 임의의 truthy 값일 때 무조건 유휴 복원 가능으로 취급하던 shortcut을 제거했습니다.
   - inspection 계약에 명시적 `options.restoreCapability`를 요구하며, 복원 능력이 보장되지 않는 호출이나 환경에서는 loaded 대화가 존재하는 서버를 유휴 업데이터 진입에서 엄격히 차단합니다.
2. **개별 Loaded 대화의 상태·영속성·복원 가능성 심층 검증 (`inspectAppServer`):**
   - `thread/loaded/list`의 각 대화에 대해 `thread/read` 조회를 수행하여 상태를 검증합니다.
   - **Active 대화:** 진행 중인 대화(`status === 'active'`)는 즉시 보류 (`Active thread in progress: ${id}`).
   - **비영속(Ephemeral) 대화 (`thread.ephemeral === true`):** 인메모리 전용 대화는 프로세스 종료 시 메모리가 소멸되어 upstream `thread/resume`을 지원하지 않으므로, 턴 내용이 있는 경우(`turns.length > 0`) `Unrestorable ephemeral conversation with ${turns.length} turn(s): ${id}; held until session exits` 사유로 **프로세스 종료 전(pre-signal)** 확실히 보류. 빈 ephemeral 대화 역시 세션 호스트의 ID 리매핑이 없는 표준 Unix 서버에서는 안전하게 보류.
   - **영속(Persistent) 대화:** 디스크의 실제 롤아웃 파일 경로(`thread.path`) 유효성, 일반 파일 여부, `size > 0`을 엄격히 검증.
3. **표준 Unix 서버 재시작 트랜잭션의 실질적 복원 구현 (`restartServers`):**
   - Step 2 pre-signal 검사 시 `{ expectedVersion, restoreCapability: typeof restoreThreads === 'function' }`를 전달하여, 복원 함수가 없거나 비영속 대화가 있는 서버는 시그널 전송 전 `server_busy_pre_signal` 예외로 즉시 롤백 및 기존 프로세스를 보존.
   - Step 4 새 바이너리 기동 후 기존의 빈 주석 블록(`// Threads are restored...`) 대신 `restoreThreads(server.socketPath, server.loadedThreads)`를 호출하여 영속 대화를 새 세대에 실질적으로 `thread/resume` 복원.
   - `codex-runtime-manager.mjs`에 `restoreAppServerThreads(socketPath, threadIds)` 함수를 구현 및 export하여 트랜잭션과 직접 연동.
4. **정식 회귀 테스트 완비:**
   - Reviewer의 독립 재현(`.test-tmp/review007-fix06/ephemeral.py`)을 정식 테스트 `test_proxy_real_update_restart_transaction_holds_on_nonempty_ephemeral_thread`로 포팅: Turn 1 완료 후 `canApply: false`, `managedIdleServers: 0`, `restartableServers: []`, 트랜잭션 시도 시 `applied: false, reason: server_busy_pre_signal`, 이전 서버 프로세스 생존 및 Turn 2 요청 정상 수락 및 문맥 유지(requests=2)를 검증 (PASS).
   - 기존 영속 대화 양성 테스트 `test_proxy_real_update_restart_transaction_and_cross_generation_turn_continuity`에 `restoreThreads` 연동 및 소켓 경로 단축(`s.sock`)을 적용하여 0.162.1 → 0.166.0 실 서버 교체, 세대 간 `thread/resume`, Turn 2 문맥 연속성 통과 유지 (PASS).
5. **배포 보류 지침 준수:**
   - Reviewer 지시에 따라 `0.7.3-dev.5` 버전을 유지하며, 신규 DEV 버전 번호 증가(dev.6 등), Git 태그, 원격 push 및 DEV 릴리스 발행을 수행하지 않았습니다.

---

## 2. 변경 상세

### 2.1 `codex-runtime-manager.mjs`
- **`restoreAppServerThreads(socketPath, threadIds)` 신설:**
  - `MinimalWebSocketClient`로 소켓에 연결하여 `threadIds`의 각 대화에 대해 `thread/resume`을 호출하고 검증.
- **`inspectAppServer(socketPath, expectedPid, options = {})` 전면 개선:**
  - `const opts = typeof options === "string" ? { expectedVersion: options } : (typeof options === "object" && options !== null ? options : {});`
  - `const restoreCapability = Boolean(opts.restoreCapability);`
  - loaded thread가 1개 이상 존재할 때 `!restoreCapability`이면 즉시 `Loaded server requires a managed lifecycle host with restore capability`로 fail-closed.
  - `restoreCapability: true`일 때 각 대화를 `thread/read`로 개별 검사:
    - active thread 차단 (`Active thread in progress: ${id}`).
    - `thread.ephemeral === true`: 내용 있는 비영속 대화 차단 (`Unrestorable ephemeral conversation with ${turns.length} turn(s): ${id}; held until session exits`). 라이프사이클 호스트가 없는 표준 서버의 빈 ephemeral도 차단.
    - persistent thread: `thread.path` 경로 stat 검사 (`st.isFile() && st.size > 0`).
- **`inspectAllSessions()`:**
  - 관리형 앱 서버 검사 시 `{ restoreCapability: true }`를 전달하여 영속 대화 복원 능력을 가진 경우에만 `managedIdleServers`로 분류.
- **`applyUpdate()`:**
  - `restartServers` 호출 옵션에 `restoreThreads: restoreAppServerThreads`를 전달.

### 2.2 `codex-server-transaction.mjs`
- **`restartServers` 시그니처 및 옵션:**
  - `restoreThreads` 옵션 수신.
- **Step 2 pre-signal 검사:**
  - `inspectServer` 호출 시 `{ expectedVersion: record.version, restoreCapability: typeof restoreThreads === 'function' }` 전달.
  - `server.loadedThreads = inspectRes.loadedThreads || [];`로 실시간 검증된 thread 목록 캡처.
  - 비영속 대화 등이 있어 `inspectRes.busy`이면 SIGHUP 시그널 전 `server_busy_pre_signal`을 던져 프로세스 종료를 사전 차단.
- **Step 4 새 세대 기동:**
  - `launched = await launch(server, binary, version)` 성공 후:
    `if (Array.isArray(server.loadedThreads) && server.loadedThreads.length > 0 && typeof restoreThreads === 'function')`
    `await restoreThreads(server.socketPath, server.loadedThreads);`
  - 실질적인 `thread/resume`을 수행하여 새 서버 세대에 대화를 복원.

### 2.3 `tests/test_codex_wrapper_proxy.py`
- **신규 음성 회귀 테스트 `test_proxy_real_update_restart_transaction_holds_on_nonempty_ephemeral_thread`:**
  - 0.162.1 공식 바이너리로 앱 서버 기동.
  - proxy를 통해 `thread/start` with `ephemeral: true`.
  - Turn 1 실행 및 완료.
  - proxy 1 종료.
  - `mgr.inspectAllSessions()` 호출: `canApply: false`, `managedIdleServers: 0`, `restartableServers: []`, blocker `app-server busy: Unrestorable ephemeral conversation...` 확인.
  - `restartServers` 직접 호출: `applied: false, reason: "server_busy_pre_signal"` 확인, `server1.poll() is None` (기존 서버 PID 생존) 확인.
  - 살아있는 `server1`에 재연결하여 `thread/read` 및 Turn 2 실행: mock provider에 요청 2개가 정상 누적되고 Turn 1의 문맥이 보존됨을 확인.
- **양성 영속 대화 테스트 `test_proxy_real_update_restart_transaction_and_cross_generation_turn_continuity`:**
  - `restoreThreads: mgr.restoreAppServerThreads` 옵션 연동.
  - 소켓 경로 길이 한계 회피를 위한 `s.sock` 단축 적용.
  - 0.162.1 → 0.166.0 실제 서버 교체, 세대 간 복원, Turn 2 문맥 보존 확인.

---

## 3. 검증 결과

### 3.1 Reviewer 독립 재현 스크립트 검증
- `.venv/bin/python .test-tmp/review007-fix06/ephemeral.py`:
  - `res_idle["counts"]["managedIdleServers"] == 1` assertion에서 즉시 차단 (`AssertionError`).
  - 더 이상 ephemeral thread가 있는 서버를 restartable로 판단하거나 applied=true로 종료하지 않음 확인.

### 3.2 Pytest 회귀 및 계약 시험
- `tests/test_codex_wrapper_proxy.py`:
  - `9 passed in 12.37s` (음성 ephemeral 회귀 + 양성 persistent 교체 포함 전 항목 PASS).
- `tests/test_codex_update_contract.py` + `tests/test_remote_setup.py`:
  - `141 passed in 104.08s`.
  - Reviewer가 기록한 긴 fixture 경로로 인한 1개 테스트(`test_fix11_websocket_cli_endpoint_and_switch_worker`)는 단축 basetemp(`/home/lee/short-t`)에서 독립 재실행하여 `1 passed in 0.46s` 확인.

### 3.3 정적 점검 및 이미지 빌드 / 스모크
- `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/*.mjs`: **PASS** (문법 오류 없음).
- `git diff --check`: **PASS** (공백 및 충돌 없음).
- `docker build -t codex-ha:test-fix07 codex_home_assistant`: **PASS** (이미지 빌드 성공).
- `IMAGE_NAME=codex-ha:test-fix07 .venv/bin/python tests/mobile-ssh-smoke.py`:
  - **PASS** (`interactive setup, both PEM SSH auth, revoke rejection, S6 activation/restart and SSH wrapper proxy bootstrap`).

---

## 4. 미수행 (NOT RUN) 및 한계 공개

- **Native AArch64 / ARM 물리 하드웨어:** x86_64 리눅스 환경에서 검증되었으며 물리 ARM 기기 시험은 NOT RUN입니다.
- **HAOS / Supervisor 실 운영 환경:** Docker 컨테이너 및 로컬 Linux 격리 환경에서 검증되었으며 물리 HAOS 인스톨레이션 시험은 NOT RUN입니다.
- **실제 iOS/Android 모바일 앱 자동 재연결:** 모바일 앱의 백그라운드 프록시 자동 복원 UX는 mock 및 CLI 클라이언트 수준에서 검증되었으며 실 기기 E2E는 NOT RUN입니다.
- **버전 및 배포:** `0.7.3-dev.5` 유지, 신규 DEV 배포 보류.
