# FIX_07 — FIX_06 재리뷰: 복원 불가능한 loaded 대화의 재시작 허용 회귀

작성일: 2026-11-02 (Asia/Seoul)
Reviewer: Codex
대상: `25472a2` / `feat/fix03-mobile-proxy-bootstrap`
판정: **REQUEST CHANGES — 비영속 대화 유실 재현, 신규 DEV 배포 보류**

## 1. 검토와 수용된 부분

사용자의 Reviewer 지시에 따라 PLAN과 FIX/REPORT 이력, FIX_06_REPORT, progress, 현재 Git 상태와 `9edb0b8..25472a2`를 검토했다. 이번 Reviewer는 제품 코드·버전·외부 Git·운영 HA를 변경하지 않는다.

다음 개선을 수용한다.

- procfs mtime/any-accepted 연결 대신 커널 UNIX_DIAG peer inode와 후보 owner FD를 대조하는 방향으로 수정했다. start-time도 proc start tick을 사용한다.
- 기존 unrelated accepted alias 재현을 새 코드로 독립 재실행해 더 이상 B helper로 잘못 승격하지 않음을 확인한다. 정확한 결과는 아래 검증 항목에 기록한다.
- 실제 raw server 0.162.1→0.166.0의 restartServers transaction과 새 proxy의 thread/resume·후속 turn 문맥 확인 시험을 추가했다. 이 시험은 client가 proxy를 닫고 직접 재연결·resume하는 범위이며 실제 모바일 앱의 자동 복원을 입증하지 않는다.
- SSH 상태 진단과 기존 실제 SSH wrapper/bootstrap smoke 개선은 유지됐다.

그러나 loaded 대화 허용 범위를 넓히면서 복원 불가 상태도 재시작하는 P1 회귀가 생겼다. 다음 Executor는 FIX_07을 수행해 `FIX_07_REPORT.md`를 새로 작성한다. 과거 보고서는 보존하고 재리뷰 전 신규 DEV 버전 배포를 실행하지 않는다. 이번 문서는 dev.6 등 배포 지시가 아니다.

## 2. [P1] 내용 있는 ephemeral도 applied=true로 종료해 복원 불가

대상:

- `codex-runtime-manager.mjs`의 `inspectAppServer()` (약 1214~1275행), 호출부 `isManaged: true`.
- `codex-server-transaction.mjs`의 Unix server 재시작 분기 (약 293~297행).

### 원인

기존 `loadedThreads.length` 차단을 managed server에서는 제거했다. 하지만 단순 관리 record와 복원 capability는 다르다. 현재 `isManaged`는 옵션 객체 외에도 **아무 문자열 또는 true**이면 참이 되며, transaction이 세 번째 인자로 넘기는 version 문자열도 복원 가능한 것으로 취급한다.

표준 Unix server의 재시작 분기는 server를 종료·재기동한 뒤 다음 빈 분기만 실행한다.

```javascript
if (Array.isArray(server.loadedThreads) && server.loadedThreads.length > 0) {
  // Threads are restored onto the launched generation
}
```

실제로 loaded thread의 영속성·비영속 내용·복원 가능성을 검증하거나 복원하지 않는다. 검증된 lifecycle host의 원래 복원 로직과 동일하지 않다. 새로운 persistent positive test에서 client가 직접 `thread/resume`한 성공으로 모든 managed loaded 상태의 안전성을 입증할 수 없다.

### Reviewer 독립 재현

Git 제외 `.test-tmp/review007-fix06/ephemeral.py`, 결과 `ephemeral-final.log`.

Executor의 `test_proxy_real_update_restart_transaction_and_cross_generation_turn_continuity`를 그대로 사용하면서 **최초 thread/start params에 `ephemeral: true` 한 항목만 추가**했다. 로컬 mock provider와 공식 binary·실제 transaction을 사용했고 제품 코드는 변경하지 않았다.

관측:

1. 비영속 대화의 첫 turn이 실제로 완료된다.
2. 재시작 직전 restartable server의 loadedThreads에 해당 thread가 남아 있다.
3. restartServers가 **applied=true**를 반환한다.
4. 새 server에서 같은 thread/resume은 result 없이 error를 반환해 기존 수용 assertion이 실패한다.

이는 단순 시험 누락이 아니라 **복원 불가능한 내용 있는 대화를 가진 서버를 종료하는 실제 회귀**다. `docs/development/runtime-handover.md`의 “내용 있는 비영속 대화는 복원 미지원 이유로 전환 보류” 경계와도 충돌한다. 테스트가 proxy를 먼저 닫았다는 이유로 유실을 정상 처리하지 않는다. 실제 loaded 상태가 남아 있고 updater가 안전 적용이라고 판단했기 때문이다.

## 3. 필수 수정

