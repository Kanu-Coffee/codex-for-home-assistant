# FIX_01 — 자동 업데이트 리뷰: 변경 요청

## 판정과 범위

- Reviewer: 2026-10-13, Asia/Seoul.
- 판정: **CHANGES REQUESTED**. 현재 `0.7.1` 후보를 승인하거나 발행하지 않는다.
- 기준: 이 task의 PLAN/REPORT, 기존 001 PLAN, `feat/codex-auto-update` HEAD `a32698851e3c3539f5d4b823e60d4f0d29038df1`와 전체 working tree. 기존 FIX는 없다.
- Executor의 tracked 변경 32개 외에 untracked maintenance module/S6/test 파일도 검토했다. 과거 PLAN/REPORT는 보존한다. 이 수정은 `FIX_01_REPORT.md`로 보고한다.
- 사용자 추가 요구: 개발 환경 HAOS VM 활용, 재시작 검토와 재시작의 무한 반복 방지, HA 옵션의 자동 업데이트 선택권과 현재 버전 안내, 프로젝트 고정 버전 오류 점검.
- Reviewer는 구현 코드를 수정하지 않았다. 아래 요구를 Executor가 구현하고 검증한다. commit/push/PR/release와 운영 HA 변경은 현재 범위 밖이다.

## 독립 검증 결과

| 검사 | Reviewer가 실제 확인한 결과 |
| --- | --- |
| `.venv/bin/python -m pytest -q` | **123 passed in 10.19s** |
| 변경된 wrapper/manual helper/S6 run의 ShellCheck | PASS |
| `hadolint --config .hadolint.yaml codex_home_assistant/Dockerfile` | PASS |
| 3개 workflow actionlint | PASS |
| `apparmor_parser --skip-kernel-load --skip-cache codex_home_assistant/apparmor.txt` | PASS, kernel에 load하지 않음 |
| 두 신규 module `node --check`, `git diff --check` | PASS |
| 리뷰 문서 작성 후 `pytest -q tests/test_secret_scan.py` | **2 passed in 1.71s**, 신규 FIX 구조·progress 링크·diff 검사도 PASS |
| 임시 디렉터리에서 stale state save 재현 | staging을 기록한 직후 daemon과 같은 오래된 snapshot save를 수행하면 `stagedVersion=null`로 소실 |
| 임시 디렉터리에서 current containment 재현 | runtime root 밖의 `current` target을 init이 수용하고 status가 그 밖의 fixture executable을 실행함 |
| kernel gate 외부 배타 잠금 상태에서 apply 호출 | apply가 기다리거나 lock-busy를 반환하지 않고 함수 본문 실행 후 `no_staged_update` 반환; source에도 flock acquisition 없음 |
| wrapper start-time 기록 재현 | `awk /proc/self/stat`은 wrapper가 아닌 awk 프로세스 start time을 반환 |
| malformed Unix RPC fixture | 유효한 Sec-WebSocket-Accept도 없고 diagnostics/loaded 응답이 `{}`인데 `inspectAppServer(..., expectedPid)`가 `busy:false` 반환 |
| malformed options JSON fixture | `readOptions()`가 `autoUpdate:true` 반환 |
| `virsh -c qemu:///system list --all`/`dominfo` | HAOS 계열 개발 VM 존재, 현재 shut off. 부팅·guest 변경은 하지 않음 |

모든 재현은 private temporary fixture와 가짜 버전/응답만 사용했다. 실제 auth/token/session 내용·proc environ을 읽지 않았다. 기존 123개 테스트 PASS는 아래 runtime 결함을 검증하지 못한다. REPORT의 RPC/locking/상태 sanitization 검증 설명은 실제 테스트 범위보다 넓다.

## 수정 1 — 실제 transaction/launch 잠금과 올바른 session identity (P1)

근거: `codex-runtime-manager.mjs:866-885`는 gate 파일을 open할 뿐 kernel lock을 얻지 않는다. check/init/save/GC에도 transaction 단일화가 없다. wrapper `codex:107-122`는 공유 lock을 exec 전에 해제하고, lock 실패 시 그대로 실행한다. `codex:108`의 start time은 awk 자신의 PID를 읽는다.

영향: 수동·daemon check/apply가 동시에 state와 package를 바꿀 수 있다. 새 launch와 idle 검사/선택 전환이 경합한다. 등록 session이 잘못된 start time 때문에 삭제될 수 있어 REPORT의 “커널 flock으로 완벽 차단”은 성립하지 않는다.

요구:

