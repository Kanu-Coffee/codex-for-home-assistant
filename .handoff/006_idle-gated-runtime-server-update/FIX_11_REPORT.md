# FIX_11_REPORT — 관리형 CLI endpoint WebSocket 어댑터 및 유휴 전환 구현 보고

## 1. 개요 및 요약

- **작업자:** Executor (Antigravity), 2026-10-29.
- **기준 handoff:** `.handoff/006_idle-gated-runtime-server-update/FIX_11.md` (Reviewer: Codex).
- **판정 목표:** P1 결함인 "raw JSON socket에 WebSocket frontend를 연결하여 CLI 기동 불가" 문제를 해결하고, 실제 WebSocket Upgrade 및 RFC 6455 프레이밍 어댑터를 구현하여 공식 frontend(`codex --remote unix://...`)와의 양방향 통신 및 유휴 시 worker 전환을 완결한다.
- **결과:** 구현 및 전수 검증 완료. 전체 회귀 테스트 **265 passed, 1 skipped in 123.50s** (0 failures).

---

## 2. P1 결함 구현 상세

### 2.1 RFC 6455 WebSocket Server 어댑터 구현 (`codex-session-host.mjs`)

공식 `codex --remote unix://<socket>` 프론트엔드는 Unix domain socket 상에서도 HTTP Upgrade 기반의 WebSocket 전송 방식을 사용한다. 기존 `node:net.createServer` 기반 raw 소켓은 HTTP 요청을 JSON 개행 파서에 직접 주입하여 파싱 실패 및 `HANDSHAKE_TIMEOUT`을 유발했다.

이를 해결하기 위해 외장 npm 패키지 의존성 없이 Node.js 내장 모듈(`node:http`, `node:crypto`)만을 활용하여 Unix domain socket 상에서 완전한 RFC 6455 WebSocket 어댑터를 구현했다:

