# FIX_07_REPORT — 실제 버전 관측·수집 종료 보장·진단 및 종료 검증 보완

## 1. 개요 및 판정

- **Executor**: Antigravity, 2026-10-26 (Asia/Seoul).
- **대상 과제**: `.handoff/004_runtime-update-process-classification/FIX_07.md`.
- **기능 브랜치**: `fix/runtime-update-dev-0.7.2-2` (기준: `dev` @ `aa76fe8`).
- **후보 버전**: **`0.7.2-dev.2`** (기존 `0.7.2-dev.1` 태그/릴리스 보존, stable 0.7.1 불변 유지).
- **결과 요약**: **F1, F2, F3, F4 요구사항 4개 전원 구현 완료 및 전체 단위/계약 테스트 100% 통과 (245 passed, 1 skipped in 78.95s), ShellCheck exit 0 통과**. 실제 Supervisor stop/restart 현장 검증 및 실장비 배포는 사용자 명시 승인 전까지 엄격히 NOT RUN으로 유지.

---

## 2. 항목별 구현 및 정정 내역

### F1 — P2: 피드백 수집 종료 보장 및 관측 신뢰성 확보

1. **파일 읽기 차단 방지 (`lstat` 사전 검증)**:
   - `codex-runtime-manager.mjs`: `loadState()`, `readOptions()`에서 `readFile` 호출 전 `lstat`으로 파일 타입을 확인하여 FIFO, 소켓, 특수 파일 또는 1MB 초과 비정상 크기 파일일 경우 블로킹 없이 즉시 fail-closed 에러/기본값을 반환하도록 수정했습니다.
2. **세션 관측 정직성 확보**:
   - `codex-runtime-manager.mjs:getStatus()`: `/proc` readdir에 실패(EACCES 등)하거나 `inspectAllSessions()`가 inspection incomplete(`sessionCount === -1` 또는 `inspection_failed` 블로커) 상태인 경우, `runningVersions`를 빈 배열(`[]`)이 아닌 `null`로, `runningVersion`을 `"none"`이 아닌 `"unobserved"`로 반환하도록 수정했습니다. 정상 관측된 유휴(idle)와 관측 불가를 명확히 구분합니다.
3. **선택 버전 교차 검증**:
   - `codex-runtime-manager.mjs:getStatus()`: `state.selectedVersion`만 맹신하지 않고 실제 `current` symlink의 격리 유효성(`validateSymlinkContainment`) 및 대상 디렉터리의 `codex-package.json` 메타데이터와 대조합니다. `current` 링크가 누락되었거나 대상 메타데이터 버전과 일치하지 않는 경우 `selectedVersion: null`(unverified)로 처리하여 허위 버전 보고를 차단합니다.
4. **수집 프로세스 bounded 종료 보장**:
   - `ha-feedback.mjs`: `readCodexRuntimeVersions`에서 `spawnSync` 기반의 독립 자식 프로세스를 통해 런타임 상태를 수집하며, `timeout: 3000` 및 `killSignal: "SIGKILL"`을 지정했습니다. FIFO 등 어떠한 비정상 I/O 정체가 발생하더라도 3초 경과 시 OS 커널에 의해 자식 프로세스가 즉시 강제 회수되고 부모 프로세스는 3.5초 이내에 잔류 자식 0 상태로 안전하게 복귀합니다.
5. **리포트 렌더링 구분**:
   - `codex_selected_version === null`: `| Codex (selected) | unverified / 미검증 |`
   - `codex_running_versions === null`: `| Codex (running) | unobserved / 관측 불가 |`
   - `codex_running_versions: []`: `| Codex (running) | none / 실행 중 없음 |`
   - 기존 레거시 schema 1 리포트의 단일 `Codex` 행 호환성을 온전히 유지합니다.
6. **테스트 추가 및 검증**:
   - `tests/test_feedback_contract.py`: `test_feedback_runtime_versions_collection_and_fifo_hang_prevention` 추가 (FIFO state.json 주입 시 4초 이내 bounded 복귀, 누락된 current 링크 unverified 처리 등 회귀 검증). 13 passed.

---

### F2 — P2: Root symlink 분류 정정 및 실제 Caller 검증

1. **Root symlink 1 분류 (`sensitive-path-policy.sh`)**:
   - `config_root` 검사 시 `[[ -L "${config_root}" || -f "${config_root}" || -p "${config_root}" || -S "${config_root}" || -b "${config_root}" || -c "${config_root}" ]]`를 선행 검사하여, root 경로 자체가 symlink이거나 비정상 파일 형태인 경우 명확히 `1` (unsafe shape)을 반환하도록 정정했습니다.
   - root가 missing이거나, 절대 경로가 아니거나, 디렉터리 순회 권한이 없는 경우에만 `78` (traversal restricted / inspection incomplete)을 반환합니다.
2. **공용 강제 함수 `codex_ha_sensitive_paths_enforce` 도입**:
   - `sensitive-path-policy.sh`에 `codex_ha_sensitive_paths_enforce <path> <caller>`를 정의하고, `codex` 래퍼와 `codex-ha-init`이 각각 이를 호출하도록 통일했습니다. 테스트와 프로덕션 간의 코드 복제를 원천 방지했습니다.
