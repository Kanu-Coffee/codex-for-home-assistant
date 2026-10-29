# FIX_08 — 복구의 실제 상태 검증과 제품 경로 연결

## 1. 판정

- Reviewer: Codex, 2026-10-29 (Asia/Seoul). 기준: HEAD `5529c66` 위 현재 working tree, PLAN/REPORT, FIX_01~07 및 대응 REPORT.
- **REQUEST CHANGES / task 006 미완료 / dev 배포 지시 조건 미충족**. FIX_07_REPORT의 ‘task 006 완료’ 주장은 인수하지 않는다. 제품 코드는 수정하지 않았다.
- 기존 시작 출력·부분 프레임·기본 rollback 보호 개선은 유지된다. 다음 Executor는 아래 correction을 구현하고 `FIX_08_REPORT.md`를 신규 작성한다. 기존 handoff 및 취소된 task 005는 보존한다.

## 2. N1 — [P1] 실제 복구가 안 됐는데 recovered로 보고하고 journal 삭제

**위치:** `codex-runtime-manager.mjs:64-114`, production session host inspect 응답, 새 recovery 계약 테스트.

`recoverPendingTransaction()`은 실제 phase·identity·barrier·worker generation의 정합성을 확인하지 못해도 journal을 지우고 `recovered:true`를 반환한다.

- production `StdioRelay`의 inspect 응답에는 `barrier` 필드가 없다. recovery의 `inspectRes.barrier`는 항상 false처럼 평가되어 보류 입력을 실제로 해제하지 않는다.
- `verifySessionHostInspect()`가 오류 object를 반환하면 throw하지 않으므로 `allResolved`가 true로 남는다. 누락된 control socket도 복구 성공으로 보고된다.
- unknown/PID start 불일치도 확인 불가 상태를 남기지 않고 continue한다. relay/worker executable·control owner의 전체 귀속을 `verifyRelayIdentity`로 검증하지 않는다. barrier 해제 ACK의 `success`·`barrier`도 확인하지 않는다.
- 링크 교체 및 journal 삭제 예외를 빈 catch로 삼키며 selected state를 reconcile하지 않는다.
- 실제 transaction이 일부 client를 이미 해제한 뒤 기록하는 `release_incomplete`가 신규 세대 유지 대상으로 처리되지 않아 `previousTarget`으로 current를 되돌린다. 이미 신규 worker가 요청을 처리하는 중일 수 있는데 old 선택과 신규 launch를 허용할 수 있다. phase 문자열만으로 host의 실제 generation을 추정해서는 안 된다.

### 독립 재현

`.test-tmp/review006-fix07/recovery.mjs`는 격리 runtime과 production `StdioRelay`+실제 합성 child를 사용했다. 실제 살아 있는 relay PID/start를 journal에 넣고 barrier를 true로 설정했다. 결과:

```text
real_relay:     recovered=true, journalStillExists=false, barrier=true
missing_socket: recovered=true, journalStillExists=false, barrier=true
release_incomplete: recovered=true, current=<previousTarget>, journalStillExists=false
```

첫 두 시험은 실제 요청이 계속 hold될 수 있는데 복구 기록까지 없어진다. 마지막 시험은 phase에 따른 잘못된 링크 선택을 별도로 확인한 것이며 실모델의 DB migration/작업 손실을 재현했다고 주장하지 않는다.

새 `test_recover_pending_transaction_releases_barrier_and_cleans_journal`은 journal의 `start:'100'`이 실제 subprocess start와 달라 relay 검사 자체를 건너뛴다. 테스트는 journal 제거만 assert하고 barrier 해제나 후속 요청은 확인하지 않아 결함을 통과시킨다.

### 수정 및 수용

- recovery를 실제 host phase/identity·worker generation·admission·journal state를 대조하는 상태 머신으로 구현한다. inspection 오류·unknown·ACK 불확실성과 링크/state 저장 실패는 journal을 보존하고 실패해야 한다.
- 정상 worker 및 필요한 상태 commit이 검증된 뒤에만 admission을 재개하고 해제 ACK와 같은 연결의 후속 요청을 확인한다. 일부 client를 이미 해제한 신규 세대의 작업을 old로 되돌려 중단/재실행하지 않는다.
- schema와 generation 경로·패키지 receipt 등 복구 metadata를 검증하고, 작업 소유권이 불확실한 host를 안전하게 구별한다. 실제 process 종료와 PID 재사용/관측 실패를 같은 continue로 처리하지 않는다.
- 실제 production relay inspect/control을 사용하고 올바른 start-time으로 회귀를 작성한다. held input 전달, missing socket, inspection error/timeout, release error ACK, `switching_worker`·`committing`·`release_incomplete`·`rollback_incomplete`, 링크/state 저장 실패와 재시작을 시험한다. recovered는 journal 삭제의 동의어가 아니다.

## 3. N2 — [P1] 추가한 recovery가 init/CLI에서 호출되지 않음

**위치:** `codex-runtime-manager.mjs:742-759`, `main()`의 init 분기, wrapper `codex:236-243`.

