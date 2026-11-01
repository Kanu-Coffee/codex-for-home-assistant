# FIX_03 — 모바일 SSH 인증 이후 bootstrap 실패와 app-server proxy 전송 오류

작성일: 2026-11-02 (Asia/Seoul)
역할: Reviewer / 다음 실행자: 별도 Executor
판정: **REQUEST CHANGES — 제품 wrapper의 raw proxy 경로에서 연결 실패 재현**
상태: **수정·검증 지시 발행 / 제품 수정·추가 배포 전**

## 1. 목표와 범위

사용자는 DEV의 모바일 Remote 연결을 계속 실패했으며, 공개키 저장과 실제 인증을 순서대로 확인한 뒤 트러블슈팅용 FIX 발행을 요청했다. 다음 Executor는 이 FIX를 수행하고 `FIX_03_REPORT.md`를 신규 작성한다. 기존 PLAN/REPORT/FIX_01/FIX_02와 각 보고서는 이력으로 보존한다. FIX_02의 dev.5 배포를 반복하거나 기존 tag/image를 덮어쓰지 않는다.

목표는 **SSH 인증 이후 제품 Codex wrapper를 거치는 원격 bootstrap/transport를 정상화**하고, 관리형 실제 작업 기반 업데이트의 보호·유휴 적용 조건을 유지하는 것이다. 키를 재생성하거나 비밀번호 SSH로 바꾸는 작업이 아니다.

이번 FIX의 기본 범위는 로컬 원인 확인·구현·검증·문서와 보고서다. 사용자 운영 HAOS·Stable/main·인증·키·포트·네트워크를 변경하지 않는다. 새 DEV version bump/push/PR/merge/tag/image/release는 별도 사용자 배포 지시가 있을 때 수행한다. 과거 FIX_02의 dev.5 게시 지시를 이후 버전 배포 승인으로 자동 재사용하지 않는다. 단, 사용자가 이 FIX 실행과 함께 배포까지 명시하면 그 범위와 확정 버전을 보고서에 기록하고 진행한다.

## 2. 필수 사전 확인

1. 루트 AGENTS, `docs/development/rules.md`, `progress.md` 및 관련 product_spec/architecture/addon_spec/security/test_plan을 읽는다.
2. 이 task의 PLAN·REPORT·모든 FIX/REPORT와 현재 Git diff/status를 읽는다. 이전 부분 구현 보고만으로 현재 제품이 미구현이라고 단정하지 않는다.
3. 발행 시점 branch는 `dev`, HEAD는 `b7b3479f7e4c78dd87f7b5b28a6474e64f33f19a`다. 기존 미커밋 progress 진단 기록을 보존한다. Executor는 feature branch를 사용하고 다른 작업자의 변경을 삭제하지 않는다.
4. 최신 공식 Codex 문서/실행 파일 help/필요한 공식 source로 실제 `app-server`, `app-server proxy`, stdio, Unix WebSocket 계약을 확인한다. app-server 하위 명령의 실행 규약을 부모 명령과 동일하다고 가정하지 않는다.
5. 로컬 이미지·binary가 참고 경로에 없으면 공식 패키지 checksum을 검증해 격리 fixture를 준비한다. 운영 CODEX_HOME/auth를 재사용하지 않는다.

## 3. 확보된 증거와 남은 불확실성

### A. 사용자 제공 운영 증거

- `/data/ssh/mobile/authorized_keys`의 fingerprint와 `ha-codex-remote status` 값이 일치한다.
- `sshd -T`는 일반 구성 키와 `/data/ssh/mobile/authorized_keys`를 모두 사용한다.
- localhost에서 해당 `private.pem`으로 공개키 인증 → 원격 `printf` → SSH_OK 및 exit 0을 확인했다.
- 휴대폰 접속 시각의 실제 DEV sshd 로그에도 동일 ECDSA 키의 `Accepted publickey` 및 원격 command session 시작이 반복된다.
- 사용자는 같은 서버의 Stable 연결은 정상이라고 확인했다.

따라서 현재 증거상 PEM 입력 파싱·공개키 부재·키 소실·SSH 인증 실패는 이번 조사 우선 원인이 아니다. `/data/ssh/mobile`은 앱 영속 `/data` 아래이며 setup은 기존 키 재사용, revoke는 공개키 등록을 비우고 private 복사본 삭제, 이후 setup은 새 키를 생성한다. 사용자에게 반복 revoke/키 교체를 요구하지 않는다.

