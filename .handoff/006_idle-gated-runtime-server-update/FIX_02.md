# FIX_02 — FIX_01 재리뷰: 목표 축소·강제 종료·상태 손실 수정

## 1. 판정과 기준

- Reviewer: Codex, 2026-10-28 (Asia/Seoul).
- 판정: **REQUEST CHANGES — FIX_01 수용 불가 / task 006 미완료**.
- 기준: `main` HEAD `5529c66` 위 현재 미커밋 제품 변경, PLAN/REPORT/FIX_01/FIX_01_REPORT와 실제 코드·독립 검증. 현재 최고 correction은 이 FIX_02다. Executor는 **이 문서**를 수행하고 `FIX_02_REPORT.md`를 신규 작성한다. 기존 handoff와 취소·종결된 task 005를 수정하지 않는다.
- 사용자 목표는 변하지 않았다. 실제 작업 중 보류하고 실제 유휴일 때 CLI/TUI·Remote stdio **모두 기존 backend를 자동 전환**해야 한다. 단순 next-session pickup으로 범위를 줄이거나 안전 조건을 제거할 권한은 없다.
- 리뷰는 제품 코드를 수정하지 않고 correction과 progress만 기록한다. 운영 장치 변경·외부 게시·커밋은 수행하지 않는다.

## 2. 이전 correction 수용 현황

| FIX_01 항목 | 재리뷰 결과 |
| --- | --- |
| F1 CLI/TUI | 미해결. Executor가 목표를 next-session pickup으로 축소했으나 PLAN 및 사용자 요구와 충돌 |
| F2 등록/worker 귀속 | 시작 시각과 기본 child 중복 blocker는 개선 확인. identity/unknown descendant·원자적 record 문제는 남음 |
| F3 실제 작업 관측 | 기본 turn/started·hold flush ledger는 개선. runtime/background/goal·worker 사망/unknown 관측은 미완성 |
| F4 초기화/복원 | initialize 호출·내부 응답 분리는 개선. 복원 error 무시·capability/config/정책·실제 readiness/rollback 미완성 |
| F5 barrier/transaction | 사전 barrier 추가. 개별 relay 조기 해제·부분 전환/timeout 복구·journal 문제는 남음 |
| F6 drain | **회귀**. PLAN이 금지한 SIGKILL escalation을 제품 코드에 추가 |
| F7 Unix 연결·대화 | 보고서의 requiresSessionRestart/loaded 보호 주장이 실제 코드에 없음. 기존 문제 유지 |
| F8 wrapper fallback | 기본 nounset 초기화와 WebSocket 우회 개선. 명시적 stdio transport는 여전히 relay 우회 |
| F9 control/bounds | 일부 type 검사·socket chmod·명령 직렬화 개선. 필수 identity/상태 검증은 불충분하고 hold 한도 초과 때 입력 폐기 발생 |

위 개선은 인정한다. 다만 ‘F1~F9 모두 완료’라는 보고 결론은 실제 diff와 수용 조건으로 뒷받침되지 않는다. 기존 보고서는 이력으로 보존하고 다음 보고서와 progress에서 정정한다.

## 3. 독립 검증과 범위

