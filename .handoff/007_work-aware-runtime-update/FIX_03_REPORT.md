# FIX_03_REPORT — 모바일 Codex bootstrap 및 raw app-server proxy 전송 결함 해결 보고서

- **작성일**: 2026-11-02
- **역할**: Executor
- **기반 FIX 지침**: [.handoff/007_work-aware-runtime-update/FIX_03.md](FIX_03.md)
- **작업 브랜치**: `feat/fix03-mobile-proxy-bootstrap` (base `b7b3479f7e4c78dd87f7b5b28a6474e64f33f19a` / `dev`)
- **검증 테스트 이미지**: `codex-ha:test-fix03` (`sha256:6d03ae5bc0c97744c70461ffa764fca5471a25db109bb3f7a1f59e992b4260aa`)
- **배포 상태**: **로컬 구현 및 전체 테스트 검증 완료 / 미배포 (사용자 명시 지시 대기)**

---

## 1. 수정 전/후 소스 기준 및 결함 재현 세부사항

### 1.1 소스 기준 및 바이너리 신원
- **Base Commit**: `b7b3479f7e4c78dd87f7b5b28a6474e64f33f19a` (origin/dev)
- **Codex Binary**: 0.162.1 (`x86_64-unknown-linux-musl`, sha256 `6a3a4b9c9e836102aafead52b2f6ef3b0743b171f11a43ffb9c46ce36e6fe4eb`)
- **테스트 컨테이너 이미지**: `codex-ha:test-fix03` (amd64, Alpine 3.24 based, s6-overlay)

### 1.2 결함 재현 결과 (수정 전)
- **증상**: 모바일 클라이언트가 SSH 접속 후 `/usr/local/bin/codex app-server proxy --sock /tmp/bootstrap.sock`를 호출할 때, 제품 wrapper가 `app-server`를 감지하면서 하위 명령인 `proxy`를 식별하지 못해 `socket_path`가 비어있는 상태로 판단.
- **오분류 경로**: `socket_path`가 비어있고 `--listen`이 없으므로 `session_type="remote-stdio"`로 오분류되어 `codex-session-host.mjs`가 stdio JSONL 릴레이 모드로 구동됨.
- **재현 에러**: 모바일 클라이언트가 HTTP/1.1 WebSocket Upgrade 요청(`GET / HTTP/1.1\r\nHost: ...\r\nUpgrade: websocket\r\nConnection: Upgrade...`)을 stdio로 전송하면 `codex-session-host.mjs`가 줄바꿈 기반 JSONL 메시지로 해석하지 못하고 즉시 다음 에러를 stderr에 출력하며 비정상 종료(exit 1):
  ```text
  [codex-session-host] fatal transport error: malformed_frame in jsonl (measuredBytes=0, limit=33554432)
  ```
- **테스트 케이스 재현**: `tests/test_codex_wrapper_proxy.py::test_proxy_transport_defect_reproduction_on_jsonl_host`에서 이 실패 메커니즘을 100% 동일하게 재현 및 입증함.

---

## 2. 원인 분석 및 실제 모바일 환경과의 경계

1. **확정한 원인**:
   - `codex` bash wrapper (`/usr/local/bin/codex`)의 인자 파서가 최상위 하위 명령(`app-server`)만 파싱하고, `app-server` 뒤에 오는 2차 하위 명령(`proxy`, `daemon`, `generate-ts`, `generate-json-schema`, `help`)과 `--sock`/`--sock=` 옵션을 전혀 파싱하지 않았음.
   - 이로 인해 `app-server proxy` 호출이 `stdio://` 기반 관리형 JSONL stdio 세션으로 처리되어 `codex-session-host.mjs`가 개입함.
   - 공식 `codex app-server proxy --sock <socket>`는 stdin/stdout과 Unix 도메인 소켓 간의 순수 양방향 바이트 브리지(byte-bridge)이므로, JSONL framing을 기대하는 session host와 직접 충돌함.

