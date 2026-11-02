# FIX_03 Executor 보고서

작성: 2026-10-28. 결과: **부분 구현 / task 006 미완료 / 재리뷰 필요**.

사용자 목표는 작업이 없는 유휴 CLI/TUI 및 Remote stdio의 기존 backend를 대화와 연결을 보존하며 자동 전환하는 것이다. 아래 안전성 보완과 격리 시험은 그 목표의 완료나 출시 수용을 뜻하지 않는다. 특히 CLI/TUI 전환 경로와 live 자동 전환은 아직 구현·검증되지 않았다. 기존 세션이 없는 경우의 업데이트 경로는 유지한다. task 005 및 기존 handoff 문서는 보존했다.

## H1: rollback과 단일 writer

`codex-session-host.mjs`는 후보 worker를 정상 종료했음을 확인하지 못하면 이전 writer를 다시 시작하지 않고 `rollback_incomplete`로 barrier를 유지한다. worker PID와 시작 시각, exit/signal 및 zombie 상태를 확인한다. 복원 가능성 사전 검사 중 worker가 죽거나 identity가 불확실해진 경우도 복원 성공으로 보고하지 않는다. 세션 기록 저장에 실패하면 입력을 먼저 풀지 않고 rollback한다. `tests/test_codex_update_fix03.py`는 HUP을 무시하는 후보가 살아 있는 동안 old worker를 중복 실행하지 않고 release를 거부하는 경로와 preflight 중 종료를 검사한다.

이 검사는 합성 worker 기준이다. 모든 가능한 PID 재사용, rollback spawn 실패, ACK race와 입력 중복을 실환경에서 검증한 것은 아니다.

## H2: 작업 상태와 identity

thread별 상태와 turn ID를 분리해 동일 active 이벤트를 중복 계수하지 않는다. 대화를 실제로 여는 start/resume/fork와 metadata read를 구분하고, archive/delete 등에는 필요한 thread ID만 보관한다. 알 수 없는 상태, goal/background 작업의 관측 불확실성은 busy로 보류한다. relay/control socket 소유권과 권한, worker PID·시작 시각·부모·실행 파일을 확인한다.

서버의 모든 background/goal 상태에 대한 authoritative snapshot, revision과 freshness는 아직 구현하지 못했다. 불확실성은 해제 근거가 아니다. 따라서 장기 연결의 모든 유휴 조건을 검증했다고 주장할 수 없다.

## H3: commit, release와 복구

transaction은 barrier·전환 ACK 및 worker identity와 release 응답을 확인하고 selection/state commit을 worker 준비 뒤에 수행한다. 불완전한 rollback, ACK 유실 또는 release 오류는 applied로 보고하지 않고 durable transaction journal과 barrier를 유지한다. 이미 일부 barrier가 풀린 뒤 실패한 경우에는 들어온 작업을 파괴할 수 있는 rollback을 시도하지 않는다. journal이 남으면 init/check/apply와 신규 Codex 실행을 보류한다.

**자동 복구 절차는 아직 없다.** journal은 복구가 필요한 상태를 보존하고 fail closed할 뿐, 여러 host의 부분 release를 원자적으로 되돌리거나 재시작 후 자동 복구하지 않는다. 장애 시 operator가 실제 프로세스·요청 상태를 확인해 복구해야 하며, 단순 journal 삭제를 복구 완료로 간주해서는 안 된다. live handover는 현재 `compatibility_unverified`로 보류하므로 이 미완성 transaction 경로가 제품에서 자동 실행되지는 않는다.

## H4: 공식 바이너리 및 stable endpoint 격리 시험

Linux x86_64에서 공식 GitHub release 패키지를 다운로드하고 SHA-256을 검증했다. 0.162.1의 digest는 저장소 Dockerfile에 고정된 값이며, 0.164.0은 GitHub release API digest와 대조했다.

```sh
gh release download rust-v0.162.1 --repo openai/codex --pattern codex-package-x86_64-unknown-linux-musl.tar.gz --dir .test-tmp/fix03/baseline
gh release download rust-v0.164.0 --repo openai/codex --pattern codex-package-x86_64-unknown-linux-musl.tar.gz --dir .test-tmp/fix03/candidate
gh api repos/openai/codex/releases/tags/rust-v0.164.0
sha256sum .test-tmp/fix03/{baseline,candidate}/codex-package-x86_64-unknown-linux-musl.tar.gz
```

| 공식 package | archive SHA-256 | 추출한 `bin/codex` SHA-256 |
| --- | --- | --- |
| 0.162.1 | `a676f5722aae0d86cbe3764332f08eab1fdd89dc0a300b3ad4ffbf48611fa3e3` | `628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1` |
| 0.164.0 | `3ec55053109608d5038f7e50750f7d25f768dfd740fef071aa710e2559b63aac` | `b93f6811d3f653f0fb83be4050d857fb9abbb111dfa2ce160563327daff7f306` |

