# FIX_04 — stdin interpreter의 데이터 인수를 종료 대상으로 오인하지 않기

## 판정과 재검토 결과

- Reviewer: Codex, 2026-10-17 (Asia/Seoul).
- 판정: **P2 1건 수정 필요 / 인수 보류**. 제품 로직에 새 결함을 재현한 것은 아니며 남은 대상은 테스트 정리 함수다.
- PLAN부터 FIX_03_REPORT까지의 handoff와 현재 working tree를 대조했다. 기준 HEAD `11b8839`, branch `main`, 기존 미커밋 변경·인계 이력을 보존한다.
- FIX_03 F2의 `isIdle` 조건에 따른 cooldown 표시, invalid options 우선 판정, `getNow()` 사용 변경은 수용한다.
- FIX_03 F1의 경로 segment 경계와 PID+start-time 재확인은 추가됐다. 다만 “데이터 argv는 종료 대상으로 삼지 않는다”는 수용 조건이 아래 interpreter 실행 모드에서 여전히 충족되지 않는다.

## F1 — P2: python stdin 모드의 데이터 경로를 실행 스크립트로 취급함

위치: `tests/test_codex_update_contract.py`의 `_is_proc_running_inside_fixture()`, “Interpreter script execution: find first non-option argument” 분기.

모든 `-` 시작 토큰을 건너뛰고 첫 비옵션 토큰을 스크립트로 간주한다. Python의 `-`는 stdin에서 프로그램을 읽는 실행 모드이므로 그 뒤의 토큰은 스크립트 entrypoint가 아닌 사용자 데이터 인수다. 현재 구현은 이 모드를 구분하지 않아 fixture 경로를 데이터로만 받는 외부 프로세스도 `_find_fixture_processes_for_dir()`에 포함한다. `_terminate_fixture_processes()`의 신원 재검사도 같은 함수를 사용하므로 start-time이 맞으면 그 잘못된 대상에 실제 신호를 보낼 수 있다.

### 독립 재현

1. 고유 임시 디렉터리 아래 `case/data.txt`를 생성한다.
2. fixture 밖에서 `Popen([sys.executable, '-', str(data_file)], stdin=PIPE)`로 Python을 시작한다. stdin을 열어 두므로 프로세스는 입력을 기다리며 살아 있다. data.txt의 코드를 실행하는 프로세스가 아니다.
3. 실제 `_find_fixture_processes_for_dir(case)`를 호출한다.

```text
stdin_python_alive: true
data_argument_selected_as_entrypoint: true
```

Reviewer는 종료 helper를 호출하지 않고 직접 소유한 Popen 객체로 정상 종료·reap했다. 무관 프로세스에 실제 신호를 전송한 검증은 아니다. 기존 `python -c 'sleep...' <data>` 대조 테스트는 코드 문자열에서 루프가 멈추므로 이 stdin 사례를 검출하지 못한다.

## 요구 수정 — 이 범위만 작게 처리

1. 범용 interpreter parser를 새로 만들 필요는 없다. fixture에서 실제 사용하는 executable/script 실행 형태만 명시적으로 인정하고, 불명확한 interpreter 모드는 탐색 결과에서 제외한다. 추적된 직접 child와 검증된 replacement identity의 정리는 유지한다.
2. 최소한 `python -`, `python -c`/`-m`, Node의 `-e`/`--eval`, 셸 `-c` 등에서 뒤따르는 데이터 인수를 script entrypoint로 취급하지 않는다. 알려진 interpreter의 실제 executable과 실제 script 인수 위치를 확인한다. argv[0]의 이름이나 임의 첫 비옵션 인수만으로 종료 소유권을 확정하지 않는다.
3. cwd 분기의 `codex`/`app-server` 문자열 포함 fallback도 실행 정체성을 대신하지 않게 한다. fixture cwd에 있고 데이터 인수에 그 문자열이 있는 별도 프로세스를 종료 대상으로 선정하지 않는다. 실제 fixture 스크립트는 명시적 entrypoint 검사로 찾을 수 있어야 한다.
4. 기존 sibling·`-c` 데이터·PID 재사용 회귀를 유지하고 위 stdin 데이터 사례를 추가한다. 신호 전송 여부는 mock으로 확인하거나 탐색 결과와 직접 소유 프로세스의 생존 상태로 안전하게 대조한다.
5. helper+replacement 성공과 setup 실패 테스트를 고유 basetemp에서 실행해 종료 후 잔류 0을 다시 확인한다. 각 신호 직전 PID+start-time 검증을 제거하거나 production 로직을 수정하지 않는다.

## 검증과 인계

- Reviewer는 위 stdin 데이터 탐색 재현, Node/Bash syntax, wrapper ShellCheck 및 `git diff --check`를 수행했다. 관련 pytest는 새 teardown 실행을 피하기 위해 `-k 'not companion_server and not terminate_fixture_processes'`로 실행했고 최종 결과는 progress의 이번 Reviewer 기록에 남긴다.
- 전체 pytest·해당 teardown의 실제 실행·새 image build·운영 update/restart·enforced AppArmor·HAOS·ARM은 이번 리뷰에서 NOT RUN이다.
- Executor는 이 FIX_04를 수행하고 `FIX_04_REPORT.md`를 새로 작성한다. 기존 PLAN/REPORT/FIX 문서를 수정하지 않는다. 이번 한 건의 수정·회귀 결과와 기존 검증 공백을 구분해 progress에 기록한다.
- 제품 코드 변경·버전 상승·commit/push/PR/release·실제 HAOS 변경은 이 수정 지시의 요구 범위가 아니다.
