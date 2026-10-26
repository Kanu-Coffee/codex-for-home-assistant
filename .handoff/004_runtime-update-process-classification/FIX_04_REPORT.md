# FIX_04_REPORT — stdin interpreter 데이터 인수 배제 및 entrypoint 엄격화

- Executor: Antigravity, 2026-10-17 (Asia/Seoul).
- 판정 대상: `.handoff/004_runtime-update-process-classification/FIX_04.md` (Reviewer: Codex).
- 기준 HEAD: `11b8839`, branch `main`. 미커밋 working tree 유지.
- 규칙 준수: 기존 PLAN, REPORT, FIX_01~FIX_03 및 각 REPORT는 일체 수정하지 않고 온전히 보존했다. 제품 런타임 코드 변경 없음. 외부 Git push/PR/release 및 실제 HAOS 운영 장치 조작은 수행하지 않았다.

---

## 1. F1 (P2) 조치 — 인터프리터 stdin 및 인라인 eval 모드의 데이터 경로 배제

### 문제 및 위치
- 위치: `tests/test_codex_update_contract.py`의 `_is_proc_running_inside_fixture()`
- 문제:
  1. `python - <data_file>`(stdin 모드)에서 단일 대시(`-`)를 단순 옵션으로 건너뛰어 뒤따르는 데이터 경로를 실행 스크립트로 오인 수집함.
  2. `python -c`/`-m`, `node -e`/`--eval`/`-p`/`--print`, `bash -c` 등 인라인 코드/모듈 모드 뒤에 오는 인수가 데이터 인수임에도 스크립트 entrypoint로 오인될 수 있음.
  3. cwd 검사에서 `codex` / `app-server` 문자열 포함 fallback이 느슨하여, fixture 내부 cwd에서 데이터 인수에 해당 문자열이 포함된 프로세스를 오인 수집할 위험이 있음.

### 구현 내용
1. **인터프리터 stdin 및 인라인 코드 모드 명시적 배제**:
   - `_is_proc_running_inside_fixture`의 인터프리터(`node`, `python`, `bash`, `sh`, `perl`) 순회 검사에서:
     - `arg == "-"`: Python stdin 모드 감지 시 즉시 `return False` (스크립트 파일 실행이 아님).
     - `arg in ("-c", "-m", "-e", "--eval", "-p", "--print")`: 인라인 코드 또는 모듈 실행 모드 감지 시 즉시 `return False`.
     - 옵션(`arg.startswith("-")`)을 건너뛴 후 발견되는 첫 비옵션 인수가 `_is_path_inside(arg, fixture_dir)`가 아니면 즉시 `return False`.
2. **cwd 검사의 문자열 fallback 완전 제거**:
   - `cwd`가 fixture 내부이더라도, 실행 바이너리(`argv[0]`) 또는 첫 번째 스크립트 인수(`argv[1]`)가 실제로 `fixture_dir` 내부에 위치할 때만 소유권을 인정하도록 엄격화(`_is_path_inside(argv[0], fixture_dir) or _is_path_inside(argv[1], fixture_dir)`).
3. **회귀 테스트 확장 (`test_find_fixture_processes_excludes_sibling_dirs_and_data_argv`)**:
   - `p_stdin`: `[sys.executable, "-", str(data_file)]` (stdin 열어둔 상태로 대기) -> `_find_fixture_processes_for_dir(case_dir)`에서 **제외 확인** (Reviewer 독립 재현 케이스 검증).
   - `p_node_eval`: `["node", "-e", "setInterval(() => {}, 60000)", str(data_file)]` -> **제외 확인**.
   - `p_sibling`: sibling cwd 프로세스 -> **제외 확인**.
   - `p_data`: python `-c` 데이터 argv 프로세스 -> **제외 확인**.
   - `p_case`: 실제 fixture 내부 스크립트 실행 프로세스 -> **정상 수집 확인**.
4. **PID+start-time 신원 재검증 유지**:
   - 신호 전송(SIGTERM/SIGKILL) 직전 `_verify_process_identity`를 통한 동일 프로세스 생존 및 fixture 소유권 재검증 로직은 온전히 유지됨.

---

## 2. 검증 결과 (단일 기준 실행)

현재 working tree 소스 기준 단일 실행 결과:

| 검증 명령 | 대상 및 내용 | 결과 |
| --- | --- | --- |
| `.venv/bin/pytest tests/test_codex_update_contract.py -k "companion_server or fixture_processes" -vv --basetemp=/tmp/pytest-fix04-test1` | 고유 basetemp 격리 실행 (stdin/인라인 eval 배제 및 teardown 검증) | **4 passed in 4.60s** (사후 잔류 프로세스 0 확인) |
| `.venv/bin/pytest tests/test_codex_update_contract.py -k "test_status_" -vv --basetemp=/tmp/pytest-fix04-test2` | status 포맷 및 정합성 검증 | **4 passed in 1.61s** |
| `.venv/bin/pytest -q tests/test_codex_update_contract.py` | 계약 테스트 파일 전체 | **101 passed in 70.31s** |
| `.venv/bin/pytest -q tests/test_codex_update_contract.py tests/test_runtime_contract.py` | Update 및 Runtime 계약 pair 전체 | **113 passed in 73.12s** |
| `.venv/bin/pytest -q` | 저장소 전체 pytest suite | **239 passed, 1 skipped in 79.17s** (기존 환경 skip) |
| `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs` | Runtime Manager 문법 검사 | **PASS (exit 0)** |
| `shellcheck -x codex_home_assistant/rootfs/usr/local/bin/codex` | Wrapper 셸 스크립트 정적 분석 | **PASS (exit 0)** |
| `git diff --check` | 공백·EOF 줄바꿈 점검 | **CLEAN (exit 0)** |

---

## 3. 검증 미수행 항목 (NOT RUN)

- 호스트의 `apparmor_parser` 부재로 인한 AppArmor profile 하 `tests/codex-update-smoke.sh` 및 boot smoke: **NOT RUN**.
- 실제 사용자 HAOS 환경에서의 장기 세션, 외부 Remote SSH, 자동 업데이트 수용: **NOT RUN**.
- aarch64 native 실행: **NOT RUN**.
- 버전 상승 및 배포(Builder, GHCR, release tag, CHANGELOG unreleased 기재): **NOT RUN** (작업 범위 밖).
- Git commit / push / PR: **NOT RUN** (사용자 명시적 승인 대기).

---

## 4. 다음 단계 제안 (Reviewer)

- FIX_04에서 요구된 stdin 인터프리터(`python -`) 및 인라인 코드 모드(`-c`, `-e`, `-m` 등) 데이터 argv 배제, cwd의 느슨한 문자열 fallback 제거, 그리고 신규 회귀 검증이 모두 완료되었습니다.
- Reviewer의 최종 검토 및 인수 승인을 요청합니다.