각 archive를 해당 디렉터리에 `tar -xzf`로 풀고 `bin/codex --version`, `bin/codex --help`, `bin/codex app-server --help`를 실행했다. 두 버전에서 `--remote unix://...` 및 app-server Unix/stdio 지원을 확인했다. 추가로 `bin/codex app-server generate-json-schema --out <dir>`로 두 버전의 schema를 생성하고 `v2/ThreadResumeParams.json`을 확인했다. 이 schema는 `threadId`를 요구한다.

실험은 별도 HOME/CODEX_HOME, localhost 합성 Responses SSE 서버와 임시 PTY/socket을 사용했다. 실제 계정, 실모델 요청 및 HA 변경은 사용하지 않았다. 재현 보조 스크립트와 로그는 이 작업 트리의 Git 제외 경로 `.test-tmp/fix03/`에 있다. `python .test-tmp/fix03/stdio_probe.py`, `python .test-tmp/fix03/stdio_mock_probe.py`, `python .test-tmp/fix03/tui_stable_probe.py`를 순차 실행한다. TUI bridge probe는 해당 머신에 이미 설치된 `openclaw`의 `ws` 패키지를 임시로 사용하며 제품 의존성은 아니다. 이 임시 파일은 Git으로 전달되지 않으므로 별도 환경에서는 스크립트와 의존성을 재구성해야 한다.

- 새 idle thread의 `thread/read`는 경로를 반환했으나 해당 rollout 파일이 존재하지 않았다. 사전 검사 없이 worker를 교체하면 `thread/resume`은 `no rollout found`로 실패했으며 이전 worker로의 resume도 실패했다. 현재 relay는 기존 worker를 유지하고 `thread_restorability_unverified`로 보류한다 (`stdio_preflight.log`).
- 합성 서버의 첫 turn으로 rollout이 저장된 후 relay control을 직접 호출한 시험에서는 동일 stdio 연결에서 0.162.1 → 0.164.0 전환, 같은 thread read 및 다음 `turn/start` 수락을 관찰했다 (`stdio_mock_preflight.log`). 이는 scheduler 자동 전환이나 실제 모델의 응답 완성을 검증한 것이 아니다.
- 실제 TUI와 고정 Unix endpoint, 임시 WebSocket→stdio relay 조합에서는 첫 요청 뒤에도 미저장 thread가 남았고 전환은 안전 보류됐다. 보류 후 같은 TUI의 후속 요청이 합성 서버에 도달했다 (`tui_stable_postfix.log`). 성공적인 TUI 전환은 입증되지 않았다. 별도 직접 socket 교체 시험에서 재연결 표시를 관찰했으므로 FIX_02 보고서의 ‘TUI가 재연결을 지원하지 않는다’는 단정은 정정한다.

따라서 stable endpoint 자체의 불가능성은 입증되지 않았다. 미저장/ephemeral 대화의 ID와 대화 상태를 보존해 신규 worker에서 복원하는 방법 또는 대화를 변경하지 않고 안전하게 영속화하는 방법을 upstream protocol/adapter 차원에서 확인해야 한다. 다중 client routing, background 상태, transaction 복구, Web/SSH 및 모바일 환경까지 검증하기 전에는 열린 세션에서 자동 적용을 활성화하지 않는다.

## 검증 및 잔여 사항

- 업데이트 계약 및 FIX_03 회귀: `.venv/bin/python -m pytest -x -q tests/test_codex_update_fix03.py tests/test_codex_update_contract.py` → **116 passed**.
- 전체 suite 최초 실행: **257 passed, 1 skipped, 1 failed**. 실패는 `Unreleased` changelog heading이 App 버전 검사와 충돌한 것이며 heading을 수정했다. 수정 후 해당 검사와 FIX_03 테스트 → **8 passed**. 전체 suite는 수정 후 재실행하지 않았다.
- `node --check` 대상 JS 3개, wrapper `shellcheck`, `git diff --check`, 변경 Markdown 15개 lint 통과.
- `docker build --platform linux/amd64 --tag codex-for-home-assistant:fix03 codex_home_assistant` 성공. `tests/codex-update-smoke.sh`는 Docker의 AppArmor profile 적용 실패로 시작하지 못했다. `tests/docker-smoke.sh`는 App을 시작했으나 container의 bubblewrap이 `RTM_NEWADDR: Operation not permitted`로 실패해 완료하지 못했다. 이는 AppArmor 수용 성공 근거가 아니다.
- HAOS 실제 App, 모바일 Remote, 실모델, native arm64, AppArmor 적용 환경의 수용 시험 및 장시간 운용은 수행하지 않았다. 외부 push, PR, release 및 실제 HA 변경은 하지 않았다.