### B. Reviewer가 로컬 제품 이미지에서 재현한 결함

Git 제외 참고 파일:

- `.test-tmp/proxyprobe.py`
- `.test-tmp/proxyprobe.log`
- 이미지 `codex-ha:0.7.3-dev.5-test` (최종 Executor는 image ID/labels와 정확한 binary version/digest를 별도로 기록).

격리 `/init` 컨테이너, 합성 옵션·보호경로 fixture, 공식 Unix app-server listener를 사용했다. 사용자 auth·키·운영 데이터는 사용하지 않았다. 같은 socket에 HTTP WebSocket Upgrade를 보내 아래 차이를 확인했다.

| 경로 | 관측 결과 |
| --- | --- |
| `/usr/local/libexec/codex-real app-server proxy --sock /tmp/probe.sock` | `HTTP/1.1 101 Switching Protocols` |
| `/usr/local/bin/codex app-server proxy --sock /tmp/probe.sock` | 응답 없이 exit 1, `fatal transport error: malformed_frame in jsonl` |

raw proxy의 exit 0은 이 짧은 fixture가 입력 EOF로 종료된 결과이지 장기 연결/후속 작업 성공의 증거가 아니다. 이번 재현은 HTTP Upgrade까지 확인했으며 모델 응답까지 확인한 시험이 아니다. 시험 컨테이너는 제거했다.

### C. 원인과 확정 범위

wrapper는 첫 positional 명령 `app-server`만 보고 하위 `proxy`를 구분하지 않는다. `--listen`이 없다는 이유로 JSONL remote-stdio lifecycle host에 전달한다. 그러나 공식 `app-server proxy --sock`는 Unix socket의 raw byte bridge다. HTTP Upgrade/WebSocket bytes가 JSONL parser에 들어가 `malformed_frame`으로 종료된다.

**이 제품 결함은 재현됐지만, 제공된 sshd 로그에는 모바일이 보낸 정확한 bootstrap 명령과 원격 stderr가 없다.** 이것이 사용자 접속 실패의 유일한 직접 원인이라고 아직 단정하지 않는다. 수정 후 실제 제품 bootstrap과 모바일 수용까지 확인하거나, 남은 실패 단계를 명시해야 한다.

## 4. P1 — 서버 실행과 proxy 전달을 분리

대상:

- `codex_home_assistant/rootfs/usr/local/bin/codex`
- `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs`
- `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`
- 필요 시 `codex-server-transaction.mjs`와 실제 wrapper/transport 시험

구현 요구:

1. global 옵션 값·`--`·부모/하위 명령을 구분해 실제 server 실행과 `app-server proxy`를 파싱한다. argv 어딘가에 문자열 proxy가 있다는 이유로 분기하지 않는다. `-c key=value`, `--cd`, 옵션 값이 proxy인 경우, `--sock PATH`/공식 지원 등호 형식, help/version을 실제 계약에 맞춰 처리한다. 기타 app-server 하위 utility도 JSONL 서버로 오분류하지 않는다.
2. raw proxy는 HTTP Upgrade/WebSocket text/binary/control frames를 변형 없이 전달한다. JSONL lifecycle host로 보내지 않는다. 공식 byte bridge 직접 실행이나 명시적인 raw transport adapter 중 검증 가능한 최소 구현을 선택한다. 기존 stdio JSONL 서버와 TUI WebSocket 경로를 깨뜨리지 않는다.
3. proxy를 단발 명령으로 거짓 분류해 실행 중 프로세스를 숨기지 않는다. managed=true 기록을 남긴 채 실제 host/control socket이 없는 상태로 실행하지 않는다. 검증할 수 없는 프로세스를 inventory에서 조용히 제외하지 않는다.
4. 기존 실행 세대 resolve/integrity 검증, admission lock, interrupted transaction 보호, 고정 민감 경로 정책, credential 비상속을 유지한다. 통신 오류를 피해 raw binary를 무조건 우회 실행하는 식으로 제품 정책 전체를 제거하지 않는다.
5. stdout은 wire 데이터 전용이다. 안내·warning·진단은 정제된 stderr로 보내고 secret/원격 payload를 기록하지 않는다. bootstrap script가 stdout/stderr를 병합하는 실제 진입도 확인한다. 단순 정책 warning까지 실패 원인으로 단정하지 말고 재현으로 판단한다.
6. peer EOF, stdin half-close, SSH 단절, server 종료, signal, backpressure와 frame 분할에서 영구 대기·고아 proxy/worker/record를 남기지 않는다. 종료 이유와 exit status를 보존하며 실패를 성공 exit로 바꾸지 않는다.

