# FIX_06_REPORT — dev.1 자체점검 후속: 관리 CLI 진단·런타임 버전·정상 종료 구현

## 1. 개요 및 판정

- **Executor**: Antigravity, 2026-10-26 (Asia/Seoul).
- **대상 과제**: `.handoff/004_runtime-update-process-classification/` 내 `FIX_06.md`.
- **기능 브랜치**: `fix/runtime-update-dev-0.7.2-2` (기준: `dev` @ `aa76fe8`).
- **후보 버전**: **`0.7.2-dev.2`** (기존 `0.7.2-dev.1` 태그/릴리스 보존, stable 0.7.1 불변 유지).
- **결과 요약**: **F1, F2, F3 요구사항 전원 구현 및 로컬 단위/계약 테스트 100% 통과 (244 passed, 1 skipped in 95s)**. 실제 HAOS 실장비 및 외부 Registry/Git 배포는 사용자 명시 승인 전까지 엄격히 NOT RUN으로 유지.

---

## 2. 항목별 구현 내역

### F1 — P1: 관리 CLI 민감 경로 검사 코드 분리 및 진단 안내 개선

1. **검증 함수 반환 코드 분리 (`sensitive-path-policy.sh`)**:
   - `0`: 검사 통과 (정상).
   - `1`: 안전하지 않은 파일 형태 감지 (symlink, pipe, socket, unreadable hardlink 등).
   - `64`: 사용법 오류 (인수 부족).
   - `73`: OS 검사 준비 실패 (`mktemp` 등 임시 파일 생성 불가).
   - `78`: 검사 대상 디렉터리 순회 불가 또는 권한 거부 (EACCES/EPERM/디렉터리 누락).
   - 기존에 `.storage` 내부 순회 실패 시 반환하던 코드 1을 접근 거부/순회 불가 코드인 78로 명확히 분리.
2. **호출부 진단 메시지 분리 (`codex` 및 `codex-ha-init`)**:
   - bash에서 `if ! cmd; then` 대신 `cmd || validate_code=$?` 패턴을 사용하여 반환 코드를 보존.
   - 코드 `1`: `"Config validation failed: unsafe link or special file detected"` 출력.
   - 코드 `78`: `"Config validation restricted: cannot traverse or stat /config (permission denied or restricted environment)"` 출력.
   - 코드 `73`: `"Config validation failed: unable to allocate temporary inspection state"` 출력.
   - 보안 불변조건에 따라 fail-closed 거부(exit 78)를 완화하지 않고 유지.
3. **독립 Web/SSH 셸 대 중첩 sandbox 실행 경계**:
   - 독립 Web 터미널 셸과 SSH 셸은 `/config`에 대한 직접 읽기/접근 권한이 유지되어 정상적으로 통과.
   - 중첩 Codex sandbox(`bubblewrap` 등으로 격리되어 `/config`가 마운트되지 않거나 차단된 환경)에서 내부 `codex` 래퍼를 호출할 경우, 더 이상 오도적인 "unsafe link" 메시지를 출력하지 않고 정확한 권한/순회 불가 원인(코드 78)을 stderr에 출력하고 fail-closed 종료.
4. **회귀 및 계약 테스트**:
   - `tests/test_sensitive_path_policy.py`: unreadable directory fixture 검증(`test_sensitive_path_policy_code_distinction_between_unsafe_shape_and_unverifiable`) 및 래퍼 에러 메시지 분리 검증(`test_codex_wrapper_distinguishes_unsafe_link_vs_restricted_access_messages`) 추가. 19 passed.

---

### F2 — P2: 피드백 리포트의 bundled / selected / observed running 버전 분리

1. **`ha-feedback.mjs` 환경 정보 확장**:
   - `readCodexBaselineVersion()`: `/usr/local/share/codex-ha/package.json` 매니페스트를 우선 읽어 정적 번들 버전(0.162.1)을 파악하고, 없을 때만 fallback으로 `codex-real --version` 실행.
   - `readCodexRuntimeVersions()`: `codex-runtime-manager.mjs`의 `getStatus()`를 3초 타임아웃과 함께 동적 로드하여 현재 `selectedVersion`과 `runningVersions` 배열을 로컬 read-only로 수집.
   - `normalizeEnvironment()`: `codex_selected_version`(문자열, 최대 32자, semver 형식) 및 `codex_running_versions`(문자열 배열, 최대 8개 항목, 중복제거 및 정렬) 스키마 확장.
   - 완전 유휴(runningProcesses 없음) 시 `none (completely idle)`, 모니터링 실패 시 `none (unobserved)`로 명확히 구분.
2. **렌더링 포맷 세분화 (`renderEnvironment`)**:
   - 확장 필드가 존재하는 경우:
     - `| Codex (bundled) | 0.162.1 |`
     - `| Codex (selected) | 0.164.0 |`
     - `| Codex (running) | 0.162.1, 0.164.0 |`
   - 확장 필드가 없는 경우(과거 레거시 스키마 1): 기존 단일 `| Codex | 0.162.1 |` 행 유지 (완벽한 하위 호환성).
3. **보안 및 프라이버시 유지**:
   - 프로세스 PID, 실행 인자(argv), 작업 디렉터리(cwd), status JSON 전체 및 토큰/비밀값은 절대 리포트에 노출하지 않음.
4. **회귀 및 계약 테스트**:
   - `tests/test_feedback_contract.py`: `test_feedback_environment_version_distinction` 추가 (레거시 단일 버전 렌더링, 확장 버전 렌더링, 다중 실행 버전 정렬, 유휴 및 미관측 구분, 유효하지 않은 버전 문자열 차단 검증). 12 passed.

