# FIX_04_REPORT — FIX_04 proxy 신원·상태 진단·후속 요청 검증 완료 보고

작성일: 2026-11-02 (Asia/Seoul)  
작성자: Executor  
기준 FIX: `.handoff/007_work-aware-runtime-update/FIX_04.md`  
브랜치: `feat/fix03-mobile-proxy-bootstrap`  
기준 커밋: `ae6814a` (FIX_03) -> 작업 트리 수정 완료 (커밋 대기)

---

## 1. 개요 및 요약

Reviewer의 FIX_04 지침에 따라 3대 결함 영역을 완전히 해결하고 엄격한 단위/통합/컨테이너 검증을 완료했다:

1. **Area 1 [P1] Proxy 신원 및 소유권 엄격 검증 (`codex-runtime-manager.mjs`)**:
   - launch record가 실제 프로세스의 `/proc` argv를 임의로 덮어쓰거나 비-proxy를 helper로 위장하지 못하도록 차단.
   - `isProxyInvocation`과 `isProxyRecord`가 모두 참이어야만 proxy로 인정하며, 어느 한쪽만 참인 불일치는 즉시 `kind: "unknown"` (`proxyCommandMismatch` 또는 `unverifiedProxy`)로 실패 닫힘.
   - 실제 argv의 `--sock` 인자와 launch record의 `socketPath`가 `resolve()` 기준 정확히 일치함을 강제. 불일치 시 `kind: "unknown"` (`proxyTargetMismatch`)로 격리.
   - 대상 Unix 소켓의 symlink/realpath를 따라가며 살아있는 활성 소유자 서버(`app-server` 또는 `cli`)와 대조. 일치하는 소유자가 없는 고아 proxy는 `kind: "unknown"` (`orphanProxy`)로 분류되어 업데이터를 안전하게 차단.
   - Reviewer가 독립 재현한 `owner-mismatch.py` 시나리오를 정식 회귀 테스트로 구현하여 `canApply: false`, `unknown: 1` 차단 확인.

2. **Area 2 [P2] `ha-codex-remote status` 정직한 상태 진단 (`codex-remote-setup.mjs`)**:
   - `mobileStorage.status()`가 안전하지 않은 권한(0777, symlink 등)에서 예외를 던져도 `status` 명령이 크래시하지 않고 안전 상태를 파악하도록 try-catch 보호.
   - Private material 권한을 `absent`, `present (0600)`, `present (0400)`, `insecure permissions (mode)`, `insecure (symlink)`, `insecure (hardlink)`로 정밀 감지.
   - Authorized keys를 한 줄씩 정확히 파싱하여 `synchronized (1 key)`, `commented / inactive`, `empty`, `out of sync`로 구분 (주석 라인이나 빈 파일이 동기화로 오인되는 문제 방지).
   - SSH service: `/run/codex-ha/ssh-disabled` marker 존재 시 `disabled (no keys registered at startup)`, `/run/sshd.pid` 및 프로세스 실시간 생존 시 `active / listening`, 미구동 시 `not_disabled / listener not_running`으로 정직하게 보고.
   - SSH auth: `not_checked (confirm Accepted publickey in App logs)`로 고정하여 미관측 연결을 성공으로 과장하지 않음.
   - Codex bootstrap: `not_checked (verified when client connects)` 고정.
   - 테스트 격리를 위한 `CODEX_SSH_DIR` 환경변수 지원.

3. **Area 3 [P1] 종합 wire 다중 요청 및 활성 작업 보류 검증**:
   - `tests/test_remote_setup.py`: 상태 진단 상태머신 및 주석/불일치 판별 2개 신규 테스트 추가 (12/12 PASS).
   - `tests/test_codex_wrapper_proxy.py`: 0.162.1(`task007-baseline`) 및 0.166.0(`resume-166`) 양쪽 공식 바이너리에 대해 파라미터화 검증. Upgrade, initialize, initialized, `server/diagnostics`, `thread/start`, `thread/read` 컨텍스트 보존 검증 (5/5 PASS).
   - `tests/mobile-ssh-smoke.py`: 실 S6 컨테이너 내 실제 SSH 세션에서 Upgrade (101), initialize, initialized, `server/diagnostics`, `model/list`, `config/read` 다중 요청 성공 검증, per-operation deadline 및 EOF stderr 정제 적용 (PASS).
   - `tests/test_codex_update_contract.py`: argv/record 불일치, target 불일치, record 없는 unverified proxy 회귀 테스트 3종 추가 및 활성 작업 중(`in_flight: 2`, `core.turns.active: 1`) 업데이터 보류(`canApply: false`) 및 유휴 복귀 후 업데이터 허용(`canApply: true`) 검증 추가 (127/127 PASS).
   - 관련 핵심 단위/통합 테스트: **144 passed in 96.53s**.
   - 실 컨테이너 격리 smoke: **PASS** (`codex-ha:test-fix04`).