## 5. P1 — updater의 proxy 소유관계·유휴 판정 유지

현재 `parseCodexInvocation`과 inventory도 첫 `app-server`만으로 server를 분류한다. wrapper만 고쳐도 살아 있는 proxy가 독립 server/unknown/busy로 남을 수 있으므로 함께 검토한다.

- proxy 자체는 사용자 turn의 authoritative 작업 상태를 제공하는 서버가 아니다. 실제 socket의 관리 대상 server/relay와 연결되는지 검증한다.
- PID/start-time, exact executable generation, 관리 record·socket identity/소유관계 등 현재 설계의 신뢰 근거를 사용한다. socket 문자열 일치나 argv/동일 사용자만으로 임의 프로세스를 helper로 인정하지 않는다. 실제 proxy는 SSH 아래의 별도 process일 수 있어 단순 ancestor 관계만 가정하지 않는다.
- 검증된 소유 server가 있으면 proxy를 helper로 일관되게 계상하고 server의 실제 active/queued/tool/approval/background 작업을 보호한다. 창·연결·proxy 생존만으로 유휴 업데이트를 무기한 보류하는 회귀를 만들지 않는다.
- 소유권·상태·복원 가능성을 확인할 수 없으면 구체적인 unknown/unsupported 사유로 보류한다. missing socket/record, PID 재사용, 다른 서버 socket, 조작된 record 사례를 검사한다.
- 안전한 worker 교체가 제공되지 않는 경로를 “완전한 무중단 mobile 업데이트 지원”으로 표현하지 않는다. 필요 시 raw bridge 유지·server 전환/재연결 구조를 조정하되 세션 의미와 정책을 보존하고 설계 근거를 보고한다.

## 6. P1 — 실제 wrapper와 SSH를 통과하는 회귀

기존 `tests/test_codex_wire_probe.py`는 공식 raw binary를 검증한다. `mobile-ssh-smoke.py`는 키 인증과 printf를 확인한다. 둘의 PASS를 **제품 wrapper를 통한 모바일 bootstrap 성공**으로 대체할 수 없다.

필수 행렬:

| 시험 | 최소 성공 기준 |
| --- | --- |
| 수정 전 결함 | 제품 wrapper proxy에 Upgrade 전송 시 기존 JSONL 실패 재현 |
| 수정 후 실제 wrapper | HTTP 101 → masked WS initialize → 동일 ID/result; JSONL 오류/불필요 stdout 없음 |
| 실제 SSH command | 격리 sshd의 비대화형 로그인 환경 → 제품 `codex app-server proxy` → 동일 handshake/initialize 성공 |
| 후속 요청 | 같은 연결에서 thread/turn 요청·완료 및 다음 요청 처리. 모델은 임시 HOME의 로컬 mock provider 허용 |
| 기존 경로 | 관리형 stdio JSONL, Unix server, TUI/resume, help/version/기타 하위 명령 회귀 통과 |
| 프레이밍·종료 | 분할 입력, 여러 frame, binary/control, EOF/half-close, 서버 종료, 신호·정리·bounded backpressure |
| updater 보호 | proxy 연결 유지 중 유휴 판정, 실제 작업 중 보류, 신뢰할 수 없는 owner 보류, 안전한 전환 후 다음 요청 |

시험 지침:

- 참고 repro를 정식 자동 시험으로 정리한다. `.test-tmp` 안에만 남은 스크립트를 새 회귀가 있다고 보고하지 않는다.
- 실제 이미지의 제품 wrapper·등록 record·세대 resolve를 사용한다. classifier를 테스트 안에 복사한 구현만 비교하거나 raw binary만 실행해 통과시키지 않는다.
- baseline 0.162.1과 사용자 제보 당시 0.166.0을 우선 검증한다. 현재 다른 runtime이면 정확한 version/target/archive checksum과 실행 파일 digest를 기록하고 차이를 설명한다. 무관한 bundled/dependency 업그레이드를 섞지 않는다.
- 기존 live handover 시험의 짧은 Unix socket 경로·임시 HOME·package 권한 제약을 따른다. 실제 정책 gate를 stub한 시험은 그 사실과 범위를 명시한다.
- 필요한 테스트가 native CI에서 계속 실행되도록 기존 workflow에 연결한다. 실제 HAOS/custom AppArmor·모바일 연결과 로컬 Docker/OpenSSH는 분리해 기록한다.

