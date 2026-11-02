# FIX_04 — FIX_03 Reviewer 보완: proxy 신원·상태 진단·후속 요청 검증

작성일: 2026-11-02 (Asia/Seoul)
Reviewer: Codex
판정: **REQUEST CHANGES — 새 DEV 배포 지시 보류**
리뷰 대상: `ae6814a` / branch `feat/fix03-mobile-proxy-bootstrap`

## 1. 요청·판정·다음 역할

사용자는 Reviewer 리뷰 후 합격이면 새 DEV(예: 0.7.3-dev.6) 배포를 지시하는 FIX 발행을 요청했다. 아래 미충족 항목으로 현재는 합격이 아니다. 이 문서는 배포 지시가 아니라 보완 지시다. 다음 Executor는 이 FIX를 수행해 `FIX_04_REPORT.md`를 새로 작성한다. 기존 FIX_03 및 보고서는 보존한다. 제품 수정·버전 변경·배포는 이번 Reviewer가 실행하지 않았다.

보완 후 다시 리뷰한다. 통과할 때 다음 번호의 FIX로 DEV 버전 확정·배포 절차를 발행한다. 이번 문서를 dev.6 배포 승인으로 해석하지 않는다. 운영 HAOS·Stable/main·키·인증·포트·네트워크는 변경하지 않는다.

## 2. 검토 근거와 수용된 부분

PLAN·기존 REPORT/FIX들·FIX_03_REPORT, 현재 Git diff/status, progress와 실제 구현을 대조했다. FIX_03의 JSONL 오분류 수정은 유효하다. Reviewer가 `python3 tests/mobile-ssh-smoke.py codex-ha:test-fix03`를 독립 재실행해 S6, 키 인증, 실제 SSH 안의 wrapper proxy, HTTP 101와 initialize 성공을 확인했다.

다만 시험은 initialize 직후 연결을 닫는다. 이를 대화·모델 응답·유휴 업데이트 후 같은 세션의 후속 요청 성공으로 확대하지 않는다. 실제 ChatGPT 모바일·HAOS 수용은 여전히 NOT RUN이다.

Reviewer 증거는 Git 제외 `.test-tmp/review007-fix03/`, `.test-tmp/review007-fix03-smoke.log`에 있다. 아래 추가 재현은 합성 프로세스·임시 파일·격리 이미지에 한정하며 운영 자료와 키를 사용하지 않았다.

## 3. [P1] launch record가 실제 proxy argv보다 우선돼 다른 대상도 helper로 숨김

위치: `codex-runtime-manager.mjs` 약 1416~1426, 1474~1513행.

현재 `isProxyInvocation || isProxyRecord`로 분류한 뒤 `record.socketPath`를 실제 `invocation.proxySocket`보다 우선한다. 이후 경로가 server 후보의 socket과 같으면 helper로 인정한다. proxy record의 PID/start-time이 맞아도 실제 명령과 target이 일치하는지는 검증하지 않는다.

독립 재현:

- 기존 `test_managed_idle_server_with_owned_proxy_is_restartable`의 실제 proxy Popen `--sock` 값만 다른 socket 경로로 바꿨다.
- launch record와 검증용 idle server socket은 원래 값으로 유지했다.
- 실제 `/proc` argv는 다른 대상인데도 기존 assertions가 통과했다: `helpers=1`, `unknown=0`, `canApply=true`.
- 스크립트: `.test-tmp/review007-fix03/owner-mismatch.py`.

이 결과는 실제 활성 작업 중단을 재현한 것은 아니다. 그러나 작업 관측 대상과 다른 proxy를 검증된 helper로 제외할 수 있어, FIX_03이 요구한 신원·소유관계 검증을 충족하지 못한다. socket 경로 일치만으로 연결 소유권이 입증되는 것도 아니다. 기존 정상 fixture의 proxy는 실제 socket 연결 없이 대기하는 합성 프로세스다.

### 필수 보완

