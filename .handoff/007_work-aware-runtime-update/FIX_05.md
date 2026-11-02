# FIX_05 — FIX_04 재리뷰: 연결 신원·listener 진단·실제 turn 수용 미달

작성일: 2026-11-02 (Asia/Seoul)
Reviewer: Codex
대상: `5822cc0` / `feat/fix03-mobile-proxy-bootstrap`
판정: **REQUEST CHANGES — 신규 DEV 배포 지시 보류**

## 1. 검토와 수용된 변경

사용자의 Reviewer 지시에 따라 이전 PLAN/REPORT/FIX 이력, FIX_04_REPORT, progress, 현재 Git 상태와 `ae6814a..5822cc0` 변경을 검토했다. 이번은 리뷰·보완 문서 발행이며 제품 코드·버전·외부 Git·운영 HA는 변경하지 않는다.

수용한 부분:

- 실제 proxy argv와 launch record의 type/target 불일치를 unknown으로 처리하는 수정.
- SSH auth를 실제 관측 없이 verified로 표시하지 않고 not_checked로 바꾼 수정.
- 키 주석/불일치 진단과 SSH wire 시험의 deadline·stderr 정제 개선.
- 추가된 다중 RPC, 두 binary 버전 fixture 및 합성 작업 보류 회귀.

그러나 아래 세 사항이 FIX_04의 기존 필수 조건을 충족하지 못한다. 다음 Executor는 FIX_05를 수행하고 `FIX_05_REPORT.md`를 신규 작성한다. 과거 handoff 문서는 수정하지 않는다. 통과 후 재리뷰에서 다음 번호 FIX로 새 DEV 배포를 지시한다. 이번 문서는 dev.6 등 배포 승인이 아니다.

## 2. [P1] 실제 연결된 peer 대신 현재 alias 경로로 owner를 결정

위치: `codex-runtime-manager.mjs:1516` 이후 owner 탐색.

argv/record 일치는 보완됐으나 owner 탐색은 여전히 `realpath(candidateSock) === realpath(targetSock)` 또는 resolve 경로 비교와 후보 kind만 사용한다. 현재 파일 시스템 경로가 기존 연결의 상대 서버를 증명하지는 않는다.

### Reviewer 독립 재현

Git 제외 `.test-tmp/review007-fix04/alias-owner.py`에서 다음을 실행했다.

1. 합성 Unix listener A와 별도의 idle managed server B를 실행한다.
2. alias → A인 상태에서 proxy 프로세스가 실제 Unix 연결을 연다. A의 accept 완료를 확인하고 연결을 유지한다.
3. proxy의 `/proc` argv 및 launch record는 **동일한 alias 경로**다. 이전 FIX의 단순 mismatch가 아니다.
4. alias만 B로 바꾼 뒤 `inspectAllSessions`를 호출한다.
5. 기존 연결은 A에 그대로 남아 있는데 helper=1, unknown=0, canApply=true가 반환된다. proxy를 무관한 idle B의 helper로 인정했다.

이 재현은 실제 사용자 작업 중단이나 공식 proxy의 turn 실패를 증명한 것은 아니다. 그러나 실제 접속 대상과 다른 서버의 상태로 proxy를 제외할 수 있어 신원 검증 조건이 충족되지 않는다. 실제 IPC 연결도 갖지 않는 기존 정상 helper fixture만으로 소유권을 검증했다고 보고하면 안 된다.

### 보완

