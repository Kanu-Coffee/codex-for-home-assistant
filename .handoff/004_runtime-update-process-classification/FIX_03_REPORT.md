# FIX_03_REPORT — 테스트 정리 대상 신원 확인·경로 경계 엄격화·cooldown JSON/text 정합성 일치

- Executor: Antigravity, 2026-10-17 (Asia/Seoul).
- 판정 대상: `.handoff/004_runtime-update-process-classification/FIX_03.md` (Reviewer: Codex).
- 기준 HEAD: `11b8839`, branch `main`. 미커밋 working tree 유지.
- 규칙 준수: 기존 PLAN, REPORT, FIX_01, FIX_01_REPORT, FIX_02, FIX_02_REPORT, FIX_03은 일체 수정하지 않고 온전히 보존했다. 외부 Git push/PR/release 및 실제 HAOS 운영 장치 조작은 수행하지 않았다.

---

## 1. F1 (P2) 조치 — fixture 정리 대상의 경로 세그먼트 경계 및 PID+start-time 신원 확인

### 문제 및 위치
- 위치: `tests/test_codex_update_contract.py`의 `_find_fixture_processes_for_dir`, `_terminate_fixture_processes`
- 문제:
  1. 단순 문자열 포함 판정(`fixture_str in cmdline/exe/cwd`)으로 인해 `/tmp/.../case-sibling` 등 형제 디렉터리에서 실행된 프로세스나, fixture 경로가 단순 데이터 인수로 포함된 무관 프로세스가 종료 대상으로 수집됨.
  2. PID가 start-time 신원 없이 관리되어, reap 후 동일 PID가 재사용(PID recycling)될 경우 다른 새 프로세스에 신호(SIGTERM/SIGKILL)를 보낼 위험이 존재함.

### 구현 내용
1. **정확한 경로 세그먼트 경계 검증 (`_is_path_inside`)**:
   - `p = Path(child_path_str).resolve()` 및 `parent = parent_dir.resolve()`에 대해 `p == parent or p.is_relative_to(parent)`로 판정.
   - `/tmp/.../case-sibling`은 `is_relative_to('/tmp/.../case')`가 `False`이므로 형제 디렉터리가 확실히 배제됨.
2. **실행 Entrypoint 식별 및 데이터 argv 배제 (`_is_proc_running_inside_fixture`)**:
   - `exe`: readlink 대상이 fixture 내부인지 검사.
   - `cmdline`: `argv[0]`(실행 바이너리)이 fixture 내부이거나, `node`/`python`/`bash`/`sh`/`perl` 인터프리터의 첫 번째 비옵션 스크립트 인수가 fixture 내부인지 검사.
   - 단순 데이터 인수로 fixture 경로가 넘겨진 프로세스는 매칭 대상에서 엄격히 제외.
   - `cwd`: `cwd`가 fixture 내부인 경우에도 fixture 관련 실행 바이너리/스크립트인지 교차 검증.
3. **PID + start-time 신원 추적 (`(pid, start_time)`)**:
   - `/proc/<pid>/stat`의 필드 20(`starttime`, clock ticks)을 조회하는 `_get_proc_start_time(pid)` 구현.
   - 프로세스 신원을 `(pid, start_time)` 튜플로 기록.
   - `_verify_process_identity(pid, expected_start, fixture_dir)` 구현:
     - 현재 `/proc/<pid>/stat`의 start-time이 기록된 `expected_start`와 일치하는지 확인.
     - `fixture_dir`에 여전히 속해있는지 확인.
     - 프로세스가 이미 종료되었거나 동일 PID로 다른 프로세스가 생성된 경우 `False` 반환.