1. 실제 executable generation·PID/start-time·파싱한 명령이 proxy인지 확인하고 launch record의 type/args/target과 대조한다. 불일치는 unknown으로 보류한다. record만으로 비proxy 프로세스를 proxy/helper로 바꾸지 않는다.
2. 실제 접속 target과 record target의 정규 경로·socket identity를 대조한다. 정상 daemon alias는 지원하되 alias 재지정/경로 재사용을 정상 소유관계로 오인하지 않는다. 어느 PID의 어떤 실제 listener인지 증거를 확인한다. `/proc`/Unix socket 정보나 peer 신원 등 검증 가능한 방식을 선택하고 근거를 설명한다.
3. 신원·owner 관계를 증명하지 못한 경우 무시하거나 정상 helper로 숨기지 않는다. 그렇다고 정상 연결 모두를 영구 busy로 처리해 기존 유휴 업데이트 요구를 포기하지 않는다.
4. 정식 회귀를 추가한다: argv/record target 불일치, type/command 불일치, stale PID/record, owner 부재, 잘못된 listener/재지정된 alias, 정상 alias와 실제 연결된 proxy.
5. 해당 proxy의 실제 작업이 owner 관측에 포함되고 busy 중 전환을 차단하는지 확인한다. 단순히 aggregate count와 canApply만 통과시키지 않는다.

## 4. [P2] 상태 진단이 관측하지 않은 listening·인증을 성공처럼 표시

위치: `codex-remote-setup.mjs` 약 140~161행.

`ssh-disabled` marker가 없다는 이유만으로 `SSH service: active / listening`을 출력한다. `SSH auth: verified on client connection`은 실제 관측과 관계없이 고정 출력한다. 등록 문자열도 `content.includes(info.line)`만으로 synchronized라 판단해 주석·허용 제약·파일 구조를 충분히 구분하지 않는다.

Reviewer가 sshd를 시작하지 않은 격리 이미지에서 `install -d -m 0700 /data/ssh; ha-codex-remote status`를 실행하자 다음이 동시에 출력됐다.

```text
Mobile key: not configured
Private material: absent
Authorized keys: absent
SSH service: active / listening
SSH auth: verified on client connection (check App SSH logs for Accepted publickey)
```

이는 사용자가 현재 장애 단계를 판별하는 데 잘못된 근거를 준다. FIX_03에서 P2가 선택 사항이었다고 해도, 이미 추가한 진단이 미검증 상태를 성공으로 표시해서는 안 된다.

### 필수 보완

- 최소 수정은 marker 부재를 `not_disabled / listener not_checked`, 인증을 `not_checked (confirm Accepted publickey in App logs)`로 표현하는 것이다. 실제로 검사한다면 listening의 근거와 신원, 실패/unknown을 구분한다.
- private 파일이 0400인 경우 등에도 무조건 정확히 0600이라고 표시하지 않는다. unsafe private state는 storage.status가 먼저 throw하므로 현재 이후의 permissions 진단이 도달 가능한지도 정리한다. 민감값이나 crypto 오류 원문은 출력하지 않는다.
- 공개키는 정상 등록 라인의 key type/blob을 정확히 검사하거나, 한계를 명시한다. 주석 처리된 key, 빈 파일, out-of-sync를 정상 synchronized로 표시하지 않는다.
- helper status가 key를 생성하거나 등록을 복구하는 동작과 구분되도록 한다. 상태 점검을 이유로 사용자 키를 바꾸지 않는다.
- 실제 service 없음/marker 부재, marker 있음, private 없음/unsafe, public 불일치·주석 라인과 정상 상태를 정식 자동 검증한다.

## 5. [P1] 실제 wrapper+SSH의 대화·업데이트 후 후속 요청 수용 미검증

위치: `tests/mobile-ssh-smoke.py` 약 179~197행, `tests/test_codex_wrapper_proxy.py`의 실제 binary 시험.

현재 SSH smoke는 initialize 응답 직후 stdin을 닫는다. 새 wire 시험은 official raw binary 경로를 검증하며 실제 제품 wrapper는 SSH smoke의 초기 handshake까지만 확인한다. 새 updater fixture는 합성 idle server/helper 계상이며 실제 연결/turn/worker 전환을 수행하지 않는다.

따라서 FIX_03의 thread/turn·후속 요청, 실제 작업 중 보류, 유휴 전환 후 요청 수용 기준은 아직 충족되지 않았다. 기존 stdio/TUI handover PASS를 새 raw-proxy 경로의 증거로 대체할 수 없다.

### 필수 보완