---

### F3 — P2: Supervisor 정지 타임아웃 30초 명시 및 Graceful Shutdown 보장

1. **`codex_home_assistant/config.yaml` `timeout: 30` 설정**:
   - Home Assistant Supervisor의 App 정지 기본 타임아웃은 10초임.
   - 본 App은 S6 overlay 하위에 Ingress(ttyd), OpenSSH 서버, Playwright headless 브라우저, Codex 런타임 매니저, 백그라운드 업데이터 데몬 등 다중 서비스를 운영하므로 10초 내에 모든 소켓 정리, IPC 세션 정상 종료, PID 파일 정리 및 state lock 해제가 완료되지 못해 SIGKILL(exit 137)이 발생하는 위험이 있었음.
   - 공식 App 설정 사양에 따라 `timeout: 30`을 명시하여 Supervisor가 컨테이너 정지 시 최대 30초의 정상 종료 유예 시간을 제공하도록 설정.
2. **계약 테스트 및 문서화**:
   - `tests/test_addon_contract.py`: `test_addon_config_defines_explicit_stop_timeout` 추가 (30초 이상 및 정수형 검증). 19 passed.
   - `docs/development/addon_spec.md`: 정지 타임아웃 근거 및 다중 서비스 스택 정상 종료 요건 문서화.

---

### 3. 후보 버전 0.7.2-dev.2 동기화

수정 사항을 시험하기 위해 candidate 버전을 `0.7.2-dev.2`로 전체 파일에 걸쳐 일치시킴:
- `codex_home_assistant/config.yaml`: `version: "0.7.2-dev.2"`, `timeout: 30`
- `codex_home_assistant/Dockerfile`: `ARG BUILD_VERSION=0.7.2-dev.2`
- `codex_home_assistant/playwright/package.json` & `package-lock.json`: `"version": "0.7.2-dev.2"`
- `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`: `APP_VERSION = "0.7.2-dev.2"`
- `codex_home_assistant/CHANGELOG.md`: `## [0.7.2-dev.2]` 섹션 추가
- 문서 동기화: `README.md`, `README.en.md`, `codex_home_assistant/README.md`, `codex_home_assistant/README.en.md`, `codex_home_assistant/DOCS.md`, `codex_home_assistant/DOCS.en.md`

---

## 4. 검증 결과 및 증거

### A. 단위 및 계약 테스트 전체 (Pytest)

- 실행 명령: `.venv/bin/pytest tests/test_codex_update_contract.py -q`
  - 결과: **102 passed in 67.65s**
  - 수정 내역: `test_status_format_session_ready_and_auto_apply_ready_classification`에서 2026-10-18 날짜 의존성으로 인해 발생하던 쿨다운 비교 오동작을 mock clock 주입(`process.env.CODEX_TEST_CLOCK = '2026-10-17T12:00:00.000Z'`)으로 항구적 안정화.
- 실행 명령: `.venv/bin/pytest tests/test_*.py (기타 13개 파일) -v`
  - 결과: **142 passed, 1 skipped in 27.21s**
- **전체 합계: 244 passed, 1 skipped in 94.86s (실패 0건)**

### B. 정적 문법 및 코드 스타일 검증

- 실행 명령:
  ```bash
  node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs
  node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/ha-feedback.mjs
  bash -n codex_home_assistant/rootfs/usr/local/lib/codex-ha/sensitive-path-policy.sh
  bash -n codex_home_assistant/rootfs/usr/local/bin/codex
  bash -n codex_home_assistant/rootfs/usr/local/bin/codex-ha-init
  git diff --check
  ```
- 결과: **모두 에러 및 경고 0건으로 정상 종료 (exit code 0)**

---

## 5. 계획 대비 편차 (Deviations)

- **없음**: `FIX_06.md`에서 지시한 F1(오류 범주 코드 1/73/78 분리), F2(bundled/selected/running 버전 분리), F3(`timeout: 30` 명시) 및 버전 승격(`0.7.2-dev.2`) 요구사항을 정확히 준수함.

---

## 6. 미검증 범위 (NOT RUN) 및 잔존 리스크

1. **실제 HAOS 18.3 실기기 설치 및 Supervisor stop/restart 실측 (NOT RUN)**:
   - 로컬 단위/계약 테스트 및 설정 검증은 완료했으나, 실제 HAOS 상에서 Supervisor의 30초 유예 적용 및 실제 exit 0 확인은 실장비 환경에서 수행되어야 함.
2. **AppArmor enforced 커널 하에서의 중첩 bwrap sandbox 실측 (NOT RUN)**:
   - 호스트 환경의 unprivileged user namespace 제약으로 인해 중첩 bwrap의 실제 실행은 격리 VM 또는 실기기에서 검증 필요.
3. **ARM64 (aarch64) 물리 기기 실행 검증 (NOT RUN)**:
   - 본 검증은 x86_64 리눅스 환경에서 수행됨.
4. **원격 저장소 Push 및 Registry 게시 (NOT RUN)**:
   - `AGENTS.md` 절대 조건에 따라 사용자 명시 승인 없이 git push, PR 생성, GHCR 이미지 배포를 수행하지 않음.

---

## 7. 인계 상태

- 현재 Git 브랜치: `fix/runtime-update-dev-0.7.2-2`
- 현재 작업 트리: clean (untracked: `FIX_06.md`, `FIX_06_REPORT.md` 포함)
- 다음 단계: 사용자 및 Reviewer 검토 후, 실기기 시험 배포 진행 여부 결정.