3. **실제 Caller 검증 (`tests/test_sensitive_path_policy.py`)**:
   - `bwrap` 컨테이너 하네스를 사용하여 호스트의 실제 `/config`를 건드리지 않고 격리된 rootfs 환경에서 프로덕션 `/usr/local/bin/codex --version` 바이너리를 직접 실행했습니다:
     - `/config`가 symlink인 경우: exit 78, stderr에 `codex: protected Home Assistant paths have an unsafe link or file type` 출력 확인, `codex-real` 미실행 확인.
     - `/config/secrets.yaml`이 symlink인 경우: exit 78, unsafe 메시지 출력 및 비밀값 미노출 확인.
     - `/config` 내 하위 디렉터리가 chmod 000인 경우: exit 78, `cannot verify protected Home Assistant path integrity (access or traversal restricted)` 출력 확인.
     - `mktemp` 실패 시: exit 78, `failed to prepare temporary storage` 출력 확인.
   - `codex-ha-init` 호출 시 exit 1 및 일치하는 `bashio::log.fatal` 로그 출력을 검증했습니다. 19 passed.

---

### F3 — P2: 변경 셸 코드 ShellCheck 통과

1. **SC2094 루프 내 파일 제거 경고 해소**:
   - `sensitive-path-policy.sh`에서 `while IFS= read ...; done < "${listing}"` 루프 내부에서 `rm -f -- "${listing}"`을 호출하던 중복 코드를 제거하고, 루프 종료 후 `"${listing}"`을 일괄 정리하도록 재구조화했습니다.
2. **ShellCheck 검증 실행**:
   - 명령:
     ```sh
     docker run --rm -v "$PWD:$PWD" -w "$PWD" koalaman/shellcheck:latest -x \
       codex_home_assistant/rootfs/usr/local/bin/codex \
       codex_home_assistant/rootfs/usr/local/bin/codex-ha-init \
       codex_home_assistant/rootfs/usr/local/lib/codex-ha/sensitive-path-policy.sh
     ```
   - 결과: **Exit code 0 (경고 및 오류 0건 통과)**.

---

### F4 — P2: 문서 보장 표현 정정 및 수용 행렬 명시

1. **문서 단정적 표현 정정**:
   - `CHANGELOG.md`, `addon_spec.md`에서 "SIGKILL 방지 보장", "독립 Web/SSH 정상 동작 보장" 등 현장 실측 전 단정적 표현을 후보 설정 및 관측 증거 수준으로 바로잡았습니다.
   - `timeout: 30`은 다중 서비스 스택 정상 종료를 위한 Supervisor 유예 시간 요청 후보이며, 실제 Supervisor exit 0 및 종료 시간은 dev.2 배포 후 실장비 현장 시험에서 최종 수용함을 명시했습니다.
2. **`test_plan.md` 수용 행렬 추가 (§6)**:
   - 실행 경계별 수용 판정 행렬: 독립 Web/SSH 셸 정상 통과, 도구 sandbox(`workspace-write` bwrap) deny-read에 의한 명시적 fail-closed(코드 78) 불변조건 명시.
   - 피드백 버전 관측 수용 행렬: Idle, 다중 버전 실행, 관측 불가(EACCES), 링크 누락/불일치(unverified), FIFO 정체 시 bounded 복귀 명시.
   - 정지/재시작 수용 경계: 설정 계약 PASS, 스크립트 계약 PASS, 실기기 HAOS 일반 stop/restart는 **NOT RUN**으로 분리 관리.

---

## 3. 검증 결과 및 증거

### A. 단위 및 계약 테스트 전체 (Pytest)

- 실행 명령: `.venv/bin/pytest tests/test_*.py -q`
- 결과: **245 passed, 1 skipped in 78.95s (실패 0건)**
  - `test_sensitive_path_policy.py`: 19 passed
  - `test_feedback_contract.py`: 13 passed
  - `test_addon_contract.py`: 19 passed
  - `test_codex_update_contract.py`: 102 passed
  - 기타 10개 테스트: 92 passed, 1 skipped

### B. 정적 분석 및 문법 검증

- `shellcheck -x`: **exit code 0** (3개 스크립트 모두 클린)
- `node --check codex-runtime-manager.mjs` & `ha-feedback.mjs`: **exit code 0**
- `bash -n`: **exit code 0**
- `git diff --check`: **0 warnings (클린)**

---

## 4. 계획 대비 편차 (Deviations)

- **없음**: `FIX_07.md`의 F1~F4 지침을 모두 누락 없이 충실히 이행했습니다.

---

## 5. 미검증 범위 (NOT RUN) 및 잔존 리스크

1. **실제 HAOS 18.3 Supervisor 일반 stop/restart 실측 (NOT RUN)**:
   - dev.2 이미지 배포 후 실제 HAOS 상에서 Supervisor의 30초 유예 적용 및 실제 exit 0 확인은 실장비 환경에서 수행되어야 합니다.
2. **ARM64 (aarch64) 실기기 실행 검증 (NOT RUN)**:
   - 본 검증은 x86_64 리눅스 환경에서 수행되었습니다.
3. **Memory warning 9개 및 PATH alias EROFS 관측**:
   - 단순 warning 0 만들기가 아닌 원인별 영향 분류 및 enrichment 정상 동작 여부 관측 과제로 유지됩니다.
4. **원격 저장소 Push 및 Registry 게시 (NOT RUN)**:
   - `AGENTS.md` 절대 원칙에 따라 사용자 명시 승인 없이 git push, PR 생성, GHCR 이미지 배포를 수행하지 않았습니다.

---

## 6. 인계 상태

- 현재 Git 브랜치: `fix/runtime-update-dev-0.7.2-2`
- 현재 작업 트리: clean (untracked: `FIX_06.md`, `FIX_06_REPORT.md`, `FIX_07.md`, `FIX_07_REPORT.md` 포함)
- 다음 단계: 사용자 및 Reviewer 검토 후, dev.2 배포 및 실기기 시험 진입 여부 결정.
