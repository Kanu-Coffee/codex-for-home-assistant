# FIX_04 — 프레임 경계·요청 ID 및 live 전환 잔여 작업

## 1. 판정

- Reviewer: Codex, 2026-10-28 (Asia/Seoul).
- 기준: HEAD `5529c66` 위 현재 working tree, PLAN/REPORT, FIX_01~03 및 대응 REPORT와 독립 재현.
- **REQUEST CHANGES / task 006 미완료**. 제품 코드는 수정하지 않았다. 다음 Executor는 이 문서를 수행하고 `FIX_04_REPORT.md`를 신규 작성한다. 기존 handoff와 취소된 task 005는 보존한다.
- FIX_03_REPORT가 부분 구현과 한계를 명시한 점은 인수한다. 안전 보류는 유지해야 하지만 사용자 목표인 유휴 CLI/TUI·Remote stdio 기존 backend 자동 전환의 구현 완료를 뜻하지 않는다.

## 2. 개선 인정과 독립 확인

| FIX_03 항목 | 판정 |
| --- | --- |
| H1 rollback 중 단일 writer | 후보 drain 실패 때 old 추가 spawn 금지·barrier 유지 및 preflight worker 사망 처리 개선 확인. 알려진 이중 writer 재현은 해소 |
| H2 이벤트 중복 및 identity | thread 상태와 turn ID 분리, metadata read 제외, worker start/parent/exe 및 socket 검증 개선. authoritative background/goal·snapshot/revision은 미완료 |
| H3 release·commit | release error를 applied로 삼키지 않고 journal을 보존하는 개선 확인. 자동 recovery 및 다중 host/late completion 인수는 미완료 |
| H4 공식 pair·stable endpoint 근거 | archive/binary SHA-256을 실제 파일과 대조했고 저장된 stdio 대화의 제한적 전환을 재실행했다. TUI 전환 불가능 주장은 철회된 것으로 인수. TUI의 성공적 live 전환은 미입증 |

- 독립 전체 `.venv/bin/python -m pytest -q` → **259 passed, 1 skipped in 108.90s**. Executor 보고서의 과거 전체 실패와 구별되는 이번 Reviewer 실행 결과다.
- JS 3개 `node --check`, wrapper `shellcheck`, `git diff --check` → PASS.
- `python3 .test-tmp/fix03/stdio_mock_probe.py` → baseline 0.162.1, 후보 0.164.0, `switch.success=true`, 같은 연결의 `thread/read` 성공 및 다음 `turn/start` 수락. 실제 모델·자동 scheduler·turn 완료·전체 CLI/TUI 수용의 증거는 아니다.
- timeout 뒤 늦은 control ACK 보조 시험에서는 relay가 생존했다. 이 결과만으로 crash/restart·다중 host 복구가 검증된 것은 아니다.
- 이번 Reviewer는 Docker build/smoke, HAOS/mobile, native arm64, 실모델·장시간 수용을 실행하지 않았다. Executor의 build 성공과 환경 오류 보고를 이 시험들의 PASS로 바꾸지 않는다.
- 독립 probe 및 로그는 Git 제외 `.test-tmp/review006-fix03/`에 있다. 아래 재현 입력·결과를 문서에 남겨 임시 파일 없이도 결함을 재구성할 수 있게 한다.

## 3. 필수 correction

### J1 — [P1] 청크 경계의 미완성 요청을 idle로 판정하고 worker 교체 후 요청 유실

**위치:** `codex-session-host.mjs:230-239`, `304-310`, `577-612`.

`_processAndForwardClientChunk`는 수신 청크를 즉시 old worker에 전달하지만, newline으로 완성된 JSON만 request ledger에 올린다. `_workState`는 `clientBuffer`의 미완성 프레임과 decoder의 미완성 UTF-8을 검사하지 않는다. 따라서 프레임 중간에 barrier가 들어오면 아직 응답하지 않은 요청의 앞부분은 old worker, 뒷부분은 new worker에 전달된다. 메모리에 문자열을 남겨 두는 것으로 backend의 프레임 상태가 복원되지 않는다.

**production relay + 실제 합성 child 재현:** readline으로 한 줄씩 JSON을 읽고 ID를 그대로 응답하며 HUP에서 종료하는 Node worker로 `StdioRelay.start({attachStdio:false})`를 실행한다.

1. `_handleClientData(Buffer.from('{"id":7,"method":"model/'))`.
2. inspect → `busy:false`, `inFlight:0`.
3. 같은 합성 worker를 후보로 `switchWorker` → `success:true`.
4. `_handleClientData(Buffer.from('list"}\n'))`.
5. 새 worker는 `list"}`만 받아 parse error를 반환하며 id=7은 ledger에 영구 잔류한다. 이번 결과: `partial_frame_parse_error`, `pending:true` (`partial-frame.log`).

**수정:** 전달·수락된 프레임의 generation 경계를 명확히 정의한다. 이미 old worker에 전달한 미완성 입력이 있으면 old에서 프레임과 응답을 정상 처리하기 전 교체하지 않는다. barrier가 그 프레임의 나머지 입력을 막는 교착도 피해야 한다. 완성 프레임 단위 전달 또는 안전한 전환 취소 등 구현을 선택할 수 있으나 앞부분 재전송으로 중복 실행을 만들어서는 안 된다. `serverBuffer`와 UTF-8 decoder의 경계, 늦은 old stdout도 generation별로 검토한다. buffer를 조용히 지워 해결하지 않는다.

