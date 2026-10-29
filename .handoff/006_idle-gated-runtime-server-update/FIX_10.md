# FIX_10 — 유휴 전환 후 요청 처리와 CLI 경로

## 1. 판정

Reviewer: Codex, 2026-10-29. HEAD `5529c66` 위 현재 working tree, PLAN 및 FIX_01~09/대응 보고서를 기준으로 재리뷰했다. **REQUEST CHANGES / dev 배포 전 보완 필요**. Reviewer는 제품 코드를 수정하지 않았다.

FIX_09의 사용자 clarification을 유지한다. 채팅창·연결·로드된 대화·미저장 빈 대화 자체는 업데이트 보류 사유가 아니다. 실제 진행·대기 작업만 보호한다. 불필요한 loaded-thread 및 blanket gate 제거는 방향에 맞는 개선이다. 아래 지적을 이유로 해당 gate를 복원하지 않는다.

## 2. P1 — 빈 대화를 제외하기만 하여 전환 성공 후 첫 요청이 실패

**위치:** `codex-session-host.mjs:365-380,491-501`, 새 `test_fix09_idle_session_with_persisted_and_empty_threads_transitions_backend`.

현재 미저장 대화는 resume 목록에서 제외하고 신규 worker를 시작한다. client는 기존 thread ID를 계속 사용하지만 신규 worker에는 그 대화가 없다. 따라서 단순 제외만으로 빈 대화 처리가 완료되지는 않는다.

### 공식 바이너리 독립 재현

기존 격리 probe를 현재 production relay 코드로 다시 실행했다:

```sh
python3 .test-tmp/fix03/stdio_probe.py
```

별도 HOME/CODEX_HOME, 실제 계정 없이 localhost 외부 연결 차단 환경의 공식 x86_64-musl 바이너리를 사용했다. binary SHA-256은 이전 공식 package 검증 기록과 일치했다.

- 0.162.1 `628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1`
- 0.164.0 `b93f6811d3f653f0fb83be4050d857fb9abbb111dfa2ce160563327daff7f306`

실제 결과:

```text
thread_start ok status idle
before busy=false, unknown=false, version=0.162.1
switch success=true, version=0.164.0
post_thread_read thread not loaded: <thread ID>
post_turn_start thread not found: <thread ID>
```

로그는 Git 제외 `.test-tmp/review006-fix09/official-empty.log`에 있다. 오류가 모델 호출 전에 발생하므로 실제 inference를 수행하지 않았다. 이 시험은 scheduler 전체 인수 증거가 아니라 전환 후 사용 불가의 독립 재현이다.

새 계약 테스트는 `thread/turn/start`라는 요청을 threadId 없이 보내며 합성 worker가 임의 요청에 무조건 성공 응답한다. 실제 `turn/start`와 기존 threadId의 조합을 검사하지 않아 이 오류를 놓친다. ‘빈 대화 안전 처리·후속 요청 처리 검증 완료’라는 보고는 정정해야 한다.

### 수정과 수용

- 빈 대화를 이유로 업데이트를 보류하지 않는다. 빈 대화의 재생성/ID 매핑 또는 frontend의 지원되는 재연결·대화 초기화 흐름을 구현해 다음 실제 요청이 신규 worker에서 처리되게 한다. 기록이 있는 대화와 빈 대화를 구별하며 저장된 대화 내용은 보존한다.
- 파일 조회의 모든 오류를 빈 대화로 취급하지 않는다. 예컨대 EACCES·unsafe path·기록 파일 손상은 단순 ‘내용 없는 대화’의 근거가 아니다. UI 열림이 아닌 실제 오류로 보고한다.
- 실제 `turn/start`와 client가 보유한 threadId를 사용하는 상태 검증 합성 worker 및 공식 pair로 확인한다. 빈 대화·저장된 대화 모두 전환 뒤 다음 요청이 처리돼야 한다. 신규 worker PID/version 확인만으로 성공 처리하지 않는다.
- rollback에서도 client가 다음 요청을 보낼 수 있어야 한다. 현재 성공/rollback이 같은 skip 목록을 사용하는 점을 함께 검증한다.

## 3. P1 — 일반 CLI/TUI는 여전히 프로세스 생존만으로 업데이트 보류

**위치:** `/usr/local/bin/codex:183-197` 및 일반 direct exec, `codex-runtime-manager.mjs`의 CLI 집계 분기.

wrapper가 control socket을 설정하는 것은 `app-server` stdio 경로뿐이다. 일반 CLI/TUI는 `managed:false`/control socket 없음으로 direct exec되고, manager는 `active registered session` 또는 `active codex cli process`를 busy로 추가한다. 실제 진행 요청이 없어도 같은 결과다. 즉 사용자 clarification의 CLI/TUI 범위는 아직 구현되지 않았다.

**수정:** 일반 CLI/TUI도 실제 backend 작업 상태를 관측하고 유휴 시 기존 스케줄이 적용하도록 실제 launch 경로를 연결한다. UI focus·키보드 입력 대기 자체를 작업으로 세지 않는다. 단순히 CLI 프로세스를 inventory에서 무시해서 진행 중인 turn/tool을 종료하지 않는다. backend/실제 작업의 소유권을 확인하는 방식으로 구현한다.

**수용:** 웹/SSH CLI를 열고 아무 요청도 하지 않을 때 scheduler 적용·재시작 후 다음 요청이 정상 동작해야 한다. 진행 요청/queued/approval/tool/background는 보류하고 종료 후 적용한다. CLI가 켜져 있다는 이유만으로 계속 pending되는 상태를 완료로 보고하지 않는다.

## 4. 인수·dev 배포 범위

- 이번 변경은 loaded 대화를 작업과 혼동한 조건을 제거했지만, 다음 요청 성공 및 CLI 정상 경로는 남아 있다. 전환 성공을 위해 빈 대화의 완벽한 메모리 이관을 요구하는 것이 아니라 실제 사용 가능성을 확인하는 것이다.
- 일반 Unix socket 경로도 stop/relaunch만으로 다음 요청이 정상이라는 증거는 아니다. 새 진단 연결에서 idle이라는 결과와 원래 client의 재연결·후속 요청을 구별해 검증한다. 실제 요청이 들어오는 동안 stop하는 경합도 기존 지시대로 보호한다.
- transaction의 selection commit을 worker 준비 전으로 옮긴 변경이 crash/실패에서 어떤 상태를 남기는지 증거를 남긴다. 보고서의 ‘완전히 보장’ 표현은 실제 검증 범위에 맞게 정정한다.
- 다음 Executor는 위 두 P1을 수정하고 `FIX_10_REPORT.md`를 신규 작성한다. 보고서·과거 handoff를 덮어쓰지 않는다.
- 이 보완을 인수하면 기존 dev 게시 절차로 사용자 설치 가능한 버전·저장소와 실기기 시험 절차를 전달한다. HAOS 실기 수용 자체를 dev 배포 전 완료한 것처럼 요구하지 않는다. 현재는 다음 입력 실패와 CLI 차단이 있어 dev 배포 지시 조건 미충족이다.

## 5. 이번 검증

독립 전체 `.venv/bin/python -m pytest -q` → **263 passed, 1 skipped in 110.78s**. JS 3개 각각 `node --check`, wrapper `shellcheck`, `git diff --check`, 리뷰 Markdown lint·Gitleaks PASS. 전체 테스트 통과와 위 실제 공식 바이너리 오류를 구별한다. Docker 신규 빌드/native ARM/HAOS/mobile·실모델·장기 수용은 이번 Reviewer가 실행하지 않았다. 외부 게시와 사용자 장치 변경은 하지 않았다.
