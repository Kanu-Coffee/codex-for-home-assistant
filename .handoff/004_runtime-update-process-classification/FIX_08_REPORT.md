# FIX_08_REPORT — 버전 관측 누락·피드백 읽기 전용 경계·실제 수집 회귀 보완 보고서

## 1. 개요 및 판정

- **역할**: Executor (Antigravity), 2026-10-26 (Asia/Seoul).
- **대상 과제**: `.handoff/004_runtime-update-process-classification/FIX_08.md` (Reviewer: Codex, 2026-10-26).
- **브랜치/작업 상태**: `fix/runtime-update-dev-0.7.2-2`, base commit `aa76fe8`.
- **작업 트리 상태**: 미커밋 작업 트리 유지 (사용자 명시적 요청 없이 commit/push/PR/release를 수행하지 않는 절대 원칙 준수).
- **판정 요약**: Reviewer Codex가 `FIX_08.md`에서 요구한 P2 4개 항목(F1, F2, F3, F4)의 구현, 단위 및 실측 검증, 수용 행렬의 정직한 분리(PASS vs NOT RUN)를 모두 완료했다.

---

## 2. 변경 내용 및 구현 상세

### F1 (P2): getStatus 정직한 버전 관측 및 host unit test fallback 제거

1. **Host unit test fallback 제거**:
   - `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`의 `getStatus()`에서 baseline 디렉터리가 없는데 `bundledVersion`으로 `selectedVersion`을 확정하던 host unit test fallback 분기(`else if (!existsSync(getBaselineDir()) && state.selectedVersion === bundledVersion)`)를 완전히 제거했다.
   - `loadState()`에서 `state.json`이 FIFO/비정규 파일이거나 파싱 실패 시, 가짜 `bundledVersion`으로 채우지 않고 `selectedVersion: null`을 반환하도록 수정했다.
   - `getStatus()`에서 `current` symlink 및 `codex-package.json` 매니페스트와 `state.selectedVersion`을 상호 교차 검증하여, 메타데이터 읽기 실패 또는 symlink/state 불일치 시 `selectedVersion: null`로 정직하게 보고한다.
2. **미식별(unknown) 프로세스 및 검사 불능 격리**:
   - `sessionInspectionIncomplete` 조건에 `sessions.counts.unknown > 0` 및 blockers에 `unknown` 또는 `inspection_failed`가 포함된 경우를 명시적으로 추가했다.
   - 미식별 홀더가 존재하고 확인된 주 프로세스(primary)가 없는 경우, 실행 버전을 `none`이나 `[]`로 허위 단정하지 않고 `runningVersions: null`, `runningVersion: "unobserved"`로 정직하게 보고한다.
   - 확인된 주 버전이 일부 존재하는 상태에서 미식별 홀더가 섞여 있는 경우 `runningVersion: "<버전> (partial)"`로 한계를 명시한다.
3. **단위 테스트 픽스처 보완**:
   - `tests/test_codex_update_contract.py`의 `test_status_output_scrubs_secrets_and_reports_honest_versions`에서 가짜 fallback에 의존하지 않고, 실제 `codex-package.json` 매니페스트(version, target, entrypoint)를 갖춘 완전한 baseline 픽스처를 생성하여 정상 선택 상태를 정직하게 검증하도록 보강했다.

### F2 (P2): getStatus 순수 snapshot 보장 및 버전 수집 자식 credential 격리

1. **getStatus 순수 read-only snapshot 모드**:
   - `codex-runtime-manager.mjs`의 `inspectAllSessions(options = {})`에 `readOnly: Boolean(options.readOnly)` 옵션을 추가했다.
   - `readOnly: true`인 경우, PID가 종료된 세션 파일이라도 삭제(`unlink`)하지 않고 순수하게 관측만 수행하도록 분기했다.
   - `getStatus()`는 항상 `inspectAllSessions({ readOnly: true })`를 호출하여 피드백 수집 및 상태 조회 시 영속 세션 레코드를 일체 훼손하지 않음을 보장했다.
