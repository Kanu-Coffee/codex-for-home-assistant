# FIX_05 — 서버 출력 세대 경계와 미완료 자동 전환

## 1. 판정 및 범위

- Reviewer: Codex, 2026-10-28 (Asia/Seoul).
- 기준: HEAD `5529c66` 위 현재 working tree, PLAN/REPORT, FIX_01~04 및 대응 REPORT. 이전 리뷰에서 인수한 개선과 미검증 범위는 유지한다.
- **REQUEST CHANGES / task 006 미완료**. 제품 코드는 수정하지 않았다. 다음 Executor는 `FIX_05_REPORT.md`를 새로 작성하며 기존 handoff 및 취소된 task 005를 보존한다.

## 2. FIX_04 대응 판정과 독립 검증

| 항목 | 판정 |
| --- | --- |
| J1 client 프레임 분리 | 완성 frame만 전달하고 partial client frame은 busy로 보류하는 개선 확인. 이전 client 입력 유실 재현은 해소. server 세대 경계의 나머지는 K1 |
| J2 `__internal_` client ID 폐기 | 광범위 prefix 폐기를 제거한 개선 확인. 이전 재현에서 client 응답이 전달되고 pending이 해제됨. 실제 내부 ID 충돌·만료 응답의 전체 행렬은 별도 검증 필요 |
| J3 유휴 자동 전환·복구 | 기능은 계속 미완료. fail-closed 유지는 인정하나 PTY 마이그레이션 불가능을 다시 단정한 근거는 인수할 수 없음. K2로 이월 |

- 독립 `.venv/bin/python -m pytest -q tests/test_codex_update_contract.py tests/test_codex_update_fix03.py` → **117 passed in 86.46s**.
- JS 3개 각각 `node --check`, wrapper `shellcheck`, `git diff --check` → PASS.
- 이전 독립 `partial-frame.mjs` 재실행: partial client 입력에서 `busy:true`, `worker_busy`; 완성 뒤 실제 합성 child의 id=7 응답이 도착하고 pending이 해제됨.
- 이전 독립 `client-id.mjs` 재실행: `__internal_client_1` 응답이 전달되며 `requestStillPending:false`, `busy:false`.
- 아래 K1은 production relay와 실제 합성 child 및 별도 parser 주입 시험으로 재현했다. 증거는 Git 제외 `.test-tmp/review006-fix04/`에 있다.
- 전체 **260 passed, 1 skipped**는 Executor 보고 결과이며 이번 Reviewer가 전체 suite를 재실행한 결과가 아니다. 공식 binary pair·Docker/AppArmor·native ARM·HAOS/mobile·실모델·장기 시험은 이번 Reviewer가 실행하지 않았다.

## 3. 필수 correction

### K1 — [P1] 서버 출력의 미완성 프레임을 무시하고 종료해 신규 initialize 응답을 손상

**위치:** `codex-session-host.mjs:233-244`, `266-304`, `530-532`.

FIX_04는 client의 부분 프레임을 보호했지만 `_workState()`는 serverBuffer 및 server decoder의 부분 상태를 확인하지 않는다. worker가 알림 등을 나누어 출력한 첫 조각만 도착한 시점에도 idle로 판단할 수 있다. 이 상태에서 worker를 종료하면 기존 부분 출력과 신규 worker의 응답이 같은 `serverBuffer`에서 합쳐진다.

추가한 `serverBuffer = ''` / `serverDecoder` 초기화는 `_drainAndStopChild()`의 마지막 경로에만 있다. 정상 종료 및 이미 종료된 worker는 275/290행의 `return true`로 먼저 반환하므로 초기화되지 않는다. `_spawnChild()`의 stdout listener도 worker별 parser 소유권을 구분하지 않는다. 따라서 보고서의 ‘종료·교체 시 stale 버퍼 격리 완료’는 현재 코드와 다르다.

**독립 production 재현 (`server-generation.mjs`):**

1. 합성 Node worker는 최초 old 기동에서만 stdout에 newline 없는 `{"method":"unfinished`를 출력한다. marker file로 다음 old 복원에서는 반복하지 않게 한다. HUP에서는 종료하며, 정상 JSON 요청에는 id를 그대로 넣어 응답한다. 후보는 같은 프로그램의 new 모드로 partial 출력 없이 initialize에 정상 응답한다.
2. `StdioRelay.start({attachStdio:false})` 후 실제 child 출력이 도착할 때까지 기다린다. `serverBuffer`는 위 문자열인데 inspect는 `busy:false`다.
3. `switchWorker`는 old를 종료하고 new를 시작한다. old 부분 출력과 new initialize 응답이 결합돼 JSON parse에서 사라지고 내부 RPC가 timeout된다.
4. 실제 결과는 `error:'initialize_failed: internal_rpc_timeout: initialize'`, `rollbackStatus:'restored'`, version은 다시 0.162.1이다. 후보 worker 자체의 initialize 오류가 아니다. 별도 `_handleServerData` 주입 재현도 같은 결과였다.