**수용:** 한 JSON 요청을 모든 byte 경계와 한글 UTF-8 내부에서 나누고 barrier/switch와 교차시킨다. 전환을 보류하거나 같은 요청을 정확히 한 번 처리해야 한다. old에서 이미 받은 입력의 손실·중복, false success, stale server frame과 new initialize 응답의 결합이 없어야 한다. 현재 manager의 blanket gate는 이 결함을 자동 경로에서 막고 있지만 relay를 활성화하기 전 반드시 해결한다.

### J2 — [P2] 유효한 client 문자열 ID의 응답을 내부 RPC로 오인해 폐기

**위치:** `codex-session-host.mjs:629-637`.

서버 응답의 ID가 `__internal_`로 시작하면 실제 내부 pending RPC인지와 무관하게 무조건 `continue`한다. client가 보낸 유효한 문자열 요청 ID에도 적용되므로 평상시 stdio 경로에서 응답을 잃고 요청이 계속 busy로 남는다. 이 문제에는 worker 전환이 필요하지 않아 manager의 live gate로 방지되지 않는다.

**production parser 재현:** relay의 client 경로에 `{id:'__internal_client_1',method:'model/list'}`를 전달하고 server 경로로 `{id:'__internal_client_1',result:{data:[]}}`를 전달한다. 실제 결과는 `forwarded:''`, `requestStillPending:true`, `busy:true` (`client-id.log`).

**수정:** client ID와 내부 ID를 충돌 없이 매핑·복원하거나, 실제 내부 발급 ID만 식별하는 별도 원장을 사용한다. prefix 전체를 client에서 금지하거나 모르는 응답을 조용히 버리지 않는다. timeout된 내부 응답과 늦은 ACK가 실제 client 응답으로 새지 않도록 만료된 내부 ID 처리도 정의한다.

**수용:** 숫자/문자열 ID, `__internal_` prefix client ID, 내부 발급 ID와의 충돌 및 timeout 후 늦은 응답을 production 경로에서 검증한다. client ID·응답·순서가 보존되고 해당 client 요청이 pending에서 제거되어야 한다.

### J3 — [P1, 이월] 정상 유휴 세션의 자동 전환과 복구 경로 미구현

**위치:** `codex-runtime-manager.mjs:2352-2367`의 무조건 `compatibility_unverified` 반환, wrapper 일반 CLI direct exec 경로, transaction recovery.

모든 restartable live server는 유휴여도 반환되며, 아래의 실제 `restartServers` 분기는 현재 도달할 수 없다. CLI/TUI는 여전히 직접 실행되어 프로세스 종료까지 보류된다. 현재 fail-closed 처리는 안전성 개선으로 인정하지만 원래 사용자 요구의 구현 완료는 아니다. 이 항목은 신규 안전 결함으로 재분류한 것이 아니라 FIX_03 H2/H3/H4의 명시적 미완료를 다음 작업으로 인계하는 것이다.

**다음 작업:** gate를 단순 제거하지 않는다. 실제 검증된 version pair와 capability에 한해 stable endpoint 및 같은 대화의 복원을 제품 경로에 연결한다. 미저장/ephemeral 대화, per-thread model/config/policy 및 subscription, background/goal 관측과 새 요청 admission을 함께 다룬다. journal에는 host별 이전/현재 generation과 실제 phase를 재확인해 recovery를 끝낼 수 있는 정보를 보존하고, updater 재시작·ACK 유실·부분 release에서 진행 중 작업을 종료/재실행하지 않는 복구 경로를 구현한다.

현재의 `thread/resume` 실패는 해당 구현/조합의 제한이며 stable endpoint 또는 목표 전체의 기술적 불가능성 증거는 아니다. 구현을 막는 upstream 제약이 남으면 필요한 최소 변경과 재현 가능한 근거를 보고하고 task를 미완료로 유지한다. 별도 머신의 전역 `openclaw` 설치와 Git 제외 probe에만 의존하지 않도록 공식 package pair 실험의 보조 코드·환경·입력과 결과를 저장소 테스트 관례에 맞게 전달한다. 제품에 시험용 의존성을 무조건 추가하라는 뜻은 아니다.

**수용:** 최소 하나의 공식 검증된 pair에서 실제 CLI/TUI와 Remote stdio 모두 자동 scheduler가 기존 idle backend를 전환하고, 같은 frontend/대화의 다음 요청을 새 backend가 정상 처리함을 확인한다. active/queued/approval/background는 보류하고 완료 후 유휴가 해소되어야 한다. 재시작·timeout·부분 host 전환의 actual phase 및 identity를 확인해 복구하며 허위 applied/restored를 금지한다. HAOS/mobile·native ARM·AppArmor 실기는 기존 PLAN처럼 별도 미검증 상태를 유지한다.

## 4. 다음 인계

- J1/J2의 회귀와 J3의 미완료 범위를 `FIX_04_REPORT.md`에 대응시킨다. 기술 blocker 인수와 기능 완료 판정을 구분한다.
- 기존 단일 writer 보호, forced kill 제거, thread별 idempotent 상태, 미저장 대화 사전 검사와 release 오류 보존은 유지한다.
- 제품·양언어 사용자 문서와 progress는 실제 지원 범위에 맞게 갱신한다. 외부 게시나 실제 HA 변경 권한을 확대하지 않는다.
