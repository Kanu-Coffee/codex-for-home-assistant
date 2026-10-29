# FIX_14 Executor 보고서

작성: 2026-10-29. 결과: **관리형 TUI 제목 thread의 정상 unsubscribe 처리 구현 / 재리뷰 필요**.

## 구현

공식 `rust-v0.162.1` 소스의 `codex-rs/tui/src/app/thread_title.rs`와 `temporary_structured_request.rs`를 확인했다. TUI는 `threadSource=thread_title`, `ephemeral=true`인 임시 thread에서 제목 작업을 수행한 뒤 `thread/unsubscribe`를 요청한다. 소스는 unsubscribe를 bounded best-effort로 처리하므로 응답이 실패하거나 확인되지 않은 경우 정리를 가정하지 않는다.

relay는 자체 기동한 관리형 CLI frontend에서 관측한 `thread/start`가 위 계약과 일치하고, 해당 thread의 unsubscribe가 `unsubscribed` 또는 `notLoaded`로 성공했으며, thread 상태가 idle이고 추적 중인 active turn이 없을 때만 그 임시 thread를 loaded 원장에서 제거한다. `threadSource` 문자열만으로 임의 thread를 폐기하지 않는다. 사용자 ephemeral thread와 진행 중 작업, 실패·미확인 unsubscribe는 기존 보호를 유지한다. 기록이나 prompt 본문을 별도로 저장하지 않는다.

## 검증

- 공식 0.162.1 frontend와 production `--client-socket --spawn-client` relay를 격리 HOME/CODEX_HOME·PTY·localhost 합성 모델로 실행했다. 첫 합성 요청이 완료된 뒤 thread 1개가 남고 idle인 것을 확인했다. control socket에서 공식 0.164.0으로 직접 전환하자 worker PID와 실행 파일이 변경됐으며, 같은 TUI의 다음 요청이 합성 서버에 도달하고 해당 입력 이후 화면 데이터에서 합성 응답을 확인했다 (`.test-tmp/review006-fix12/fix14-spawn-response.log`).
- 후보 실행 파일이 없는 실패를 주입한 `fix14-spawn-rollback.log`에서는 `rollbackStatus:restored` 후 같은 TUI의 다음 합성 요청이 서버에 도달했다. 이 시험은 다음 응답 완료까지 별도로 검증하지 않았다.
- 회귀 `test_completed_managed_title_unsubscribe_retires_only_title`는 제목 작업 진행 중에는 남기고, 완료 후 성공적인 unsubscribe는 정리하며, 사용자 ephemeral thread는 정리하지 않음을 검사한다. 초기 FIX_03 선택 suite **9 passed**, 이후 active 보호 조건을 추가한 해당 검사 **1 passed**.
- `.venv/bin/python -m pytest -q tests/test_codex_update_contract.py tests/test_codex_update_fix03.py` → **124 passed in 89.74s**. `node --check`, wrapper ShellCheck, `git diff --check`, 변경 Markdown lint 통과.

공식 TUI 시험은 **control socket 직접 switch**이며 wrapper 스크립트→manager→scheduler의 전체 자동 적용은 검증하지 않았다. 최초 실행과 회귀에서 사용한 source 및 probe는 Git 제외 `.test-tmp/fix14-source/`, `.test-tmp/review006-fix12/`에 있다. 실제 HAOS/mobile, 실모델, native ARM, Docker 신규 build 및 장시간 운용은 수행하지 않았다. 내용이 있는 사용자 ephemeral 대화의 신규 worker 인계는 미구현으로 기존처럼 안전 보류한다.

사용자가 요청한 dev 배포 시 기존 설치본보다 높은 미사용 version을 사용해야 한다. 이번 Executor 단계에서 외부 게시나 사용자 장치 변경은 하지 않았으며, 재리뷰 후 배포 단계로 인계한다.