## 7. P2 — 오류 위치를 구분하는 안전한 진단

이번 `status`는 private key의 fingerprint만 계산한다. 공개키 등록 파일·sshd 실효 설정·실제 인증·Codex transport까지 보장하지 않는다. 가능하면 현재 도구의 범위를 명확히 하고 아래 비밀 없는 상태를 제공한다.

- private material 존재/안전한 소유·권한, 공개키 등록 일치, sshd 등록 경로·listener 상태를 각각 표시한다.
- SSH 인증 성공과 Codex bootstrap/initialize 성공을 구분한다. 확인하지 않은 단계는 not_checked/unknown으로 표시한다.
- 진단이 필요하면 role/transport/phase/정제된 error code/exit status만 사용한다. 전체 argv/env, auth token, private key, thread 내용과 WebSocket payload를 로그에 남기지 않는다. SSH/wire stdout에 진단을 섞지 않는다.

P2를 구현하지 않아도 P1 수정과 검증을 지연시키지 않는다. 그 경우 문서에서 기존 status의 한계를 분명히 하고 보고서에 잔여 개선으로 남긴다. 사용자에게 키 재생성을 반복 요구하지 않는다.

## 8. 검증·문서·인계

- 관련 회귀, 전체 pytest, Node syntax, wrapper ShellCheck, 변경 YAML/Markdown, workflow 변경 시 actionlint, Dockerfile 변경 시 Hadolint, secret scan, `git diff --check`를 수행한다.
- 정확한 수정 소스로 amd64 이미지 build와 mobile SSH smoke, 새 실제 wrapper/bootstrap smoke를 실행한다. native ARM/실제 AppArmor/HAOS가 불가하면 정확한 이유를 남긴다. 금지 권한을 추가해 통과시키지 않는다.
- README/DOCS 한국어·영어, changelog의 미배포 수정 항목과 개발 문서/progress를 필요한 범위에서 갱신한다. 키 인증이 정상인 사용자에게 다시 공개키 붙여넣기를 안내하지 않는다.
- 공개 배포 없이 로컬에서 검증했으면 “수정본 로컬 검증 완료/미배포”로 보고한다. dev.5에서 해결됐다고 쓰지 않는다.
- 실제 사용자 모바일 재시험은 별도 수용이다. 원격 command/transport를 검증한 로컬 모의 client의 PASS를 ChatGPT 앱 수용으로 바꾸지 않는다. 사용자 장치나 앱에 직접 접근할 수 없다면 다음 확인 항목만 전달한다: 인증 성공 뒤 bootstrap 오류 여부, 모델 응답·다음 요청, 유휴 업데이트 뒤 복원. 실제 사용자가 제공한 결과는 그 출처를 명시한다.

## 9. FIX_03_REPORT 필수 내용과 완료 기준

1. 수정 전/후 정확한 source SHA 또는 diff 기준·이미지 ID·labels·binary version/target/digest와 재현 절차.
2. 확정한 원인과 아직 입증하지 못한 실제 모바일 bootstrap 세부를 구분한 설명.
3. wrapper parser/transport·inventory/helper ownership·updater 변경 및 정책·신원 검증 유지 근거.
4. 실제 wrapper와 실제 SSH 경로의 HTTP Upgrade/initialize·후속 요청 결과, 종료·작업 보호·기존 CLI/resume 회귀 결과.
5. 실제 실행한 명령·개수·결과, skip/fixture/stub 여부와 로그 위치. 민감값 없는 최소 증거만 포함.
6. 전체 검증·이미지 build·native ARM/AppArmor/HAOS/mobile의 PASS/PARTIAL/NOT RUN, P2 수행 여부.
7. 제품 코드·문서 변경 목록, 공개 배포 여부와 필요 시 이후 사용자 수용 절차.

완료 기준은 **재현된 raw proxy 결함의 수정, 실제 제품 wrapper+SSH transport 성공, 기존 실제 작업 기반 업데이트 보호 회귀 없음, 정확한 문서·보고**다. 실제 모바일 수용을 확인하지 못했다면 그 제한을 명시한다. 원인 분석이나 키 인증 성공만으로 FIX 구현을 완료 처리하지 않는다.