- manual/daemon check·stage·apply·init recovery·GC가 같은 transaction discipline을 사용하도록 실제 lock을 구현한다. 파일 open만으로 lock을 대체하지 않는다. 필요한 도구가 image에 실제 존재하는지도 확인한다.
- shared launch gate 아래에서 올바른 wrapper PID/start identity를 기록하고 executable generation을 선택한다. lock 실패/registry 오류/검사 실패는 업데이트를 blocked로 만든다. updater 장애가 기존 CLI 복구를 막지 않도록 image fallback과 불확실한 session 존재 처리를 설계한다.
- process exec 전후 공백을 처리하고 stale PID/고아 companion·background 작업을 안전하게 추적한다. proc environ은 읽지 않는다.
- lock을 잡은 채 새 launch와 병렬 manual commands를 실행하는 회귀 시험, PID 재사용/등록 직후 exec/lock timeout 음성 시험을 추가한다. source 문자열 검사만으로 PASS 처리하지 않는다.

## 수정 2 — daemon의 stale state overwrite 제거 (P1)

근거: `codex-updater-daemon.mjs:38-52`가 check 전에 읽은 state를 `checkUpdate()`의 상태 저장 뒤 다시 save한다. catch의 `:72-76`도 오래된 snapshot을 저장한다.

영향: staging과 `lastCheckAt`이 사라진다. busy apply는 staged symlink를 남기지만 state에는 staged version이 없어 5분 재검사가 동작하지 않는다. 다음 slot에서 같은 package를 다시 다운로드할 수 있다.

요구:

- slot reservation/result/state transition은 동일 transaction 안에서 최신 상태를 읽어 필요한 필드만 갱신한다. 함수별 stale snapshot 저장을 금지한다.
- 성공·실패·pending의 package pointer, selected/staged/hash와 journal이 일치하도록 crash recovery를 구현한다. 단순 atomic JSON rename과 transaction journal을 구분한다.
- 한 slot에서 download 성공→busy 보류→다음 5분 재검사→세션 종료→적용까지 frozen clock으로 실행한다. staging·선택 버전이 잃어버려지거나 동일 후보가 다시 다운로드되면 실패다.

## 수정 3 — 후보별 재검토·재시작·실패 시도 상한과 진짜 적용 완료 (P1)

근거: daemon `:78-94`의 pending 재검사에 누적 상한이 없다. manager `:918-927`의 검증 실패는 stagedVersion/link를 남겨 다음 loop에서 같은 실패를 반복한다. 코드에는 server drain/restart가 없으며 `:941-945`에서 symlink와 `--version`만 확인하고 `applied`로 기록한다. idle Unix app-server는 `inspectAllSessions()`에서 busy로 계산하지 않으므로 구버전 서버가 살아 있는데도 applied가 될 수 있다.

요구:

- 최신 stable **조회는 하루 4회 계속**한다. 이를 개별 candidate의 무한 idle 검사·재시작 반복과 구분한다.
- 기본 안전 상한: 후보 `version+verified digest`당 자동 idle 검토 **최대 12회**, 5분 간격. 자동 graceful restart는 후보당 **최대 1 transaction 시도**. verification/partial restart 실패는 즉시 자동 차단한다. 성공 후보에는 동일 재시작을 반복하지 않는다.
- 이 count/blocked reason/마지막 시도·다음 가능 시각을 영속화한다. daemon/App restart·slot 변경·OFF/ON으로 한도가 초기화되면 안 된다. 같은 버전 artifact의 hash 변경은 새 후보로 수용하지 말고 무결성 오류로 처리한다.
- 상한 도달 시 `blocked_busy`/`blocked_restart`로 멈추고 사용자에게 이유와 명시적 manual retry 경로를 보여 준다. manual retry도 세션 보호와 verification은 우회하지 못한다. 새로운 정식 후보만 별도 budget으로 시작한다.
- App 소유권·transport·graceful semantics를 검증한 서버만 안전하게 drain/restart하고 PID/start identity·실제 실행 version·socket readiness를 확인한다. unknown/stdio Remote는 자연 종료까지 보류한다. 전체 App/Core restart, kill -9/pkill이나 timeout 뒤 강제 종료를 추가하지 않는다.
- managed restart를 지원하지 않는 case는 보류/미지원으로 보고한다. 살아 있는 구버전 서버를 남겨 놓고 `applied` 또는 재시작 완료라고 쓰지 않는다. 서버가 전혀 없으면 다음 launch 경로 검증으로 적용을 완료할 수 있다.
- frozen-clock과 실제 fixture process로 장기 busy, 동일 실패, daemon restart, 부분 restart 실패, 새로운 slot/후보를 시험해 횟수 상한과 signal 수를 assertion한다.

