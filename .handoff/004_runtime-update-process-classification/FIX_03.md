# FIX_03 — 테스트 정리 대상 신원 확인과 cooldown 표시 일치

## 판정과 검토 범위

- Reviewer: Codex, 2026-10-17 (Asia/Seoul).
- 판정: **수정 필요 / 인수 보류**. 아래 P2 2건을 확인했다.
- PLAN/REPORT, FIX_01/FIX_01_REPORT, FIX_02/FIX_02_REPORT와 현재 코드·테스트·progress를 대조했다. 기준 HEAD `11b8839`, branch `main`, 기존 미커밋 변경을 보존한다.
- FIX_02 F2의 policyProbe 성공 stub·fixture transaction·실제 정책 검증 공백 구분 정정은 수용한다. 새 테스트가 성공 transaction만 검증하고 rollback은 별도 검사라는 구분도 유지한다.
- FIX_02 F1은 정리 대상 수집과 setup/finally 보호를 추가했지만 종료 대상의 경계·신원 확인이 부족하다. F3은 예산 소진/자동 OFF 표시를 분리했으나 cooldown 표시가 JSON과 불일치한다.
- 제품 코드는 Reviewer가 수정하지 않았다. 재현용 자체 생성 프로세스만 정상 종료했으며, 새 정리 함수로 무관 프로세스에 실제 종료 신호를 보내지는 않았다. 운영 HAOS/Remote·외부 Git·배포 변경은 수행하지 않았다.

## F1 — P2: fixture 정리 함수가 형제 경로 프로세스까지 종료 대상으로 수집함

위치: `tests/test_codex_update_contract.py:2388`의 `_find_fixture_processes_for_dir`, `:2424` 및 `:2454`의 신호 전송.

경로 경계를 검사하지 않고 `fixture_str in cmdline/exe/cwd`로 프로세스를 수집한다. 따라서 fixture가 `/tmp/.../case`일 때 `/tmp/.../case-sibling`에서 실행한 별도 프로세스도 대상이 된다. 이 결과를 `_terminate_fixture_processes`가 그대로 합쳐 SIGTERM, 최대 대기 이후 SIGKILL을 전송한다. argv에 fixture 경로가 데이터로 포함된 별도 프로세스도 같은 문제를 갖는다.

또한 `tracked_pids`와 sessions 파일에서 읽은 PID는 start-time 없이 저장된다. 이미 old server가 reap된 뒤 정리하거나 bounded wait 중 PID가 재사용되면, `kill(pid, 0)`은 원래 프로세스와 새 프로세스를 구분하지 못한다. FIX_02가 요구한 PID+start-time 기반 자체 생성 대상 확인이 구현되지 않았다.

### 독립 재현

임시 부모 아래 `case`, `case-sibling` 디렉터리를 만들고 sibling을 cwd로 하는 자체 생성 Python 대기 프로세스를 시작했다. 실제 `_find_fixture_processes_for_dir(case)`를 호출한 결과:

```text
sibling_process_alive: true
unrelated_sibling_selected: true
```

이 프로세스는 helper의 종료 대상 탐색에는 포함됐지만, Reviewer가 해당 helper를 통한 실제 kill은 실행하지 않았다. 직접 소유한 Popen 객체로 정상 종료·reap했다. PID 재사용 문제는 코드상 신원 검증 부재로 확인했으며 실제 시스템 PID 재사용을 강제로 유발하지 않았다.

### 요구 수정과 수용 조건

1. `fixture_dir` 소유 프로세스를 단순 문자열 포함으로 판정하지 않는다. 경로는 정확한 segment 경계를 확인하고, interpreter script argv를 사용할 때 실행 entrypoint 위치를 데이터 인수와 구분한다. 가능하면 spawn 시점 identity와 직접 관측한 자식/대체 서버 identity를 우선 기록한다.
2. `(pid, start_time)` 또는 동등한 안정된 프로세스 핸들을 추적한다. stale session 파일의 숫자 PID만으로 종료하지 않는다. SIGTERM과 이후 escalation 각각 직전에 동일 신원과 fixture 소유권을 확인하고, 사라지거나 다른 신원이면 대상에서 제거한다.
3. 직접 child의 reap, detached child의 bounded wait 및 setup 실패 시 정리는 유지한다. helper 동작 검증에서 fixture 밖 프로세스를 실제로 종료하지 않는다.
4. 최소 회귀: `case-sibling` cwd/exe는 제외, argv에 case 경로가 데이터로만 든 프로세스는 제외, 재사용 PID에 signal 미전송(안전한 mock 가능), 실제 fixture replacement/helper는 성공·setup 실패 양쪽에서 잔류 0. 실패 assertion 이전에 출력이 없더라도 회수 가능해야 한다.
5. Reviewer는 이 결함 때문에 현재 companion_server cleanup 테스트 실행을 보류했다. 수정 후 고유 basetemp 단독 실행과 사후 잔류 확인을 다시 수행한다. 기존 프로세스나 이전 Executor의 잔류물을 전역 검색으로 일괄 종료하지 않는다.

