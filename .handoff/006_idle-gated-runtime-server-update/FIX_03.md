# FIX_03 — rollback·작업 상태·commit 재검토

## 1. 판정과 기준

- Reviewer: Codex, 2026-10-28 (Asia/Seoul).
- 판정: **REQUEST CHANGES / task 006 미완료**.
- 기준: `main` HEAD `5529c66` 위 현재 working tree, PLAN/REPORT, FIX_01·FIX_02와 모든 대응 REPORT, 실제 제품 코드와 독립 재현. task 005 취소·종결은 유지한다.
- 이번 correction은 확인된 잔여 결함에 집중한다. 이전 문서를 덮어쓰지 않고 Executor는 최신 **FIX_03**을 수행한 뒤 `FIX_03_REPORT.md`를 신규 작성한다. Reviewer는 제품 코드를 수정하지 않았다.
- 사용자 목표는 실제 작업 중 보류하고, 유휴이면 CLI/TUI·Remote stdio의 **기존 backend**를 연결·동일 대화를 보존하며 자동 전환하는 것이다. 기술 blocker가 있다고 보고한 것과 목표를 구현·검증한 것은 구별한다.

## 2. 개선 인정과 검증 범위

| FIX_02 항목 | 이번 판정 |
| --- | --- |
| G1 CLI/TUI·명시 stdio | 명시 stdio 분기 개선. CLI/TUI 기존 backend 전환은 미구현이며 upstream 실측 근거도 독립 검증 불가 |
| G2 강제 종료 | SIGKILL/TERM escalation 제거 확인. 정상 drain timeout은 실패 처리하도록 개선 |
| G3 resume 실패 | 내부 RPC error reject·일반 resume 실패 rollback과 clientInitParams 보존은 개선. rollback 중 drain 실패 무시는 H1 |
| G4 hold·UTF-8 | 받은 청크 보존 후 pause·StringDecoder·침묵 buffer reset 제거 확인. 과거 입력 폐기 결함은 같은 방식으로 반복 지적하지 않음 |
| G5 다중 relay | keepBarrier 전달 개선. release/rollback 확정·late ack·durable commit은 H3 |
| G6 관측/identity | 죽은 worker unknown·원자적 record·worker PID+ancestor 확인 개선. 상태 모델과 identity 미완성은 H2 |
| G7 Unix 보호 | loaded thread 존재 시 busy/requiresSessionRestart 및 pre-signal 보호 확인. 파괴적 교체 회귀는 안전 보류로 완화했으나 유휴 연결 전환 기능 자체는 미완료 |

- 독립 명령 `.venv/bin/python -m pytest -q tests/test_codex_update_contract.py` → **109 passed in 78.73s**.
- wrapper `shellcheck`·`git diff --check` → PASS. Node syntax·문서 검사 결과는 progress에 확정 기록한다.
- 전체 **252 passed, 1 skipped in 94.41s**는 Executor 보고 결과다. 이번 Reviewer가 전체 suite를 재실행한 것은 아니다.
- 추가 증거는 Git에서 제외된 `.test-tmp/review006-fix02-reviewer/`의 `rollback.log`, `status-ledger.log`, `release.log`, `status.log`, `pytest.log`에 있다. 아래 입력과 결과만으로 다른 환경에서도 재현 가능하게 기술했다.
- 실제 공식 binary pair·Docker/native/AppArmor·HAOS/mobile Remote 수용은 이번에도 **NOT RUN**이다. 합성 Node worker나 fake control endpoint의 결과를 공식 Codex 시험으로 표기하지 않는다.

## 3. 필수 correction

### H1 — [P1] rollback이 신규 worker drain 실패를 무시하고 두 generation을 실행

**위치:** `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs:276-307`.

