# FIX_05_REPORT — fixture 실행 형태를 명시적 Positive Allowlist로 한정

- Executor: Antigravity, 2026-10-17 (Asia/Seoul).
- 대상: Reviewer Codex의 `FIX_05.md` 남은 F1 (붙여 쓴 inline code 옵션의 데이터 경로 오인 결함) 해결.
- HEAD: `11b8839`, branch: `main`, 기존 12개 미커밋 변경 보존. 제품 런타임 코드(`codex-runtime-manager.mjs`, wrapper `codex`)는 일체 수정하지 않고 오직 테스트 헬퍼 및 회귀 테스트만 수정했다.

---

## 1. 구현 내용 (F1 해결)

Reviewer 지침에 따라 임의의 CLI 옵션 파서나 플래그 블랙리스트 예외 확장을 중단하고, 테스트가 실제 사용하는 실행 형태만을 허용하는 **엄격한 Positive Allowlist**로 `_is_proc_running_inside_fixture()`를 전면 재작성했다.

### 1) Native executable allowlist
- `/proc/<pid>/exe`의 symlink target이 canonical `fixture_dir` 내부인 경우에만 fixture native executable로 인정한다 (`_is_path_inside(exe_target, fixture_dir)`).

### 2) Interpreter fixture allowlist
- `/proc/<pid>/exe`의 실제 target realpath가 사전에 확인된 Node/Python 인터프리터(`sys.executable`, `which node`, `/usr/bin/node`, `/usr/local/bin/node`, `/bin/node`, `/usr/bin/python3`, `/usr/local/bin/python3`의 realpath 집합 `_get_known_interpreters()`)여야 한다. `argv[0]`의 basename prefix 검사만으로 인터프리터 정체성을 인정하지 않는다.
- cmdline 인자 검사:
  - `len(argv) >= 2` 이어야 한다.
  - `argv[1]`이 옵션(`-`로 시작)이 아니어야 한다. 붙여 쓴 `-cCODE`, `-m`, `--eval=CODE`, `-` 등 어떤 인터프리터 옵션이라도 선행하는 형태는 현재 fixture에서 사용하지 않으므로 보수적으로 전부 제외(`return False`)한다.
  - `argv[1]`이 canonical `fixture_dir` 내부여야 한다 (`_is_path_inside(argv[1], fixture_dir)`).
  - `argv[1]`의 대상 경로가 실제 존재하는 regular file이어야 한다 (`Path(argv[1]).is_file()`).

### 3) Fallback 완전 제거
- `argv[0]`의 임의 경로, `cwd` 내부 여부, `argv[2:]`에서 비옵션 토큰을 찾는 루프, `codex`/`app-server` 문자열 매칭 fallback을 완전히 제거했다. (프로세스의 cwd나 데이터 파일 접근은 실행 정체성이 아니므로 독립 소유권 근거로 사용하지 않음).

### 4) 신원 확인 및 종료 안전성 유지
- `_get_proc_start_time(pid)`를 통한 `(pid, start_time)` 신원 추적, 직접 자식 reap, bounded wait, SIGTERM/SIGKILL 전송 직전 `_verify_process_identity(pid, expected_start, fixture_dir)`를 통한 재확인을 그대로 유지했다.

---

## 2. 검증 결과

### 1) 수정 전 버그 재현 및 수정 후 정상 배제 확인
Reviewer가 지적한 F1 실행 형태를 독립 subprocess로 실행하여 검증했다:
```python
p = subprocess.Popen([sys.executable, '-cimport time; time.sleep(30)', str(data_file)])
```
- **수정 전**: `_is_proc_running_inside_fixture()` -> `True` (버그 재현: 데이터 인수를 entrypoint로 오인)
- **수정 후**: `_is_proc_running_inside_fixture()` -> `False` (정상 배제: 붙여 쓴 `-cCODE`가 옵션이므로 즉시 제외)