## F2 — P2: 완전 유휴 상태의 cooldown 처리에서 JSON과 text가 모순됨

위치: `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs:2404`, `formatAutoApplyReady():2440`.

JSON `autoApplyReady`는 `sessions.isIdle`이면 restart cooldown을 무시한다. 이는 실제 apply 로직이 restartable server를 교체할 때만 cooldown을 적용하는 동작과 일치한다. 그러나 text formatter는 isIdle 조건 없이 미래의 nextRestartAllowedAt이 있으면 항상 대기라고 표시한다. 서버가 모두 종료되어 일반 symlink 전환만 하면 되는 상태에서 불필요하게 자동/수동 적용 대기를 안내한다.

### 독립 재현

임시 options에서 auto-update ON, state에 stagedVersion 0.163.0, idleCheckCount 0, blockedReason 없음, status ready_to_apply, nextRestartAllowedAt 현재보다 1시간 뒤를 기록했다. 실행 중인 Codex 프로세스가 없는 상태에서 실제 `getStatus()`와 formatter의 출력:

```json
{"isIdle":true,"canApply":true,"autoApplyReady":true,"text":"waiting (restart cooldown active until ...; manual apply also respects cooldown)"}
```

현재 새 테스트의 cooldown case는 idle managed server라고 설명하지만 실제 `getStatus()`로 받은 완전 유휴 상태에 시간만 저장한다. 해당 case에서 JSON boolean을 검증하지 않아 이 모순이 통과한다.

### 요구 수정과 수용 조건

1. JSON과 text가 같은 판정 결과/보류 code를 사용하게 정리하거나 최소한 같은 조건을 공유한다. cooldown은 실제 restartable server 교체가 필요한 상태에서만 대기 사유가 된다. 예산·권한·정책 자체는 바꾸지 않는다.
2. 미래 cooldown+프로세스 없음은 세션/후보 등 다른 조건이 충족되면 JSON ready와 text ready가 일치해야 한다. 미래 cooldown+idle managed server는 양쪽 모두 대기여야 한다. formatter를 검사하는 테스트도 정확한 상태의 `isIdle` 값을 사용한다.
3. 예산 소진·자동 OFF·busy blocker 회귀를 유지한다. invalid options에서는 readOptions가 autoUpdate false를 반환하더라도 명시적으로 disabled인 정상 옵션과 잘못된 구성에 의한 blocked를 혼동하지 않게 출력 순서를 검토한다.
4. `getNow()`를 사용하는 apply 판정과 readiness 판정의 시간 기준도 일치시켜 경계 테스트에서 서로 다른 시계를 쓰지 않게 한다.

## 검증과 인계

- Reviewer는 위 두 독립 재현, Node/Bash syntax, wrapper ShellCheck 및 `git diff --check`를 수행했다. 관련 pytest는 위험한 새 teardown 호출을 피하도록 `-k 'not companion_server'`를 지정해 재실행했다. 최종 수치와 미실행 항목은 progress의 이번 Reviewer 기록에 남긴다.
- 전체 pytest, companion_server teardown 재실행, 새 image build, 실제 Codex update/restart, enforced AppArmor, HAOS·ARM 실기는 이번 리뷰에서 NOT RUN이다. 소스의 새 변경을 과거 실제 바이너리 검증으로 자동 승격하지 않는다.
- Executor는 이 FIX_03을 수행하고 `FIX_03_REPORT.md`를 새로 작성한다. 기존 handoff는 수정하지 않는다. progress를 실제 결과와 일치시킨다. commit/push/PR/release·버전 상승·실제 HAOS 변경은 요구 범위가 아니다.