4. **릴리스 및 제약 준수**:
   - Reviewer의 FIX_04 지침에 따라 버전 번프(0.7.3-dev.6 등), git tag push, DEV 릴리스 배포는 일체 수행하지 않음.
   - 운영 HAOS 및 Stable/main 불변.

---

## 2. 검증 환경 및 바이너리/이미지 신원

| 항목 | 값 / 식별자 |
| :--- | :--- |
| **Git Branch** | `feat/fix03-mobile-proxy-bootstrap` |
| **Base Commit** | `ae6814a` |
| **Node.js** | v26.10.0 (`node --check` 통과) |
| **Python** | 3.13.15 (pytest-8.4.1) |
| **Docker Test Image** | `codex-ha:test-fix04` |
| **Image ID** | `sha256:37cb6cfbdf203acf474873ec588d80b72c6dd1074304f176bad660369b49e5a8` |
| **Baseline Codex Binary (0.162.1)** | `.test-tmp/task007-baseline/bin/codex`<br>SHA256: `628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1` |
| **Target Codex Binary (0.166.0)** | `.test-tmp/resume-166/bin/codex`<br>SHA256: `b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8` |

---

## 3. P1 Proxy 신원 및 소유권 검증 상세

### 3.1 문제점 및 독립 재현 원인
- FIX_03 검토 당시 `isProxyInvocation || isProxyRecord` 평가 후 `record.socketPath`가 `invocation.proxySocket`보다 우선시되어, 실제 `/proc` argv에서 `--sock`이 엉뚱한 대상을 가리켜도 record만 정상 소켓 경로를 적어두면 `helpers: 1, unknown: 0, canApply: true`로 통과하는 취약점이 존재했다.

### 3.2 구현 수정 (`codex-runtime-manager.mjs`)
1. **양방향 신원 일치 강제 (Pass 3)**:
   ```javascript
   const isProxyInvocation = identity && identity.role === "primary" &&
     identity.command === "app-server" && identity.appServerCommand === "proxy";
   const isProxyRecord = record && record.type === "app-server-proxy";

   if (isProxyInvocation || isProxyRecord) {
     if (!isProxyInvocation) {
       // record says proxy, but actual invocation is not proxy -> untrusted/mismatched
       e.kind = "unknown";
       e.unverifiedProxy = true;
     } else if (!isProxyRecord) {
       // invocation is proxy, but no valid session record registered
       e.kind = "unknown";
       e.unverifiedProxy = true;
     } else {
       // Both agree it is a proxy. Now strictly verify target socket.
       const invocationSock = invocation.proxySocket ? resolve(invocation.proxySocket) : null;
       const recordSock = record.socketPath ? resolve(record.socketPath) : null;
       if (!invocationSock || !recordSock || invocationSock !== recordSock) {
         e.kind = "unknown";
         e.proxyTargetMismatch = true;
       } else {
         e.kind = "proxy";
         e.targetSocket = invocationSock;
       }
     }
   }
   ```
2. **살아있는 소유자 서버 및 symlink 추적 (Pass 4)**:
   - `e.targetSocket`을 `realpath()`로 정규화하여 대상 Unix 소켓의 실제 장치를 확인.
   - 현재 실행 중인 세션 중 `app-server` 또는 `cli` 소유자 후보의 `socketPath`와 일치하는 프로세스를 탐색.
   - 소유자 프로세스가 실제로 존재하고 생존해 있는 경우에만 `e.kind = "helper"`, `e.owner = sPid`, `e.isProxy = true`로 승격.
   - 소유자 후보가 없거나 비정상 소켓인 경우 `e.kind = "unknown"`, `e.orphanProxy = true`로 실패 닫힘.

3. **정식 회귀 테스트 (`tests/test_codex_update_contract.py`)**:
   - `test_proxy_argv_target_mismatch_with_record_held_unknown`: 실제 argv의 `--sock`이 다른 경로일 때 `canApply: false`, `unknown: 1` 검증.
   - `test_proxy_command_mismatch_with_record_held_unknown`: 프로세스는 일반 cli인데 record가 `app-server-proxy`일 때 `unknown: 1` 검증.
   - `test_proxy_unverified_without_session_record_held_unknown`: 프로세스는 proxy인데 record가 없을 때 `unknown: 1` 검증.
   - `test_managed_server_with_owned_proxy_held_busy_during_active_work`: proxy가 살아있는 상태에서 대상 서버가 활성 작업(`in_flight: 2`, `core.turns.active: 1`) 중일 때 `canApply: false` 보류, 작업 완료 후 `canApply: true` 허용 검증.

