# FIX_02 — 교체 테스트 정리·검증 기록·상태 표시 정합성

## 판정과 범위

- Reviewer: Codex, 2026-10-17 (Asia/Seoul).
- 판정: **수정 필요 / 인수 보류**. FIX_01의 F1~F3 코드 수정은 반영됐으나 아래 P2 세 항목이 남아 있다.
- PLAN, REPORT, FIX_01, FIX_01_REPORT와 현재 코드·테스트·문서 및 Git 상태를 검토했다. 기준 HEAD `11b8839`, branch `main`, 미커밋 working tree다. 기존 12개 tracked 변경과 untracked task 004 이력을 보존한다.
- Reviewer는 제품 코드·기존 handoff를 변경하지 않았다. 임시 파일과 자체 생성 프로세스만 이용했고 운영 HAOS/Remote 연결·외부 Git·배포 작업은 수행하지 않았다.

## FIX_01 재검토 결과

- F1: package 경계와 allowlist 역할을 분리해 미지 executable을 unknown으로 보류하는 경로 및 baseline/release/deleted/형제 경로 대조 회귀가 추가됐다.
- F2: lastBlocker의 sanitize/load/default/save와 별도 status 프로세스 round trip, budget 소진 후 process 원인 유지가 구현됐다.
- F3: 값 있는 옵션 skip에 `-p`, `-a`, `--enable` 등이 추가됐고 wrapper/manager/update 라우팅 회귀가 보완됐다.
- 이전 리뷰의 `-p home app-server --help` 성공은 도움말 파싱까지만 입증한다. FIX_01_REPORT가 기록한 실제 server 실행 시 profile 거부를 인정한다. `-p`는 parser/record 회귀로, 실제 server가 허용하는 `--enable`은 runtime 관측으로 구분한 정정은 타당하다. 프로필을 사용한 실제 server 실행이 가능하다는 주장을 요구하지 않는다.

## F1 — P2: 새 replacement 테스트가 대체 서버 프로세스를 남김

위치: `tests/test_codex_update_contract.py:2466`의 `test_companion_server_real_replacement_preserves_old_generation_while_helper_lives` 정리 코드.

테스트의 finally는 old server PID와 old helper PID만 종료한다. replacement transaction이 detached로 시작한 새 server는 `afterRestartable`에서 PID를 확인하면서도 정리하지 않는다. 새 server는 timeout 없이 Unix socket을 listen하므로 pytest가 종료된 뒤에도 살아 있다. readiness 확인과 session record 생성이 끝난 뒤 assertion이 실패하는 경우에도 같은 누수가 발생한다. 초기 READY assertion·helper PID 읽기·record 쓰기는 try 밖에 있어 setup 도중 실패 시에도 자체 생성 프로세스가 남을 수 있다.

### 독립 재현

Reviewer가 고유 임시 디렉터리를 `--basetemp`로 지정해 이 테스트만 실행했다.

```text
1 passed in 4.57s
pytest_exit: 0
surviving_fixture_processes: [{pid: 1668122, state: S}]
```

그 PID는 해당 단독 실행의 임시 경로 아래 server entrypoint를 argv로 참조했다. Reviewer는 PID start-time을 다시 확인한 뒤 이 단독 실행에서 만든 잔류 프로세스에만 SIGTERM을 보내 정리했다. 기존 Executor 실행에서 남았을 수 있는 프로세스나 운영 프로세스는 종료하지 않았다.

### 요구 수정과 수용 조건

- setup 시작부터 teardown을 보장하는 fixture/try 구조를 사용한다. old/helper/replacement 및 실패 시 rollback으로 생기는 모든 자체 생성 generation을 추적한다.
- 성공 경로의 `res`만 의존하지 말고, 출력·assertion 이전 실패에도 회수할 수 있게 fixture 소유권과 PID+start-time을 기록한다. 세션 record나 고유 fixture 경계를 활용할 수 있으나 전역 문자열 kill은 금지한다.
- pipe를 닫고 직접 child는 reap하며, detached child는 bounded wait로 종료를 확인한다. runtime 신원 보호와 graceful 동작을 약화하지 않는다.
- 단독 테스트 PASS 후 자신의 임시 경로를 참조하는 live fixture process가 0인지 확인한다. setup/readiness 또는 assertion 실패 경로도 정리되는지 증거를 남긴다.

## F2 — P2: policy probe 검증 주장이 실제 테스트와 불일치

위치: `FIX_01_REPORT.md:35`의 “정책 probe injection 없는 … preflight 통과” 주장과 `tests/test_codex_update_contract.py:2435`.

현재 테스트는 다음과 같이 실제 managed policy 검사를 성공 stub으로 대체한다.

```javascript
await mgr.applyUpdate({ policyProbe: async () => ({ valid: true }) });
```