1. 실제 제품 wrapper+SSH+raw proxy를 통과해 thread 시작/복원, local mock provider의 첫 turn 완료, 같은 연결의 다음 요청·문맥 보존을 검증한다. 운영 auth나 모델 과금은 필요 없다.
2. 같은 실제 경로에 진행 turn, 미완료 요청 또는 승인 대기 fixture를 두고 updater가 보류하는지 확인한다. 유휴 상태는 proxy 생존만으로 보류하지 않음을 확인한다.
3. 지원하는 안전한 전환에서 실제 owner/worker 교체와 이후 같은 대화 후속 요청을 확인한다. raw Unix server를 재시작하면 proxy가 종료되는 경우 정상 업데이트로 포장하지 말고, 필요한 reconnect/restore를 구현·검증하거나 기술적 한계와 사용자 요건 조정 필요를 명시한다.
4. timeout은 read loop 전체에 deadline을 두고, 예외 시 SSH/proxy/worker를 정리한다. 현재 `.read()` 기반 SSH read_exact는 wire 무응답에서 무기한 대기할 수 있다. EOF 시 stderr 전체를 무조건 공개하지 않도록 최소 오류만 정제한다.
5. baseline 0.162.1과 제보 당시 0.166.0에서 새 경로를 확인하고 exact package identity를 기록한다. 현재 신규 raw wire 시험은 local cache에서 첫 binary를 선택하므로 자동으로 두 version 모두 검증되는 것이 아니다.
6. 기존 CLI/resume, stdio, 모바일 키 생성·보존·폐기 회귀를 유지하고 필요한 native CI smoke에 연결한다. 실제 mobile/HAOS가 불가하면 NOT RUN을 명시한다.

## 6. 검증·문서·보고

- 위 독립 재현을 정식 failing regression으로 먼저 옮긴 뒤 고친다. Reviewer의 `.test-tmp`만으로 정식 시험을 대체하지 않는다.
- 관련 pytest와 전체 suite, Node syntax·ShellCheck, 변경 문서 lint, workflow 변경 시 actionlint, image build·새 SSH smoke, secret scan과 diff를 확인한다. 금지 권한이나 제품 보호 정책을 완화하지 않는다.
- FIX_03_REPORT는 이력으로 보존하고 새 결과는 FIX_04_REPORT에 쓴다. 실행하지 않은 시험을 PASS로 올리지 않는다. skip 사유를 실제 pytest 결과에서 확인한다.
- 한국어·영어 README/DOCS·changelog 미배포 항목과 progress를 실제 수정·지원 범위에 맞춰 정리한다. 이번 FIX_03 커밋에서 빠진 사용자 문서 검토도 포함한다.
- FIX_04_REPORT에는 실제 source/이미지/binary 신원, 각 결함의 수정 전/후 결과, proxy 소유권 근거, status 관측 범위, 실제 SSH의 첫/후속 turn·보류·전환 후 결과, 전체 검사와 NOT RUN·배포 여부를 기록한다.

합격 기준은 세 항목의 수정·검증과 사실에 맞는 보고다. 통과 후 Reviewer가 다음 번호 FIX로 새 DEV 배포를 지시한다. 이번에는 배포 지시를 발행하지 않는다.

## 7. 이번 Reviewer의 독립 검증 결과

- `tests/test_codex_update_contract.py`, `tests/test_codex_wrapper_proxy.py`, `tests/test_remote_setup.py`: **136 passed in 89.23s**. 로그 `.test-tmp/review007-fix03/pytest.log`.
- `python3 tests/mobile-ssh-smoke.py codex-ha:test-fix03`: **PASS** (SSH wrapper의 HTTP 101·initialize까지). 로그 `.test-tmp/review007-fix03-smoke.log`.
- argv/record target 불일치의 잘못된 helper 인정과, sshd 없는 상태의 거짓 active/listening 표시는 위 방법으로 별도 재현했다. 해당 합성 process와 컨테이너는 정리했다.
- wrapper ShellCheck, 수정된 runtime manager/remote setup Node syntax, diff 검사 PASS. 전체 pytest·새 image build·두 version full handover·native ARM·custom AppArmor·실제 HAOS/mobile은 이번 Reviewer가 재실행하지 않았다.
- 이전 보고서의 전체 307 passed/6 skipped 및 image build는 Executor 제공 증거다. 이번 독립 검사 136 PASS가 위 수용 미달을 해소하는 것은 아니다.