**수정:** server의 완성되지 않은 프레임·UTF-8 상태도 안전한 전환 경계에 포함한다. 아직 수신 중인 old 프레임이 있으면 전환을 보류/취소하거나 old에서 정상적으로 완성·처리하게 해야 한다. 수락된 출력은 버퍼 초기화로 조용히 버리지 않는다. 종료가 확인된 뒤에는 모든 정상/이미 종료/rollback 경로에서 generation별 parser와 decoder를 일관되게 관리하고, 늦은 old stdout이 new parser를 오염시키지 않도록 child generation을 식별한다.

**수용:** 실제 child가 notification/응답을 여러 청크와 한글 UTF-8 내부에서 나눠 출력하는 동안 inspect/barrier/switch를 교차시킨다. partial server 프레임에서 unsafe idle을 허용하지 않고, 정상 old 종료·이미 종료·rollback에서 frame 결합 및 new initialize timeout이 없어야 한다. 이전 client frame과 id 회귀도 유지한다. 현재 blanket manager gate를 제거해 시험 성공을 만들지 않는다.

### K2 — [P1, 이월] 자동 전환·복구 미구현 및 근거 없는 불가능 단정

**위치:** `codex-runtime-manager.mjs:2352-2367`, 일반 CLI wrapper direct exec 경로, `FIX_04_REPORT.md` §3 및 progress의 FIX_04 Executor 항목.

유휴 관리형 서버에도 `compatibility_unverified`가 반환되어 실제 restart transaction은 도달 불가이며 CLI/TUI frontend/backend 분리는 구현되지 않았다. journal 자동 복구와 authoritative background/goal 관측도 미완료다. 미완료 상태 자체는 보고서에 올바르게 표시되어 있으므로 이를 숨긴 것으로 판단하지 않는다. 다만 J3의 구현·검증 요구는 수행되지 않았다.

또한 보고서는 ‘PTY 상태 및 메모리 상태 마이그레이션이 불가능’이라고 다시 단정한다. PLAN의 stable endpoint 방식은 기존 frontend/PTY를 유지하고 backend를 전환하는 설계이므로 PTY 자체의 마이그레이션 불가는 해당 설계의 불가능성을 입증하지 않는다. FIX_03_REPORT와 FIX_04가 이미 이 구분을 요구했고, 이번 보고서에는 새 공식 source/schema 또는 재현 가능한 stable endpoint 실패 실험이 없다.

**다음 작업:**

- J3 및 PLAN의 요구를 유지한다. 검증된 pair/capability에 한해 stable endpoint와 동일 대화 복원을 실제 제품 경로에 연결하고, 실제 작업이 끝난 뒤 유휴를 확인해 scheduler가 기존 backend를 바꾸도록 구현한다. 미저장/ephemeral, config/policy·subscription, background와 admission race를 함께 다룬다.
- transaction의 host별 실제 phase/identity를 재확인하는 복구 경로와 timeout/late completion·crash/restart·부분 release의 테스트를 구현한다. journal 존재 시 영구 차단하는 것만으로 복구 구현으로 간주하지 않는다.
- 기술 blocker가 남으면 정확한 버전/명령·schema/소스·입력과 출력, 최소 upstream/adapter 변경을 보고한다. 기존 보고서는 보존하고 새 REPORT/progress에서 불가능 단정을 정정한다. Git 제외 probe와 외부 전역 패키지에만 의존한 실험을 다른 Executor도 재현할 수 있게 전달한다.
- 안전 gate를 단순 제거하거나 새 빈 대화로 대체해 완료하지 않는다. 사용자 목표 변경 없이 열린 세션 종료 후 적용만을 task 006 완료로 선언하지 않는다.

**수용:** 최소 하나의 검증된 공식 pair에서 CLI/TUI와 Remote stdio 모두 같은 frontend/대화를 유지한 채 scheduler의 유휴 자동 전환과 신규 backend의 다음 요청 처리를 확인한다. busy/queue/approval/background 보호와 종료 후 유휴 해소, 장애 recovery를 실제 production 경로에서 확인한다. 남은 기술 blocker는 인수 가능하나 그 경우 task는 미완료다.

## 4. 다음 인계

K1 회귀와 K2 실제 구현·남은 제약을 `FIX_05_REPORT.md`에 대응시킨다. 관련 검증과 한국어·영어 문서·progress의 상태를 일치시키며 외부 게시 또는 실제 HA 변경 권한을 확대하지 않는다.