## 수정 4 — 적용 전 호환성·unsafe path·archive·resource 보존 (P1)

근거: `downloadAndStagePackage():624-798`은 URL/digest와 archive member **이름**만 일부 확인하고 `--version`만 실행한다. companion/config/requirements/sandbox 호환성 검사와 link target/type/owner 검사가 없다. `:778-781`은 같은 version destination을 재귀 삭제한다. `initRuntime():232-250`과 `applyUpdate():877-905`는 root 밖 link를 허용한다. `cleanupOldReleases():960-971`는 실행 중 참조 package를 보존하지 않는다.

영향: unsafe 링크의 외부 executable 실행, 현재 실행 resource 삭제, 새 Codex의 정책 비호환 적용이 가능하다. TLS로 공식 파일을 받았다는 사실은 local state나 unpacked tree의 안전성 검증을 대신하지 못한다.

요구:

- URL/tag/stable flags/arch/manifest/digest를 strict하게 검증하고 network redirect·응답 크기·total timeout을 제한한다. timeout 시 실제 request/stream도 abort/close하고 staging 정리가 완료되게 한다.
- archive type·symlink/hardlink target·absolute/traversal·device·파일 수/총 추출 크기를 검사한다. root 밖 link와 owner/mode/type/link-count가 안전하지 않은 tree는 거부한다. lstat import만 해 두고 검증됐다고 쓰지 않는다.
- current/staged/previous는 canonical release root 또는 **정확한** image baseline 안에만 있어야 한다. bin/manifest·중간 디렉터리 symlink도 검증한다. 임시 파일은 exclusive/no-follow 방식과 atomic+durable journal을 사용한다.
- official package의 필요한 code-mode-host/bwrap/app-server/resource와 license를 확인하고 적용 **전** isolated fixture HOME에서 config/requirements/MCP approval parsing과 real sandbox deny/정상 RW/network/helper 호환성을 검증한다. 불가능하면 적용을 blocked로 한다.
- 동일 version 디렉터리를 덮어쓰거나 지우지 않는다. current/previous/staged/실행 중 참조본은 삭제하지 않으며 불확실하면 GC를 보류한다. 새 App image baseline과 retained override의 version floor/호환성도 검증한다.
- wrapper 선택도 동일 canonical validation을 사용하고 검증된 package의 실제 실행 실패는 명확한 오류·복구 상태로 다룬다. 지금의 `-x` 검사만으로 안전한 fallback이 보장됐다고 쓰지 않는다.
- escaping symlink/손상 state/동시 stage/실행 companion 유지/unknown future config/rollback crash 회귀와 actual AppArmor sandbox의 runtime write 거부·필수 resource 실행을 검증한다.

## 수정 5 — unknown 세션 상태의 fail-open 제거 (P1)

근거: `inspectAppServer():463-490`는 diagnostics PID·gauges·loaded data가 없으면 idle로 처리한다. `inspectAllSessions():500-535`는 proc/registry read 오류를 무시하고 companion 이름도 포괄하지 않는다. Unix socket WebSocket은 `:341`의 HTTP 101 문자열만 검사하며 frames/응답 크기·lifetime 제약도 부족하다.

요구:

- expected PID와 실제 socket owner, diagnostics 필수 gauge의 타입/범위, loaded 목록·cursor를 strict 검증한다. 응답/메서드 누락·unknown fields로 상태를 판단할 수 없으면 busy/blocked다.
- 승인·사용자 입력 대기·pending server request·background terminal·client/loaded session을 다룬다. loaded idle conversation 보류 정책을 유지한다. 프로세스 탐색 오류는 빈 목록으로 바꾸지 않는다.
- 실제 사용할 tag의 protocol과 `--listen unix://` 기본/explicit socket 경로·별도 app-server companion을 확인한다. 임의 local process가 advertised한 socket에 무조건 연결하지 않는다.
- 정식 WebSocket library 사용 여부는 기존 dependency와 비교해 판단한다. 자체 구현이면 Sec-WebSocket-Accept/frames/fragmentation/close/errors와 message size·전체 deadline을 검증한다. raw error payload/본문을 로그에 출력하지 않는다.
- 이번 Reviewer의 `{}` 응답 fixture가 반드시 blocked가 되는 회귀를 추가한다. source와 fake response 테스트 및 실제 app-server 검증을 구분한다.

## 수정 6 — 옵션 선택권과 신뢰 가능한 현재 버전 표시 (P1/P2)

확인: `config.yaml`에 `codex_auto_update: true`, schema `bool`과 ko/en 설명이 **이미 있다**. 이를 중복 옵션으로 추가하지 않는다. 실제 HA Configuration 화면의 토글은 아직 시험하지 않았다.