2. **버전 수집 자식 프로세스 환경 변수 최소 allowlist**:
   - `codex_home_assistant/rootfs/usr/local/share/codex-ha/ha-feedback.mjs`의 `readCodexRuntimeVersions`에서 자식 프로세스(`node`) 실행 시 `env: { ...process.env }` 전량 상속을 폐기했다.
   - 필수 실행 변수(`PATH`, `LANG`, `HOME`, `CODEX_HOME`)와 명시적 테스트 디렉터리 경로만 전달하는 엄격한 allowlist `childEnv`를 구성했다.
   - 부모 프로세스가 보유한 `SUPERVISOR_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` 및 셸/Node injection 변수는 자식 프로세스로 절대 상속되지 않는다. 부모의 고정 Supervisor 읽기 API 동작은 기존대로 보존된다.

### F3 (P2): 실제 manager FIFO 조기 거부·3초 hard timeout·0 zombie 회귀 검증

1. **실제 sibling manager 도달 지원**:
   - `ha-feedback.mjs`의 `readCodexRuntimeVersions`에서 `process.env.CODEX_RUNTIME_MANAGER_PATH`를 지원하도록 개선했다. 이를 통해 임시 디렉터리에 복사된 테스트 픽스처에서도 실제 형제 런타임 매니저 모듈을 온전히 import하여 검증할 수 있게 되었다.
2. **다각도 독립 회귀 테스트 구현 (`tests/test_feedback_contract.py`)**:
   - `test_feedback_runtime_versions_collection_and_fifo_hang_prevention`:
     1. **실제 매니저 정상 연동**: 실제 manager 모듈을 로드하여 정상 유휴 상태(`bundled: 0.162.1`, `selected: 0.162.1`, `running: []`) 정확히 확인.
     2. **Stale 세션 파일 보존**: dead PID 세션 파일(`maint/sessions/99999999`)이 `getStatus()` 호출 후에도 디스크에 온전히 보존됨을 확인.
     3. **Credential 상속 차단**: 부모 환경의 합성 `SUPERVISOR_TOKEN`이 자식 프로세스로 전달되지 않음을 확인.
     4. **FIFO state.json 조기 비차단 거부**: FIFO `state.json` 주입 시 `lstat` 비정규 파일 감지로 즉시 예외를 발생시켜, 4초 이내(실제 ~0.6초)에 종료되고 selected가 unverified(`null`)로 처리됨을 확인.
     5. **느린 I/O 3초 하드 타임아웃 및 0 zombie**: 10초 지연 매니저 주입 시 3000ms 하드 타임아웃(`killSignal: "SIGKILL"`)으로 자식이 강제 종료되고, 약 3.2초 만에 부모가 fallback 값(`selected: null`, `running: null`)을 반환하며 잔류 zombie 프로세스가 0개임을 확인.
     6. **Current 링크 누락 시 정직한 렌더링**: selected가 `null`일 때 리포트에 `| Codex (selected) | unverified / 미검증 |`으로 정직하게 렌더링됨을 확인.
     7. **Unknown holder 존재 시 정직한 렌더링**: running이 `null`일 때 리포트에 `| Codex (running) | unobserved / 관측 불가`로 정직하게 렌더링됨을 확인.

### F4 (P2): 수용 행렬 정정 및 서비스별 teardown 실측 근거 확보

1. **`docs/development/test_plan.md` §6 수용 행렬 정정**:
   - §6.1 실행 경계: Web 터미널(`ttyd`) 및 SSH 세션을 **PASS (단위 계약 검증) / NOT RUN (실기기 ttyd/sshd 라이브 세션)**으로 정정. `bwrap` 도구 샌드박스를 **PASS (bwrap 음성 대조) / NOT RUN (Codex managed sandbox)**으로 정정.
   - §6.2 피드백 버전 관측: 실제 manager 연동 결과와 honest reporting 규칙(FIFO 조기 거부, 3초 timeout SIGKILL, stale 세션 보존, credential 격리)을 정확히 반영.
   - §6.3 컨테이너 정지: 실기기 HAOS 수용 항목을 **NOT RUN (실기기 HAOS 검증 대기)**으로 정직하게 분리.