2. **실제 모바일 환경과의 경계 (입증/미입증 구분)**:
   - **입증 완료**:
     - 사용자 실제 로그에서 확인된 ECDSA 공개키 SSH 인증 성공(`Accepted publickey for root`).
     - SSH 세션 내에서 `/usr/local/bin/codex app-server proxy --sock ...` 호출 시 발생하는 전송 결함 재현 및 해결.
     - HTTP Upgrade 101, WebSocket `initialize` 요청/응답, ping 제어 프레임, 분할 바이트 수신 및 정상 종료.
   - **미입증 (PARTIAL / NOT RUN)**:
     - 실제 물리 모바일 장치의 ChatGPT 앱에서 전송하는 세부 헤더/프로토콜 파라미터는 앱 내부 구현이므로 모의 클라이언트로만 검증됨.
     - 실제 Home Assistant OS 하드웨어 및 외부 모바일 네트워크를 통한 E2E 수용 시험은 로컬 개발 환경에서 불가능하므로 **NOT RUN**으로 유지.

---

## 3. 구현 내용 (P1 및 P2)

### 3.1 P1: Wrapper 파서 및 Raw Byte-Bridge 전송 보존
- **파일**: `codex_home_assistant/rootfs/usr/local/bin/codex`
- **구현 세부사항**:
  - `codex_app_server_subcommand` 파싱 로직 추가 (`proxy`, `daemon`, `generate-ts`, `generate-json-schema`, `help` 구분).
  - `--sock` 및 `--sock=` 인자 파싱 추가 (`codex_proxy_sock` 변수 추출).
  - `codex_subcommand == "app-server"` && `codex_app_server_subcommand == "proxy"` 조건 충족 시:
    - `is_app_server_proxy=true`, `session_type="app-server-proxy"`, `managed="false"`, `unix_sock="${socket_path}"`, `control_sock=""`, `is_one_shot=false`.
    - `/run/codex-ha/codex-maintenance/sessions/$$`에 세션 레코드 안전 기록.
    - `control_sock`이 비어있으므로 `codex-session-host.mjs`를 우회하고, 세션 게이트 보호 하에 검증된 불변 바이너리로 직접 실행:
      ```bash
      exec "${codex_real_bin}" "${options[@]}" app-server proxy --sock "${socket_path}"
      ```

### 3.2 P1: Runtime Manager 인벤토리 분류 및 소유권 검증
- **파일**: `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`
- **구현 세부사항**:
  - `parseCodexInvocation`: `appServerCommand` 및 `--sock`/`--sock=` 파싱 추가 (`proxySocket` 반환).
  - `classifyProcesses` Pass 3:
    - 세션 레코드(`type: "app-server-proxy"`) 또는 프로세스 인자(`appServerCommand: "proxy"`)를 통해 proxy 프로세스를 `e.kind = "proxy"`로 분류.
    - 하위 명령이 존재하는 listener는 일반 server 목록(`serverByArgv`, `serverByRecord`)에서 배제.
  - `classifyProcesses` Pass 4:
    - proxy의 대상 Unix 소켓을 `stat`으로 검사하고, symlink인 경우 `realpath`로 정규 경로를 해석 (`codex app-server`가 생성하는 소켓이 `/tmp/codex-daemon-0/...` 대상 symlink이므로 필수).
    - 소켓 정규 경로를 활성 서버(`app-server` 또는 `cli`)의 리스너 소켓과 매칭.
    - 활성 소유자 서버가 확인되면 `e.kind = "helper"`, `e.owner = ownerPid`, `e.isProxy = true`로 설정하여 관리형 유휴 서버의 정상 companion으로 회계 (유휴 서버 갱신 차단하지 않음).
    - 세션 레코드 누락, 대상 소켓 부재, 또는 소유 서버 부재 시 `e.kind = "unknown"`으로 설정하여 실패 닫힘 보존 (원인별 `unverifiedProxy`, `missingTargetSocket`, `orphanProxy` 플래그 부여).
  - `classifyProcesses` Pass 5:
    - `e.kind === "unknown"`인 비정상 proxy에 대해 명확한 busy reason 기록 (`unverified codex proxy process without valid session record`, `codex proxy target socket is missing or not a socket`, `codex proxy has no active owner server`).