결함: `readOptions():156-171`은 malformed/unreadable JSON에서도 ON을 반환한다. daemon은 다운로드 시작 전에만 옵션을 읽어 작업 중 OFF 변경을 적용 직전에 확인하지 않는다. `getStatus():979-996`의 runningVersion은 살아 있는 프로세스 버전이 아니라 current 파일을 새로 실행한 출력이다. `APP_VERSION/BASELINE_VERSION` 상수도 image metadata와 독립적으로 하드코딩되어 있다.

요구:

- 옵션 **누락**의 기본 ON과 옵션 파일 **검증 실패**를 구분한다. parse/schema 오류 시 자동 업데이트를 차단하고 정제 reason을 표시한다.
- HA 토글 OFF를 최종 apply gate 안에서도 재확인한다. OFF 이후 자동 선택 전환/재시작이 없어야 한다. 수동 명령만 사용자의 명시적 호출로 허용한다. status에서 ON/OFF/timezone도 확인 가능해야 한다.
- App version은 baked `app-version`, bundled version은 검증한 package manifest에서 읽고 image pin과 대조한다. selected와 실제 running versions를 구분해 표시한다. 실행 프로세스가 없으면 running은 `none`이지 selected version이 아니다. 여러 버전이 실행되면 배열/집계로 정직하게 보여 준다.
- 사용자가 HA에서 현재 버전을 쉽게 확인하도록 App startup log와 Ingress terminal의 간결한 상태 안내에 bundled/selected/running·자동 ON/OFF·pending reason 및 `ha-codex-update status`를 제공한다. 동적 버전을 저장용 HA 옵션으로 위장하지 않는다. 별도 대시보드/외부 포트를 새로 만들 필요는 없다.
- wrapper `codex:8-44`의 argument parser는 flags의 값과 실제 update subcommand를 구분하지 못한다. `codex -m update`는 모델 값인데 가로채고, `codex -c key=value update`는 실제 subcommand인데 놓친다. supported global flags/`--`/help/인자 오류를 실제 실행 fixture로 검증한다. unknown update 인자를 조용히 무시하지 않는다.
- HAOS Configuration에서 ON/OFF 저장·재시작 후 보존·busy staged 중 OFF, Ingress 상태 안내와 actual version을 검증한다. 번역 설명도 동작과 일치시킨다.

## 수정 7 — 고정 버전·경로 문서와 검증 주장 교정 (P2)

일괄 치환하지 말고 “현재 동작”, “후보”, “기발행 역사”를 분리한다.

| 위치 | 발견한 오류/누락 | 요구 |
| --- | --- | --- |
| `docs/development/addon_spec.md:103` | `Stable 0.7.1` native CI/public image 검증 통과라고 적음 | 0.7.1은 미발행 후보, 새 CI/build/HAOS 결과와 과거 0.7.0 증거를 분리 |
| `addon_spec.md:294-298` | 현재 설치 절차/체크섬이 여전히 0.144.1 bare artifact | 현재 package 설치·정확한 두 hash로 갱신 |
| `test_plan.md:186`, `:492` | 현재 artifact/ARM 절차가 0.144.1 | bundled pin/selected override/running 버전별 acceptance로 갱신 |
| `releasing.md:74` | 게시 후 검사 Codex 0.144.1 고정 | image baseline metadata 기준 exact 검사로 변경 |
| `references.md:125-126` | 이전 CLI release만 참고 목록에 남음 | 새 baseline 공식 release 추가, 이전 자료는 historical로 표시 |
| `architecture.md:569-574`, `DOCS.en.md:434`, 한국어 DOCS의 같은 절 | `/data/codex-runtime/versions/`와 실제 코드 `releases/<version>-<target>` 불일치 | 실제 확정된 구조로 통일 |
| `.github/workflows/ci.yaml:155-159`, `tests/update-smoke.sh:4` | update baseline이 계속 0.6.0 | PLAN대로 0.7.0 → 0.7.1 검증 및 관련 step-name contract 갱신 |
| manager 상수, tests, README/DOCS current-version 문구 | image version과 별도의 current-version 하드코딩 | runtime metadata를 사용하고 bundled/selected/running을 분리; 기발행 current stable 0.7.0 표기는 publication 전 역사로 유지 가능 |
| REPORT 비교/완료 설명, progress 완료 주장 | 실제 서버는 단순 파일 검사 방식이 아니며, 새 테스트에 RPC/transaction/runtime E2E 증거가 없음 | 원 REPORT를 덮어쓰지 말고 FIX report/progress에서 정정·미검증 범위를 명시 |