4. **신호 전송 전 신원 재확인 및 안전한 종료 (`_terminate_fixture_processes`)**:
   - SIGTERM 전송 직전: `_verify_process_identity`를 통과한 경우에만 `os.kill(pid, 15)` 전송, 불일치 시 대기 목록에서 즉시 제거.
   - Bounded wait 대기 루프: `_verify_process_identity`가 `False`가 되면(프로세스 종료 확인) 대기 목록에서 제거.
   - SIGKILL escalation 직전: 여전히 살아있고 신원이 일치하는 경우에만 `os.kill(pid, 9)` 전송.
5. **회귀 테스트 추가**:
   - `test_find_fixture_processes_excludes_sibling_dirs_and_data_argv`:
     - `case-sibling` cwd 프로세스 배제 확인.
     - fixture 경로를 데이터 인수로만 넘긴 프로세스 배제 확인.
     - 실제 fixture 내부 스크립트 프로세스만 정확히 수집됨을 확인.
   - `test_terminate_fixture_processes_skips_recycled_pid_with_mismatched_start_time`:
     - PID는 동일하지만 `start_time`이 불일치하는 모의 재사용 PID 신원을 넘겼을 때, 신호를 보내지 않고 프로세스가 안전하게 생존함을 확인.
   - `test_companion_server_real_replacement_preserves_old_generation_while_helper_lives` 및 `test_companion_server_setup_failure_teardown_leaves_zero_processes`에 신원 기반 teardown을 적용하고 사후 잔류 프로세스 0개 확인.

---

## 2. F2 (P2) 조치 — 완전 유휴 상태 cooldown 처리의 JSON/text 정합성 일치

### 문제 및 위치
- 위치: `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`의 `getStatus()` (line 2396) 및 `formatAutoApplyReady()` (line 2421)
- 문제:
  1. JSON `autoApplyReady`는 `sessions.isIdle === true`(실행 중인 프로세스 0개)이면 restart cooldown을 대기 사유로 보지 않는데, `formatAutoApplyReady`는 `isIdle` 검사 없이 미래의 `nextRestartAllowedAt`이 있으면 무조건 `waiting (restart cooldown active ...)`을 반환하여 JSON(true)과 text(waiting)가 모순됨.
  2. `readOptions`가 옵션 파싱 실패 시 `autoUpdate: false, valid: false`를 반환할 때, `formatAutoApplyReady`에서 `!status.autoUpdate`를 먼저 검사하면 옵션 구성 오류(`blocked`)가 정상 비활성화(`disabled`)로 오인되어 출력될 수 있음.
  3. readiness 판정과 apply 판정 간 시간 함수 기준 일치 필요(`getNow().getTime()`).

### 구현 내용
1. **옵션 유효성 검사 최우선 배치**:
   ```javascript
   if (!status.optionsValid) {
     return "blocked (configuration options invalid)";
   }
   if (!status.autoUpdate) {
     return "disabled (auto-update disabled; manual apply only)";
   }
   ```
2. **시간 기준 통일 (`getNow().getTime()`)**:
   - `Date.now()` 대신 테스트 클록을 존중하는 `getNow().getTime()`을 `getStatus()` 및 `formatAutoApplyReady()` 양쪽에 동일하게 적용.
3. **완전 유휴 상태(`isIdle === true`) cooldown 대기 사유 해제**:
   - restart cooldown은 실행 중인 관리형 서버가 남아 graceful restart 전환이 필요한 경우(`!status.isIdle`)에만 적용되는 제약임.
   - `cooldownActive`:
     ```javascript
     const nowMs = getNow().getTime();
     const cooldownActive = Boolean(
       !status.isIdle &&
       (status.reason === "restart_cooldown" || (status.nextRestartAllowedAt && new Date(status.nextRestartAllowedAt).getTime() > nowMs))
     );
     ```
   - `status.isIdle === true`인 완전 유휴 상태에서는 미래의 `nextRestartAllowedAt`이 있더라도 `cooldownActive`가 `false`가 되어:
     - JSON: `autoApplyReady: true`
     - Text: `yes (ready for next automatic apply check)`
     - **JSON과 text가 완벽히 일치**.
   - `status.isIdle === false`인 경우(idle managed server 존재):
     - JSON: `autoApplyReady: false`
     - Text: `waiting (restart cooldown active until ...; manual apply also respects cooldown)`
     - **JSON과 text가 완벽히 일치**.
