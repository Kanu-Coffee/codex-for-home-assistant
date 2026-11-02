# FIX_12 Executor 보고서

작성: 2026-10-29. 결과: **ephemeral 분류 보완 및 실제 TUI 직접 전환 확인 / 재리뷰 필요**.

`thread/read` 결과가 `ephemeral:true`, path 없음, 빈 turns 배열인 thread를 디스크 resume 대신 새 worker에 재생성하고 기존 client ID와 매핑한다. 복원 대상의 read 실패나 불명확한 metadata는 성공으로 간주하지 않는다. 후보 실패 후 rollback 시 빈 thread 재생성 실패도 더 이상 무시하지 않으며, 신규 thread ID가 없으면 실패 처리한다. 채팅창이나 빈 대화의 존재를 blanket busy로 처리하지 않는다.

## 실제 공식 TUI 격리 시험

Linux x86_64, 공식 baseline 0.162.1 및 후보 0.164.0, 별도 HOME/CODEX_HOME, localhost의 합성 Responses SSE 서버와 PTY를 사용했다. 실제 계정·모델·HA API는 사용하지 않았다. `.test-tmp/review006-fix11/fix12-response-delta.py`는 production session host의 WebSocket endpoint와 별도 공식 `codex --remote` frontend를 연결하고 control socket으로 직접 전환한다.

- 첫 합성 요청 완료 후 idle인 thread 2개를 관찰했다. switch는 성공했고 worker PID 및 실행 파일이 바뀌었으며 기존 TUI는 유지됐다.
- 같은 TUI의 다음 요청이 합성 서버에 도달했고 해당 입력 이후 수신한 화면 데이터에서 합성 응답을 확인했다 (`fix12-response-delta.log`).
- 후보 executable이 없는 실패를 주입하면 `rollbackStatus:restored`이며 같은 TUI의 후속 요청이 합성 서버에 도달했다 (`fix12-rollback.log`). 이 시험은 후속 모델 응답 완료까지 별도로 검증하지 않았다.
- 이는 **control socket 직접 호출**에 의한 시험이다. 실제 scheduler→apply와 wrapper `--spawn-client` 전체 경로, HAOS/mobile 실기기는 검증하지 않았다. 따라서 task 전체의 배포 수용 근거로 확대하지 않는다.

`thread/read`의 `includeTurns:true`를 시도한 별도 공식 TUI 시험은 전환을 보류하고 기존 TUI 후속 요청을 처리했다. 기본 read의 빈 turns 배열만으로 임의 ephemeral 대화에 과거 메모리 내용이 전혀 없음을 일반적으로 증명할 수 있는지는 미검증이다. 실제 기록이 있는 ephemeral 대화의 복원·보존은 추가 확인이 필요하다.

## 검증

- `tests/test_codex_update_fix03.py::test_ephemeral_thread_is_recreated_and_next_turn_reaches_new_worker` 및 기존 실패/rollback 두 검사: **3 passed**.
- `.venv/bin/python -m pytest -q tests/test_codex_update_contract.py tests/test_codex_update_fix03.py` → **123 passed in 90.57s**.
- Node syntax, wrapper ShellCheck 및 `git diff --check` 통과.
- 전체 suite·Docker 신규 build·native ARM·실제 HAOS/mobile·실제 모델·장기 운용은 이번에 실행하지 않았다. 외부 게시나 사용자 장치 변경은 하지 않았다.