### 3.3 P2: `ha-codex-remote status` 비비밀 진단 보강
- **파일**: `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-remote-setup.mjs`
- **구현 세부사항**:
  - 민감정보(비밀키 내용) 노출 없이 다음 안전 진단 항목을 출력하도록 확장:
    - `Private material`: `present (mode 0600)` / `absent` / `unsafe permissions (...)`
    - `Authorized keys`: `synced (1 key)` / `out of sync` / `absent`
    - `SSH service`: `active / listening` / `stopped (ssh-disabled marker present)`
    - `SSH auth`: `verified on client connection (check App SSH logs for Accepted publickey)`
    - `Codex bootstrap`: `not_checked (verified when client connects)`

---

## 4. 검증 결과 및 증거

### 4.1 전체 테스트 매트릭스
1. **신규 전송 및 와이어 프로토콜 회귀 테스트 (`tests/test_codex_wrapper_proxy.py`)**:
   - `test_proxy_transport_defect_reproduction_on_jsonl_host`: JSONL session host에 Upgrade 전달 시 `malformed_frame in jsonl` 결함 재현 검증 (PASS).
   - `test_official_proxy_wire_upgrade_and_initialize`: 공식 app-server와 proxy 간의 실제 Unix 소켓 통신을 통한 HTTP Upgrade 101, masked WebSocket `initialize` 요청/응답, EOF 정상 종료 검증 (PASS).
   - `test_proxy_split_frames_and_control_frames`: 다중 청크 분할 Upgrade 헤더, 1바이트 단위 분할 WebSocket 프레임, Ping 제어 프레임(0x09)에 대한 Pong(0x0A) 응답 수신, 클라이언트 종료 시 정상 exit 0 검증 (PASS).
   - **결과**: `3 passed in 0.68s`.

2. **계약 및 런타임 갱신 테스트 (`tests/test_codex_update_contract.py`)**:
   - `test_parse_codex_invocation_app_server_proxy_and_subcommands`: 파서가 proxy 및 하위 명령, `--sock` 옵션을 정확히 추출하는지 검증 (PASS).
   - `test_wrapper_app_server_proxy_subcommand_parsing`: wrapper 스크립트 슬라이스가 `app-server proxy`에 대해 `is_app_server_proxy=true`, `session_type=app-server-proxy`, `managed=false`를 산출하는지 검증 (PASS).
   - `test_managed_idle_server_with_owned_proxy_is_restartable`: proxy가 소유 서버에 매핑되어 helper로 회계되고 유휴 서버 재시작 트랜잭션을 차단하지 않는지 검증 (PASS).
   - `test_proxy_with_missing_target_server_is_held_unknown`: 소유 서버가 없는 고아 proxy가 unknown으로 분류되어 갱신을 안전하게 보류하는지 검증 (PASS).
   - **결과**: 전체 123개 테스트 중 `123 passed in 87.81s`.

3. **원격 설정 및 진단 테스트 (`tests/test_remote_setup.py`)**:
   - SEC1/PKCS#8 키 생성, TTY 출력 통제, 비정상 권한/심링크 거부, 상태 진단 필드 등 회귀 검증.
   - **결과**: `10 passed in 0.41s`.

4. **전체 Pytest 회귀 슈트**:
   - 실행: `.venv/bin/python -m pytest -v`
   - **결과**: `307 passed, 6 skipped in 114.18s` (6개 skip은 호스트 환경에 AppArmor 커널 모듈 또는 OCI 이미지 미배포 상태인 선택적 테스트).

5. **격리 Docker 컨테이너 실제 SSH S6 스모크 테스트 (`tests/mobile-ssh-smoke.py`)**:
   - 새로 빌드된 이미지 `codex-ha:test-fix03` 사용.
   - S6 supervisor 하에서 sshd 및 codex-updater가 실행 중인 상태에서:
     - `ha-codex-remote setup`을 통한 ECDSA 키 쌍 생성 및 authorized_keys 등록.
     - SEC1 PEM을 이용한 실제 SSH 공개키 인증 접속.
     - 백그라운드 `codex app-server --listen unix:///tmp/bootstrap.sock` 구동.
     - SSH 접속을 통해 `/usr/local/bin/codex app-server proxy --sock /tmp/bootstrap.sock` 실행.
     - SSH 파이프를 통한 HTTP Upgrade 요청 전송 -> `HTTP/1.1 101 Switching Protocols` 수신 확인.
     - 마스킹된 WebSocket `initialize` JSON-RPC 프레임 전송 -> 서버의 `initialize` 응답 프레임 정상 수신 확인.
   - **결과**:
     ```text
     PASS: interactive setup, both PEM SSH auth, revoke rejection, S6 activation/restart and SSH wrapper proxy bootstrap
     ```

