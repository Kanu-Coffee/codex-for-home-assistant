# FIX_02_REPORT — 교체 테스트 정리·검증 기록 정정·상태 표시 분리

- Executor: Antigravity, 2026-10-17 (Asia/Seoul).
- 판정 대상: `.handoff/004_runtime-update-process-classification/FIX_02.md` (Reviewer: Codex).
- 기준 HEAD: `11b8839`, branch `main`. 미커밋 working tree 유지.
- 규칙 준수: 기존 PLAN, REPORT, FIX_01, FIX_01_REPORT, FIX_02는 일체 수정하지 않고 온전히 보존했다. 외부 Git push/PR/release 및 실제 HAOS 운영 장치 조작은 수행하지 않았다.

---

## 1. F1 (P2) 조치 — replacement 테스트의 fixture 프로세스 완전 회수

### 문제 및 수정 위치
- 위치: `tests/test_codex_update_contract.py`의 `test_companion_server_real_replacement_preserves_old_generation_while_helper_lives`
- 문제: `applyUpdate` 트랜잭션이 detached로 spawn한 새 server(`afterRestartable`)가 teardown 대상에서 누락되어 pytest 종료 후에도 살아남았음. 또한 setup 도중 실패 시 프로세스가 누수될 가능성이 있었음.

### 구현 내용
1. **Fixture 전용 프로세스 추적 및 회수 유틸리티 추가**:
   - `_find_fixture_processes_for_dir(fixture_dir)`: `/proc`를 탐색하여 해당 `fixture_dir`의 절대 경로를 cmdline, exe(readlink), 또는 cwd(readlink)에 포함하는 live 프로세스를 특정(전역 문자열 kill 금지, 테스트 고유 임시 디렉터리 범위에 한정).
   - `_terminate_fixture_processes(tracked_pids, fixture_dir, direct_children, timeout=5.0)`:
     - 직접 child (`proc` Popen 객체)의 stdout 파이프를 닫고 `terminate()` 및 `wait(timeout=2.0)`으로 reap.
     - `tracked_pids` 및 `fixture_dir`를 참조하는 모든 detached 프로세스에 SIGTERM(15) 전송 후 bounded wait(최대 5초, 0.05초 간격 폴링).
     - 기한 내 미종료 시 SIGKILL(9) 후 대기.
2. **Setup~Teardown 전 구간 보호**:
   - `proc = subprocess.Popen(...)` 직후 즉시 `try` 블록에 진입하여 `tracked_pids`에 등록.
   - `proc.stdout.readline()`, companion PID 파일 대기 및 읽기 등 setup 전 과정이 `try` 블록 내에서 보호됨.
   - `applyUpdate()` 완료 후 `res["afterRestartable"]`에 포함된 새 replacement server PID를 즉시 `tracked_pids`에 추가.
   - `finally` 블록에서 maintenance sessions 디렉터리의 모든 세션 파일 PID와 `fixture_dir` 참조 프로세스를 종합하여 완전 종료 및 reap 수행.
   - 테스트 마지막 단계에서 `_find_fixture_processes_for_dir(tmp_path)`가 빈 리스트임을 assertion으로 검증.
3. **Setup/Assertion 실패 경로의 정리 검증 추가**:
   - `test_companion_server_setup_failure_teardown_leaves_zero_processes`: setup 도중(프로세스 기동 후) 의도적인 assertion 에러 발생 시에도 teardown이 정상 작동하여 잔류 프로세스가 0개임을 검증하는 테스트 추가.

### 단독 재현 및 검증 결과
- 고유 임시 디렉터리를 basetemp로 지정하여 단독 실행:
  ```bash
  .venv/bin/pytest tests/test_codex_update_contract.py -k "test_companion_server" -vv --basetemp=/tmp/pytest-fix02-test1
  ```
  결과: **2 passed in 4.52s**
- 실행 직후 잔류 프로세스 검사:
  ```bash
  ps aux | grep "/tmp/pytest-fix02-test1" | grep -v grep
  ```
  결과: **출력 없음 (surviving fixture process: 0)**

---

## 2. F2 (P2) 조치 — 검증 범위 및 policyProbe stub 사용 정정

### FIX_01_REPORT 검증 주장 정정
- 기존 `FIX_01_REPORT.md`는 이력으로 그대로 보존하며, 본 보고서에서 다음을 명시적으로 정정한다:
  1. `test_companion_server_real_replacement_preserves_old_generation_while_helper_lives`의 `applyUpdate()` 호출 시 사용된 `policyProbe`는 **성공 stub**(`{ policyProbe: async () => ({ valid: true }) }`)이다.
  2. 따라서 이 테스트는 실제 Node subprocess 간의 signal(SIGHUP) 전송, Unix socket 바인딩 전환, session record 갱신, old generation 디렉터리 보존 및 surviving helper의 unknown 보류를 검증한 **fixture transaction**이며, 실제 Codex 공식 바이너리 및 enforced AppArmor/managed policy를 통과한 업데이트 증거가 아니다.
  3. Rollback 경계 검증: 이 신규 replacement 테스트는 성공 트랜잭션 경로를 검증하며 rollback 실패를 주입하지 않는다. Rollback 동작은 별도의 기존 단위 테스트(`test_graceful_restart_failure_rolls_back_symlink_and_keeps_old_process`, `test_restart_failure_restores_actual_servers_or_reports_incomplete` 등)에서 검증된 증거이며 신규 replacement 테스트의 결과와 명확히 구분한다.
  4. Enforced smoke(`tests/codex-update-smoke.sh` 및 AppArmor profile boot smoke)는 호스트 환경의 `apparmor_parser` 부재로 인해 **NOT RUN**을 유지한다.

---