### 2) 회귀 테스트 강화 (`test_find_fixture_processes_excludes_sibling_dirs_and_data_argv`)
실제 live 프로세스 11개를 띄워 포괄적인 양성/음성 대조를 수행했다:
- **음성 대조 (반드시 배제되어야 하는 프로세스 8종)**:
  1. `p_sibling`: cwd가 sibling_dir (`tmp_path / "case-sibling"`)인 무관 프로세스 -> 배제 (`not in found_pids`)
  2. `p_data`: 분리된 `-c` 모드에서 fixture 디렉토리를 데이터 인수로 넘긴 프로세스 -> 배제
  3. `p_attached_c`: 붙여 쓴 `-cCODE` 모드에서 fixture 데이터 파일을 넘긴 프로세스 (FIX_05 핵심) -> 배제
  4. `p_stdin`: python stdin 모드 (`-`)에서 fixture 데이터 파일을 넘긴 프로세스 -> 배제
  5. `p_node_eval`: Node 분리된 `-e` 모드에서 fixture 데이터 파일을 넘긴 프로세스 -> 배제
  6. `p_node_eval_eq`: Node 붙여 쓴 `--eval=CODE` 모드에서 fixture 데이터 파일을 넘긴 프로세스 -> 배제
  7. `p_cwd_external`: fixture 디렉토리가 cwd인 외부 프로그램(sleep) 실행 프로세스 -> 배제
  8. `p_imposter`: `argv[0]="python3"`으로 위장했지만 실제 executable이 외부 바이너리(sleep)인 프로세스 -> 배제
- **양성 대조 (반드시 탐색되어야 하는 fixture 프로세스 3종)**:
  9. `p_case_py`: 정식 Python fixture script 실행 프로세스 -> 탐색 (`in found_pids`)
  10. `p_case_node`: 정식 Node fixture script 실행 프로세스 -> 탐색 (`in found_pids`)
  11. `p_case_native`: fixture 디렉토리 내 복사된 native binary 실행 프로세스 -> 탐색 (`in found_pids`)
- 모든 프로세스는 `try ... finally` 블록에서 reap/kill 처리되어 테스트 종료 후 누수가 발생하지 않는다.

### 3) 신규 합성 단위 테스트 (`test_is_proc_running_inside_fixture_synthetic_proc`)
합성 `/proc` 디렉토리 구조(symlink `exe`, `cmdline`, `cwd`)를 생성하여 외부 프로세스 스폰 타이밍에 구애받지 않고 결정론적으로 allowlist 규칙을 검증한다:
- imposter argv[0] 거부: exe=sleep, cmdline=python3 fixture/app.py -> `False`
- 붙여 쓴 `-cCODE` 거부: exe=python, cmdline=python3 -cimport... fixture/data.json -> `False`
- Python `-m` 모듈 모드 거부: exe=python, cmdline=python3 -mfoo fixture/data.json -> `False`
- Node `--eval=` 거부: exe=node, cmdline=node --eval=... fixture/data.json -> `False`
- 외부 바이너리 cwd 거부: exe=sleep, cwd=fixture -> `False`
- 정식 Python script 수용: exe=python, cmdline=python3 fixture/app.py -> `True`
- 정식 Node script 수용: exe=node, cmdline=node fixture/index.mjs -> `True`
- 정식 Native binary 수용: exe=fixture/bin/daemon -> `True`

### 4) 고유 basetemp 격리 실행 및 프로세스 잔류 0 확인
`--basetemp=/tmp/pytest-fix05-companion`으로 관련 테스트를 단독 실행했다:
```bash
.venv/bin/pytest tests/test_codex_update_contract.py -k "companion_server or terminate_fixture_processes" -vv --basetemp=/tmp/pytest-fix05-companion
```
- 결과: **3 passed in 4.36s**
  - `test_companion_server_real_replacement_preserves_old_generation_while_helper_lives` PASSED
  - `test_companion_server_setup_failure_teardown_leaves_zero_processes` PASSED
  - `test_terminate_fixture_processes_skips_recycled_pid_with_mismatched_start_time` PASSED
- 사후 검증: `_find_fixture_processes_for_dir(Path("/tmp/pytest-fix05-companion")) == []` (잔류 프로세스 0개 확인)

### 5) 전체 테스트 스위트 및 정적 분석 결과
- `.venv/bin/pytest -q tests/test_codex_update_contract.py`: **102 passed in 70.64s**
- `.venv/bin/pytest -q`: **240 passed, 1 skipped in 78.80s** (apparmor_parser 부재 기존 환경 skip)
- `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`: PASS
- `shellcheck -x codex_home_assistant/rootfs/usr/local/bin/codex`: PASS
- `git diff --check`: PASS (0 warnings, 0 errors)

---

## 3. 미검증 공백 (NOT RUN)

- enforced AppArmor profile 환경에서의 `tests/codex-update-smoke.sh` 전편 (`apparmor_parser` 부재).
- 실제 운영 HAOS 장치에서의 Add-on 갱신 및 실제 Codex 프로세스 자동 재기동.
- aarch64 native 아키텍처 실기 실행.
- 신규 도커 이미지 빌드 및 배포.
- 외부 Git commit / push / PR / release 및 버전 번호 상승 (인계 지침 준수).
