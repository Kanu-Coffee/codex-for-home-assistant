# FIX_11 — 관리형 CLI endpoint의 실제 WebSocket 연결

## 1. 판정

Reviewer: Codex, 2026-10-29. HEAD `5529c66` 위 현재 working tree, FIX_10_REPORT 및 이전 handoff를 기준으로 **REQUEST CHANGES / CLI 실기기 dev 배포 전 보완 필요**로 판정한다. 제품 코드는 수정하지 않았다.

빈 대화 재생성과 ID 매핑은 진전이다. 이전 공식 0.162.1→0.164.0 격리 probe를 기반으로 같은 연결의 `thread/read`가 성공함을 확인했다. 추가로 내용 없는 대화 상태에서 다시 0.162.1로 worker를 전환하는 시험도 성공했다. 이는 실제 모델 응답·전체 scheduler·CLI 수용의 증거는 아니지만 이전 빈 대화의 즉각적인 read 실패는 개선됐다.

채팅창·연결 존재는 업데이트 보류 사유가 아니라는 사용자 기준은 유지한다. 이번 지적은 유휴 차단을 복원하라는 요구가 아니라 새로 만든 CLI 연결을 실제로 동작시키라는 요구다.

## 2. P1 — raw JSON socket에 WebSocket frontend를 연결하여 CLI 기동 불가

**위치:** `codex-session-host.mjs`의 `start()` / `_startClientSocketServer()` 및 wrapper의 `--client-socket`·`--spawn-client` 경로.

`start()`는 공식 frontend를 `codex --remote unix://<clientSocket>`으로 실행한다. 그러나 `_startClientSocketServer()`는 `node:net.createServer`로 raw socket을 열고 모든 바이트를 newline JSON parser인 `_handleClientData()`에 바로 넘긴다. HTTP Upgrade나 WebSocket frame 처리가 없다.

공식 frontend는 Unix socket에서도 WebSocket을 사용한다. 따라서 첫 HTTP handshake가 JSON parser에서 사라지고 `101` 응답을 받지 못한다. 이후 정상 initialize/thread 요청으로 진행할 수 없다. 단순 socket 생성과 TTY 상속만으로 TUI 연결이 완성되는 것은 아니다.

### 독립 실제 비교 재현

`.test-tmp/review006-fix10/handshake.py`는 임시 HOME/CODEX_HOME과 socket에서 다음 두 endpoint에 동일한 유효한 WebSocket Upgrade 요청을 보냈다.

1. 공식 0.162.1 `codex app-server --listen unix://<path>`.
2. 현재 production host `node codex-session-host.mjs --client-socket <path> --type cli --exe <공식 codex> -- app-server`.

```text
official HTTP/1.1 101 Switching Protocols
relay HANDSHAKE_TIMEOUT
```

실제 계정이나 모델·HA API는 사용하지 않았다. 생성한 테스트 프로세스만 정리했다. 로그는 Git 제외 `.test-tmp/review006-fix10/handshake.log`에 있다.

새 `test_fix10_idle_managed_cli_transitions_backend`는 `--type cli`만 주고 `--client-socket`/`--spawn-client`를 사용하지 않는다. 따라서 실제 frontend transport 없이 stdio relay를 CLI로 분류하고 switch하는 경로를 검사한다. CLI endpoint나 TUI가 연결됐다는 증거가 아니므로 보고서의 CLI 완결·TTY 완벽 보존 주장은 다음 보고서에서 정정한다.

### 구현 지시

- 공식 frontend가 사용하는 HTTP Upgrade 및 WebSocket frame과 backend stdio JSON 사이에 올바른 adapter를 구현한다. 프로젝트 image에는 고정된 `ws` 패키지가 `/usr/local/lib/codex-ha/playwright/node_modules/ws`에 이미 포함돼 있으므로 기존 의존성 사용 가능 여부를 먼저 확인한다. 전역 머신 패키지에만 의존하지 않는다.
- WebSocket message 단위와 stdio newline frame 단위를 구별하고, Unicode·fragmentation·ping/pong·close·backpressure 및 single-client 소유권을 처리한다. raw HTTP 바이트를 backend JSON parser에 전달하지 않는다.
- 실제 frontend가 연결한 socket과 worker 사이의 요청·응답으로 기존 activity ledger를 구동한다. 유휴·진행 요청·approval 상태가 실제 endpoint를 통과할 때 관측되도록 한다.
- frontend 정상 종료·연결 오류·재연결 시 backend와 control/session record를 일관되게 정리하고, listener가 중복되거나 정상 연결이 임의 교체되지 않도록 한다.

### 수용 기준

1. 실제 새 endpoint에서 HTTP 101 handshake와 initialize 왕복을 확인한다.
2. 공식 frontend를 PTY에서 `--remote unix://...`로 연결해 정상 화면과 요청·응답을 확인한다. 화면 프로세스 생존만으로 PASS하지 않는다.
3. wrapper가 사용하는 `--client-socket` 및 `--spawn-client`와 실제 세션 record를 포함하는 production 경로를 시험한다. 유휴 시 manager가 restartable로 인식하고 backend를 전환한 뒤 같은 frontend의 다음 요청이 정상 처리되어야 한다.
4. 요청 중·승인 대기·queued 입력은 보류하고 작업 종료 후 다음 허용 검사에서 적용한다. 유휴 상태의 빈 대화와 저장된 대화 모두 다음 입력이 가능해야 한다.
5. 기존 stdio transport·ID 매핑·rollback·부분 frame 회귀를 유지한다. 새 테스트는 raw stdio 성공을 WebSocket CLI 성공으로 대신하지 않는다.

## 3. 검증 범위와 다음 인계

- 이번 Reviewer는 빈 대화 read 및 연속 worker 교체의 공식 pair 시험과 위 실제 WebSocket handshake 비교를 실행했다. 독립 전체 pytest **264 passed, 1 skipped in 122.61s**, JS 3개 syntax·wrapper ShellCheck·`git diff --check`·리뷰 Markdown lint·Gitleaks PASS. 테스트 통과는 실제 endpoint가 연결된다는 증거가 아니다.
- Docker 신규 build·HAOS/mobile·native ARM·실모델·장기 수용은 이번에 수행하지 않았다. 외부 게시 및 사용자 장치 변경은 하지 않았다.
- 다음 Executor는 이 endpoint 결함을 수정하고 `FIX_11_REPORT.md`를 신규 작성한다. 이전 문서를 덮어쓰지 않는다.
- 정상 frontend 연결과 유휴 전환을 인수하면 기존 dev 배포 절차로 실제 설치 가능한 버전·저장소 및 실기기 시험 안내를 전달한다. 실기기 수용을 dev 게시 전에 완료한 것처럼 요구하지 않는다. 현재 endpoint가 연결되지 않아 dev 배포 지시 조건은 충족되지 않았다.