### 4.2 정적 및 코드 무결성 검사
- `git diff --check`: 공백 오류 및 구문 결함 없음 (PASS).
- `node --check`: 수정된 `codex-runtime-manager.mjs`, `codex-remote-setup.mjs`, `codex-session-host.mjs` 구문 검사 이상 없음 (PASS).
- `wrapper` 문법: bash -n 및 계약 테스트 내 슬라이스 구문 검사 완료 (PASS).

---

## 5. 검증 범위 경계 (PASS / PARTIAL / NOT RUN)

| 영역 | 상태 | 세부 내용 |
| :--- | :--- | :--- |
| **P1 Proxy Byte Bridge** | **PASS** | wrapper가 `app-server proxy`를 감지하여 session-host 우회, 공식 바이너리 raw bridge로 직접 실행 |
| **P1 Runtime Manager Inventory** | **PASS** | proxy를 소유 서버 검증 후 helper로 안전 분류, 고아 proxy는 unknown으로 갱신 차단 |
| **P2 Remote Status 진단** | **PASS** | private.pem(0600), authorized_keys, sshd 상태, bootstrap 상태 비비밀 안내 추가 |
| **SSH S6 모바일 스모크** | **PASS** | 도커 컨테이너 내 S6 sshd + SSH auth + wrapper proxy + HTTP Upgrade + WS initialize E2E 통과 |
| **기존 CLI/세션/업데이트 보호** | **PASS** | 123개 update contract 테스트 및 전체 307개 pytest 테스트 통과 |
| **실제 HAOS 하드웨어 장치** | **NOT RUN** | 로컬 개발 환경으로 실제 Home Assistant OS 하드웨어 기기 테스트는 미수행 |
| **물리 모바일 장치(iOS/Android)** | **NOT RUN** | 물리 스마트폰 ChatGPT 모바일 앱 연동은 사용자 실기기 수용 테스트 영역 |

---

## 6. 변경 파일 목록

- `codex_home_assistant/rootfs/usr/local/bin/codex`: `app-server proxy` 하위 명령 및 `--sock` 파싱, raw byte-bridge 바이너리 직접 실행.
- `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`: proxy 파서, socket symlink realpath 검사, 소유 서버 helper 매핑 및 고아 proxy 실패 닫힘.
- `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-remote-setup.mjs`: `ha-codex-remote status` 비비밀 진단 라인 추가.
- `tests/test_codex_wrapper_proxy.py`: 와이어 프로토콜, 결함 재현, split framing, ping 제어 프레임 회귀 테스트 신규 작성.
- `tests/test_codex_update_contract.py`: proxy 파서 및 인벤토리 helper/unknown 회귀 단위 테스트 추가.
- `tests/mobile-ssh-smoke.py`: SSH 세션 내 실제 wrapper proxy 실행 및 HTTP Upgrade/WebSocket initialize E2E 검증 추가.
- `docs/development/progress.md`: FIX_03 구현 및 검증 현황 기록.

---

## 7. 향후 사용자 수용 절차 안내

1. **배포 승인**:
   - 현재 구현 및 로컬 테스트 검증은 완료되었으나, FIX_03 지침(Section 1 및 Section 8)에 따라 버전 번프, git tag push, DEV 공개 릴리스 배포는 보류되어 있습니다.
   - 사용자가 새로운 DEV 릴리스(예: `0.7.3-dev.6`) 배포를 지시하면 버전 반영 및 CI 배포를 진행합니다.
2. **사용자 실기기 수용 확인 항목**:
   - 새 DEV 버전 업데이트 후:
     - Web UI 터미널에서 `ha-codex-remote status` 실행 시 진단 상태 정상 확인.
     - 모바일 앱에서 SSH 연결 시:
       - 이전과 동일하게 `Accepted publickey for root` 확인.
       - 이후 `[codex-session-host] fatal transport error: malformed_frame in jsonl` 오류가 더 이상 발생하지 않고, 정상적으로 Codex bootstrap이 완료되어 프롬프트 대화가 가능한지 확인.