## 3. F3 (P2) 조치 — Auto-apply ready 및 세션 적용 조건 표시 정합성 개선

### 문제 및 수정 위치
- 위치: `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`의 `getStatus()` (line 2390) 및 text status 출력 (line 2468)
- 문제: 세션에 blocker가 없다는 `canApply` 판정만으로 text status에 `Auto-apply ready: yes (no Codex processes)`가 출력되어, 일일 예산 소진(`paused_busy`), restart cooldown, auto-update OFF 상태에서도 사용자가 "지금 자동 적용이 가능하다"고 오해하는 모순 발생.

### 구현 내용
1. **JSON 필드 의미 명확화 및 신규 필드 추가**:
   - `canApply`: 하위 호환성을 위해 live process/session blocker 부재를 나타내는 세션 레벨 predicate로 유지하고 코드 내 주석을 보강함.
   - `autoApplyReady`: 전체 자동 업데이트(daemon) 파이프라인 관점에서 주기적 검사 시 즉시 적용이 가능한지 여부를 평가하는 boolean 필드 추가(`autoUpdate && optionsValid && stagedVersion && !blockedReason && status !== 'paused_busy' && idleCheckCount < MAX_IDLE_CHECKS && canApply && (isIdle || cooldownElapsed)`).
2. **Text status 출력 분리 및 정밀화**:
   - `Session ready:`
     - `canApply === false`: `no (waiting for real sessions or unverifiable processes to exit)`
     - `canApply === true && isIdle === true`: `yes (no Codex processes; manual apply can run now)`
     - `canApply === true && isIdle === false`: `yes (idle managed server(s) eligible for restart; manual apply can restart now if cooldown allows)`
   - `Auto-apply ready:`
     - `autoUpdate === false`: `disabled (auto-update disabled; manual apply only)`
     - `optionsValid === false`: `blocked (configuration options invalid)`
     - `!stagedVersion`: `no (no staged update waiting to apply)`
     - `blockedReason`: `blocked (${blockedReason})`
     - `status === 'paused_busy' || idleCheckCount >= maxIdleChecks`: `paused (daily check budget exhausted; waiting for scheduled retry at ${nextRetryAt || 'next window'}; manual apply can re-check immediately)`
     - `canApply === false`: `deferred (waiting for active sessions or unverifiable processes to clear)`
     - `cooldown active`: `waiting (restart cooldown active until ${nextRestartAllowedAt || 'next window'}; manual apply also respects cooldown)`
     - 모두 충족 시: `yes (ready for next automatic apply check)`
3. **회귀 테스트 추가**:
   - `test_status_format_session_ready_and_auto_apply_ready_classification`:
     - Case 1: 예산 소진(`paused_busy`, 12/12) + 유휴 -> `Session ready: yes`, `Auto-apply ready: paused (daily check budget exhausted... manual apply can re-check immediately)`
     - Case 2: Restart cooldown active + idle managed server -> `Auto-apply ready: waiting (restart cooldown active until... manual apply also respects cooldown)`
     - Case 3: Auto-update disabled -> `Auto-apply ready: disabled (auto-update disabled; manual apply only)`
     - Case 4: No staged update -> `Auto-apply ready: no (no staged update waiting to apply)`
     - Case 5: Active session blocker -> `Session ready: no`, `Auto-apply ready: deferred (waiting for active sessions or unverifiable processes to clear)`
   - `test_status_cli_text_output_includes_both_session_ready_and_auto_apply_ready`:
     - CLI `ha-codex-update status` 실행 후 stdout 텍스트 전체에서 분리된 라벨과 안내 문구가 정확히 렌더링되는지 확인.

---

## 4. 검증 결과 (단일 기준 실행)

현재 working tree 소스 기준 단일 실행 결과:

| 검증 명령 | 대상 및 내용 | 결과 |
| --- | --- | --- |
| `.venv/bin/pytest -q tests/test_codex_update_contract.py` | 계약 테스트 파일 전체 (기존 96 + 신규 3) | **99 passed in 70.01s** |
| `.venv/bin/pytest -q tests/test_codex_update_contract.py tests/test_runtime_contract.py` | Update 및 Runtime 계약 pair 전체 | **111 passed in 72.84s** |
| `.venv/bin/pytest -q` | 저장소 전체 pytest suite | **237 passed, 1 skipped in 77.60s** |
| `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs` | Runtime Manager 문법 검사 | **PASS (exit 0)** |
| `shellcheck -x codex_home_assistant/rootfs/usr/local/bin/codex` | Wrapper 셸 스크립트 정적 분석 | **PASS (exit 0)** |
| `git diff --check` | 공백·EOF 줄바꿈 점검 | **CLEAN (exit 0)** |

---

## 5. 검증 미수행 항목 (NOT RUN)

- 호스트의 `apparmor_parser` 부재로 인한 AppArmor profile 하 `tests/codex-update-smoke.sh` 및 boot smoke: **NOT RUN**.
- 실제 사용자 HAOS 환경에서의 장기 세션, 외부 Remote SSH, 자동 업데이트 수용: **NOT RUN**.
- aarch64 native 실행: **NOT RUN**.
- 버전 상승 및 배포(Builder, GHCR, release tag, CHANGELOG unreleased 기재): **NOT RUN** (작업 범위 밖).
- Git commit / push / PR: **NOT RUN** (사용자 명시적 승인 대기).

---

## 6. 다음 단계 제안 (Reviewer)

- FIX_02에서 지적된 F1(프로세스 정리), F2(stub 명시 및 검증 정정), F3(상태 표시 분리 및 정합성)이 모두 반영되었으며 회귀 테스트가 통과했습니다.
- Reviewer의 최종 검토 및 인수 승인을 요청합니다.