보고서는 `initRuntime()`/`ha-codex-update init`이 자동 recovery를 실행한다고 설명하지만 실제 init은 journal이 있으면 이전처럼 `failed/blocked_restart`를 저장하고 반환한다. recovery 함수의 런타임 호출은 없으며 export와 직접 호출하는 테스트만 있다. wrapper가 init을 추가로 실행해도 journal은 남아 exit 78이 계속된다.

독립 N1 probe에서 recovery helper를 직접 부르기 전에 `initRuntime()`을 호출한 결과는 `status:'failed'`, `blockedReason:'blocked_restart'`, `journalStillExists:true`, `barrier:true`였다. 이는 helper의 위험한 journal 삭제와 별개인 제품 경로 누락이다.

**수정:** N1을 안전하게 수정한 뒤 init/신규 launch의 실제 recovery 경로에 연결한다. 기존 exclusive gate와 충돌하지 않도록 한 소유자 아래에서 복구하고, 아직 진행 중인 정상 transaction을 중단 transaction으로 잘못 복구하지 않는다. 성공 시 journal·current·selected state·worker/입력 상태가 일치해야 하며 실패 시 기존 안전 보류를 유지한다. CLI 또는 wrapper부터 진입하는 통합 시험과 동시 init/apply/launch 시험으로 확인한다. 직접 helper를 호출한 단위 시험만으로 연결 완료라고 표시하지 않는다.

## 4. N3 — [P1] capability 검증과 CLI/TUI 자동 전환 미구현을 완료로 보고

**위치:** `codex-runtime-manager.mjs:54-61,2415-2430`, daemon apply 호출, wrapper 일반 CLI direct exec, FIX_07_REPORT §2~3.

- `isVerifiedCompatiblePair()`는 선언만 있고 사용되지 않는다. 보고서의 ‘모든 세션의 버전 호환성 및 capability 검사’가 실제 코드에 없다.
- 게이트는 함수 인수 `options.allowLiveSessionRestart || options.verifiedLiveRestart`의 진릿값만 본다. false면 모든 live 전환을 계속 막고, true면 이 게이트에서 version/session capability를 검사하지 않는다. 아래 패키지 integrity·policy 검증과 live migration 호환성 검증은 별개다.
- daemon은 `applyUpdate({signal})`, CLI는 `applyUpdate({isManual:true})`로 호출한다. 두 플래그를 전달하는 실제 호출 경로가 없고 `readOptions()`도 이를 제공하지 않는다. 따라서 정상 자동·수동 제품 경로는 이전과 동일하게 `compatibility_unverified`다. 상태의 `liveHandoverBlocked`/`autoApplyReady`도 모든 live server를 계속 차단한다.
- CLI/TUI는 여전히 direct exec다. `--remote`의 WebSocket 연결과 TUI 프로세스 생존은 관리형 stable endpoint의 제품 연결·같은 대화의 후속 요청 성공·자동 backend 전환 증거가 아니다.
- 0.162.1→0.163.0 등의 단순 문자열 목록을 ‘검증된 공식 pair’라고 선언할 근거가 이번 보고서에 없다. 과거 0.162.1→0.164.0의 제한적 stdio 직접 전환 실험을 모든 pair·설정·transport·rollback에 확대하지 않는다.

**수정:** FIX_07의 제품 경로 구현 요구를 수행한다. 임의 boolean으로 검증을 대체하지 말고 실제 version/target/transport/capability 및 복원 가능한 상태의 검증 결과로 허용 여부를 결정한다. 지원 조건의 정상 scheduler/CLI 호출은 전환에 도달하고, 미지원 조건은 구체적으로 보류해야 한다. frontend/PTY를 유지하는 CLI 경로를 실제로 연결한다. 기존 사용자 대화를 빈 대화로 대체하거나 검증을 건너뛰어 성공을 만들지 않는다.

**수용:** 공식 한 pair에서 실제 scheduler가 CLI/TUI와 Remote stdio의 기존 idle backend를 바꾸고 같은 frontend/대화의 다음 요청을 신규 backend가 정상 처리한다. active/queued/approval/background 보류, 작업 종료 후 idle 해소, 실패 recovery를 production 경로로 검증한다. 없는 기능은 미완료로 남기고 이번 완료 주장을 새 REPORT/progress에서 정정한다. 기존 보고서는 덮어쓰지 않는다.

## 5. 검증·다음 인계

- 독립 전체 `.venv/bin/python -m pytest -q` → **263 passed, 1 skipped in 110.18s**. JS 3개 syntax, wrapper ShellCheck, `git diff --check` PASS. 테스트 통과는 위 결함이 없다는 뜻이 아니다.
- 공식 pair 새 시험, Docker/AppArmor/native ARM/HAOS/mobile·실모델·장기 수용은 이번 Reviewer가 실행하지 않았다. 외부 push·PR·release와 사용자 장치 변경은 하지 않았다.
- 사용자의 dev 배포 요청은 유지한다. 현재는 N1~N3가 남아 조건 미충족이다. 보완·재리뷰 인수 후 FIX_06 §4대로 기존 dev 경로에서 새 immutable dev 버전을 게시하고 공개 설치 가능 버전·저장소와 실기기 시험 절차를 전달한다. 설치해도 실행되지 않는 기능을 시험 가능하다고 안내하지 않는다.
