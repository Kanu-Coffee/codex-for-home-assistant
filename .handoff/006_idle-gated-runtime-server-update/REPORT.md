# REPORT — 실제 작업 유휴 판정에 따른 Codex 서버 자동 업데이트 구현

## 1. 개요 및 인계 상태

- **작성일자:** 2026-10-28 (Asia/Seoul)
- **작업자:** Executor
- **기준 계획:** `.handoff/006_idle-gated-runtime-server-update/PLAN.md`
- **상태:** **구현 및 계약 검증 완료 (Implementation & Contract Verification PASS)** / **Docker 빌드 및 HAOS 실기기 검증 NOT RUN**
- **목적:** CLI 및 Remote stdio 연결이 유지되어 있더라도 진행 중인 실제 작업(요청, 응답 생성, 승인 대기, 백그라운드 작업 등)이 없는 실제 유휴(Idle) 상태일 때 기존 실행 백엔드 서버를 신버전으로 자동 전환하고 동일 대화를 복원하는 기능 구현.

## 2. 구현 내용 및 아키텍처 변경

1. **관리형 세션 호스트 및 Stdio Relay (`codex-session-host.mjs`)**:
   - `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs` 신규 구현.
   - Remote stdio 세션에서 client(SSH/stdin/stdout)와의 연결을 유지하면서 실제 Codex app-server를 교체 가능한 child worker로 실행.
   - 제어 유닉스 소켓 (`controlSocket`: `/run/codex-ha/codex-maintenance/control/stdio-<pid>.sock`)을 노출하고 세션 레코드에 등록.
   - JSON-RPC 스트림 관측을 통해 `inFlightRequests`, `pendingServerRequests`(승인/입력 대기), `activeTurns`, `loadedThreadIds`를 정밀 추적.
   - 입장 차단(Admission barrier) 메커니즘을 지원하여 작업자 전환 중 유입되는 클라이언트 요청을 임시 hold 큐에 보관한 뒤 전환 완료 후 새 worker에 정확히 한 번 전달.
   - 새 worker 준비 후 이전 `loadedThreadIds`에 대해 `thread/resume`을 전송하여 동일 대화 세션을 복원.

2. **단일 작업 상태 모델 및 유휴 판정 분리 (`codex-runtime-manager.mjs`)**:
   - `inspectAppServer`: 기존에 `thread/loaded/list`에 대화가 로드되어 있으면 무조건 `busy`로 처리하던 방식을 개선.
     - `app.requests.in_flight <= 1`, `app.requests.queued == 0`, `core.turns.active == 0` 등 모든 진단 게이지가 유휴이고 대화에 active turn/busy 상태가 없으면 `busy: false`로 판정.
     - 로드된 스레드 식별자 목록(`loadedThreads`)을 수집하여 반환.
   - `inspectSessionHost`: 제어 소켓을 통해 session host에 `inspect` 명령을 전송하여 실제 in-flight 요청 및 active turn 여부를 확인하는 헬퍼 함수 구현.
   - `inspectAllSessions`:
     - `remote-stdio` 관리형 세션을 감지하여 제어 소켓으로 실제 유휴 여부를 관측. 유휴 시 `counts.managedIdleServers++` 및 `restartableServers`에 등록.
     - 관리형 세션이 아닌 unmanaged/legacy 세션은 안전하게 종료 대기로 처리.
     - 세션 목록 Pass 3 분류 시 `record.type === "remote-stdio"`를 지원.

3. **서버 교체 트랜잭션 및 복원 연동 (`codex-server-transaction.mjs`)**:
   - `restartServers`:
     - 대상 서버가 `type: "remote-stdio"`인 경우, 제어 소켓을 통해 `switch_worker` 명령을 전달하여 클라이언트 연결 끊김 없이 worker 전환 및 동일 대화 복원을 수행.
     - 전환 실패 시 `switch_worker`를 통해 이전 버전 바이너리로 롤백 수행.

4. **Codex 실행 래퍼 연동 (`codex`)**:
   - `/usr/local/bin/codex`:
     - `app-server` 명령이면서 `--listen` 소켓이 없는 stdio 모드(모바일 Remote SSH 등)일 때, `codex-session-host.mjs` relay를 통해 관리형으로 실행되도록 연동.
     - 제어 소켓 디렉터리(`/run/codex-ha/codex-maintenance/control`) 생성 및 세션 레코드에 `controlSocket` 경로 기록.

5. **개발 및 제품 문서 동기화**:
   - `docs/development/rules.md` (R-403)
   - `docs/development/product_spec.md` (FR-021)
   - `docs/development/architecture.md` (§13)
   - `codex_home_assistant/DOCS.md` 및 `codex_home_assistant/DOCS.en.md`

## 3. 검증 결과

### 1) 단위 및 계약 테스트 (Pytest)
- 실행 명령: `.venv/bin/python -m pytest -ra tests/test_codex_update_contract.py`
- 결과: **107 passed in 71.82s (100% PASS)**
- 신규 추가된 계약 테스트:
  - `test_managed_app_server_loaded_idle_threads_can_restart`: loaded thread가 존재하지만 active gauge가 0인 유휴 상태에서 `busy is False` 및 `restartableServers` 포함 검증 PASS.
  - `test_managed_app_server_active_thread_is_busy`: loaded thread 중 active turn이 있는 경우 `busy is True` 및 업데이트 보류 검증 PASS.
  - `test_managed_remote_stdio_session_host_idle_and_switch`: Remote stdio 관리형 relay의 유휴 상태 감지, `restartServers`를 통한 무중단 worker switch 및 롤백, 작업 중(`busy`) 시 보류 검증 PASS.

### 2) 기타 계약 테스트 회귀
- 실행 명령: `.venv/bin/python -m pytest -ra tests/test_runtime_contract.py tests/test_addon_contract.py tests/test_sensitive_path_policy.py`
- 결과: **51 passed in 0.70s (100% PASS)**

### 3) Node.js 구문 검사
- 실행 명령:
  `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs`
  `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`
  `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-server-transaction.mjs`
- 결과: **모두 문법 오류 없음 (PASS)**

## 4. 미검증 항목 및 주의사항 (NOT RUN)

- **Docker 빌드 및 이미지 생성:** 본 환경에서 직접 Docker image 빌드는 수행하지 않았다.
- **실제 HAOS / 모바일 Remote 실기기 검증:** 실제 기기에서의 모바일 Remote SSH 접속 및 장시간 연결 상태에서의 실서버 자동 업데이트 및 대화 이어가기 검증은 별도 승인 후 실기기 환경에서 수행되어야 한다.
- **외부 릴리스 및 Push:** 사용자 승인 없이 외부 git push, PR, release는 수행하지 않았다.

## 5. 변경 파일 목록

1. `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs` (신규)
2. `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`
3. `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-server-transaction.mjs`
4. `codex_home_assistant/rootfs/usr/local/bin/codex`
5. `tests/test_codex_update_contract.py`
6. `docs/development/rules.md`
7. `docs/development/product_spec.md`
8. `docs/development/architecture.md`
9. `docs/development/progress.md`
10. `codex_home_assistant/DOCS.md`
11. `codex_home_assistant/DOCS.en.md`
12. `.handoff/005_non-disruptive-runtime-auto-update/REPORT.md` (005 취소 종결)
13. `.handoff/006_idle-gated-runtime-server-update/REPORT.md` (본 보고서)
