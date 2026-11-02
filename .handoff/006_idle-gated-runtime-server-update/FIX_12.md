# FIX_12 — 실제 TUI의 ephemeral thread 전환 처리

## 1. 판정과 개선 인정

Reviewer: Codex, 2026-10-29. HEAD `5529c66` 위 현재 working tree, FIX_11_REPORT 및 이전 handoff를 검토했다. **WebSocket 연결 결함 해소 / REQUEST CHANGES / 실제 TUI 전환 1건 보완 필요**. 제품 코드는 수정하지 않았다.

공식 0.162.1 endpoint와 새 production endpoint가 동일한 요청에 HTTP 101을 반환함을 독립 확인했다. 기존 handshake 비교 helper는 양쪽 101을 확인한 뒤 임시 CODEX_HOME 삭제 중 background 파일 생성과 충돌해 종료 오류가 있었으므로 전체 helper를 clean PASS로 기록하지 않는다. 별도 실제 frontend 시험에서는 production endpoint에 연결한 공식 TUI 화면·첫 합성 요청/응답이 정상 진행됐다. FIX_11의 raw socket 문제는 다시 지적하지 않는다.

채팅창·연결·빈 대화의 존재는 업데이트 보류 사유가 아니라는 사용자 기준을 유지한다. 아래 correction은 ephemeral 대화 때문에 업데이트를 무기한 막는 대신 정상 전환 후 계속 사용할 수 있게 처리하는 작업이다.

## 2. P1 — path 없는 ephemeral thread를 persisted resume 대상으로 오분류

**위치:** `codex-session-host.mjs`의 `switchWorker()` preflight에서 `thread.path`가 없는 경우 `threadsToResume.push(serverThreadId)`하는 else, 신규 worker 및 rollback의 resume 루프.

현재 빈 대화 처리는 ‘문자열 path가 있으나 파일이 없는 경우’를 중심으로 동작한다. 실제 TUI가 만든 `ephemeral:true` 및 path 없는 thread는 else로 빠져 디스크 복원이 필요한 `thread/resume` 대상에 들어간다. 후보뿐 아니라 rollback도 같은 목록으로 복원을 시도해 둘 다 실패한다.

### 실제 frontend + 공식 pair 독립 재현

Git 제외 `.test-tmp/review006-fix11/tui_production_probe.py`는 이전 synthetic-model/PTY probe를 현재 production `codex-session-host.mjs --client-socket ... --type cli --exe <0.162.1> -- app-server`에 연결하도록 바꾼 시험이다. 임시 frontend는 공식 `codex --remote unix://...`이며, 격리 HOME/CODEX_HOME과 localhost의 합성 Responses SSE 서버를 사용했다. 실제 계정·실모델·HA API는 사용하지 않았다.

관찰 결과:

```text
front_ready=true, control_ready=true
TUI 화면 정상 및 첫 합성 요청 도달
before busy=false, unknown=false, version=0.162.1, loaded threads=2
switch to 0.164.0:
  resume_failed: ... no rollout found for thread id <ephemeral ID>
  rollbackStatus=rollback_incomplete
후속 입력: 합성 서버 도달 요청 수 0, TUI 프로세스는 살아 있음
```

추가 재현에서는 별도 launcher에서 production `_sendInternalRpc`를 감싸 read 응답의 metadata만 기록했다. 제품 파일은 수정하지 않았고 prompt·응답 본문은 수집하지 않았다 (`trace-host.mjs`, `tui_trace_probe.py`, `thread-metadata.log`). 다음 두 thread가 관찰됐다:

```text
thread 1: ephemeral=false, pathPresent=true, pathExists=true
thread 2: ephemeral=true,  pathPresent=false, pathExists=false, turns=[]
candidate thread/resume(thread 2): no rollout found
rollback thread/resume(thread 2):  no rollout found
```

즉 TUI 연결이나 HTTP 101 문제가 아니라, 실제 TUI에서 생기는 ephemeral thread의 복원 분류 문제다. 프로세스 생존은 다음 요청 성공의 증거가 아니다.

## 3. 구현 지시와 수용

- read metadata의 ephemeral/path 유무를 명시적으로 분류한다. 디스크 rollout이 없는 ephemeral thread를 무조건 persisted resume 루프에 넣지 않는다. 알 수 없는 read 오류를 ‘복원 가능’으로 삼키지 않는다.
- 해당 thread의 실제 용도·상태에 맞는 재생성/ID 매핑 또는 정상 lifecycle 정리를 구현한다. 사용자 기록은 보존하고 사용 중인 요청은 보호한다. idle ephemeral/내용 없는 대화가 있다는 이유로 이전 blanket gate를 복원하지 않는다.
- 신규 worker와 rollback이 같은 잘못된 resume 대상을 사용하지 않게 한다. 이미 실패한 후보 이후 old 복원에서도 사용자 입력을 받을 수 있도록 검증한다.
- 합성 worker도 `ephemeral:true,path:null/미지정` 및 영속 thread를 함께 제공하고, 실제 thread 상태에 맞는 `turn/start`를 검사하도록 한다. 기존 파일 없음 case만으로 ephemeral 전체 지원을 입증하지 않는다.
- 위 실제 공식 TUI/production endpoint 경로로 첫 요청 완료→유휴 확인→worker 전환→같은 frontend의 다음 요청이 합성 서버에 도달하고 응답을 받는 것을 확인한다. 이 시험을 통과하기 전 ‘실제 TUI 전수 검증 완료’로 보고하지 않는다.
- `--spawn-client`/wrapper 경로와 manager의 active/idle 인식도 확인한다. direct control switch 성공과 scheduler 전체 성공은 보고서에서 구별한다.

이번 보완은 새 UI 관측·완벽한 frontend 메모리 이관을 요구하는 것이 아니다. 공식 TUI가 이미 연결·요청 처리까지 진행되는 구현에서, 실제로 나타난 빈 ephemeral thread의 잘못된 resume 분기를 고치는 것이다.

## 4. 다음 인계·dev 배포

다음 Executor는 이 1건을 수정하고 `FIX_12_REPORT.md`를 신규 작성한다. 기존 handoff는 보존한다. 인수 후 사용자 설치 가능한 dev 게시 단계로 인계한다. HAOS 실기 수용은 dev 게시 후 사용자가 수행할 시험으로 남기며 미실행을 PASS로 쓰지 않는다. 현재는 로컬 실제 frontend의 전환/rollback이 실패해 dev 배포 지시 조건을 충족하지 못했다.

이번 Reviewer는 독립 전체 pytest와 JS/Shell 정적 검사 결과를 progress에 기록한다. Docker 신규 build·native ARM/HAOS/mobile·실모델·장기 수용은 수행하지 않았고 외부 게시나 사용자 장치 변경은 하지 않았다.