- 연결 신원을 실제 peer와 결합한다. 단순 realpath 일치·PID 생존만으로 helper 승격하지 않는다.
- 가능한 최소 설계를 선택한다: 실제 peer/listener의 신원을 검증하거나, 검증된 관리형 raw transport/등록 절차로 연결 세대를 고정하는 방식을 검토한다. alias를 허용해야 한다면 연결 당시 해석한 대상과 세대를 보존하고 retarget/rebind를 감지한다. 신원 확인에 필요한 금지 권한을 새로 주지 않는다.
- SO_PEERCRED/Unix socket 정보 등 선택한 방법의 적용 가능성과 권한을 실제 환경에서 확인한다. 특정 API가 Node/HAOS에서 지원된다고 가정하지 않는다. 기술 제약이 있으면 근거와 안전한 대안을 보고한다.
- 증명 불가 상태는 unknown으로 보류하고 정확한 이유를 표시한다. 모든 정상 proxy를 영구 busy로 만들어 유휴 업데이트 목표를 포기하지 않는다.
- 정식 회귀: 실제 연결 A 유지 중 alias→B, socket pathname 재사용, 정상 실제 proxy, stale owner/peer 종료. 실제 관측 대상의 작업이 보류 조건에 포함되는지 확인한다.

## 3. [P2] 다른 살아 있는 PID도 SSH listener로 오판

위치: `codex-remote-setup.mjs:188~194`.

현재 `/run/sshd.pid`의 숫자에 `process.kill(pid, 0)`이 성공하면 `active / listening`을 표시한다. 이는 임의 프로세스의 생존 검사일 뿐 sshd 신원 또는 listening 검사가 아니다.

### Reviewer 독립 재현

```bash
docker run --rm --entrypoint /bin/bash codex-ha:test-fix04 -ec \
  'install -d -m 0700 /data/ssh; printf "%s\n" "$$" > /run/sshd.pid; ha-codex-remote status'
```

sshd가 없는 컨테이너에서 PID 파일은 bash를 가리키는데 `SSH service: active / listening`이 출력됐다. 출력에는 private/public 키 모두 absent라고 함께 표시된다.

### 보완

- 가장 작은 안전한 수정은 관측 범위대로 `pid_present / listener not_checked`라고 표시하는 것이다. 실제 listening을 주장하려면 PID/start-time·실행 파일 신원·listener를 확인한다.
- stale PID, 다른 executable PID, 0/잘못된 PID, sshd 생존하지만 listener 미확인, 정상 sshd를 구분한다. 없는 관측은 unknown/not_checked로 표현한다.
- `tests/test_remote_setup.py`에서 실제 status 함수를 호출해 검증한다. 현재 comment/mismatch 시험 일부는 파싱 로직을 시험 안에서 다시 작성해 boolean만 확인하며 실제 status 출력을 검사하지 않는다. 0400, marker 있음, 실제 active 상태를 모두 검증했다는 보고도 시험 코드와 일치시키거나 해당 시험을 추가한다.
- 임시 PID 파일은 시험 컨테이너에만 쓴다. 운영 `/run/sshd.pid`를 변경하거나 사용자 SSH를 중단하지 않는다.

## 4. [P1] 다중 조회 RPC는 실제 대화와 업데이트 후 복원 검증을 대체하지 않음

위치: `tests/mobile-ssh-smoke.py` 다중 요청 부분, `tests/test_codex_wrapper_proxy.py:179~203` 및 새 updater fixture.

현재 구현은:

- 실제 SSH: initialize → diagnostics → model/list → config/read → EOF.
- host official binary: initialize → thread/start → thread/read → EOF.
- updater: 합성 gauge를 busy/idle로 바꿔 canApply를 검사.

위 경로에는 실제 `turn/start`, mock provider의 응답, 다음 turn의 문맥 보존, 실제 owner/worker 전환 뒤 후속 요청 검증이 없다. 빈 thread ID를 다시 읽는 것은 사용자 대화의 문맥 보존을 입증하지 않는다. 이전 FIX_04에서 이미 요구한 항목이며 새 요구가 아니다.

### 보완