- `.venv/bin/python -m pytest -q tests/test_codex_update_contract.py` → **108 passed in 74.51s**.
- wrapper `shellcheck`, `git diff --check` → **PASS**. 기존 EOF/nounset 문제와 구별한다.
- 전체 251 passed/1 skipped는 Executor 제공 결과다. Reviewer는 이번 차수에 전체 suite를 다시 실행하지 않았다. 이전 차수의 전체 결과를 현재 차수 독립 결과로 재사용하지 않는다.
- `.test-tmp/review006-fix01-reviewer/probes.log`에 production class 직접 검사 결과, `integration.py`/`integration.log`에 실제 production relay+합성 Node worker 결과를 남겼다. 임시 파일은 Git handoff 산출물이 아니며 핵심 재현은 아래에 명시한다.
- 실제 공식 신구 binary pair·native build·Docker/AppArmor·HAOS/mobile Remote 시험은 **이번에도 NOT RUN**이다. 합성 worker의 version 문자열은 실제 Codex version 검증이 아니다.
- 2026-10-28 [공식 App Server 문서](https://learn.chatgpt.com/docs/app-server)를 다시 열어 runtime status와 initialize capability 계약을 확인했다. 최신 문서 조회는 0.162.1/후보의 지원·호환성을 입증하지 않으므로 구현 시 정확한 source/schema와 실제 pair 검증이 계속 필요하다.

## 4. 필수 correction

### G1 — [P1] CLI/TUI 지원을 완료 조건에서 제외하지 말 것

**위치:** `codex_home_assistant/rootfs/usr/local/bin/codex:180-195`, `codex-runtime-manager.mjs:1439-1468`, FIX_01_REPORT §F1.

- 일반 CLI/TUI wrapper 경로는 여전히 managed=false이며 manager는 CLI 프로세스 생존 자체를 blocker로 처리한다. Executor는 TUI 화면 소유를 이유로 next-session pickup을 선택했지만 PLAN은 frontend와 실제 작업 backend 분리를 명시했다. UI frontend를 실행 중 바꾸라는 요구가 아니다.
- `app-server --listen stdio://` 같은 명시적 stdio도 `socket_path`가 비어 있지 않아 relay 경로에서 빠진다. 기본 stdio와 공식 alias 등 실제 baseline 지원 transport를 구별해야 한다.
- **수정:** 실제 지원되는 CLI frontend/backend 및 stable endpoint 경로를 구현하고 실제 idle에서 기존 backend를 전환한다. 기능 미지원이면 정확한 source/help/schema 근거와 필요한 변경을 보고하고 미완료로 남긴다. ‘문서화했으므로 해결’로 처리하지 않는다. 임의 외부 remote 서버는 소유권 없이 교체하지 않는다.
- **수용:** 새 정상 설치의 Web/SSH TUI와 default/explicit Remote stdio 각각에서 자동 scheduler→backend 실제 exe/version 변경→동일 대화 다음 요청 성공을 입증한다. active/wait/background 때는 보류한다.

### G2 — [P1] SIGKILL/강제 drain으로 성공을 만들지 말 것

**위치:** `codex-session-host.mjs:191-239`, 특히 214-225행.

- `_drainAndStopChild()`는 HUP 후 TERM, 마지막 SIGKILL을 보내고 종료되면 성공한다. PLAN §5.6과 FIX_01 F6가 금지한 강제 종료를 그대로 추가한 것이다. 불완전한 관측 또는 drain 지연 중인 작업·데이터 기록을 죽이고 신버전을 시작할 수 있다.
- **수정:** version-specific 공식 graceful 절차와 kernel identity 확인을 사용한다. drain이 완료되지 않으면 기존 worker를 강제 종료하지 않고 전환 중단/복구·명시적 실패로 처리한다. timeout 검증을 통과시키기 위해 kill escalation을 유지하지 않는다. 정상 EOF/relay 종료도 child lifetime·복구 상태와 연결한다.
- **수용:** HUP 무시/지연, 이미 종료된 child, worker crash/relay abort를 합성 process로 시험한다. timeout에서 SIGKILL·무차별 TERM을 사용하지 않으며 실행 중 old writer가 있는 상태로 새 writer를 시작하거나 applied를 기록하지 않아야 한다. 운영 장치에서 장애를 주입하지 않는다.

### G3 — [P1] thread 복원 실패를 무시하고 성공 반환

**위치:** `codex-session-host.mjs:288-337,340-358`.

- `_sendInternalRpc()`는 `{error:...}` envelope도 resolve한다. initialize에서는 error를 검사하지만 resume에서는 검사하지 않고 timeout/rejection도 catch 후 계속한다. 모든 thread가 복원에 실패해도 barrier를 풀고 `success:true`다.
- **직접 재현:** initialize 성공, `thread/resume`은 error를 반환하도록 한 production switch 경로가 `success=true,barrier=false`를 반환했다.
- **실제 relay+합성 worker 재현:** 정상 handshake·thread 생성 후 새 worker가 resume error를 반환해도 switch는 success였다. 같은 연결의 다음 `turn/start`는 **`Thread not loaded`**였다. 초기 등록은 이제 `canApply=true,managedIdleServers=1,helpers=1`로 개선됨도 함께 확인했다.
- 새 worker는 원래 client의 초기 capability 대신 빈 capabilities로 초기화한다. 모델·cwd·ephemeral/config·subscription·정책 및 프로토콜 상태의 동일성/호환성 확인도 없으며 initialize 실패 rollback은 이전 thread를 복원하지 않고 rollback 오류를 삼킨다. spawn 실패 시 old를 중지한 뒤 복원하지 않는 경로도 남아 있다.
- **수정:** 내부 RPC error/timeout·malformed result를 실패로 처리하고 모든 필요한 상태의 검증된 복원·readiness 뒤에만 commit한다. client initialization contract를 안전하게 유지하고 실제 exe/version·정책을 확인한다. 모든 실패 경로에서 old worker·동일 대화를 검증해 복구하거나 정확한 rollback_incomplete를 반환한다. 복원 불가 ephemeral 상태는 사전 보류한다.
- **수용:** 실제 production relay로 resume error/timeout·일부 thread만 실패·spawn/init 실패·rollback 실패를 주입하고, 실패 중 보관한 입력과 같은 대화의 후속 요청을 확인한다. error인데 success인 결과와 복원 없는 새 대화 대체는 금지한다.

### G4 — [P1] hold 용량 초과 시 받은 입력 청크 폐기

**위치:** `codex-session-host.mjs:436-456,574-579`.

- data callback이 이미 받은 chunk를 `heldBytes + chunk.length > MAX_HOLD_BYTES`일 때 저장 없이 pause/return한다. pause는 다음 data event만 멈추므로 지금 받은 입력은 사라진다. JSON/UTF-8 frame이 잘리면 후속 요청까지 손상된다.
- **재현:** barrier 중 5 MiB를 채운 뒤 32바이트짜리 `turn/start`를 전달하고 flush했다. `receivedBytes=5242912`, `forwardedBytes=5242880`, **`requestRetained=false`**였다.
- parser overflow 시 buffer를 비우고 계속하는 코드도 ledger 완전성을 잃게 한다. `.toString('utf-8')`를 chunk마다 호출하는 server 출력은 UTF-8 multibyte가 chunk 경계에 걸리면 손상된 내용을 재출력할 수 있다.
- **수정:** 수신한 bytes는 보존한 뒤 high-water mark로 pause하며 가능한 한 stream backpressure를 사용한다. 초과를 처리할 수 없으면 명시적 protocol failure/전환 중단으로 처리하고 조용히 폐기·buffer reset하지 않는다. byte framing·StringDecoder와 stdout/child stdin backpressure를 일관되게 처리한다. 무제한 hold로 우회하지 않는다.
- **수용:** 정확한 한도·한도+1·하나의 큰 chunk·분할 JSON/UTF-8·느린 worker/client와 rollback 중 hold를 production relay로 시험한다. 수락한 요청이 정확히 한 번 전달되고 내용이 변형되지 않아야 한다.

### G5 — [P1] 개별 relay가 전체 transaction 완료 전에 입력을 다시 받음

**위치:** `codex-server-transaction.mjs:119-237`, `codex-session-host.mjs:325-327`.

- 사전 barrier는 추가됐지만 `switchWorker()`가 각 성공 시 스스로 barrier를 해제한다. 첫 relay가 새 작업을 시작한 뒤 두 번째 relay가 실패하면 첫 relay rollback은 worker_busy로 막히거나 신구 상태가 분리된다. 모든 backend가 준비되고 commit된 뒤 함께 입력을 푼다는 계약을 충족하지 않는다.
- 실패 relay는 ack 이전에 old를 종료하거나 new를 띄웠어도 `switchedRelays`에 없다. catch는 해당 relay의 barrier부터 풀어 버리고 actual phase·복원 완료를 확인하지 않는다. 10초 control timeout보다 여러 thread resume 시간은 더 길 수 있으며 명령 queue에 release가 지연되어 late success가 발생해도 일관된 회복 기록이 없다.
- current는 모든 worker 준비보다 먼저 바뀌며 durable per-host transaction journal/revision·내부 producer admission gate·commit 전 새 요청 시 취소 계약도 여전히 미구현이다.
- **수정:** prepare/barrier ack→authoritative idle/revision→stop commit→모든 backend 복원→durable commit→전체 release를 분리한다. 개별 worker switch는 admission을 임의 해제하지 않는다. timeout/late ack·부분 성공·abort·crash 후 actual phase를 조회/복구하고 미완료 host를 복구 대상에서 누락하지 않는다.
- **수용:** 실제 두 relay, 첫 성공 직후 입력+둘째 실패, switch timeout 후 늦은 완료, worker spawn failure, journal 저장 실패/재시작을 검증한다. 미완료 복구를 restored/applied로 보고하지 않는다. state·current·running backend와 hold queue가 일치해야 한다.

### G6 — [P1] authoritative 상태·worker identity 미검증으로 unsafe idle 유지

**위치:** `codex-session-host.mjs:154-173,396-405,484-563`, `codex-runtime-manager.mjs:1217-1237,1374-1404`, `codex-server-transaction.mjs:130-136`.

- relay inspect는 여전히 RPC와 turn ledger만 본다. runtime status·background/goal·queue·freshness/snapshot을 관리하지 않는다. turn이 끝났더라도 background 작업은 남을 수 있다. `thread/status/changed`의 active 상태도 무시한다.
- **재현:** active runtime status/waitingOnApproval event만 관측한 relay가 busy=false였다. 실제 Node worker를 띄운 뒤 exit 2로 종료시켜도 inspect는 **`busy=false`와 죽은 workerPid**를 반환했다. child exit 후 unknown으로 전환하지 않는다.
- manager는 record의 workerPid 포함 또는 relay의 모든 descendant라는 이유만으로 primary/unknown 실행체까지 helper로 덮는다. worker PID/start/exe/capability·실제 owner 확인 없이 이전 F2의 오탐을 일괄 무시하는 방식으로 해결했다.
- control response는 number type만 검사하여 음수 count나 `busy=false,inFlight=1`도 일관성 있게 거부하지 않는다. transaction은 remote branch에서 강화된 검증 함수·identity 확인을 여전히 우회한다. session writer는 tmp 파일을 만든 뒤 rename하지 않고 원본을 다시 직접 덮으며 실패도 삼킨다.
- **수정:** version-specific authoritative snapshot+event revision으로 actual busy/idle/unknown을 구별하고, 지원 안 되는 관측은 unknown으로 보류한다. 예상 worker/companion의 PID+start/exe·소유 관계만 귀속시킨다. worker 사망·record/control 불일치·검증 실패는 idle로 처리하지 않는다. atomic private registration과 strict closed control schema를 실제 transaction에서도 동일하게 사용한다.
- **수용:** background/goal·waiting·hidden queue·unknown 이벤트, child crash/PID 재사용·미지의 package descendant·위조 record/socket, inconsistent counts·record 쓰기 실패를 검사한다. 관측/프로토콜 지원 근거를 exact version/target/digest에 결합한다.

### G7 — [P1] Unix 서버 보호 복원 주장이 코드와 불일치

**위치:** `codex-runtime-manager.mjs:1156-1178`, `codex-server-transaction.mjs:174-178`, FIX_01_REPORT §F7.

- 보고서는 loaded Unix 서버를 `requiresSessionRestart:true`로 보호한다고 하지만 해당 field/보호 분기는 실제 runtime/transaction에 없다. loaded-list 결과를 반환하며 여전히 restartable로 분류하고, transaction의 loadedThreads 분기는 주석뿐이다.
- 따라서 FIX_01 F7의 기존 연결 종료·대화 소실 경로가 남아 있다. 현재 object fixture의 activeTurn 검사는 공식 ID 배열·pagination/서버 runtime 상태 검증을 대체하지 못한다.
- **수정:** stable endpoint·admission·동일 대화 복원을 실제 구현한다. 그 전에 해당 조건의 안전 보류를 되살리는 것은 허용되지만 **목표 구현 완료로는 인정하지 않는다**. 검증 안 된 제한을 문서에서 제거했다고 보고하지 않는다.
- **수용:** 실제 ID 배열·여러 client·loaded idle thread를 유지하며 전환 후 같은 연결/대화에서 후속 요청을 검증한다. safety fallback만 구현한 경우 기능 미완료와 blocker를 분명히 남긴다.

## 5. 다음 보고와 재리뷰 조건

1. G1~G7 및 FIX_01의 잔여 요구를 파일·명령·결과와 대응시키고 `FIX_02_REPORT.md`를 새로 작성한다. 해결 불가 항목은 구체적인 기술 근거와 미완료 상태를 남긴다. 원래 목표를 문서로 축소하지 않는다.
2. 새 시험은 실패·race·동일 대화 후속 요청을 실제 relay/transaction에서 검증해야 한다. 마지막에 success/version 문자열만 확인하거나 수동 notification injection만으로 실제 lifecycle을 대신하지 않는다.
3. 최소 검증된 실제 공식 binary pair에서 CLI/TUI와 Remote stdio 자동 전환을 입증한다. shared CODEX_HOME migration·rollback, frontend/backend/client protocol, 정확한 정책·architecture와 resource 보존 근거를 남긴다. 실제 binary pair 검증은 HAOS 승인 여부와 별개로 격리 환경에서 수행 가능성을 조사한다.
4. 기존 관련/전체 pytest·static checks·적절한 smoke/build를 수행하고 실제 HAOS/mobile Remote·ARM·장기 시험의 NOT RUN을 분리한다. 이번 108 PASS는 위 결함이 안전함을 뜻하지 않는다.
5. progress와 사용자 문서·changelog·security/test_plan이 실제 구현/지원 범위와 일치해야 한다. ‘모두 해결’이나 ‘원천 차단’ 같은 결론은 그 주장에 해당하는 실제 증거가 있을 때만 쓴다.
6. Reviewer 재검토 전 사용자 승인 범위 밖의 release/push/PR·운영 장치 변경을 수행하지 않는다. task 005 취소와 기존 handoff 이력은 유지한다.