---

## 4. P2 정직한 상태 진단 (`ha-codex-remote status`) 상세

### 4.1 문제점
- sshd가 전혀 뜨지 않은 격리 환경에서도 `ssh-disabled` 마커가 없다는 이유로 `SSH service: active / listening`과 `SSH auth: verified on client connection`을 고정 출력하여 사용자가 장애 원인을 오판할 위험이 있었다.
- `authorized_keys`에 주석 처리된 키나 빈 파일이 있어도 `content.includes(line)` 체크로 인해 `synchronized`로 오판될 수 있었다.

### 4.2 구현 수정 (`codex-remote-setup.mjs`)
1. **비밀키 저장소 상태 조회 try/catch 래핑**:
   - `mobileStorage.status()`가 비정상 파일 권한에 대해 throw하더라도 크래시하지 않고 `insecure permissions (mode)` 등으로 분류.
2. **Authorized keys 정밀 행 파싱**:
   ```javascript
   const lines = authContent.split("\n").map(l => l.trim()).filter(Boolean);
   if (lines.length === 0) {
     authStatus = "empty";
   } else {
     const exactMatch = lines.some(l => l === info.line);
     const commentedMatch = lines.some(l => l.startsWith("#") && l.includes(info.publicKey));
     if (exactMatch) {
       authStatus = `synchronized (${lines.length} key${lines.length > 1 ? "s" : ""})`;
     } else if (commentedMatch) {
       authStatus = "commented / inactive";
     } else {
       authStatus = "out of sync";
     }
   }
   ```
3. **SSH 서비스 실시간 생존 확인**:
   ```javascript
   if (existsSync("/run/codex-ha/ssh-disabled")) {
     sshStatus = "disabled (no keys registered at startup)";
   } else if (existsSync("/run/sshd.pid")) {
     try {
       const pid = parseInt(readFileSync("/run/sshd.pid", "utf-8").trim(), 10);
       process.kill(pid, 0);
       sshStatus = "active / listening";
     } catch {
       sshStatus = "not_disabled / listener not_running";
     }
   } else {
     sshStatus = "not_disabled / listener not_running";
   }
   ```
4. **미검증 항목 과장 방지**:
   - `SSH auth: not_checked (confirm Accepted publickey in App logs)`
   - `Codex bootstrap: not_checked (verified when client connects)`

5. **정식 회귀 테스트 (`tests/test_remote_setup.py`)**:
   - `test_status_diagnostics_states`: 키 미등록, 마커 존재(disabled), sshd 구동(active/listening), sshd 미구동(not_disabled/listener not_running), 0400/0600 권한 보고 검증.
   - `test_status_authorized_keys_comment_and_mismatch`: 주석 키(`commented / inactive`), 빈 파일(`empty`), 불일치 키(`out of sync`) 정밀 진단 검증.

---

## 5. Area 3 Wire 다중 요청 및 공식 바이너리 검증 상세

### 5.1 Docker 컨테이너 실제 SSH Wire Smoke (`tests/mobile-ssh-smoke.py`)
- **실행 환경**: `IMAGE_NAME=codex-ha:test-fix04` (S6 overlay, dropbear/OpenSSH sshd, wrapper proxy).
- **수행 과정**:
  1. 컨테이너 기동 후 `ha-codex-remote setup` 대화형 키 등록.
  2. PKCS#8 및 SEC1 PEM 형식으로 실제 SSH 연결 및 인증.
  3. `ha-codex-remote status` 멱등성 및 정직한 진단 출력 검증.
  4. 실제 SSH 채널에서 `/usr/local/bin/codex app-server proxy --sock /run/codex-ha/app-server.sock` 실행.
  5. HTTP/1.1 101 WebSocket Upgrade 프레임 송수신.
  6. `initialize` (id: 1) 호출 및 응답 수신.
  7. `initialized` 알림 송신.
  8. **후속 요청 1**: `server/diagnostics` (id: 2) 호출 및 프로세스 ID/게이지 응답 수신.
  9. **후속 요청 2**: `model/list` (id: 3) 호출 및 모델 목록 응답 수신.
  10. **후속 요청 3**: `config/read` (id: 4) 호출 및 설정 응답 수신.
  11. 클라이언트 측 EOF 송신 후 프로세스 정상 종료(exit 0) 및 소켓 정리 확인.
  12. `ha-codex-remote revoke` 후 재연결 시 `Permission denied (publickey)` 차단 검증.
