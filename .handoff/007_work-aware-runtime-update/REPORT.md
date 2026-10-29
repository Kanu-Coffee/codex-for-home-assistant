# REPORT — task 007 Executor 부분 진행

작성일: 2026-10-30  
상태: **미완료**

## 변경

- `inspectAppServer()`가 `app.server_requests.pending` gauge가 제공되고 0보다 크면 서버 요청 대기 상태를 보류한다. 존재하지만 잘못된 값도 보류한다. 기존 gauge 누락 처리와 loaded thread 보류, CLI·stdio 보류는 유지된다.
- 기존 Unix WebSocket fixture에 pending 0/1 회귀 사례를 추가했다. 이 변경은 전체 목표의 일부인 추가적인 작업 보호이며, 유휴 CLI·stdio의 업데이트를 가능하게 만들지 않는다.

## 기능 실험

- 로컬 공식 `0.165.0` 바이너리와 임시 `HOME`/`CODEX_HOME`, 임시 Unix socket으로 app-server와 공식 stdio proxy를 실행했다. 사용자 인증·대화·운영 서버는 사용하지 않았다.
- 첫 시도는 CODEX_HOME 디렉터리를 만들지 않아 서버 시작에 실패했다. 다음 시도에서는 서버가 시작됐으나 initialize 응답을 확인하지 못했고, 서버에 SIGHUP 후 5초 동안 proxy가 종료되지 않았다. handshake 및 이후 통신이 검증되지 않았으므로 자동 reconnect 성공·실패 어느 쪽의 근거로도 부족하다. cleanup에서 시험 프로세스를 종료했다.
- 별도의 짧은 진단 실행은 timeout 후 임시 디렉터리 cleanup이 실패했다. 해당 서버는 `subprocess.run` timeout 처리로 종료됐지만 임시 디렉터리 잔여 가능성이 있다. 운영 데이터와는 무관하다.
- baseline `0.162.1` 실행 바이너리는 확인하지 못했다. CLI/TUI, 실제 stdio 연결·대화 복원, request admission·경합, backend 교체와 scheduler 전체 경로는 **NOT RUN**이다.

## 검증

- `.venv/bin/python -m pytest -q tests/test_codex_update_contract.py`: 116 passed.
- 변경 JS의 `node --check`, `git diff --check`: PASS. 전체 pytest, Docker, native ARM, HAOS는 NOT RUN.

## 남은 작업

PLAN의 A~F 대부분이 남았다. 특히 baseline/후보의 기능 확인, 공식 proxy 연결 및 재연결 재현, CLI·stdio 작업 관측과 admission, 대화 복원·rollback, scheduler 통합 및 실제 후속 요청 검증이 필요하다. 아직 프로세스/loaded 대화 존재만으로 보류하는 기존 문제는 해결되지 않았다. 제품 완료나 HAOS 수용으로 기록하지 않는다.
