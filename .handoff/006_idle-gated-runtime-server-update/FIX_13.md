# FIX_13 — ephemeral 대화의 실제 내용 보존

## 1. 판정과 사용자 dev 시험 요청

Reviewer: Codex, 2026-10-29. HEAD `5529c66` 위 현재 working tree, PLAN 및 FIX_01~12/대응 보고서를 검토했다. **FIX_12의 TUI 전환 실패 보완은 인정 / REQUEST CHANGES — 대화 내용 유실 1건**. 제품 코드를 수정하지 않았다.

사용자는 필요시 HAOS VM이나 새 dev를 사용한 운영 시험을 허용했으며, HAOS가 업데이트로 인식하도록 이전 설치 버전보다 높은 version을 게시해야 한다. 이 조건을 후속 배포 인계에 유지한다. 현재 결함은 격리 공식 바이너리로 확인돼 운영환경에 노출하지 않고 먼저 보완할 수 있다. VM이나 사용자 실장비에서만 발견할 수 있는 문제로 미루지 않는다.

FIX_12는 path 없는 ephemeral thread를 resume하느라 실패하던 원래 문제를 해소했다. 채팅창·연결·빈 대화 자체를 업데이트 보류 사유로 되돌리지 않는다. 아래 correction은 ‘빈 대화’와 ‘내용이 있는 ephemeral 대화’를 구별해 사용자 기록을 보존하는 작업이다.

## 2. P1 — 기본 read의 빈 turns 배열을 근거로 내용 있는 대화를 빈 대화로 재생성

**위치:** `codex-session-host.mjs`의 `switchWorker()` preflight (`thread/read` 호출 및 ephemeral/ENOENT의 turns.length 검사), `emptyThreads` 재생성과 ID 매핑.

기본 `thread/read`는 과거 turn을 모두 가져오는 호출이 아니다. 현재 코드는 이 응답의 turns=[]만으로 내용 부재를 판단하여, 실제로 이미 대화한 ephemeral thread도 빈 `thread/start`로 대체한다. client ID를 투명하게 유지하므로 read와 다음 turn은 성공하는 것처럼 보이지만 모델에 전달되는 대화 문맥이 사라진다. FIX_12_REPORT가 미검증으로 남긴 위험이 실제로 재현됐다.

### 공식 바이너리 비교 재현

Git 제외 `.test-tmp/review006-fix12/`에 `ephemeral-control.py`, `ephemeral-switch.py`, `ephemeral-same-version.py` 및 로그를 작성했다. 기존 합성 Responses SSE/production stdio relay probe를 사용해 `thread/start`에 `ephemeral:true`를 지정하고 다음 순서로 실행했다.

1. 격리 HOME/CODEX_HOME에서 공식 0.162.1 worker를 시작한다.
2. ephemeral thread에서 고정된 합성 첫 메시지를 보내고 합성 응답 완료 및 busy=false를 기다린다.
3. control 시험은 worker를 유지한다. switch 시험은 공식 0.164.0으로 교체한다. 추가 시험은 동일 0.162.1로 재시작해 버전 차이를 통제한다.
4. 같은 client thread ID에 두 번째 메시지를 보내고 localhost 모델 서버가 받은 요청에 첫 합성 메시지가 포함되는지만 출력한다. 실제 사용자 본문·계정·원격 모델·HA API는 사용하지 않았다.

관찰:

```text
control (worker 유지):       request_count=2, previous_prompt_in_last_request=True
0.162.1 → 0.164.0 switch:    success=True, read=ok, next turn=accepted,
                             previous_prompt_in_last_request=False
0.162.1 → 0.162.1 restart:   success=True, read=ok, next turn=accepted,
                             previous_prompt_in_last_request=False
```

직접 control switch의 기능적 대조 시험이며 실제 scheduler나 HAOS 전체 수용 시험이 아니다. 다음 요청이 accepted라는 결과만으로 기록 보존을 증명할 수 없다는 점을 확인한다.

## 3. 필요한 보완

- ‘기본 read의 turns=[]’와 ‘이 thread가 정말 내용 없는 상태’라는 사실을 구별한다. 알려진 client/thread lifecycle 원장·공식 지원 history 조회·실제 생성/turn 관측 등 검증된 근거로 분류한다. read 실패나 불명확한 상태를 빈 대화로 대체하지 않는다.
- 내용이 있는 ephemeral 대화는 문맥을 보존하는 지원 경로로 인계한다. 공식 protocol이 그것을 지원하지 않는 상태라면 해당 구체적 상태의 명시적 제한으로 처리하고, 이를 모든 열린 창/빈 대화의 blanket 보류로 확대하지 않는다. 모르는 사용자 대화 내용을 조용히 없애면서 업데이트 성공으로 보고하지 않는다.
- 내부 일회성 ephemeral 작업을 종료·재생성할 수 있다면 실제 소유권·용도·종료 여부를 구별한다. ephemeral이라는 flag만으로 모든 대화가 폐기 가능하다고 가정하지 않는다.
- 정상 전환뿐 아니라 후보 실패 후 rollback에도 같은 내용 보존 조건을 적용한다.
- 회귀는 빈 ephemeral, 실제 turn을 완료한 ephemeral, 저장된 대화를 구분한다. 모델 서버가 받은 다음 요청의 문맥 및 답변을 검사한다. 프로세스 생존·thread/read 성공·turn/start accepted만 검사하지 않는다.

## 4. 수용·dev 배포 인계

빈 대화 및 실제 작업 없는 연결에서는 정상 적용하고, 내용 있는 대화의 다음 요청에는 이전 문맥이 유지되어야 한다. 실제 진행/queued/approval/tool/background는 기존대로 보호한다. FIX_12의 실제 TUI 재현을 다시 실행하고, wrapper/manager/scheduler 연결과 기본 업데이트 경로의 검증도 기록한다.

다음 Executor는 이 1건을 수정한 뒤 `FIX_13_REPORT.md`를 신규 작성한다. 이전 보고서와 task 005·006 이력은 보존한다. 인수 가능한 상태가 되면 dev 배포로 전환하며 다음을 지시한다.

- remote와 사용자가 설치한 DEV의 기존 version을 확인하고 그것보다 높은 미사용 dev version을 설정한다. 같은 version/image를 덮어써서 HAOS 업데이트가 보이기를 기대하지 않는다.
- config/Dockerfile/runtime version·changelog·양언어 안내를 일치시키고 CI/native build 및 image 게시 검증 뒤 공개 dev 저장소에서 새 version이 보이는지 확인한다.
- 정확한 설치 버전·저장소·실기기 시험 절차를 전달한다. HAOS/mobile 실기기 수용은 게시 후 운영 테스트로 남기며 사전 PASS로 기록하지 않는다. 사용자 장치를 직접 업데이트하거나 stable로 승격하지 않는다.

## 5. 이번 검증 범위

공식 바이너리와 localhost 합성 모델의 대조 시험, JS 3개 syntax·wrapper ShellCheck·`git diff --check`를 실행했다. 독립 전체 pytest **266 passed, 1 skipped in 133.83s**, 리뷰 Markdown lint·Gitleaks PASS. HAOS VM은 조회 시 shut off였으며 시작·변경하지 않았다. 이번 결함은 로컬에서 재현돼 VM/운영 장치 검증으로 대체하지 않았다. Docker 신규 build·native ARM·실제 모델·HAOS/mobile·장기 운용 및 외부 배포는 수행하지 않았다.
