# FIX_06 — FIX_05 재리뷰: 실제 peer 관계와 교체 후 요청 수용 보완

작성일: 2026-11-02 (Asia/Seoul)
Reviewer: Codex
대상: `9edb0b8` / branch `feat/fix03-mobile-proxy-bootstrap`
판정: **REQUEST CHANGES — 새 DEV 배포 지시 보류**

## 1. 요청·검토·수용한 부분

사용자의 Reviewer 지시에 따라 PLAN·기존 FIX/REPORT 이력, FIX_05_REPORT, progress, 현재 코드와 diff를 대조했다. 이전 문제를 반복했다고 단정하지 않고 개선된 부분은 수용한다.

- argv/record mismatch 차단은 유지됐다.
- 다른 PID를 sshd로 오판하던 상태 진단은 보완됐다. Reviewer가 기존 bash PID 재현을 실행해 `pid_mismatch`와 `SSH auth: not_checked` 출력을 확인했다.
- 두 공식 binary에 mock provider의 실제 첫/두 번째 turn과 user/assistant 문맥 누적 검증을 추가한 것은 유효하다.
- 실제 SSH wrapper/bootstrap smoke는 독립 재실행해 PASS했다. 이 시험의 현재 범위는 키 인증·S6·wrapper·초기 및 조회 RPC까지다.

아래 두 사항은 아직 FIX_05의 기존 요구를 충족하지 못한다. 다음 Executor는 FIX_06을 수행해 `FIX_06_REPORT.md`를 신규 작성한다. 과거 handoff 문서는 보존한다. 이번 Reviewer는 제품 구현·버전·외부 Git·운영 HA를 변경하지 않는다. 합격 시 다음 번호 FIX로 신규 DEV(예: dev.6) 배포를 지시하며, 이 문서는 배포 지시가 아니다.

## 2. [P1] 서로 다른 accepted 연결의 존재를 해당 proxy의 peer 증명으로 사용

대상: `codex-runtime-manager.mjs` 약 1519~1605행.

현재 구현은 다음 세 가지를 사용한다.

- `/proc/<pid>` 디렉터리 mtime과 target mtime/ctime의 50ms 비교.
- owner의 `/proc/<pid>` mtime과 proxy의 mtime 100ms 비교.
- proxy에 socket FD가 존재하고, 후보 owner에 **어떤 연결이든** CONNECTED(03) Unix socket FD가 존재하는지 검사.

이것은 특정 proxy socket과 해당 owner의 accepted socket이 서로 연결됐다는 증거가 아니다. 시간차 휴리스틱 역시 연결 peer와 세대의 대체 증명이 아니다. FD 목록 접근 실패가 proxyHasSocket=false로 처리되면 accepted socket 검사를 건너뛰는 점도 확인해야 한다.

### Reviewer 독립 재현

기존 `.test-tmp/review007-fix04/alias-owner.py`의 재현에 **B로 연결하는 무관한 클라이언트 하나**만 추가했다. 소스는 `.test-tmp/review007-fix05/alias-unrelated.py`다.

1. 합성 idle managed server B를 먼저 구동하고 무관한 클라이언트가 B와 연결을 유지한다.
2. alias→A 상태에서 proxy가 실제 Unix 연결을 연다. A가 accept한 연결을 유지한다.
3. 실제 proxy argv와 launch record는 동일 alias 경로다.
4. alias를 B로 바꾸고 production `inspectAllSessions()`를 실행한다. mtime 조작이나 제품 코드 변경은 하지 않았다.
5. 결과: proxy의 실제 연결은 여전히 A인데 **helpers=1, unknown=0, canApply=true**다.

사용한 owner/프로세스는 합성 fixture지만 Unix accept/연결 유지와 production inventory 경로는 실제다. 실제 사용자 작업 중단을 재현한 것은 아니다. 다만 proxy 작업을 관측하지 않는 무관한 server의 helper로 제외할 수 있는 기존 P1이 남아 있다. FIX_05_REPORT의 “real peer verification 완료”는 이 구현에 비해 과도한 표현이다.

### 필수 수정

- 특정 proxy의 연결과 상대 server를 직접 결합하는 검증을 구현한다. “proxy에 socket 있음” + “owner에 accepted socket 하나 있음” 조합으로 승격하지 않는다.
- `/proc` 디렉터리 mtime을 권위 있는 process start-time으로 사용하지 않는다. 기존 PID/start tick identity와 구별하고, timeout/시간 오차·파일시스템 generation 휴리스틱을 보조 정보 이상으로 신뢰하지 않는다.
- alias/rebind 경쟁이 가능한 경로에서는 연결 시점 세대/peer를 확보·검증한다. 연결을 생성하는 검증된 raw adapter나 관리형 등록 절차 등을 검토할 수 있다. 확인할 수 없는 경우 unknown으로 보류하되, 정상 연결도 모두 영구 보류시키는 방식으로 유휴 업데이트 요건을 포기하지 않는다.
- SOCK_DIAG/SO_PEERCRED 등 구현 수단이 실제 Node/HAOS/권한 조건에서 가능한지 확인한다. 지원 불가 시 구체적 실험과 오류를 남기고 다른 방법을 선택한다. 시간 margin 조정·추가 sleep으로 이번 시험 하나만 막는 수정은 수용하지 않는다.
- 정식 회귀에는 위 **무관한 accepted connection 존재** 시나리오를 포함한다. socket FD 관측 실패, owner 접근 실패, 정상 실제 연결, alias/rebind·stale PID, active owner 보류도 확인한다. 실패 시 검증 생략으로 helper가 되는 경로를 막는다.

