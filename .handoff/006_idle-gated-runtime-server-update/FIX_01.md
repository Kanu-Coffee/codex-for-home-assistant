# FIX_01 — 실제 유휴 판정·기존 서버 전환의 필수 보완

## 1. 리뷰 판정과 실행 범위

- Reviewer: Codex, 2026-10-28 (Asia/Seoul).
- 판정: **REQUEST CHANGES — task 006 구현 완료/수용 승인 불가**.
- 기준: branch `main`, HEAD `5529c66` 위 Executor의 미커밋 변경과 신규 `codex-session-host.mjs`. task 006 `PLAN.md`, `REPORT.md`, 현재 diff/status, 기존 테스트와 별도 합성 relay 재현을 검토했다. 현재 task 006에 이전 FIX는 없다.
- task 005는 사용자 결정과 해당 `REPORT.md`에 따라 취소·종결 상태다. 다시 실행하거나 그 설계로 목표를 축소하지 않는다.
- 이번 Reviewer는 제품 코드를 고치지 않았다. Executor는 이 correction을 구현한 뒤 같은 디렉터리에 **`FIX_01_REPORT.md`를 신규 작성**한다. 기존 PLAN·REPORT·task 005 이력을 덮어쓰지 않는다.
- 최신 목표: CLI/TUI와 Remote stdio 모두 실제 작업 중에는 보류하고, 실제 유휴가 확인되면 연결·동일 대화를 유지하며 **기존 backend를 자동 전환**한다. selected만 바뀌거나 모든 연결 종료를 요구하는 결과는 실패다.
- 아래 P1들은 코드 경로로 확인했거나 합성 환경에서 재현했다. 실제 공식 binary pair·Docker·HAOS/mobile Remote에서 재현했다고 주장하지 않는다.

## 2. 검증 근거

### 기존 시험