2. **서비스별 종료 시간 및 `timeout: 30` 설정 근거 실측**:
   - `ha-memoryd`: SIGTERM 수신 시 trap을 통해 **1.17 ms** 만에 exit 0으로 즉시 종료됨을 실측 확인.
   - `codex-updater-daemon.mjs` (유휴 상태): 슬롯 대기 중 SIGTERM 수신 시 `wakeSleep()` 인터럽트를 통해 **7.42 ms** 만에 exit 0으로 즉시 종료됨을 실측 확인.
   - `codex-updater-daemon.mjs` (네트워크 요청 중): 슬롯 체크 시 GitHub 릴리스 API를 호출하는 `fetchJson`의 소켓 타임아웃이 30,000ms(30초)로 설정되어 있음. 네트워크 지연/정체 상태에서 종료 신호가 도착할 경우, Supervisor의 기본 정지 유예 시간(10초) 내에 완료되지 못하고 SIGKILL로 강제 중단될 위험이 실측됨. 따라서 `config.yaml`에 `timeout: 30`을 명시하여 Supervisor가 최대 30초의 정상 종료 시간을 보장하도록 한 설정의 기술적 근거가 유효함을 확인.

---

## 3. 검증 결과 및 실행 증거

### 3.1 계약 및 단위 테스트

- **피드백 계약 테스트**:
  ```
  .venv/bin/pytest tests/test_feedback_contract.py -v
  ============================== 13 passed in 8.02s ==============================
  ```
- **민감 경로·피드백·애드온 통합 계약 테스트**:
  ```
  .venv/bin/pytest tests/test_sensitive_path_policy.py tests/test_feedback_contract.py tests/test_addon_contract.py -v
  ============================== 51 passed in 8.50s ==============================
  ```
- **런타임 업데이트 계약 테스트**:
  ```
  .venv/bin/pytest tests/test_codex_update_contract.py -q
  102 passed in 67.58s (0:01:07)
  ```

### 3.2 정적 검사 및 린트

- **Node 구문 검사**:
  ```bash
  node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs
  node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/ha-feedback.mjs
  # 결과: 오류 없음 (exit 0)
  ```
- **Git diff 공백 검사**:
  ```bash
  git diff --check
  # 결과: 공백 오류 없음 (exit 0)
  ```

### 3.3 서비스 종료 시간 실측

- `ha-memoryd` SIGTERM 정상 종료: **1.17 ms** (returncode 0)
- `codex-updater-daemon.mjs` 유휴 SIGTERM 정상 종료: **7.42 ms** (returncode 0)
- `fetchJson` 소켓 타임아웃 상한: **30,000 ms** (`config.yaml: timeout: 30` 근거 확보)

---

## 4. 명시적 미검증 (NOT RUN) 항목

1. **실제 HAOS 18.3 Supervisor stop/restart 실측**: dev.2 릴리스 후 실제 HAOS 시험/운영 장비에서 exit 0 및 시간 확인 대기.
2. **실기기 Web 터미널 (`ttyd`) 및 SSH 라이브 세션**: dev.2 배포 후 실제 브라우저 터미널 및 SSH 세션 동작 확인 대기.
3. **ARM64 물리 기기 실행**: aarch64 하드웨어 환경에서의 네이티브 실행 검증 대기.
4. **원격 Git commit/push/PR/release**: 사용자 승인 전까지 로컬 작업 트리에만 유지.

---

## 5. 결론 및 다음 단계

`FIX_08.md`의 모든 요구사항(F1: 정직한 버전 관측, F2: read-only 세션 검사 및 credential 격리, F3: 실제 매니저 기반 FIFO/타임아웃 회귀 검증, F4: 수용 행렬 정정 및 실측 근거 확보)을 완전히 충족했다.
Reviewer(Codex)의 재검토 및 최종 인수를 요청한다.
