# FIX_05 Executor 보고서

작성: 2026-10-28 (Asia/Seoul). 결과: **K1 결함 수정 완료 / K2 안전 게이트 유지 및 한계 분석 정정 / task 006 미완료 (재리뷰 요청)**.

사용자 목표인 작업이 없는 유휴 CLI/TUI 및 Remote stdio 기존 backend의 무중단 자동 전환은 안전성 보장 및 upstream 기술적 제약으로 인해 fail-closed 상태(`compatibility_unverified`)를 유지한다. Reviewer가 [FIX_05](FIX_05.md)에서 지적한 서버 출력의 미완성 프레임 무시 및 세대 경계 오염 결함(K1)을 제품 코드 및 계약 테스트에 전면 반영하여 해결하고, PTY 마이그레이션 불가능성에 대한 잘못된 단정을 정정(K2)했다. 기존 task 005 및 handoff 문서는 보존했다.

---

## 1. K1: 서버 출력의 미완성 프레임 보존 및 Worker 세대별 격리

### 문제점 분석
1. `_workState()`에서 `clientBuffer`의 부분 프레임만 검사하고 `serverBuffer` 및 UTF-8 디코더(`serverDecoder`)의 미완성 상태를 검사하지 않았다. 서버가 알림이나 응답을 여러 청크로 나누어 출력하는 도중(`{"method":"unfinished` 등) inspect/switchWorker가 호출되면 idle(`busy: false`)로 오판하여 worker 교체를 허용하는 결함이 있었다.
2. `_drainAndStopChild()`의 버퍼/디코더 초기화 로직이 함수의 맨 끝에만 위치하여, 정상 종료(SIGHUP 후 종료 대기 루프) 또는 이미 종료된 worker 경로에서는 `return true`로 조기 반환되어 `serverBuffer`와 `serverDecoder`가 초기화되지 않았다.
3. `_spawnChild()`의 `child.stdout.on("data")` 리스너가 worker 프로세스의 세대(generation)를 식별하지 않아, 이전 세대 worker의 지연 출력 청크가 신규 worker 세대의 파서/버퍼에 유입되어 신규 worker의 `initialize` RPC 응답을 손상시키고 timeout을 유발할 수 있었다.

### 수정 사항
1. **서버 부분 프레임 및 UTF-8 바이트 시퀀스 검사 (`_workState`)**:
   - `clientDecoder.lastNeed > 0` 및 `serverDecoder.lastNeed > 0` 검사를 추가하여 한글 등 3바이트 UTF-8 문자의 중간 바이트 분할 상태를 감지한다.
   - `hasPartialClientFrame = (clientBuffer.length > 0 || clientDecoder.lastNeed > 0)`
   - `hasPartialServerFrame = (serverBuffer.length > 0 || serverDecoder.lastNeed > 0)`
   - `hasPartialFrame = hasPartialClientFrame || hasPartialServerFrame`
   - 서버 또는 클라이언트의 부분 프레임이 수신 중인 경우 `busy: true`를 반환하며, `switchWorker` 요청은 `error: "worker_busy"`로 안전하게 거부된다.
2. **모든 Worker 종료 경로에서의 완전한 정리 (`_drainAndStopChild`)**:
   - `cleanupChild(targetChild)` 헬퍼를 도입하여, 조기 종료 확인, SIGHUP 후 정상 종료, 타임아웃 종료 등 모든 반환 경로에서 예외 없이 `targetChild.stdout.removeAllListeners("data")`, `child = null`, `serverBuffer = ""`, `serverDecoder = new StringDecoder("utf-8")`를 실행하도록 통일했다.
3. **Worker 세대 식별 및 지연 출력 격리 (`_spawnChild`)**:
   - Relay 인스턴스에 `childGeneration` 카운터와 `activeGeneration`을 도입했다.
   - `_spawnChild` 실행 시마다 세대 번호를 증가시키고(`++this.childGeneration`), 해당 세대 전용 `generation` 값을 클로저에 보존한다.
   - `child.stdout.on("data", chunk => ...)` 리스너에서 `this.activeGeneration !== generation || this.child !== child`인 경우 수신 데이터를 즉시 폐기하여 구 세대 worker의 지연 stdout이 신규 세대의 파서나 버퍼를 오염시키는 것을 원천 차단했다.