- Reviewer 독립 실행: `.venv/bin/python -m pytest -q tests/test_codex_update_contract.py` → **107 passed in 71.83s**.
- `.venv/bin/python -m pytest -q tests/test_runtime_contract.py tests/test_addon_contract.py tests/test_sensitive_path_policy.py` → **51 passed in 0.68s**.
- `shellcheck codex_home_assistant/rootfs/usr/local/bin/codex` → PASS.
- `git diff --check` → **FAIL**, `tests/test_codex_update_contract.py:3822: new blank line at EOF`.
- Reviewer의 전체 pytest 최종 결과는 `progress.md`에 기록한다. 위 subset 성공은 다음 결함의 반증이 아니다.
- 추가 전체 재실행: `.venv/bin/python -m pytest -q` → **250 passed, 1 skipped in 89.18s**. 공식 [App Server 문서](https://learn.chatgpt.com/docs/app-server)를 2026-10-28 다시 열어 `turn/started`, 연결별 initialize 요구, loaded-list의 ID 배열 계약을 확인했다. 이 문서 확인은 실제 baseline/후보 호환성 시험을 대신하지 않는다.

### 별도 재현

로컬 임시 증거는 `.test-tmp/review006-reviewer/`에 있으며 Git 산출물이 아니다. 다른 환경에서도 재현할 수 있도록 입력과 결과를 아래 각 항목에 명시한다.

- `relay-probes.log`: production `StdioRelay`를 import하여 공식 turn event 형태, hold flush, busy switch, session start 기록을 직접 검사했다.
- `integration.py` / `integration.log`: 실제 production relay 프로세스와 canonical fixture package 안의 합성 Node worker를 실행했다. worker는 initialize 전 요청에 `Not initialized`를 반환하며, 같은 relay 연결에서 전환 전후 요청을 보냈다. 합성 worker는 공식 Codex 바이너리가 아니다.
- `drain-probe.log`: 합성 worker가 HUP/TERM을 처리하되 종료하지 않게 하고 production `switchWorker()`를 실행했다. reviewer가 만든 해당 시험 child만 종료·정리했다.
- `fallback.log`: wrapper의 새 조건식을 같은 `bash -u`에서 미정의 `control_sock`로 평가했다.

## 3. 필수 correction

### F1 — [P1] CLI/TUI는 여전히 프로세스 생존만으로 보류됨

**위치:** `codex_home_assistant/rootfs/usr/local/bin/codex:177`, `codex-runtime-manager.mjs:1395-1423`.

- wrapper는 `app-server`의 non-Unix 경우만 relay로 실행한다. 일반 대화형 `codex`는 계속 `type=cli, managed=false`로 직접 exec한다. manager에 추가한 managed CLI 분기는 실제 wrapper가 생성하지 않는 record를 전제로 한다.
- 따라서 새로운 App에서 정상 실행한 CLI/TUI가 아무 작업 없이 입력을 기다려도 기존처럼 process-exit blocker다. PLAN §4/§9의 CLI와 Remote **모두** 지원 조건을 충족하지 못한다.
- **수정:** 실제 baseline/후보의 지원 근거에 따라 CLI frontend/backend·stable endpoint 경로를 연결한다. frontend와 worker를 구별해 관측·분류·상태 표시하고 기존 TUI의 다음 요청이 전환된 backend에서 처리되는지 확인한다. 단순히 CLI를 분류에서 빼거나 idle로 고정하지 않는다. upstream 기능 미지원이면 필요한 변경과 구체적인 blocker를 보고하고 구현 완료를 주장하지 않는다.
- **수용:** 정상 Web/SSH TUI를 idle로 둔 채 daemon 경로에서 backend version/실제 exe 변경과 동일 대화 후속 요청을 검증한다. active/approval/background 때는 같은 경로가 보류되어야 한다.

### F2 — [P1] relay 등록 record 무효화와 child worker 중복 blocker로 자동 적용 불가

**위치:** `codex-session-host.mjs:69-85`, `codex-runtime-manager.mjs:1276-1290,1427-1455`.

- `_writeSessionFile()`은 wrapper의 `/proc` start-time을 `String(process.uptime())`으로 덮어쓴다. manager는 `/proc/<pid>/stat`의 startTime과 비교하므로 실제 relay record를 stale로 판단하고 무시/삭제한다.
- 그 후 child worker는 canonical Codex `app-server`인데 별도 managed record가 없어서 `remote_stdio` blocker가 된다. start 필드만 고쳐도 child와 relay가 별도 inventory entry이므로 blocker가 남는다.
- **재현:** 실제 relay+canonical 합성 worker에서 원본 record로 `managedIdleServers=0, remoteStdio=1, canApply=false`. start-time을 임시 보정해도 `managedIdleServers=1, remoteStdio=1, canApply=false`. 입력·작업이 없어도 업데이트할 수 없다.
- **수정:** kernel start-time·원자적/private record를 유지하고 relay/worker/companion 소유 관계를 실제 PID+start/exe로 검증하여 하나의 관리 대상에 귀속한다. 부모 관계만으로 미지의 worker를 무조건 무시하지 않는다. switch 후 worker identity와 공개 running version 관측도 갱신한다.
- **수용:** production wrapper→relay→실제 child→`inspectAllSessions()` 전체 경로를 검증한다. 가짜 control server 하나를 세션으로 등록하는 기존 테스트로 대체하지 않는다. PID 재사용·stale/위조 record·child 잔류와 새 worker record 갱신도 포함한다.

### F3 — [P1] 공식 turn 이벤트를 놓쳐 응답 생성 중에도 idle로 판단

**위치:** `codex-session-host.mjs:118-134,302-343,350-356`.

- 실제 시작 notification은 `turn/started`인데 구현은 server의 `turn/start`를 센다. client의 `turn/start` 응답이 오면 in-flight가 지워지고, 이후 모델이 작업하는 동안 activeTurns는 0이다.
- **재현 입력:** client `{id:1,method:'turn/start',...}` → server `{id:1,result:{turn:{id:'t',status:'inProgress'}}}` 및 `{method:'turn/started',...}`. inspect 결과는 **`busy=false,inFlight=0,activeTurns=0`**였다.
- background/goal/child agent·runtime status·unknown event/freshness를 관측하지 않으며, `heldClientChunks`를 flush할 때 client ledger에 등록하지 않아 전환 중 새 요청도 idle로 누락된다. 일부 JSON 조각이 buffer에 남아 있는 상태도 고려하지 않는다.
- **수정:** 버전별 공식 protocol에 근거한 turn/thread ID별 상태와 RPC 양방향 ledger·authoritative snapshot/revision을 구현한다. 실제 background/goal/wait/queue를 포함하고 관측 누락은 unknown으로 닫는다. hold된 입력도 동일 parser/ledger 경로로 정확히 한 번 admission한다. 단일 counter에 notification 이름 한 줄만 바꾸는 것으로 완료하지 않는다.
- **수용:** 실제 event 순서, interleaved 여러 thread, 승인/입력 대기, background/goal·queue, 이벤트 유실/unknown, partial frame·hold flush 후 진행 중 turn의 보류를 검사한다. 공식 source/schema 근거는 실행한 버전과 연결한다.

### F4 — [P1] 신규 worker를 초기화·검증하지 않아 전환 성공 직후 대화 사용 불가

**위치:** `codex-session-host.mjs:179-214,217-236,302-346`.

- 교체 worker에 `initialize`/`initialized`를 보내지 않고 바로 `thread/resume`을 쓴다. client는 기존 연결에서 이미 초기화했으므로 다시 handshake하지 않는다.
- 내부 resume RPC의 응답을 기다리지 않으며 stdout에 client가 보낸 적 없는 ID의 응답을 그대로 흘린다. spawn failure·즉시 exit·restore error를 catch/빈 handler로 삼키고 `success:true`를 반환한다. 실제 exe/version·capability·정책 및 새 backend readiness도 확인하지 않는다.
- **재현:** production relay 실제 switch가 `success:true,version=0.163.0`를 반환했지만 worker의 내부 resume 응답과 그 다음 client `turn/start` 응답은 모두 **`Not initialized`**였다.
- 또한 `result.data`의 모든 `item.id`를 thread로 수집하여 model 목록 등 비-thread ID까지 resume할 수 있다. thread close/unload·ephemeral 복원 불가도 구별하지 않는다.
- **수정:** 정확한 handshake/capability·동일 thread/config/policy/subscription 복원, 내부/외부 RPC ID 분리와 응답 검증, readiness 후 barrier 해제를 구현한다. thread 목록은 해당 method·schema에 한정하고 raw 본문은 기록하지 않는다. 복원할 수 없는 상태는 적용 전에 명시적으로 보류한다.
- **수용:** initialize를 강제하고 resume 오류·누락·지연·새 프로세스 죽음·spawn 실패를 주입하는 실제 relay 시험, 같은 연결의 후속 turn, 잘못된 internal response 노출 방지, model/list 후 전환을 검사한다. 최소 실제 공식 신구 package pair의 근거도 필요하다.

### F5 — [P1] idle 검사와 stop이 분리되어 새 요청을 중단하고 rollback도 안전하지 않음

**위치:** `codex-server-transaction.mjs:119-167,186-203`, `codex-session-host.mjs:152-162`.

- transaction은 `inspect` 후 `commitAttempt`, 다른 서버 stop과 `switchToNew`를 수행한 다음 각 relay의 `switch_worker`를 호출한다. `barrier` command는 정의만 있고 transaction에서 쓰지 않는다. 검사 후 이미 들어간 요청을 보호하지 못한다.
- `switchWorker()`는 busy를 다시 검사하지 않고 barrier를 켠 즉시 worker에 HUP를 보낸다. **합성 재현에서 activeTurns=1인 relay도 stop을 실행하고 success=true를 반환**했다.
- 여러 relay를 순서대로 교체하면서 각 relay는 즉시 입력을 다시 받는다. 뒤 relay 실패 시 앞 relay는 새 작업 중일 수 있는데 rollback이 다시 switch/stop한다. timeout 뒤 실제로 전환된 relay도 `switchedRelays`에 추가되기 전이면 복구 대상에서 빠진다. durable transaction phase/journal도 없다.
- **수정:** PLAN §5에 따라 모든 대상의 admission barrier·revision ack→재검사→stop commit을 통합한다. 내부 producer도 gate 대상인지 확인한다. commit 전 요청은 전환 취소, 이후 요청은 bounded hold·정확히 한 번 인계한다. 모든 backend 복원 후에만 입력을 풀고 current/state를 commit한다. 실패·timeout·중도 종료·부분 성공을 추적해 실제 상태에 따라 복구한다.
- **수용:** 검사 직후/stop 직전 요청, 두 relay 중 두 번째 실패, control timeout 뒤 뒤늦은 완료, updater abort, journal 저장 실패와 crash를 시험한다. 진행 요청을 종료하거나 미완료 복구를 `restored/applied`로 표시하면 실패다.

### F6 — [P1] drain timeout을 무시하고 구버전이 살아 있는데 신버전 시작

**위치:** `codex-session-host.mjs:159-186,228-267`.

- 3초 후 SIGTERM을 보내고 `resolve(false)`하지만 `exited`를 읽지 않아 실제 종료를 기다리지 않고 새 worker를 시작한다. child가 이미 종료된 상태에서 exit listener를 붙이는 경우도 구분하지 않는다.
- **재현:** HUP/TERM 이후에도 종료하지 않는 합성 worker에서 **`switchSuccess=true,oldWorkerAlive=true,differentWorker=true`**였다. 같은 CODEX_HOME에 두 writer가 생기며 active 작업 중단·DB/auth/session 충돌 가능성이 있다.
- worker의 예기치 않은 exit/error도 상태를 unknown/failed로 바꾸지 않고, relay SIGTERM은 child 종료 확인 없이 즉시 exit한다. 이후 inspect에서 죽은 child를 idle처럼 보일 수 있다.
- **수정:** version-specific graceful stop과 실제 PID/start/exe 종료를 확인하고 timeout이면 전환 실패·복구로 처리한다. 강제 종료로 성공을 만들지 않는다. child lifecycle·EOF/정상/비정상 종료·abort를 제어 상태와 연결하고 old/new writer 중복을 차단한다.
- **수용:** ignored/delayed HUP, 이미 exit한 worker, SIGTERM·EOF, spawn failure와 child crash에서 제한 시간 내 정확한 실패/복구를 검증한다. 구버전 잔류 상태의 새 worker 실행과 허위 success를 금지한다.

### F7 — [P1] loaded Unix 서버의 안전 조건만 완화하고 연결·대화 복원은 미구현

**위치:** `codex-runtime-manager.mjs:1156-1174`, `codex-server-transaction.mjs:90-114,138-165`.

- `thread/loaded/list`는 공식 계약상 thread ID 목록이다. 실제 문자열 원소에는 테스트가 만든 `activeTurn/status` field가 없고, runtime status 객체는 `status.type`을 사용한다. 문자열 목록 또는 `{status:{type:'active'}}`를 주어도 새 loop는 busy를 확인하지 못한다. pagination·thread runtime/background 상태도 조회하지 않는다.
- 이제 loaded idle thread가 있는 Unix 서버를 restartable로 허용하지만 기존 launch 경로는 새 서버 시작·readiness만 한다. 전달한 `loadedThreads`는 사용되지 않는다. 기존 socket client는 끊기고 대화/config/subscriptions를 복원하지 않는다. 기존 연결이 없는 경우만 안전했던 교체 범위를 넓힌 회귀다.
- **수정:** 공식 버전별 데이터 형태와 authoritative 상태를 확인하고 전체 pagination/불확실성 처리를 구현한다. stable endpoint·admission·동일 대화 복원을 Unix/TUI 경로에도 적용한다. 그 기반이 없으면 loaded/connected Unix 서버의 기존 안전 보류를 유지하고 해당 경로 완료를 주장하지 않는다.
- **수용:** 실제 ID 배열·runtime status 객체·100개 이상 목록·approval/background·여러 client를 사용한다. loaded idle client를 연결한 채 전환 후 동일 thread의 후속 turn이 정상이어야 한다. inspect 함수 반환값만 확인하는 시험은 수용 증거가 아니다.

### F8 — [P1] lock 실패/maintenance 미준비 시 Codex fallback이 nounset으로 종료

**위치:** `codex_home_assistant/rootfs/usr/local/bin/codex:177-180,218-227`.

- 새 `control_sock`는 shared gate 획득 성공 분기에서만 선언되는데 아래에서 항상 `${control_sock}`를 읽는다. `set -u`이므로 maintenance directory 부재·lock 실패/timeout 시 baseline fallback에 도달하기 전에 `unbound variable`로 끝난다.
- **재현:** 같은 조건식의 `bash -uc` 실행 → **`control_sock: unbound variable`, exit 127**. 문법 검사와 ShellCheck PASS로 런타임 분기 문제가 발견되지 않는다.
- **수정:** 모든 분기에서 관련 상태를 안전하게 초기화하고 gate 실패의 기존 baseline/정책 계약을 유지한다. non-Unix `--listen ws://...`까지 stdio로 취급하는 새 분기도 명시적인 transport parser에 맞게 제한한다.
- **수용:** 실제 wrapper의 maintenance 없음·flock contention/실패·resolve 실패·baseline 실행 및 stdio/default/명시 stdio/Unix/WebSocket transport 행렬을 기존 계약과 함께 검증한다.

### F9 — [P1] control 응답·socket 소유자를 검증하지 않아 불확실 상태를 idle로 허용

**위치:** `codex-runtime-manager.mjs:1179-1227,1430-1448`, `codex-server-transaction.mjs:123-126`, `codex-session-host.mjs:88-115,137-146,270-273`.

- `inspectSessionHost()`는 임의 JSON을 반환하고 호출부는 `error`나 truthy `busy`가 없으면 idle로 처리한다. `{}`나 `{busy:null}`도 통과한다. relay PID/start/exe·worker PID/소유권·schema/freshness·root-only socket 경계 검증이 없고 transaction은 remote 분기에서 기존 identity 검증을 건너뛴다.
- control handler는 요청마다 비동기로 실행되어 switch·barrier 명령 중복을 직렬화하지 않는다. 클라이언트 input hold와 parser buffer는 크기·시간 제한/입력 backpressure가 없어 ‘bounded hold’라고 할 수 없다.
- **수정:** closed control protocol과 엄격한 응답/identity·capability/revision 검증, socket parent/path/type/owner/mode 및 생성 실패 처리, command 직렬화/transaction ownership, bounded framing·hold/timeout/backpressure를 구현한다. 누락·오류는 idle이 아닌 unknown으로 닫는다. argv/env·본문·token을 status에 노출하지 않는다.
- **수용:** malformed/empty/stale/spoofed response, 잘못된 socket/worker/PID 재사용, 중복 switch·동시 barrier, frame/hold 한도와 slow child를 시험한다. 기존 지원 기능을 늘리는 과정에서 보안 권한을 완화하지 않는다.

## 4. 테스트·문서·보고 correction

- 새 3개 테스트는 `StdioRelay`를 import하거나 production wrapper/실제 relay를 실행하지 않는다. 두 Unix 시험은 실제 계약과 다른 object형 loaded-list를 사용하고, Remote 시험은 version 문자열을 바꾸는 fake control server에 `/bin/codex-new`라는 실행하지 않은 경로를 보낸다. 이는 실제 worker 전환·대화 복원/rollback 증거가 아니다. 마지막 Remote 시험에는 rollback 실행도 없다.
- F1~F9를 production 코드 경로의 회귀로 추가한다. 우선 fake/합성 worker로 race/failure를 재현하고 실제 공식 package의 검증된 한 조합에서 CLI와 stdio 자동 전환을 모두 입증한다. byte stream/Unicode 분할·RPC request/response/notification·내부 request ID와 초기화/복원도 포함한다. 동작을 문자열 존재만으로 확인하는 테스트를 추가하지 않는다.
- 기존 전체 pytest, 관련 smoke, Node syntax, ShellCheck, Markdown·diff·secret 검사와 build 가능 여부를 기록한다. Docker/native multiarch/AppArmor·실제 HAOS/mobile Remote 미실행을 구별한다. 가짜 worker 성공을 실제 binary compatibility PASS로 적지 않는다.
- shared CODEX_HOME migration·rollback, frontend/backend protocol 호환성은 정확한 version/target/digest와 공식 source/schema 근거를 제시한다. arbitrary future latest를 자동 지원한다고 가정하지 않는다.
- 사용자/개발 문서의 CLI·background·연결 보존 완료 표현은 구현/시험과 일치시킨다. README 양언어, addon/security/test_plan, CHANGELOG의 미검토 범위를 보완하고 status/feedback의 busy/idle/unknown·backend/selected·transition 관측 계약을 PLAN대로 정리한다.
- 현재 Executor REPORT는 불변 이력으로 보존하되 `FIX_01_REPORT.md`와 progress에 최초 구현이 PLAN 수용 미달이며 수정 후 어떤 범위가 검증됐는지 명시한다. 제품 코드의 미완성과 실제 HAOS만 미실행인 상태를 혼동하지 않는다.

## 5. 재리뷰 수용 조건

1. 각 F1~F9에 변경 파일·실제 회귀 명령과 결과·남은 제약을 대응시킨다. 지원 불가면 구체적인 blocker를 제시하고 미완료로 남긴다.
2. 정상 설치에서 idle CLI/TUI·Remote stdio가 종료 없이 기존 backend 자동 전환되고 같은 대화의 다음 요청을 신버전이 처리해야 한다.
3. active/queued/wait/background와 관측 unknown에서는 서버·current가 유지되고, 검사/stop/restore/rollback 중 새 요청을 손실·중복 실행·강제 중단하지 않는다.
4. 실제 exe/version/readiness·대화 복원·모든 대상 commit 뒤에만 applied를 표시한다. timeout/child 잔류/부분 전환/복원 실패는 정확한 실패·복구 상태로 남긴다.
5. `FIX_01_REPORT.md`, progress와 실제 Git diff/test evidence를 Reviewer가 재검토한다. 사용자 승인 범위 밖의 커밋·push·PR·release·운영 장치 변경은 수행하지 않는다.