`rg -n '0\.144\.1|0\.162\.1|0\.7\.0|0\.6\.0|codex-runtime/versions'` 등으로 전체 source/current docs/CI/tests를 재점검한다. 과거 changelog/ADR/evidence/fixture에 필요한 구버전은 유지한다. App `0.7.1` version parity는 유지하고 임의로 `0.7.2`를 만들지 않는다.

## 수정 8 — 빠진 runtime 검증과 HAOS VM 수용 (P1: 승인 전 필요)

REPORT에는 unit/lint만 있고 image ID·Docker build/full smoke·real updater transaction·public 0.7.0 보존 검증이 없다. 기존 시험 중 일부는 fake codex를 사용한다. 신규 updater tests는 대체로 pure helper/source assertion이며 보고한 end-to-end 범위를 입증하지 못한다.

실행 순서:

1. 위 결함의 재현 회귀를 먼저 추가하고 통과시킨다. 실제 transaction·network fixture·daemon frozen clock을 시험할 수 있게 설계한다. 테스트 전용 입력은 production에서 임의 download/path 우회가 되지 않게 분리한다.
2. amd64 후보 image를 실제 build해 image ID/baseline hash/package layout/version/필수 도구를 기록한다. existing 7종 smoke와 신규 updater smoke, 0.7.0 → 후보 persistence smoke를 수행한다. 외부 최신 release 유무에 의존하지 않는 fixture를 사용한다.
3. 현재 개발환경의 libvirt HAOS VM을 사용해 Supervisor/AppArmor·Config UI·Ingress/SSH·업데이트 시나리오를 검증한다. VM은 `virsh -c qemu:///system`에서 확인됐으며 sibling `antigravity_for_HA`의 checkout-owned 관리 대상이다. 기존 ownership/state를 무시하고 덮어쓰지 않는다.
4. 참고 도구는 `/home/lee/projects/antigravity_for_HA/tools/development/haos-vm`다. 해당 AGENTS와 도구의 checkout ownership·status·app-stage 계약을 읽은 뒤 안전한 테스트 VM/guest scope를 확보한다. 이 도구를 Codex 저장소에서 그대로 실행해 다른 App을 staging하지 않는다. VM 공유 상태를 보존하고 필요하면 Codex 전용 disposable scope를 사용한다. 운영 HA에 연결하지 않는다.
5. 이 사용자 메시지는 개발 HAOS VM 검증 환경이 있다는 확인이다. 수정된 후보의 개발 VM 검증을 단순히 “실기 환경 없음”으로 건너뛰지 않는다. 신규 resource 설치·global config 변경·기존 VM 파괴가 필요하면 그 구체적 범위만 분리한다.
6. 실제 HAOS에서 자동 토글 ON/OFF·현재 버전 표시, active TUI/tmux/SSH/Remote pending, session 종료 후 apply, 후보별 retry cap/daemon 재시작 시 cap 유지, 실행 package AppArmor/bwrap·민감 경로 deny·일반 RW/API/browser/memory, App restart/update `/data` 보존을 확인한다. synthetic 파일/가짜 credential만 사용하고 비밀·실제 entity 원문을 evidence로 저장하지 않는다.
7. native aarch64는 amd64 VM으로 대체할 수 없다. native CI/별도 ARM 검증이 없으면 정확히 NOT RUN으로 남긴다. 실제 mobile Remote client가 없으면 stdio fixture와 실제 mobile E2E도 구분한다.

Reviewer는 현재 후보에 재현된 적용/무결성 blocker가 있어 HAOS에 설치하지 않았다. VM을 확인한 사실을 HAOS runtime PASS로 쓰지 않는다. 수정본의 VM 검증을 다음 correction round의 필수 evidence로 요구한다.

## 완료·재리뷰 기준

- 위 P1/P2 해결과 새 회귀 시험, App 0.7.1 parity, 가능한 image/full/updater/VM 검증 결과가 존재한다.
- `FIX_01_REPORT.md`에 각 수정 번호별 변경·재현 전후·실제 명령/exit·image ID·fixture/native/VM 구분·남은 FAIL/NOT RUN을 기록한다.
- 동일 후보가 무한 재검토/재시작하지 않고 OFF 설정을 존중하며 실제 running version을 정직하게 표시한다.
- fixed-version 검색 결과에서 현재 계약 오류와 보존해야 할 역사적 표기를 구분해 보고한다.
- diff/secret 검사 후 Reviewer에게 다시 전달한다. 구현 단계에서 외부 발행이나 운영 HA 변경을 추가하지 않는다.