4. **회귀 테스트 갱신 (`test_status_format_session_ready_and_auto_apply_ready_classification`)**:
   - Case 2-A: 완전 유휴(`isIdle: true`) + 미래 cooldown -> JSON `autoApplyReady: true`, text `yes (ready for next automatic apply check)` 일치 검증.
   - Case 2-B: 관리형 서버 실행 중(`isIdle: false`) + 미래 cooldown -> JSON `autoApplyReady: false`, text `waiting (restart cooldown...)` 일치 검증.
   - Case 3-A: options 파일 파싱 오류 -> `blocked (configuration options invalid)` 검증.
   - Case 3-B: options에서 명시적 `auto_update: false` -> `disabled (auto-update disabled; manual apply only)` 검증.

---

## 3. 검증 결과 (단일 기준 실행)

현재 working tree 소스 기준 단일 실행 결과:

| 검증 명령 | 대상 및 내용 | 결과 |
| --- | --- | --- |
| `.venv/bin/pytest tests/test_codex_update_contract.py -k "companion_server or fixture_processes" -vv --basetemp=/tmp/pytest-fix03-test1` | 고유 basetemp 단독 실행 (신규 격리 검증 2건 포함) | **4 passed in 4.70s** (사후 잔류 프로세스 0 확인) |
| `.venv/bin/pytest tests/test_codex_update_contract.py -k "test_status_" -vv --basetemp=/tmp/pytest-fix03-test2` | status 포맷 및 정합성 검증 (F2 갱신) | **4 passed in 1.67s** |
| `.venv/bin/pytest -q tests/test_codex_update_contract.py` | 계약 테스트 파일 전체 (기존 99 + 신규 2) | **101 passed in 70.15s** |
| `.venv/bin/pytest -q tests/test_codex_update_contract.py tests/test_runtime_contract.py` | Update 및 Runtime 계약 pair 전체 | **113 passed in 73.12s** |
| `.venv/bin/pytest -q` | 저장소 전체 pytest suite | **239 passed, 1 skipped in 78.56s** (기존 환경 skip) |
| `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs` | Runtime Manager 문법 검사 | **PASS (exit 0)** |
| `shellcheck -x codex_home_assistant/rootfs/usr/local/bin/codex` | Wrapper 셸 스크립트 정적 분석 | **PASS (exit 0)** |
| `git diff --check` | 공백·EOF 줄바꿈 점검 | **CLEAN (exit 0)** |

---

## 4. 검증 미수행 항목 (NOT RUN)

- 호스트의 `apparmor_parser` 부재로 인한 AppArmor profile 하 `tests/codex-update-smoke.sh` 및 boot smoke: **NOT RUN**.
- 실제 사용자 HAOS 환경에서의 장기 세션, 외부 Remote SSH, 자동 업데이트 수용: **NOT RUN**.
- aarch64 native 실행: **NOT RUN**.
- 버전 상승 및 배포(Builder, GHCR, release tag, CHANGELOG unreleased 기재): **NOT RUN** (작업 범위 밖).
- Git commit / push / PR: **NOT RUN** (사용자 명시적 승인 대기).

---

## 5. 다음 단계 제안 (Reviewer)

- FIX_03에서 지적된 F1(정확한 경로 세그먼트 경계 확인, 데이터 argv 배제, PID+start-time 신원 검증, PID 재사용 오신호 차단)과 F2(완전 유휴 시 cooldown 대기 해제, JSON/text 일치, optionsValid 최우선 순위, getNow 기준 통일)가 모두 반영되었고 전수 검증을 통과했습니다.
- Reviewer의 최종 검토 및 인수 승인을 요청합니다.