- rollback의 `await this._drainAndStopChild()` 오류를 빈 catch로 삼킨 뒤 `previousExe`를 spawn한다. 새 worker가 resume 실패 후 HUP에 종료되지 않으면 여전히 실행 중인데 구버전 writer가 추가된다. 구버전의 initialize/resume만 성공하면 `rollbackStatus:'restored'`로 표시한다.
- **실제 production class+합성 child 재현:** 구버전은 HUP에서 정상 종료·initialize/resume 성공, 신버전은 initialize 성공·resume error·HUP 무시로 설정했다. 결과는 spawnCount=3, 원래 old 종료, **new 생존+복원 old 생존**, 반환값 **`rollbackStatus=restored`**였다. 이 probe에서 만든 합성 child만 정리했다.
- **수정:** rollback에서도 이전 stop과 같은 identity/종료 확인 조건을 지킨다. 새 worker 종료가 불확실하면 추가 writer를 시작하지 않고 `rollback_incomplete`로 남긴다. admission·보관 입력을 안전하게 유지하고 상위 transaction이 실제 실패 상태를 인수하도록 한다. 강제 종료 재도입은 금지다.
- **수용:** initialize/resume/새 worker readiness 실패 뒤 새 worker가 HUP을 무시하는 경우, 이미 종료된 worker·PID 재사용·rollback spawn/resume 실패를 시험한다. 신규 worker 생존 중 old spawn 금지, 허위 restored 금지, 수락 입력 손실/중복 금지.

### H2 — [P1] 상태 이벤트를 누적해 유휴를 busy로 고정하며 authoritative 관측도 미완성

**위치:** `codex-session-host.mjs:176-181,488-507,553-608`, `codex-runtime-manager.mjs`/`codex-server-transaction.mjs`의 control·identity 검증.

- `thread/status/changed`의 active/busy/running을 받을 때마다 `activeTurns++` 한다. 같은 대화의 active flag 변경은 새 turn이 아닌데 누적된다. turn 시작 이벤트와 thread status를 같은 counter로 중복 계상한다.
- **재현 순서:** `turn/started(t)` → `thread/status/changed(active,[])` → 같은 thread `active,[waitingOnApproval]` → `turn/completed(t)` → 같은 thread `idle`. 최종 상태가 idle이고 request/pending/active ID가 없어도 **`busy=true,activeTurns=1`**이다. 장기 연결 유휴 시 업데이트가 계속 보류되는 원래 문제를 재도입한다.
- loaded inventory도 모든 `thread/*` 응답의 `thread.id`와 data ID를 추가한다. `thread/read`로 `status:notLoaded`인 대화를 읽기만 해도 loaded에 들어갔다. thread delete/archive 정리에서 참조하는 `req.params`는 request ledger에 저장하지 않아 제거할 수 없다. 메타데이터 조회를 업데이트 때 resume하는 부작용이 생긴다.
- background/goal/queued future 작업의 authoritative snapshot·revision/freshness는 여전히 없고, unknown·미지원 관측은 안전한 idle 근거가 되지 못한다. control worker PID 존재만 확인하는 것으로 PID/start/exe·capability/owner 검증을 대신하지 않는다. manager 귀속 개선도 전체 lifecycle 지원 증거는 아니다.
- **수정:** thread ID별 runtime status와 turn ID별 lifecycle을 별도로 저장하고 event 재전송·같은 status/flag 변경에 idempotent하게 동작시킨다. 실제 loaded 상태·subscriptions·ephemeral/historical metadata를 method/schema에 맞게 관리하고 변경 요청에 필요한 최소 private params만 저장한다. 실제 queue/background/goal과 worker identity를 확인할 방법을 구현하거나 해당 상태를 unknown으로 보류한다.
- **수용:** 위 실제 event 형태의 중복 active 전이·여러 thread·다른 turn 완료 순서·재접속 snapshot·unknown event·background/goal을 시험한다. 최종 실제 idle에서는 busy가 해소되고 실제 작업은 누락하지 않아야 한다. thread/read/list/delete/archive 후 전환이 무관 대화를 resume하거나 잘못된 ID를 복원하지 않아야 한다.

### H3 — [P1] barrier 해제 실패·부분 복구를 성공으로 보고

**위치:** `codex-server-transaction.mjs:189-220,239-276`, `codex-session-host.mjs:240-363`.

