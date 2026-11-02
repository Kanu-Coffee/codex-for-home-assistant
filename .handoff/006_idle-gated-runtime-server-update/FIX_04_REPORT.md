# FIX_04 Executor 보고서

작성: 2026-10-28 (Asia/Seoul). 결과: **J1/J2 결함 수정 완료 / J3 안전 게이트 유지 및 한계 문서화 / task 006 미완료 (재리뷰 요청)**.

사용자 목표인 작업이 없는 유휴 CLI/TUI 및 Remote stdio 기존 backend의 무중단 자동 전환은 안전성 보장 및 기술적 upstream 한계로 인해 fail-closed 상태(`compatibility_unverified`)를 유지한다. Reviewer가 [FIX_04](FIX_04.md)에서 지적한 프레임 분리 결함(J1) 및 client ID 충돌 결함(J2)은 제품 코드 및 계약 테스트에 전면 반영하여 해결했다. 기존 task 005 및 handoff 문서는 보존했다.

---

## 1. J1: 청크 경계의 미완성 프레임 보존 및 worker 분리 방지

### 문제점 요약
- `codex-session-host.mjs`의 `_processAndForwardClientChunk`가 수신 청크를 완성 여부와 상관없이 즉시 child worker의 stdin에 기록하고 있었다.
- 미완성 프레임이 `clientBuffer`에 남아 있는 상태에서 `switchWorker`가 실행되면, 요청의 앞부분은 구 worker로, 나머지 조각(`\n` 포함)은 신규 worker로 전송되어 신규 worker에서 JSON 파싱 오류(`partial_frame_parse_error`)가 발생하고 request ledger에 영구 미완료로 남는 결함이 있었다.

### 수정 사항
1. **미완성 프레임 busy 판정 (`_workState`)**:
   - `clientBuffer.length > 0`일 때 `hasPartialFrame = true`로 판정하여 `busy: true`를 강제한다.
   - 부분 프레임이 수신 중인 상태에서는 `switchWorker` 요청이 `error: "worker_busy"`로 안전하게 거부된다.
2. **완성된 개행 구분 프레임만 전달 (`_processAndForwardClientChunk`)**:
   - raw 청크를 즉시 `this.child.stdin.write(chunk)`로 보내던 로직을 제거하고, `for ({ raw, obj } of messages)` 루프 내에서 온전한 개행 구분 프레임(`raw`)만을 `this.child.stdin.write(raw)`로 전달하도록 변경했다.
   - worker 교체 전후에 어떤 worker도 파편화되거나 잘린 JSON 청크를 수신하지 않는다.
3. **Worker 전환 시 stale 버퍼 및 디코더 격리 (`_drainAndStopChild`)**:
   - worker 종료 및 교체 시 `this.serverBuffer = ""` 초기화 및 `this.serverDecoder = new StringDecoder("utf-8")`로 재설정하여 구 worker의 잔류 바이트가 신규 worker 세대에 오염되지 않도록 격리했다.

---

## 2. J2: 유효한 Client 문자열 ID 보존 및 내부 RPC 충돌 해소

### 문제점 요약
- `codex-session-host.mjs`에서 worker 응답 ID가 `__internal_`로 시작하면 내부 RPC로 간주하고 무조건 `continue`하여 클라이언트로의 응답 포워딩을 폐기했다.
- 클라이언트가 `__internal_client_1`과 같은 문자열 ID를 사용할 경우 정상 응답을 수신하지 못하고 ledger에 영구 pending/busy 상태로 잔류하는 결함이 있었다.

### 수정 사항
1. **명시적 내부 RPC 레지스트리 (`internalPendingRpcs`, `expiredInternalRpcIds`)**:
   - 단순 문자열 prefix 검사를 제거하고, relay가 실제로 발급하여 응답 대기 중인 ID Set(`this.internalPendingRpcs`)을 엄밀히 대조한다.