이 테스트는 실제 subprocess의 signal/socket 전환과 mock generation replacement를 검증하는 데 유효하다. 그러나 실제 Codex 바이너리와 enforced AppArmor/managed policy를 통과한 업데이트 증거는 아니다. 성공 정책 stub을 사용한 fixture 검증을 정책 검사 완료로 표현하면 검증 공백을 잘못 판단하게 된다. 같은 보고서 §6의 “rollback 경계 … 확인”도 주의한다. 이 테스트는 성공 transaction과 잔류 helper를 확인하며 rollback 실패를 직접 주입하지 않는다. 기존 rollback 테스트의 증거와 구분해야 한다.

### 요구 수정과 수용 조건

- 기존 FIX_01_REPORT는 이력으로 보존하고 새 `FIX_02_REPORT.md`에서 policyProbe stub 사용을 명시적으로 정정한다. progress에서도 fixture transaction, 실제 Codex 관측, enforced policy 검증을 구분한다.
- 실제 실행한 assertion만 검증 완료로 적는다. rollback은 별도 기존/신규 테스트 이름과 결과를 연결하거나 이 신규 테스트 범위 밖이라고 명시한다.
- enforced smoke를 실행하지 못했다면 NOT RUN을 유지하면 된다. 이를 보완하려고 production policy를 약화하거나 이번 리뷰를 운영 HAOS 변경 승인으로 해석하지 않는다.
- 테스트 수 기록도 단일 기준으로 정리한다. FIX_01_REPORT 표의 file 97과 마지막 “현재 기준 file 96”은 서로 모순된다. 새 보고서에는 현재 소스의 정확한 명령·결과만 기록하고 과거 다른 시점 수치를 현재 결과로 합치지 않는다.

## F3 — P2: 예산 소진 상태에서도 Auto-apply ready가 yes로 출력됨

위치: `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs:2390`의 session 기반 `canApply`와 `:2468`의 text status.

`canApply`는 현재 blocker가 없다는 세션 판정인데 text는 이를 전체 자동 업데이트 준비 상태로 표시한다. staged 후보가 있고 같은 날짜의 12회 예산이 소진되어 daemon이 기다리는 경우에도 프로세스가 종료되면 `Auto-apply ready: yes`가 된다. 보고서의 핵심 현상인 paused_busy와 모순되는 설명이다. 자동 OFF·검증 차단 같은 비세션 조건도 이 표현에는 반영되지 않는다.

### 독립 재현

현재 날짜/시간대 기준 budgetDate, idleCheckCount 12, stagedVersion 0.163.0, status paused_busy, nextRetryAt 다음 날짜 첫 슬롯을 임시 state에 저장하고 유휴 상태에서 실제 text `status`를 실행했다.

```text
Auto-update:       enabled
Daily idle checks: 12/12 (date: 2026-10-17)
Next retry at:     2026-10-17T18:00:00.000Z
Auto-apply ready:  yes (no Codex processes)
Status:            paused_busy
```

실제 apply·restart는 수행하지 않았고 상태 출력의 불일치까지 확인했다.

### 요구 수정과 수용 조건

- `canApply`의 기존 session predicate를 유지한다면 JSON 의미를 문서화하고 text label을 세션 조건 충족 여부로 바꾼다. 전체 자동 적용 가능 상태로 표시하려면 autoUpdate/options/staged/blocked/budget/cooldown 등 관련 조건을 구분한다. 기존 정책이나 예산을 바꾸지 않는다.
- paused_busy에서는 현재 세션 blocker가 없더라도 다음 허용 재검사 대기임을 명시한다. manual apply의 즉시 재검사 가능성과 자동 실행 대기를 구분한다.
- 예산 소진+현재 유휴, cooldown+idle managed server, auto OFF, 실제 busy blocker의 JSON/text 회귀를 추가한다. 성공 가능한 세션 상태를 “지금 자동 적용 가능”으로 오독하게 하는 출력이 없어야 한다.

## 검증·인계

- Reviewer는 관련 pytest pair를 재실행하고 manager Node syntax, wrapper Bash syntax/ShellCheck, `git diff --check`를 확인했다. 최종 결과는 progress의 이번 Reviewer 기록에 적는다. 전체 pytest·image build·enforced AppArmor·HAOS·ARM은 이번 리뷰에서 NOT RUN이다.
- Executor는 가장 높은 미실행 수정 지시인 이 FIX_02를 수행하고 `FIX_02_REPORT.md`를 작성한다. PLAN/REPORT/FIX_01/FIX_01_REPORT와 본 문서를 수정하지 않는다.
- product/progress 문서는 실제 검증 범위와 일치시킨다. 회귀 검사와 변경 문서 lint/diff를 수행하며 commit/push/PR/release, 버전 상승, 실제 HAOS 변경은 수행 범위가 아니다.
- 새 production P1 결함을 추가로 재현한 것은 아니다. 다만 테스트의 프로세스 누수와 검증 주장·상태 표시가 정리되기 전까지 전체 인수는 보류한다.