1. 실제 제품 wrapper+SSH+raw proxy를 통한 turn을 로컬 mock Responses provider로 완료하고 다음 turn에 이전 문맥이 전달되는지 검사한다. 운영 auth나 유료 모델 호출은 사용하지 않는다.
2. 같은 실제 경로에서 응답을 지연하거나 승인/요청 대기 fixture를 두고 실제 updater가 보류하는지 확인한다. 실제 유휴 복귀 후에만 허용해야 한다.
3. 안전한 전환에서 실제 PID/실행 세대가 바뀌고 후속 요청이 처리되는지 검사한다. 필요하면 검증된 reconnect/resume 경로를 포함한다. `canApply=true`만으로 교체·복원이 수행됐다고 보고하지 않는다.
4. 일반 Docker의 namespace 제약이 막으면 원인을 분리하고 사용 가능한 격리 호스트/기존 mock provider fixture 등 대안을 채택한다. 제품 AppArmor/sandbox 요구를 완화하지 않는다. FIX_04_REPORT에 쓴 `RTM_NEWADDR` 설명은 왜 실제 turn 및 handover 시험을 다른 허용 환경에서도 할 수 없는지까지 입증한 것은 아니다.
5. 정말 구현·검증이 불가능하면 재현 명령·오류·환경과 기술 한계, 현업 영향 및 우회/요건 변경안을 구체적으로 보고한다. 모델 응답·전환 후 복원을 생략하고 “3대 영역 완전 해결”로 결론내리지 않는다.
6. baseline 0.162.1/제보 0.166.0 및 실제 wrapper 경로를 구분한다. 실제 ChatGPT 모바일/HAOS 수용은 로컬 시험과 별도다.

## 5. 문서·보고와 수용 기준

- 관련 회귀와 전체 suite, Node/ShellCheck, 변경 lint, secret scan, image build·실제 SSH smoke, diff를 수행한다. native ARM·custom AppArmor·HAOS/mobile 미수행은 그대로 남긴다.
- 과거 FIX_04_REPORT는 보존하고 정정·추가 결과를 FIX_05_REPORT와 progress에 기록한다. 현재 report의 코드 인용은 실제 implementation과 다른 필드도 있고 “커밋 대기”라고 하지만 현재 commit은 5822cc0이므로, 다음 보고서는 실제 source/이미지/binary identity와 정확히 맞춘다.
- 한국어·영어 사용자 문서와 changelog의 미배포 수정/제약을 갱신한다. 기존 자동 업데이트 스케줄, 키, 인증, Stable은 유지한다.
- 결과는 helper/owner 신원 근거, listener 관측 범위, 실제 첫/후속 turn·busy 보류·전환 후 요청의 개별 증거로 나눠 보고한다.

**합격 기준:** 위 세 항목을 해소하고 실제 수행한 검증만 보고한다. 기존 조회 RPC 성공과 합성 gauge 검증은 유효한 부분 성과지만 전체 수용 완료가 아니다. 재리뷰 합격 전에는 신규 DEV 배포용 FIX를 발행하지 않는다.

## 6. 이번 Reviewer 독립 검증

- 관련 pytest(`test_remote_setup.py`, `test_codex_wrapper_proxy.py`, `test_codex_update_contract.py`): **144 passed in 98.02s**. `.test-tmp/review007-fix04/pytest.log`.
- `python3 tests/mobile-ssh-smoke.py codex-ha:test-fix04`: **PASS** (현재 다중 조회 RPC 범위). `.test-tmp/review007-fix04-smoke.log`.
- alias 재지정 후 다른 서버 helper 오분류와, PID 파일이 bash를 가리킬 때 false listening 표시는 위 절차로 별도 재현했다. 시험 process·컨테이너는 정리했다.
- Node syntax 2개, wrapper ShellCheck와 diff 검사 PASS. 이번 Reviewer는 전체 pytest·새 image build·실제 turn/handover·native ARM/custom AppArmor/HAOS/mobile을 재실행하지 않았다.
- 위 144 PASS와 현재 smoke 성공은 확인된 부분 성과다. 이번 발견한 실패 재현이나 누락된 수용 항목을 해소하지 않는다.