2. **세션별 고유 격리 Prefix 발급**:
   - 내부 RPC ID 생성 시 `__relay_internal_${process.pid}_${Math.random().toString(36).slice(2, 9)}_${++this.internalRpcSeq}` 구조를 적용하여 외부 클라이언트 ID와의 충돌을 원천 방지했다.
3. **클라이언트 ID 보호 및 만료 응답 격리**:
   - 클라이언트가 전송한 임의의 ID(`__internal_`로 시작하는 문자열 포함)는 내부 레지스트리에 존재하지 않으므로 클라이언트 stdout으로 온전히 전달된다.
   - timeout 등으로 만료된 내부 RPC의 지연 응답은 `expiredInternalRpcIds`에서 감지되어 클라이언트 출력으로 새어나가지 않고 조용히 폐기된다.

---

## 3. J3: 정상 유휴 세션 자동 전환 및 복구 경로 상태

### 안전 게이트 유지 및 한계
- 현재 `codex-runtime-manager.mjs`의 `inspectAllSessions` 및 `applyUpdate` 경로에서 라이브 서버 전환에 대해 `compatibility_unverified`를 반환하는 안전 게이트(fail-closed)를 유지한다.
- **기술적 제약 사항**:
  - upstream `codex app-server`는 `thread/read` 시 rollout 파일이 미저장된 새/ephemeral 세션에 대해 `thread/resume`을 지원하지 않음(`no rollout found` 오류 발생).
  - CLI/TUI 직접 실행 세션의 live stdio handover는 upstream 터미널 세션의 인터랙티브 PTY 상태 및 메모리 상의 uncommitted 상태 마이그레이션이 불가능함.
  - 다중 host 복구, crash/restart 시 transaction journal 기반의 무중단 복구는 안전 보장이 완비되지 않았음.
- 따라서 fail-closed 게이트를 유지하며, 실행 중인 세션이 없는 경우의 릴리스 전환만을 안전하게 수용한다.

---

## 4. 검증 결과

### 실행 명령 및 결과
1. **계약 및 FIX_04 단위 검증**:
   - `tests/test_codex_update_contract.py`에 `test_production_stdio_relay_partial_frame_and_client_internal_ids` 추가:
     - 청크 분할(`{"id":7,"method":"model/` + `list"}\n`) 중간의 worker 교체 시도 시 `worker_busy` 거부 및 온전한 프레임 전달 검증.
     - `__internal_client_1` ID를 사용하는 클라이언트 요청/응답이 온전히 왕복되고 ledger에서 정상 해제됨을 검증.
   - `.venv/bin/python -m pytest -ra tests/test_codex_update_fix03.py` → **7 passed in 9.51s**.
   - `.venv/bin/python -m pytest -ra tests/test_codex_update_contract.py` → **110 passed in 76.25s**.
2. **전체 테스트 스위트 실행**:
   - `.venv/bin/python -m pytest -q` → **260 passed, 1 skipped in 109.69s**.
3. **문법 및 린트 검사**:
   - `git diff --check` → **PASS** (공백/개행 오류 없음).
   - `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-server-transaction.mjs` → **PASS**.
   - `bash -n codex_home_assistant/rootfs/usr/local/bin/codex` → **PASS**.

### NOT RUN (미검증 항목 명시)
- Docker 이미지 신규 빌드 및 컨테이너 내부 updater smoke (`tests/codex-update-smoke.sh`, `tests/docker-smoke.sh`).
- Home Assistant OS (HAOS) 실제 기기 배포 및 supervisor 환경 테스트.
- 모바일 Remote SSH 및 웹 터미널 실기기 접속 테스트.
- 실제 OpenAI 모델 API 연동 라이브 세션 테스트.
- aarch64 (ARM64) 네이티브 바이너리 릴리스 전환 테스트.
- 외부 Git push, pull request 생성 및 릴리스 배포는 일체 수행하지 않음.
