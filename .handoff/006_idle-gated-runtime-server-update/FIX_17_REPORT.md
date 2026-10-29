# FIX_17_REPORT — 운영 CLI relay 대용량 메시지 crash 및 단발 명령 분류 완료

작성일: 2026-10-29  
담당: Executor (Antigravity)  
기준 지침: [.handoff/006_idle-gated-runtime-server-update/FIX_17.md](FIX_17.md)

---

## 1. 개요 및 변경 요약

Reviewer의 FIX_17 지침에 따라 운영 중 발생한 `server_buffer_overflow` crash와 단발 CLI 명령(`codex --version` 등)의 불필요한 백엔드 기동 문제를 수정하고, DEV 릴리스 버전을 **`0.7.3-dev.2`**로 증가시켰다.

### P1 — 대용량 JSONL 메시지 crash 및 bounded framing 해결 (`codex-session-host.mjs`)
1. **버퍼 한도 및 크기 정책 정의**:
   - `MAX_FRAME_BYTES = 32 * 1024 * 1024` (32 MiB, 단일 JSONL frame / WebSocket frame 한계)
   - `MAX_HOLD_BYTES = 32 * 1024 * 1024` (32 MiB, 전환 hold queue 및 backpressure 임계)
   - `MAX_STREAM_BUFFER_BYTES = 64 * 1024 * 1024` (64 MiB, 단일 스트림 버스트 누적 한계)
2. **완결 frame과 미완결 잔여의 분리 처리**:
   - `_handleServerData` 및 `_processAndForwardClientChunk`에서 chunk 수신 즉시 `parseJsonMessages`로 완결된 newline-delimited frame을 소비하여 버퍼를 즉시 축소.
   - 단일 chunk에 여러 개의 정상 frame이 모여 있더라도 전체 크기로 거부하지 않고 순차 처리 및 전달.
   - 미완결 잔여(trailing partial line)의 UTF-8 바이트 크기를 `Buffer.byteLength(remaining, "utf-8")`로 측정하여 단일 frame 한계 초과 여부를 정밀 검사.
3. **명시적 치명적 오류 처리 및 프로세스 정리 (`_fatalTransportError`)**:
   - `throw new Error(...)`에 의한 uncaught exception crash 경로를 완전히 제거.
   - frame 한계 초과 또는 스트림 오버플로 시 `_fatalTransportError(direction, reason, measuredBytes)` 호출.
   - 본문이나 token을 로그에 남기지 않고 `direction`, `reason`, `measuredBytes`, `limit`만 안전하게 진단 출력.
   - `this.recoveryIncomplete = true`, `this.unobservedWork.add(...)` 기록 후 `this._cleanup()`으로 child worker(`app-server`), client 프로세스, 소켓, 세션 파일을 즉시 정리하고 exit 1 종료.
4. **WebSocket 및 Backpressure 안전성 보강**:
   - WebSocket frame 파싱 시 64-bit payloadLen 및 fragment 크기 검사.
   - child worker stdin 및 client socket write buffer 포화 시 `drained === false` 감지 및 `drain` 이벤트 연동으로 upstream 스트림 backpressure 적용 (단위 테스트의 mock stream 호환성 유지).

### P2 — 단발 CLI 명령 백엔드 기동 우회 (`usr/local/bin/codex`)
1. **단발 명령 감지**:
   - 옵션 및 서브커맨드 파싱 루프에서 `--version`, `-V`, `--help`, `-h`, `help` 및 `resume --help`를 `is_one_shot=true`로 분류.
   - `--` 이후의 프롬프트나 옵션 값(예: `-m --help`)은 단발 플래그로 오인하지 않도록 기존 인자 파싱 규칙 준수.
2. **직접 실행 경로 적용**:
   - `is_one_shot=true`인 경우 `managed=false`, `control_sock=""`, `client_sock=""`를 유지하고 세션 파일 생성을 건너뜀.
   - 안전 게이트(flock -s gate.lock), 버전 확인, `unset SUPERVISOR_TOKEN`, sandbox 및 권한 옵션을 온전히 유지하면서 `codex_real_bin`을 직접 `exec`.
   - `codex --version`, `codex --help` 등이 `codex-session-host.mjs`나 `app-server`를 기동하지 않고 즉시 결과를 출력하고 종료되도록 보장.

---

## 2. 검증 결과

### 1) 단위 및 회귀 테스트 (`pytest tests/`)
- 신규 회귀 테스트 추가:
  - `test_fix17_large_jsonl_payload_and_framing_resilience`: 6.5MiB 대형 페이로드(Reviewer 재현 조건 초과), 단일 청크 내 복수 frame, 한글/이모지 멀티바이트 UTF-8 분할 청크 정상 수신 및 relay 생존 검증.
  - `test_fix17_fatal_transport_error_on_exceeded_frame_limit`: 34MiB 초과 frame 수신 시 uncaught crash 없이 safe diagnostic 출력, token/데이터 누출 없음, 자식 프로세스 및 세션 파일 정리, exit code 1 종료 검증.
  - `test_fix17_oneshot_cli_invocations_bypass_managed_session_host`: `--version`, `-V`, `--help`, `-h`, `help`, `resume --help`, `-c config --version` 등이 session-host를 우회하고 단발 실행됨을 검증하고 대화형 세션 및 `--` 프롬프트와의 분류 정확도 확인.
- 전체 테스트 스위트 결과:
  - **271 passed, 1 skipped** (139.44초).
  - 기존 269개 테스트 전원 통과 확인 (mock stream 호환성 포함).

### 2) 정적 분석 및 린트
- Node.js 구문 검사: `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/*.mjs` -> 정상 (exit 0).
- Bash 구문 검사: `bash -n codex_home_assistant/rootfs/usr/local/bin/* tests/*.sh` -> 정상 (exit 0).
- ShellCheck: `docker run --rm koalaman/shellcheck ...` -> 경고 0건, 통과.
- Git diff 검사: `git diff --check` -> 공백/개행 오류 없음 (exit 0).

---

## 3. 버전 증가 및 배포 준비

- **DEV 버전**: `0.7.3-dev.2`
- 반영 파일:
  - `codex_home_assistant/config.yaml` (`version: "0.7.3-dev.2"`)
  - `codex_home_assistant/Dockerfile` (`ARG BUILD_VERSION=0.7.3-dev.2`)
  - `codex_home_assistant/playwright/package.json` (`"version": "0.7.3-dev.2"`)
  - `codex_home_assistant/playwright/package-lock.json` (`"version": "0.7.3-dev.2"`)
  - `codex_home_assistant/CHANGELOG.md` (`## [0.7.3-dev.2] - 2026-10-29`)
  - `tests/test_addon_contract.py` (`assert addon_config["version"] == "0.7.3-dev.2"`)

---

## 4. 미검증 항목 (NOT RUN)

- 실제 HAOS 하드웨어 상의 0.7.3-dev.2 애드온 설치 및 실기 실행 (NOT RUN)
- 모바일 SSH 터미널을 통한 실제 운영 TUI 렌더링 (NOT RUN)
- 실제 물리 ARM 하드웨어에서의 네이티브 실행 (GitHub Actions Builder multiarch 교차 빌드로 대체 예정)