## 3. [P1] 서버/worker 교체 후 대화 복원 시험은 여전히 없음

대상: `tests/test_codex_wrapper_proxy.py::test_proxy_multi_turn_conversation_with_mock_provider_and_update_protection` 및 실제 SSH 경로.

새 시험은 첫 turn 중 `inspectAllSessions().canApply=false`를 확인하고, 응답을 풀어 같은 **기존 server process**에서 두 번째 turn을 실행한다. 시험에는 applyUpdate/switchWorker, server 종료·재시작, 새 실행 세대/PID 확인, reconnect/resume이 없다. 따라서 실제 대화와 active 보류는 개선됐지만 **업데이트 이후 다음 요청 수용**을 입증하지는 않는다.

### 필수 수정·검증

1. 진행 turn/요청 중에는 실제 적용이 보류되고 응답이 완료됨을 확인한다.
2. 유휴 상태에서 실제 updater/transaction으로 검증된 후보 세대로 전환한다. old/new PID, 실제 실행 파일·version, owner 연결 및 thread 신원을 기록한다. canApply 조회만으로 적용을 대체하지 않는다.
3. proxy 전송이 유지되거나 명시적인 reconnect/resume 절차가 성공한 뒤 같은 영속 대화에서 다음 turn의 응답과 문맥을 확인한다. 실제 제품 wrapper와 SSH 진입을 포함한다. 별도 raw binary 두 turn 시험과 wrapper 조회 RPC 시험을 합쳐 교체 후 성공으로 표현하지 않는다.
4. Unix app-server SIGHUP 뒤 proxy가 EOF로 종료된다면 이를 성공으로 덮지 않는다. 필요한 reconnect/restore를 구현·시험하거나, 구현 불가 근거와 현업 영향·제한된 우회/요건 변경안을 구체적으로 제시한다. 사용자가 그 요건 변경을 수용하기 전에는 동일 목표 달성으로 판정하지 않는다.
5. 기존 mock Responses provider·임시 HOME을 사용해 비용과 운영 인증 없이 시험한다. 환경의 namespace/AppArmor 제약은 구현 문제와 구분하고 가능한 격리 환경을 활용한다. 제품 보호 정책·금지 권한을 완화하지 않는다.
6. exact baseline/후보 identity를 기록한다. 새 test는 후보 0.166.0에서도 launch record version이 0.162.1로 고정돼 있으므로 실제 시험 대상과 metadata를 일치시킨다.

## 4. 보고·문서·수용 기준

- FIX_05_REPORT는 이력으로 보존한다. 새 FIX_06_REPORT에 이번 발견의 수정 전/후 증거, 실제 연결 신원 근거와 실패 닫힘, 실제 적용·복원·후속 turn 결과를 각각 기록한다.
- raw 2-turn·busy 관측은 PASS, 실제 교체 후 복원은 현재 NOT RUN이다. “실제 peer”와 “accepted 연결 존재”, “업데이트 보류 관측”과 “적용 후 복원”을 구분한다.
- 관련 회귀·전체 suite, Node/ShellCheck·문서/설정 lint·secret scan·이미지 build·SSH smoke를 수행하고 실제 HAOS/mobile/native ARM/custom AppArmor의 미검증을 남긴다.
- 한국어·영어 README/DOCS·changelog의 미배포 변경과 실제 지원 범위를 정리한다. 기본 스케줄·보호 정책·키·인증·Stable을 유지한다.
- 합격 기준은 **위 peer 오분류 제거와 실제 교체 뒤 후속 요청 수용 증거**, 정확한 검증 보고다. 기술적으로 불가능하면 실험과 대안을 보고해 사용자 요건 조정을 받는다. 이번 문서를 신규 버전 배포 승인으로 확대하지 않는다.

## 5. 이번 Reviewer 독립 검증

- 관련 pytest(`test_remote_setup.py`, `test_codex_wrapper_proxy.py`, `test_codex_update_contract.py`): **148 passed in 106.81s**. `.test-tmp/review007-fix05/pytest.log`.
- `python3 tests/mobile-ssh-smoke.py codex-ha:test-fix05`: **PASS** (현행 SSH/bootstrap·조회 RPC 범위). `.test-tmp/review007-fix05-smoke.log`.
- 기존 bash PID 재현은 pid_mismatch로 바뀌어 수용했다. alias+무관한 B accepted 연결 재현은 여전히 helpers=1/unknown=0/canApply=true였다. 시험 process와 컨테이너는 정리했다.
- Node syntax 2개·wrapper ShellCheck·diff 검사 PASS. 전체 suite·새 image build·실제 교체 후 요청·native ARM/custom AppArmor/HAOS/mobile은 이번 Reviewer가 재실행하지 않았다.
- 이번에 기록한 기존 테스트 성공과 별개로 peer 오분류 재현 및 전환 후 수용 누락이 남아 있어 합격으로 판정하지 않는다.