- 전체 switch 후 release 응답의 success/barrier를 검사하지 않고 예외도 무시한다. worker가 준비됐어도 client 입력이 계속 hold되어 정지한 상태를 applied로 표시할 수 있다.
- **production transaction+합성 endpoint 재현:** inspect와 switch는 유효한 성공을 반환하고 release만 `{error:'synthetic_release_failure'}`를 반환하도록 했다. transaction 결과는 **`applied:true`**, endpoint barrier는 **계속 true**였다.
- 실패 relay의 `rollbackStatus:'rollback_incomplete'`가 error로 올라와도 그 relay는 success ack를 받지 않아 switchedRelays에 없고, 상위 allRestored에 반영되지 않는다. timeout 뒤 late completion·여러 host 복원에 필요한 actual phase 확인도 없다. catch는 복구 성공 여부와 무관하게 모든 barrier를 풀고 current를 뒤늦게 old로 전환한다.
- transaction은 current를 worker 준비보다 먼저 바꾸며, release 시점에는 caller의 state journal commit/재시작 복구도 끝나지 않았다. durable per-host transaction 기록은 여전히 없다. keepBarrier만으로 원자적 commit이 완성되는 것은 아니다.
- **수정:** prepare/identity·barrier ack/idle revision/stop commit/restore/durable commit/release 단계를 명시하고 단계별 결과를 검증한다. release failure·timeout은 성공으로 삼키지 않는다. 불완전한 복구나 전환 중인 relay를 failed-host 집합에 보존하고 실제 phase/identity를 확인해 복구한다. admission 해제는 실제로 검증된 사용 가능 worker에만 수행하며 불확실한 rollback을 restored로 표시하지 않는다.
- **수용:** release error/timeout·worker 자체 rollback_incomplete·ack 유실/late success·두 relay 중 후반 실패·current/state 저장 실패/재시작을 시험한다. applied는 대상 backend의 실제 전환·복원과 client 요청 처리 가능성이 모두 입증된 뒤에만 기록한다. 같은 연결의 다음 요청 성공을 확인한다.

### H4 — [P1] CLI/TUI 목표 미달과 upstream blocker 근거 부족

**위치:** `codex_home_assistant/rootfs/usr/local/bin/codex`의 일반 CLI 직접 exec 경로, `FIX_02_REPORT.md` §G1.

- CLI/TUI 기존 backend 전환은 여전히 구현되지 않았다. 이제 보고서가 기술 blocker를 남긴 점은 개선이나 task 006의 완료는 아니다.
- 보고서에는 0.162.1 binary/`--remote` 실측을 주장하지만 exact 명령·출력·binary checksum/target·환경·재현 절차나 공식 해당 버전 source/schema 근거가 없다. 제공된 기록만으로 ‘실측 확인’을 독립 인수할 수 없다. 증거가 없다는 이유만으로 실험이 수행되지 않았다고 단정하지도 않는다.
- direct worker socket 교체 시 TUI가 재접속하지 못하는 결과만으로, PLAN이 지정한 **stable local relay/endpoint 유지** 방식의 불가능성을 입증할 수 없다. frontend를 재기동하라는 요구도 아니다.
- **수정/산출물:** baseline의 remote TUI 지원과 stable endpoint/relay 조합을 격리 환경에서 확인하고 정확한 command/version/target/digest·결과를 보고한다. 불가능하다면 실패 지점과 upstream에 필요한 최소 protocol/adapter 변경을 명확히 적고 **미완료/blocker**로 남긴다. 가능하면 CLI 경로를 연결하고 동일 frontend/대화의 다음 요청을 새 backend가 처리하도록 구현한다. 사용자 승인 없이 다른 목표로 완료 처리하지 않는다.
- **수용:** 실제 공식 검증된 한 pair에서 Web/SSH TUI·Remote stdio 모두 자동 전환을 입증하거나, 기술적으로 불가능한 범위를 검증 가능한 근거로 분명히 남긴다. 후자의 경우 리뷰가 기술 blocker를 인수할 수는 있어도 PLAN 목표 달성·릴리스 수용으로 선언하지 않는다.

## 4. 다음 인계와 재리뷰

1. H1~H4 및 FIX_02의 미완료 validation을 `FIX_03_REPORT.md`에서 대응시킨다. 이번에 해결된 강제 종료 제거·일반 resume error 처리·기본 hold/UTF-8·Unix 안전 보류를 되돌리지 않는다.
2. 회귀는 production relay/transaction 경로에서 실패·race를 포함하고 실제 같은 연결/대화의 다음 요청까지 검사한다. helper 함수의 success 문자열이나 fake version을 전체 지원 증거로 사용하지 않는다.
3. 변경에 적절한 pytest·static 검사·smoke/build를 실행하고 실제 공식 binary pair·Docker/native/AppArmor·HAOS/mobile Remote·장기 수용을 구분한다. 실환경 변경과 외부 게시 권한은 확대하지 않는다.
4. progress·제품/양언어 사용자 문서가 ‘코드 일부 구현’, ‘검증된 동작’, ‘미확정 blocker’, ‘실기 NOT RUN’을 구별해야 한다. 기존 불변 REPORT의 과도한 완료 표현은 새 보고서에서 정정하고 이전 문서를 덮어쓰지 않는다.