1. 표준 Unix server의 관리 record 존재와 **안전한 복원 가능성**을 구분한다. loaded 대화가 있는 상태의 유휴 허가는 검증된 관측·복원 capability를 근거로 해야 한다. 문자열/boolean shortcut으로 복원 권한을 추정하지 않는다. transaction의 version 인자와 명시적 inspection 옵션 계약을 분리한다.
2. 각 loaded thread의 persistent/ephemeral, 저장 가능한 실제 history, 복원 지원 여부를 검사한다. 내용 있는 ephemeral·unknown·저장 경로/복원 신원 불명 상태는 **종료 전** 구체적인 unsupported/unknown 사유로 보류한다. 첫 응답을 마친 idle 상태도 보존 대상이다.
3. 기존 검증된 lifecycle host의 ephemeral/empty-thread 처리와 일관성을 유지한다. 영속 대화나 검증된 빈 ephemeral의 지원 범위를 불필요하게 후퇴시키지 않는다. 모든 loaded 수만으로 무기한 보류하는 원래 문제를 재도입하지 않는다.
4. 새 Unix server 경로에서 실제 복원을 담당하는 주체를 명확히 한다. server transaction이 복원을 보장한다면 필요한 실제 resume·readiness·신원 검증을 수행한다. client reconnect/resume에 의존한다면 그 capability와 상태 보존이 검증되는 경우만 허용하고, 적용 완료와 client 복원 완료를 구분한다. 빈 comment를 복원 완료로 간주하지 않는다.
5. transaction 직전 재검증에도 같은 조건을 적용한다. snapshot 때 persistent였더라도 상태/신원이 바뀌면 전환을 취소한다. 실제 busy/queue/approval/background 보호와 admission·rollback 계약을 유지한다.
6. 종료 후 발견해 되돌리는 대신 **종료 전 차단**을 보장한다. volatile state는 기존 process 종료 뒤 old binary 재실행으로 복구할 수 있다고 가정하지 않는다.

## 4. 정식 회귀와 검증

- 위 독립 ephemeral 재현을 정식 시험으로 추가한다. ephemeral first turn 완료 후 적용 시도는 applied=false이어야 하고, old server PID·loaded thread·내용이 유지돼 다음 요청이 처리돼야 한다.
- persistent positive case는 실제 교체·재연결·resume·다음 turn 문맥을 계속 통과해야 한다.
- 검증된 빈 ephemeral, 미지원 ephemeral, missing/malformed persistence metadata, 저장 경로 불명·신원 변경을 구분한다.
- raw Unix와 lifecycle-host stdio/TUI 양쪽의 보호·복원 경계가 일관적인지 확인한다.
- 실제 제품 wrapper/SSH 진입 및 selected/bundled/worker 버전 차이를 기록한다. 기존 mock provider를 사용하며 운영 auth·개인키·기기 상태는 사용하지 않는다.
- 신규 Netlink peer 조회는 실제 이미지에서도 정상 proxy→owner 인식·unknown 실패 닫힘을 확인한다. 호스트 Python에 의존한 시험만으로 container 지원 완료라고 판단하지 않는다. Python 실행 파일/모듈과 필요한 권한이 제품 이미지·AppArmor에서 가용한지 기록한다. 금지 권한은 추가하지 않는다.
- 관련 회귀·전체 suite, Node/ShellCheck, 이미지 build·SSH smoke, 설정/문서 lint·secret scan·diff를 확인한다. native ARM/custom AppArmor/HAOS/mobile 미수행은 명시한다.

## 5. 시험 환경 실패와 보고 원칙

이번 Reviewer 최초 전체 관련 시험은 `/tmp`의 사용자 quota 초과로 다수 실패했다. 이 환경 실패를 제품 실패나 합격 근거로 사용하지 않는다. 같은 검사를 저장소 안의 짧은 `--basetemp=.test-tmp/r7`로 옮겨 재실행했다. ephemeral 독립 시험도 처음 package 복사가 quota에 걸렸고, 저장소 안의 임시 디렉터리로 옮긴 뒤 위 유실을 재현했다. 다른 사용자의 `/tmp` 데이터나 기존 증거를 지우지 않았다.

FIX_07_REPORT는 정확한 source/이미지/binary 신원, ephemeral negative·persistent positive 결과, 실제 복원 주체와 gate 계약, 관련/전체 검증 및 NOT RUN을 기록한다. 기존 FIX_06_REPORT는 이력으로 보존한다. docs/README/DOCS 한국어·영어와 changelog의 실제 지원 경계를 필요한 범위에서 정리하고 progress를 갱신한다.

합격 기준은 **비영속 대화가 유실되기 전에 안전하게 보류되고, 지원하는 영속 대화의 유휴 교체·후속 요청은 유지되는 것**이다. 이 회귀 해소 전에는 새 DEV 배포 지시를 발행하지 않는다.

## 6. 이번 Reviewer 독립 검증 결과

- 저장소 경로로 옮긴 관련 pytest: **149 passed, 1 failed in 129.53s**. 남은 실패는 긴 Unix socket fixture 경로에서 control socket이 만들어지지 않은 경우다. 해당 1개를 `/home/lee` 아래 직접 생성한 짧은 임시 basetemp에서 재실행해 **1 passed**를 확인했다. 전체 150개를 한 번에 모두 통과시켰다고 기록하지 않는다. 로그: `.test-tmp/review007-fix06/pytest-repo.log`, `socket-retry.log`.
- `python3 tests/mobile-ssh-smoke.py codex-ha:test-fix06`: **PASS** (현재 SSH/bootstrap 조회 범위). `.test-tmp/review007-fix06-smoke.log`.
- 기존 unrelated accepted alias 재현: **helpers=0, unknown=1, canApply=false**로 바뀌어 수용했다. `.test-tmp/review007-fix06/alias-final.log`.
- nonempty ephemeral 실 turn/실제 restart 재현: loadedThreads 잔존 → **applied=true** → 동일 thread/resume error. `.test-tmp/review007-fix06/ephemeral-final.log`.
- Node syntax(runtime manager/transaction), wrapper ShellCheck, diff PASS. 기존 image에서 Python 3.14.10 가용성을 확인했다. 실제 AppArmor의 Netlink 관측이나 정상 peer inventory까지 검증한 것은 아니다.
- 전체 pytest·새 image build·native ARM/custom AppArmor·실제 HAOS/mobile은 이번 Reviewer에서 NOT RUN이다. 시험 process·컨테이너 및 직접 만든 단기 임시 디렉터리는 정리했다. Git 제외 증거는 보존한다.