- **안전성 보완**:
  - `select.select` 기반 15초 per-operation deadline 적용 (무한 대기 방지).
  - EOF 도달 시 무차별적인 stderr 노출 대신 정제된 오류 메시지 처리.
- **결과**: **PASS**

### 5.2 듀얼 바이너리 패키지 검증 (`tests/test_codex_wrapper_proxy.py`)
- `task007-baseline` (0.162.1) 및 `resume-166` (0.166.0) 바이너리 양쪽 모두에 대해 파라미터화 테스트 수행.
- 검증 시나리오:
  - Upgrade + initialize
  - Split WebSocket frames 및 ping/pong 제어 프레임 처리
  - Multi-request session: initialize -> initialized -> `server/diagnostics` -> `thread/start` -> `thread/read`
- **결과**: **5/5 PASSED**

---

## 6. 테스트 수행 결과 요약

### 6.1 핵심 관련 테스트
```bash
.venv/bin/python -m pytest tests/test_remote_setup.py tests/test_codex_wrapper_proxy.py tests/test_codex_update_contract.py
```
**결과**: **144 passed in 96.53s**

세부 내역:
- `tests/test_remote_setup.py`: 12 passed
- `tests/test_codex_wrapper_proxy.py`: 5 passed
- `tests/test_codex_update_contract.py`: 127 passed

### 6.2 도커 컨테이너 검증
```bash
IMAGE_NAME=codex-ha:test-fix04 .venv/bin/python tests/mobile-ssh-smoke.py
```
**결과**: **PASS: interactive setup, both PEM SSH auth, revoke rejection, S6 activation/restart and SSH wrapper proxy bootstrap**

### 6.3 정적 분석 및 문법 검사
- `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`: **PASS (0)**
- `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-remote-setup.mjs`: **PASS (0)**
- `git diff --check`: **PASS (공백/줄바꿈 이상 없음)**

---

## 7. 검증 경계 (PASS / PARTIAL / NOT RUN)

- **PASS**:
  - launch record와 실제 argv의 불일치 시 `unknown` 실패 닫힘 보존 (독립 재현 해소).
  - 대상 소켓 symlink 추적 및 활성 소유자 서버 매핑.
  - 활성 작업 중(`in_flight: 2`) 업데이터 차단 및 유휴 시 허용.
  - `ha-codex-remote status`의 정직한 진단 (listener not_running, active/listening, authorized_keys 주석/불일치 판별, auth/bootstrap not_checked 안내).
  - 실제 SSH 세션 상의 다중 wire 요청(Upgrade -> initialize -> initialized -> diagnostics -> model/list -> config/read -> clean EOF).
  - 0.162.1 및 0.166.0 듀얼 바이너리 wire/thread 상호작용.
  - 144개 관련 pytest 전건 통과 및 Docker S6 smoke 통과.

- **PARTIAL**:
  - 도커 컨테이너 내 `thread/start`의 bwrap 실행: 비특권 컨테이너 환경에서는 loopback 네트워크 네임스페이스 제약(`RTM_NEWADDR`)으로 인해 bwrap 내부 샌드박스가 차단되므로, SSH smoke에서는 bwrap을 거치지 않는 공식 RPC 요청들(`server/diagnostics`, `model/list`, `config/read`)로 다중 요청을 실증했으며, `thread/start` 및 `thread/read`는 호스트 통합 테스트(`test_codex_wrapper_proxy.py`)에서 듀얼 바이너리로 실증했다.

- **NOT RUN**:
  - 실제 iOS/Android ChatGPT 모바일 앱 연동 (물리 모바일 기기 및 OpenAI 공식 인증 필요).
  - 실제 물리 HAOS 운영 기기 상에서의 Add-on 구동.
  - native ARM64 환경 (x86_64 환경에서 검증 수행).

---

## 8. 결론 및 릴리스 상태

- Reviewer의 FIX_04 요청 사항(Area 1, Area 2, Area 3)이 모두 엄격하게 구현 및 실증 완료되었다.
- **DEV 배포 보류 상태 준수**:
  - `config.yaml` 버전 번프 없음 (0.7.3-dev.5 유지).
  - git tag 미생성, GitHub PR/release push 없음.
  - Reviewer의 후속 리뷰 및 판정에 따라 다음 절차를 진행할 수 있도록 대기한다.
