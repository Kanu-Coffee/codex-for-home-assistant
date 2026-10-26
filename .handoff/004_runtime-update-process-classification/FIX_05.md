# FIX_05 — fixture 실행 형태를 명시적으로 한정

## 판정

- Reviewer: Codex, 2026-10-17 (Asia/Seoul).
- **P2 1건 수정 필요 / 인수 보류**. FIX_04의 stdin·분리된 eval 플래그 대조는 추가됐지만 데이터 인수 오인은 여전히 재현된다. 새 제품 런타임 결함을 지적하는 것이 아니다.
- PLAN/REPORT 및 FIX_01~FIX_04와 각 REPORT, 현재 코드·테스트·Git 상태를 대조했다. HEAD `11b8839`, branch `main`, 기존 미커밋 변경을 보존한다. 제품 코드는 수정하지 않았다.

## 남은 F1 — 붙여 쓴 inline code 옵션의 데이터 경로가 종료 대상으로 선택됨

위치: `tests/test_codex_update_contract.py`의 `_is_proc_running_inside_fixture()` interpreter 분기.

다음 실행은 Python이 inline 코드를 실행하고 fixture 파일 경로는 데이터로 받는 유효한 호출이다.

```python
Popen([sys.executable, '-cimport time; time.sleep(30)', str(data_file)])
```

현재 함수는 `-c`와 정확히 같은 토큰만 거부한다. 붙여 쓴 `-cCODE`는 일반 옵션으로 건너뛰고 뒤의 data_file을 fixture script로 오인한다. Reviewer가 fixture 밖에서 실제 자체 생성 프로세스를 실행하고 `_find_fixture_processes_for_dir()`를 호출한 결과:

```text
inline_python_alive: true
data_argument_selected_as_entrypoint: true
```

종료 helper로 신호를 보내지는 않았으며 직접 소유한 Popen 객체로 정상 종료·reap했다. FIX_04의 “인라인 코드 모드 데이터 argv 배제 완료” 주장은 이 실행 형태까지 성립하지 않는다.

## 수정 방법 — 예외 목록 대신 작은 positive allowlist 사용

테스트가 실제 사용하는 직접 실행과 `node <script>`, `python <script>` 형태만으로 fixture를 회수할 수 있다. 이번에는 일반적인 interpreter 옵션 skip 루프와 cwd fallback을 유지한 채 플래그 예외만 더하지 않는다.

1. `/proc/<pid>/exe`의 실제 executable이 정확한 fixture 경계 안이면 fixture executable로 인정한다. 이는 기존 package binary/copy fixture를 처리한다.
2. 실제 executable이 테스트에서 사용하는 **확인된 Node/Python interpreter**이고 `argv[1]`이 옵션이 아닌 절대 script 경로일 때만 interpreter fixture로 인정한다. script 경로는 canonical fixture 내부의 실제 regular file이어야 한다. interpreter 옵션이 선행하는 형식은 현재 fixture에서 필요하지 않으므로 보수적으로 제외한다. argv[0] basename prefix만으로 interpreter 정체성을 확정하지 않는다.
3. argv[0]의 경로, cwd 내부 여부, 임의 첫 비옵션 토큰을 독립 소유권 근거로 쓰는 fallback을 제거한다. argv[0]은 바꿔 붙일 수 있고, cwd나 데이터 파일 접근은 fixture 실행 정체성이 아니다.
4. 기존에 기록한 `(pid, start_time)`와 직접 child reap·signal 직전 재확인을 유지한다. 위 좁은 탐색으로 actual replacement/helper를 찾을 수 있도록 실제 fixture 실행 형태를 확인한다. 이 요구 때문에 production 로직을 변경하지 않는다.

이 범위 밖의 interpreter 지원이 실제 필요하면 해당 실행 형태와 테스트 근거를 제시한다. 이번 Node/Python fixture에 필요하지 않은 범용 CLI parser를 새로 만들지 않는다.

## 수용 기준

- actual fixture native executable와 `node <fixture-script>`/`python <fixture-script>`는 탐색된다.
- `python -`, 분리된 `-c`/`-m`, 붙여 쓴 `-cCODE`, Node `-e CODE`/`--eval=CODE` 뒤 fixture 데이터 경로는 탐색되지 않는다. argv[0] 이름만 위장한 무관 프로세스도 탐색되지 않아야 한다. 안전한 synthetic `/proc` fixture나 mock을 사용할 수 있다.
- fixture cwd에서 외부 프로그램이 데이터 파일만 읽는 경우와 형제 경로 실행은 탐색되지 않는다.
- PID 재사용에 신호를 보내지 않는 대조를 유지한다. replacement 성공·setup 실패를 고유 basetemp에서 실행하고 fixture 잔류 0을 확인한다.
- 수정 전 이번 독립 재현 실패와 수정 후 통과를 기록한다. 기존 해피패스만 실행해 완료로 처리하지 않는다.

## 검증과 인계

- Reviewer는 위 실제 inline Python 탐색 재현, Node/Bash syntax·ShellCheck·`git diff --check`를 수행했다. 관련 pytest는 `-k 'not companion_server and not terminate_fixture_processes'`로 실행하며 결과를 progress에 기록한다.
- 이번 리뷰에서 해당 teardown 자체·전체 pytest·image build·실제 update/restart·enforced AppArmor·HAOS·ARM은 NOT RUN이다.
- Executor는 이 FIX_05만 수행하고 `FIX_05_REPORT.md`를 새로 작성한다. 기존 handoff는 수정하지 않고 progress에 실제 결과와 미검증 공백을 기록한다. commit/push/PR/release·버전 상승·실제 HAOS 변경은 범위 밖이다.