1. **HTTP Upgrade 핸드셰이크:**
   - `createHttpServer()`를 Unix socket 경로에 바인딩하고 `upgrade` 이벤트를 수신.
   - `Sec-WebSocket-Key` 및 `Upgrade: websocket` 헤더를 검증.
   - RFC 6455 규격 GUID(`258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)와 결합 후 SHA-1 + base64로 `Sec-WebSocket-Accept` 응답 헤더 생성.
   - `HTTP/1.1 101 Switching Protocols` 응답으로 연결 승격.
   - `upgrade` 이벤트의 선행 바이트(`head`) 버퍼를 보존하여 핸드셰이크 직후 함께 전달된 초기 프레임 유실 방지.

2. **RFC 6455 프레임 처리:**
   - **프레임 파싱:**
     - 7-bit / 16-bit / 64-bit 페이로드 길이 지원.
     - 클라이언트 마스킹(client-to-server) 4바이트 키 언마스킹(XOR) 처리.
     - 텍스트(0x1), 바이너리(0x2), 연속/단편화 프레임(0x0, continuation) 조립 지원.
     - 제어 프레임: Ping(0x9) 수신 시 Pong(0xA) 자동 응답, Close(0x8) 수신 시 종료 프레임 송신 및 정상 자원 정리.
   - **서버 송신 프레이밍 (`_wsSendText`):**
     - 서버→클라이언트 텍스트 프레임(opcode 0x81, non-masked) 자동 패킹 및 길이 헤더 인코딩.
   - **JSON 개행 파서 연동:**
     - 수신된 WebSocket 텍스트 메시지의 끝에 `\n` 개행을 보장하여 릴레이 내부의 `parseJsonMessages()`와 무지연 즉시 연동.

3. **Single-client 소유권 및 자원 수명주기:**
   - 단일 세션 릴레이 원칙에 따라, 이미 클라이언트가 연결된 상태에서 추가 HTTP Upgrade 시도 시 `HTTP/1.1 409 Conflict`와 함께 소켓을 즉시 거부/파괴.
   - 백프레셔: `heldBytes >= MAX_HOLD_BYTES` 시 `this.wsSocket.pause()`, 장벽 해제 및 플러시 시 `this.wsSocket.resume()`.
   - `_cleanup()`: `wsServer.close()`, `wsSocket.destroy()` 및 임시 Unix socket 파일 정리.
   - 백엔드 응답(`_handleServerData`): `wsSocket`이 활성 상태인 경우 `_wsSendText`로 전달하고, raw 소켓 및 표준 입출력(stdio)은 fallback으로 유지.

---

## 3. 검증 결과 및 증거

### 3.1 Reviewer 재현 스크립트 대조 검증 (`.test-tmp/review006-fix10/handshake.py`)

공식 0.162.1 바이너리와 신규 릴레이 간 동일 HTTP Upgrade 요청 전송 비교:
- **공식 0.162.1 (`app-server --listen unix://...`):** `HTTP/1.1 101 Switching Protocols`
- **신규 릴레이 (`codex-session-host.mjs --client-socket ...`):** `HTTP/1.1 101 Switching Protocols`
- **판정:** Reviewer가 지적했던 `HANDSHAKE_TIMEOUT`이 완전히 해소되고 공식 바이너리와 100% 동일하게 101 프로토콜 전환 완료.

### 3.2 공식 0.162.1 바이너리 격리 연동 시험 (`.test-tmp/fix11/ws_handshake_test.py`)

- 공식 0.162.1 `app-server`를 백엔드 워커로 두고 `codex-session-host.mjs --client-socket <sock> --type cli` 기동.
- HTTP Upgrade 요청 전송: `HTTP/1.1 101 Switching Protocols` 및 `Sec-WebSocket-Accept: OK` 수신.
- 마스킹된 WebSocket 텍스트 프레임으로 `initialize` JSON-RPC 전송.
- 0.162.1 워커의 `initialize` 응답이 WebSocket 텍스트 프레임으로 정상 수신됨 (`userAgent` 포함): **PASS**.

### 3.3 계약 회귀 테스트 (`tests/test_codex_update_contract.py`)

신규 테스트 케이스 `test_fix11_websocket_cli_endpoint_and_switch_worker` 추가 및 검증:
1. `codex-session-host.mjs`의 `--client-socket` (WebSocket) 및 `--control-socket` 기동 확인.
2. 클라이언트의 HTTP Upgrade 요청에 대해 `101 Switching Protocols` 및 `Sec-WebSocket-Accept` 검증 통과.
3. 중복 클라이언트 연결 시도 시 `409 Conflict` 반환 및 단일 소유권 보호 검증 통과.
4. WebSocket 마스킹 프레임을 통한 `initialize` 왕복 검증 통과 (`userAgent: test-ws/0.162.1`).
5. 관리자 세션 검사(`_inspect`)에서 유휴 상태 인식 (`canApply: True`, `managedIdleServers: 1`) 검증 통과.
6. control socket을 통한 `switch_worker` 명령으로 worker2(0.164.0) 무중단 교체 성공 검증 통과.
7. **동일 WebSocket 연결을 유지한 채** 신규 worker2로 `thread/start` 요청 전송 및 응답(`thread-w2`) 수신 성공 검증 통과.
8. WebSocket Ping(0x9) 프레임 송신 시 동일 페이로드를 담은 Pong(0xA) 수신 검증 통과.

### 3.4 전체 테스트 스위트 및 정적 분석

1. **전체 pytest 스위트:**
   ```text
   265 passed, 1 skipped in 123.50s (0:02:03)
   ```
   (기존 264개 전수 통과 + FIX_11 신규 회귀 테스트 1개 통과, 0 failures)
2. **구문 검사:**
   - `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/*.mjs`: PASS
   - `bash -n codex_home_assistant/rootfs/usr/local/bin/* tests/*.sh`: PASS
3. **Git Diff 검사:**
   - `git diff --check`: PASS (공백 및 EOF 개행 정합성 완벽)

---

## 4. 미수행 및 범위 한정 사항

- **미수행:** Docker 이미지 신규 빌드, HAOS 실기기(Raspberry Pi 등) 하드웨어 배포, 모바일 SSH 터미널 시험, native ARM64 빌드, 실제 OpenAI API 모델 호출 토큰 소모, GitHub Release/태그 생성/외부 push.
- **안전 준수:** 비밀값(`SUPERVISOR_TOKEN`, `auth.json`, SSH 키 등) 노출 없음, `/config` RW 매핑 및 `manager` 권한 유지, 금지된 옵션(`admin`, `docker_api` 등) 미도입.

---

## 5. 다음 단계 인계

- 관리형 대화형 CLI/TUI의 WebSocket endpoint 어댑터가 완결되었으며, 공식 바이너리 대조 및 switch_worker 연동 테스트가 모두 PASS 판정을 받았습니다.
- Reviewer의 FIX_11 요구조건(101 handshake, initialize 왕복, switch_worker 후 연속 입력, 단일 소유권, ping/pong, 전체 회귀 통과)이 모두 충족되었으므로, 다음 Reviewer 판정 및 사용자 dev 배포 지침 단계로 인계합니다.