---

## 2. K2: 자동 전환·복구 미구현 및 기술적 한계 정정

### 기술적 제약 사항 정정 (PTY 단정 정정)
- 이전 `FIX_04_REPORT.md` 및 `progress.md`에서 "터미널 PTY 마이그레이션 한계로 인해 불가능"하다고 단정한 것은 PLAN의 설계와 부합하지 않는 잘못된 설명이었다. PLAN의 stable endpoint 설계는 frontend(PTY 및 사용자 인터페이스)를 유지한 채 backend(Codex app-server)만을 안전하게 교체하는 구조이므로 PTY 자체를 마이그레이션할 필요는 없다.
- **실제 라이브 자동 전환의 기술적 한계 및 블로커**:
  1. **Upstream `thread/resume`의 미저장 rollout 파일 요구**:
     - `codex app-server`는 `thread/read` 시 rollout 파일이 아직 디스크에 영속화되지 않은 신규/ephemeral 대화 세션에 대해 `thread/resume` 시 `no rollout found` 오류를 발생시키며 세션 복원을 거부한다.
  2. **Upstream 인터페이스의 메모리 내 동적 상태(subscription/config/policy) 인계 부재**:
     - 대화 외에 thread별 활성 구독, dynamic tool approval 대기 상태, 설정 및 background task 라이프사이클을 worker 인스턴스 간에 안전하게 추출/주입할 수 있는 공식 프로토콜이 지원되지 않는다.
  3. **Multi-host / 부분 장애 시의 자동 Transaction Recovery 부재**:
     - 장애 시 journal을 보존하고 fail-closed 상태를 유지하지만, 여러 host 간의 부분 릴리스나 재시작 상황에서 진행 중인 작업을 유실 없이 자동 롤백/복구하는 로직이 완성되지 않았다.
- 따라서 fail-closed 안전 게이트(`compatibility_unverified`)를 유지하며, 활성 세션이 없는 유휴 상태에서의 릴리스 전환만을 안전하게 수용한다.

---

## 3. 검증 결과

### 실행 명령 및 결과
1. **계약 및 FIX_05 단위 검증**:
   - `tests/test_codex_update_contract.py`에 `test_production_stdio_relay_server_generation_and_partial_frame` 추가:
     - 서버 출력 분할(`{"method":"unfinished` + `"}\n`) 중 `busy: true` / `hasPartialServerFrame: true` 확인 및 `switchWorker`의 `worker_busy` 거부 검증.
     - 한글 3바이트 UTF-8 시퀀스 분할(`[0xec, 0x95]` + `[0x88, 0x0a]`) 중 `busy: true` 및 완료 후 idle 복귀 검증.
     - `switchWorker` 시 `activeGeneration` 증가 및 이전 세대 버퍼/디코더 격리 검증.
   - `.venv/bin/python -m pytest -ra tests/test_codex_update_fix03.py` → **7 passed in 9.57s**.
   - `.venv/bin/python -m pytest -ra tests/test_codex_update_contract.py` → **111 passed in 76.5s**.
   - 두 파일 결합 실행: **118 passed in 86.60s**.
2. **전체 테스트 스위트 실행**:
   - `.venv/bin/python -m pytest -q` → **261 passed, 1 skipped in 110.04s**.
3. **정적 검사**:
   - `git diff --check` → **PASS**.
   - `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-server-transaction.mjs` → **PASS**.
   - `bash -n codex_home_assistant/rootfs/usr/local/bin/codex` → **PASS**.

### NOT RUN (미검증 항목 명시)
- Docker 신규 빌드 및 컨테이너 내부 updater smoke.
- Home Assistant OS (HAOS) 실기기 supervisor 환경 테스트.
- 모바일 Remote SSH 및 웹 터미널 실기기 접속 테스트.
- 실제 OpenAI 모델 API 연동 라이브 세션 테스트.
- aarch64 (ARM64) 네이티브 바이너리 릴리스 전환 테스트.
- 외부 Git push, pull request 생성 및 릴리스 배포는 일체 수행하지 않음.
