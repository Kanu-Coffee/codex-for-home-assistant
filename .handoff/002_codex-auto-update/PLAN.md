# PLAN — Codex 자동 업데이트와 세션 보호 적용

## 요청·역할·우선순위

- Planner 검토 시작: 2026-10-12, 완료: 2026-10-13 (Asia/Seoul).
- 사용자 추가 요청: 현재 서버의 Codex 자동 업데이트를 참고해 HA App에서도 하루 약 4회 업데이트하고, 활성 세션이 없을 때 재시작 및 적용 검증까지 자동화한다. 수동 업데이트 명령도 제공한다. HA가 신규 App 업데이트를 인식하도록 마지막 버전 자릿수를 하나 올린다.
- **현재 실행 계획은 이 문서다.** 이전 `../001_codex-binary-update/PLAN.md`는 역사로 보존한다. 이전 계획의 런타임 자동 업데이트 금지와 단일 바이너리 pin만으로 끝내는 범위는 이번 요청으로 대체한다. 별도 세션 handoff의 immutable-history 규칙에 따라 새 번호 `002`를 만들었다.
- 구현자는 이 계획 전체를 읽고 구현·검증 후 이 디렉터리에 `REPORT.md`를 작성한다. 기존 handoff를 덮어쓰지 않는다. Reviewer 수정은 `FIX_NN.md`/`FIX_NN_REPORT.md`를 따른다.
- 이번 요청은 검토와 계획 수정이다. 아직 runtime 코드·App version을 변경하거나 서버 설정을 실행/수정하지 않는다. 이후 구현도 별도 외부 Git 작업·발행·실제 HAOS 변경의 승인으로 확대하지 않는다.

## 검토 결론

가능하다. 이미지의 검증된 Codex를 복구용 기본본으로 유지하고, 공식 stable package를 영속 `/data`에 staging한 뒤 세션이 없을 때 선택 버전을 원자적으로 전환한다. 다음 Codex 실행은 새 버전을 사용한다. 계속 떠 있는 App 소유 app-server가 있으면 안전한 graceful restart 후 실제 프로세스 버전을 검증한다.

Codex 업데이트를 위해 Home Assistant Core/Supervisor나 App 전체를 자동 재시작할 필요는 없다. 현재 App에는 전역 Codex app-server S6 서비스가 없고 웹 TUI·SSH·Remote가 실행할 수 있으므로, 존재하지 않는 서비스를 재시작하는 구현을 만들지 않는다. Remote stdio 프로세스는 SSH client가 소유하는 연결이므로 updater가 같은 stdio를 복제해서 재시작할 수 없으며 연결 종료까지 보류한다. 이 구분을 UI/문서와 acceptance에 명확히 반영한다.

활성 세션이 계속 있으면 적용 완료 시점은 보장하지 않는다. `pending_busy` 상태로 보존하고 자동 재확인한다. 업무를 끊어서 시간표를 맞추지 않는다.

## 저장소와 필수 맥락

- 작업 위치 `/home/lee/projects/codex_for_HA`, branch `main`, HEAD `a32698851e3c3539f5d4b823e60d4f0d29038df1`.
- 이번 검토 시작 상태: 이전 계획이 만든 `.handoff/001_codex-binary-update/PLAN.md`와 `docs/development/progress.md` 변경만 존재. 이를 사용자 작업으로 보존한다.
- 현재 App `0.7.0`, Codex `0.144.1`, amd64/aarch64 musl; wrapper `/usr/local/bin/codex`, 이미지 기본 바이너리 `/usr/local/libexec/codex-real`.
- `/data/codex`는 인증·사용자 설정 디렉터리다. 실행 package 저장소는 여기와 분리한다.
- 시작 시 루트 및 하위 AGENTS/GEMINI, `docs/development/rules.md`, `progress.md`, `product_spec.md`, `architecture.md`, `addon_spec.md`, `security.md`, `test_plan.md`, `releasing.md`와 실제 CI/Builder를 확인한다. Archive를 현재 지침으로 사용하지 않는다.
- `rules.md` R-403은 지금 자동 업데이트를 금지한다. 사용자 최신 요청이 우선하며, 구현에서 R-403과 관련 사양을 이번 정책으로 함께 개정한다. 이 충돌만으로 추가 승인을 요구하지 않는다.
- `/config` 일반 RW, Core/Supervisor 전체 API `manager`, 보호 경로 deny, `workspace-write`+network, ambient credential 비상속은 그대로 유지한다. admin/Docker API/full_access/host_network/AppArmor 비활성화는 금지다.

## 현재 서버에서 확인한 참고 구현

검토는 파일·timer 조회만 수행했다. maintenance 스크립트의 `update`, `restart`, `status`는 실행하지 않았으며 실제 세션 내용·인증·프로세스 환경을 읽지 않았다.

| 참고 파일 | 확인 내용 |
| --- | --- |
| `/home/lee/.config/systemd/user/codex-stable-update.timer` | KST 01~05시 정각마다 5회 확인, `Persistent=false` |
| 같은 디렉터리 `codex-stable-update.service` | Python worker `update`, TZ Asia/Seoul, private umask |
| 같은 디렉터리 `codex-idle-restart.timer` | 매시간 정각 restart worker 실행 |
| 같은 디렉터리 `codex-idle-restart.service` | idle 확인 후 하루 최대 1회 재시작 시도, graceful drain 보호 |
| `/home/lee/.local/lib/codex-maintenance/codex_stable_maintenance.py` | 583줄, SHA-256 `698846761df7f0ce05e48ebb48357aa5c92cf9c5a40084f80f4764d21a31c6f3` |

서버 worker는 npm stable version을 조회하고 동일 GitHub stable tag의 공식 `codex-package-<target>.tar.gz` digest를 확인한다. 동봉 manifest/version/target/entrypoint와 code-mode-host를 확인하고 버전별 폴더·atomic current symlink를 사용한다. npm 실행 중에는 npm package를 변경하지 않는다.

재시작 worker는 특정 shared/LibreChat 서버 두 개만 대상으로 RPC PID, 진행/대기 요청·turn, loaded thread 상태와 background terminal을 검사한다. 2초 간격으로 두 번 확인하고 PID start identity 및 pidfd로 오인 signal을 피한다. 설치 코드상 `0.160.1` 이상에서 검증한 SIGHUP drain을 사용하고 새 PID/실행 버전/socket identity까지 확인한다. 재시작 부분 실패는 자동 반복하지 않는다.

**가져올 원리:** 설치/적용 분리, stable 검증, companion resource 보존, atomic 선택, 작업 상태 기반 보류, race 방어, 실행 버전 확인, 실패 제한, 정제 로그.

**그대로 복사하지 않을 부분:** systemd, Python/npm 이중 설치, LibreChat, 서버별 경로, `/proc/*/environ` 복사, 하루 1회 restart 제한. HA App은 S6와 기존 Node 런타임을 사용한다. HA AppArmor는 proc environ 접근을 차단하므로 기존 코드의 환경 복제는 호환되지 않는다. 서버 로직이 있다는 사실은 HAOS 검증 결과가 아니다.

## 공식 근거와 검증 상태

- [Codex CLI reference](https://developers.openai.com/codex/cli/reference) → 공식 `learn.chatgpt.com/docs/developer-commands?surface=cli`: `codex update`는 설치 release가 self-update를 지원할 때 적용한다. 현재 App의 custom wrapper/설치 위치에서 바로 동작한다고 가정하지 않는다.
- [Codex App Server](https://developers.openai.com/codex/app-server) → 공식 `learn.chatgpt.com/docs/app-server`: loaded thread 목록·runtime status, experimental background terminal 목록을 확인했다. `server/diagnostics`와 `SIGHUP` 동작은 이 페이지에서 확인되지 않았으므로 tag별 공식 소스/실행 검증이 필요하다.
- [HA App configuration](https://developers.home-assistant.io/docs/apps/configuration/): App `version`과 사용하는 image tag를 일치시켜야 한다. App metadata/image 업데이트와 내부 runtime 업데이트는 분리한다.
- [Codex stable 0.162.1](https://github.com/openai/codex/releases/tag/rust-v0.162.1): 앞선 공식 API 조회에서 2026-10-09 non-prerelease를 확인했다. 구현 시작 시 다시 확인한다.

이미지 baseline 목표는 `0.162.1`; 자동 updater는 **매 확인 시 최신 정식 stable**을 대상으로 한다. 자동 downgrade·alpha/beta/RC·임의 다운로드 URL은 금지다. 공식 package asset API digest 참고값은 다음과 같다. Planner는 파일 다운로드/hash/실행을 하지 않았다.

| Architecture | baseline package | API SHA-256 |
| --- | --- | --- |
| amd64 | `codex-package-x86_64-unknown-linux-musl.tar.gz` | `a676f5722aae0d86cbe3764332f08eab1fdd89dc0a300b3ad4ffbf48611fa3e3` |
| aarch64 | `codex-package-aarch64-unknown-linux-musl.tar.gz` | `53a9ce0b94beb27a63fdeb2f7704d95199e17b3898aa33b60461a1a93ac0d88b` |

기존 bare `codex-<target>.tar.gz`와 package의 checksum을 혼동하지 않는다. Package 구조·license·동봉 bwrap/code-mode/app-server 필요성과 실제 checksum을 검증하고 image baseline 설치 방식도 동일하게 맞춘다.

## 제품 동작과 기본 설정

- **App version: `0.7.0` → `0.7.1`**. 이번 기능과 baseline 변경을 포함하는 하나의 새 App 후보다. 이미 배포된 tag를 덮어쓰지 않는다. 실행 시 `0.7.1`이 이미 사용됐다면 충돌을 기록하고 다음 patch를 정한다.
- `codex_auto_update: true` 기본 및 누락값 해석: 최신 요청대로 기존 설치에도 하루 4회 확인을 기본 제공한다. 사용자는 false로 끌 수 있다. OFF는 현재 설치 버전을 삭제/강등하지 않으며 자동 다운로드·새 적용을 중지한다.
- `codex_auto_update_timezone: Asia/Seoul` 기본. 고정 확인 시간 `03:00`, `09:00`, `15:00`, `21:00`을 이 timezone으로 해석한다. timezone은 실제 IANA zone 검증; 구현 후 ko/en 설명에 시간대를 표시한다. 서버 참고값 KST를 채택한 계획상 기본이며 HA host timezone과 혼동하지 않는다.
- 실행 중 App에서 하루 4회의 **신규 version 확인**을 한다. 처리 지연은 가능하며 slot별 영속 dedup으로 중복·시계 역행·재시작 폭주를 막는다. 부팅 후 놓친 slot은 최대 1회 catch-up하고 여러 번 연달아 다운로드하지 않는다.
- staging된 업데이트는 5분마다 **network 없이** idle 조건을 재검사한다. 신규 version 확인과 적용 재시도 빈도를 구분한다.
- 수동 `ha-codex-update status`, `check`, `apply`를 제공한다. `check`는 공식 stable 조회·검증·staging까지, `apply`는 준비본의 idle 검사·적용·검증이다. 선택적으로 명시적 `ha-codex-update update`로 check+apply를 묶는다. 수동 요청은 자동 OFF에서도 가능하지만 busy 검사·checksum·정책 검사를 우회하지 않는다.
- `codex update`는 wrapper에서 managed updater로 연결한다. 임의 flags나 upstream self-update로 설치 root/wrapper를 덮어쓰는 경로를 허용하지 않는다. 지원 인자를 명확히 설명하고 `--help`, global flags 조합과 top-level subcommand parsing을 검증한다. 프롬프트 본문에 있는 문자열 `update`를 가로채지 않는다.
- `status`는 App/bundled/selected/staged/running 버전, 마지막 slot·검사·적용 시각, active-session 개수와 `pending_busy/blocked/failed/applied` reason만 표시한다. 대화·argv·thread ID·credential·내부 HA 식별자를 출력하지 않는다.

## 아키텍처와 업데이트 transaction

### 저장과 실행

- 이미지에는 checksum-pinned 기본 package를 둔다. 기존 `/usr/local/libexec/codex-real` 경로 및 정책 wrapper 계약을 유지할 수 있는 배치를 먼저 검증한다.
- 추가 영속 root는 `/data/codex-runtime/`(0700, root-owned). `releases/<version>-<target>/`, `current`, `previous`, `staged`와 transaction/state JSON(0600)을 관리한다. 버전별 package는 root-owned, executable 0755·일반 resource 최소 권한, group/world writable 금지다.
- `/run/codex-ha/codex-maintenance/` 아래의 짧은 적용 gate와 session registry는 restart 시 재구성한다. package symlink와 state는 고정 root 안에만 존재해야 한다. 기존 target을 신뢰하고 따라가지 않으며 owner/type/link/path containment를 검증한다.
- wrapper는 기존 option 검증·sensitive-path preflight·approval/sandbox/network/MCP 설정·token unset을 수행한 뒤 검증된 선택 package를 실행한다. updater는 wrapper나 requirements/user config를 교체하지 않는다.
- Codex tool sandbox에서 runtime package/선택/state를 수정할 수 없게 하되 package 실행과 동봉 resource read는 허용한다. `/data/** rw`인 현재 AppArmor에 실행 경로와 read-only package 경계를 최소 추가하고 bwrap child에도 동일하게 적용한다. 악성 root shell까지 격리됐다고 표현하지 않는다.
- `no_new_privs`, bwrap helper re-exec와 실제 package 경로의 AppArmor 호환성을 반드시 시험한다. image 경로 검사만 새 `/data` 실행 경로의 안전성을 입증하지 않는다.

### 설치와 적용 단계

1. 유지보수 전용 단일 transaction lock을 얻고 버전/arch/slot/state를 확인한다. lock 구현은 기존 도구 가용성을 확인해 선택하며 새 Python/npm 의존성은 추가하지 않는다.
2. 공식 GitHub stable release metadata에서 strict semver/non-draft/non-prerelease·정확한 arch package·고정 공식 URL·SHA-256 digest를 확인한다. npm 조회가 필요하다면 release 일치만 확인하고 npm 설치는 하지 않는다.
3. TLS, timeout, 총 다운로드 크기/시간, 디스크 여유, redirect destination을 제한한다. 실패 시 bounded backoff, 기존 실행 유지. metadata digest는 동일 배포 주체의 무결성 확인이며 별도 서명 검증으로 과장하지 않는다.
4. 같은 filesystem에 임시 staging. checksum 검증 후 archive의 traversal·절대경로·device·escaping symlink/hardlink·과도한 파일/압축 해제 크기 등을 거부한다. 허용할 내부 link가 있다면 실제 package 필요성과 containment를 검증한다.
5. manifest version/target/entrypoint·동봉 executable·license와 exact version을 검증한다. 별도 임시 HOME/CODEX_HOME/config fixture로 config/requirements/MCP approval parsing, 실제 sandbox의 synthetic deny·일반 RW/network/helper 호환성을 **적용 전에** 검사한다. 사용자 auth를 읽거나 인증 세션을 만들지 않는다. 검사 불가/실패는 `blocked_incompatible`로 남기고 실행본을 바꾸지 않는다.
6. active-session gate를 얻고 전체 프로세스/lease/서버 상태를 재확인한다. busy/unknown이면 staging만 유지한다. 이 gate를 실제 launcher도 공유해 검사 직후 새 CLI가 시작되는 race를 막는다. 다운로드 중 launch를 막지 않는다.
7. idle이면 journal을 기록하고 atomic current 선택 전환, 필요한 소유 서버 graceful drain/relaunch, readiness·실제 실행 버전/PID/socket 확인을 수행한다. `applied`는 이 검증을 통과한 뒤에만 기록한다. 서버가 하나도 없으면 새 실행 경로와 fixture launch 검증으로 완료하며 불필요한 daemon을 만들지 않는다.
8. 실패하면 gate를 유지한 채 실행 가능한 이전 package 선택을 복구하고 버전별 반복 시도를 차단한다. 이미 신규 실제 세션이 시작됐다면 강제 종료/무검증 state downgrade를 하지 않는다. 부분 실패 상태와 수동 복구 경로를 명시한다. 구버전 실행 resource는 참조가 사라질 때까지 보존한다.
9. current/previous/staged/실행 중 참조본을 GC에서 제외한다. 최대 보관 정책과 disk-full 행동을 정의하고 unsafe metadata나 불확실한 프로세스가 있으면 삭제를 보류한다.

### App lifecycle과 복구

- updater는 독립 S6 service로 실행하며 터미널·SSH·Ingress·browser·memory startup dependency가 아니다. OFF/실패/오프라인에서도 기존 제품이 시작돼야 한다. 장기 service는 `SUPERVISOR_TOKEN`을 상속/읽지 않는다.
- App 재시작과 `0.7.0` → `0.7.1` 업데이트는 `/data` 선택 버전을 보존한다. 새 image baseline보다 낮은 runtime override는 검사 후 image baseline으로 복귀하고, 더 높은 override도 새 image의 요구사항과 재검증한다. 호환성 실패 시 기본본으로 fallback하고 이유를 표시한다.
- transaction interruption/손상 JSON/unsafe link는 fail closed하고 image 기본본으로 복구 가능한 경로를 남긴다. updater 장애가 CLI 실행 불가로 번지지 않도록 검증된 기본본 fallback을 제공한다. registry/admission을 복구하지 못하면 **업데이트 적용만** 보류한다.
- App 버전은 내부 Codex가 바뀔 때마다 증가시키지 않는다. `0.7.1`은 기능 배포를 HA에 알리기 위한 metadata/image 버전이고, 이후 내부 Codex는 updater status로 구분한다. runtime override는 image SBOM·서명이 직접 보증하는 payload 범위 밖이므로 package 출처/tag/hash/시간·compatibility 결과를 따로 기록한다.

## 활성 세션 정의와 재시작 안전성

### 적용을 막는 조건

- CLI/TUI/exec/review/resume/fork 세션 프로세스 및 자식·sub-agent 작업이 존재한다. 입력 대기 TUI도 열려 있는 세션으로 보고 종료시키지 않는다. tmux에 남은 세션은 브라우저를 닫았다고 종료된 것으로 간주하지 않는다.
- Remote stdio app-server와 살아 있는 SSH client 소유 연결이 있다. 이 프로세스는 updater가 인수하지 않는다.
- managed app-server의 loaded conversation 또는 client 세션, active/queued turn·request, 승인/사용자 입력 대기, background terminal이 있다. 이 계획의 기본은 서버 참고 구현보다 보수적으로 **loaded idle conversation도 보류**한다. 과거 저장 대화 파일만으로 busy 판정하지 않는다.
- 발견한 Codex/companion 프로세스가 registry 밖이거나, socket/PID 매핑·RPC schema·pagination·background 상태를 신뢰할 수 없거나 검사에 실패했다. unknown을 idle로 치환하지 않는다.

### 구현 요구

- 관리 launcher에 session lifecycle 추적을 추가한다. wrapper의 단순 exec를 바꾼다면 stdin/stdout/stderr·exit status·signals·TTY/Remote bootstrap을 보존하는 검증이 필요하다. identity는 PID와 start time/executable generation을 함께 사용한다. 세션 영속 파일의 mtime나 `pgrep codex`만으로 판단하지 않는다.
- process discovery는 `/proc/*/exe`와 필요한 제한된 metadata를 사용하고 proc environ은 읽지 않는다. companion/고아 자식과 zombie/PID reuse를 다룬다. raw cmdline을 로그/state에 보관하지 않는다.
- app-server 제어는 확인된 transport·소유권의 local Unix socket만 사용한다. 기존 Remote 경로를 강제로 shared daemon으로 바꾸거나 외부 포트를 열지 않는다. stdio RPC stream에 maintenance 메시지를 섞지 않는다.
- 현재 서버에서 쓰는 diagnostics/loaded/read/background list의 **사용할 tag에 대한 공식 protocol/source 및 오류/지원 여부**를 확인한다. method 부재/unknown 필드면 보류한다. thread/read는 `includeTurns=false`; status만 사용하고 대화 본문을 저장하지 않는다.
- 검사 두 번 및 짧은 launch gate만으로 외부 client turn race가 완전히 해결됐다고 주장하지 않는다. 기존 client의 요청도 안전하게 drain하는 동작이 필요하다. SIGHUP은 tag별 공식 소스와 real process에서 graceful 의미를 검증한 소유 서버에만 사용한다. 불가하면 자동 종료하지 않고 자연 종료까지 pending으로 둔다.
- 자동 kill -9/timeout 후 강제 종료, pkill 전체 Codex, tmux/SSH/App 전체 restart는 사용하지 않는다. drain 중 무한 blocker가 생기면 service는 상태를 표시하고 새 restart 시도는 멈춘다. UI는 적용 보류 이유를 설명한다.
- restart 대상이 여러 개면 모든 대상의 안전성을 확인한 후 transaction을 시작한다. 부분 재시작·새 연결 경합·updater 종료 시 복구를 시험한다. 새 app-server 환경은 image-managed allowlist로 생성하고 기존 proc 환경을 복제하지 않는다.
- 새 버전/transaction별 성공·실패 dedup과 retry cooldown을 적용한다. 서버의 하루 1회 제한은 그대로 사용하지 않는다. 하루 4회 서로 다른 stable이 나와도 동일 세션 보호와 검증을 거쳐야 한다.

## 구현할 파일과 문서

- Dockerfile: baseline package `0.162.1`의 두 arch checksum/설치·동봉 resource와 license, image exact version 검사. GitHub CLI/base/Playwright 등 무관한 버전은 유지한다.
- `rootfs/usr/local/bin/codex`: managed runtime 선택·launcher·`codex update` routing을 추가하되 기존 강제 정책 유지.
- 신규 `ha-codex-update`, Node maintenance/launcher module 및 S6 service/run/dependencies/contents; `codex-ha-init`은 디렉터리/state recovery·설정만 최소 연결.
- `config.yaml`, `translations/ko.yaml`, `translations/en.yaml`, config validation helper: auto toggle/timezone와 기본값·설명·closed validation.
- `apparmor.txt`, system requirements: 필요한 실행/read-only package 경계만 추가, 민감 path deny와 bwrap 정책 유지.
- App `config.yaml`/Dockerfile `BUILD_VERSION`/Playwright package+lock root versions/CHANGELOG 첫 heading/App version test를 **0.7.1**로 일치시킨다. deps lock integrity를 임의 재생성하지 않는다.
- `tests/test_runtime_contract.py`, `test_multiarch_contract.py`, `test_addon_contract.py`, `test_token_boundary.py`, `test_sensitive_path_policy.py`와 신규 focused updater tests/smoke; 기존 smoke 경로 하드코딩은 실제 배치를 반영해 수정한다.
- `.github/workflows/ci.yaml`: ARM baseline exact version, 두 arch updater smoke, `0.7.0` update baseline과 관련 `test_browser_contract.py` 계약 동기화. network fixture updater 검증은 실제 최신 version 의존 없이 재현 가능하게 한다.
- `rules.md` R-403, 새 ADR, product/architecture/addon/security/test/releasing/references/progress, THIRD_PARTY_NOTICES, ko/en README·DOCS·예시·changelog를 동기화한다. 구버전 release 증거는 보존한다.
- Auth/config/AGENTS/override/session/SSH key/browser identity/memory는 수정·삭제하지 않는다. updater를 위한 user-file refresh나 추가 `--add-dir` 권한 확대를 하지 않는다.

## 단계별 실행과 수용 기준

### A. 먼저 해결할 spike

1. 두 official package의 실제 checksum/manifest/resource layout과 image/AppArmor/bwrap 동작 확인.
2. web TUI, SSH CLI, Remote stdio, 가능한 Unix app-server의 프로세스 소유·lifecycle 지도 작성. 현재 존재하지 않는 managed server를 있다고 가정하지 않는다.
3. fresh launcher와 pending updater 사이 admission race, client turn 경합, SIGHUP graceful drain과 startup readiness를 synthetic 환경에서 재현한다.
4. 이 spike가 성립하지 않으면 **자동 설치 staging과 안전한 다음 launch 반영**은 유지할 수 있지만 unattended restart 완료를 PASS로 쓰지 않는다. unsupported case의 pending 동작과 남은 제약을 REPORT에 명시한다. 제품 정책을 완화하지 않는다.

### B. 자동·로컬 검증

- 기존 Python unit/contract, YAML/Markdown lint, ShellCheck, Hadolint, actionlint, App config linter, AppArmor parser, secret scan과 `git diff --check`를 수행한다. 없는 도구는 임의 설치하지 않고 gap을 기록한다.
- frozen clock으로 4 slot/timezone/누락 기본 ON/OFF/manual override/dedup/부팅 catch-up/clock jump와 pending 5분 재검사를 검증한다. 일일 4회 신규조회와 pending 검사 분리를 확인한다.
- fixture release server로 stable/prerelease/downgrade/누락 digest/잘못된 URL·redirect/arch/manifest/version/companion/크기 초과/timeout/TLS 실패/disk full/archive escape/unsafe path/손상 state를 시험한다. 실패 시 current와 기존 세션이 유지돼야 한다.
- transaction 동시 실행·launch 순간 race·active turn/승인/idle loaded thread/background terminal/TUI/tmux/SSH/stdio/unmanaged/unknown RPC/PID reuse/고아 작업을 시험한다. 어떤 busy/unknown 조건에서도 signal/선택 전환이 없어야 한다.
- real package baseline과 검증한 후속 stable package를 이용해 새 launch 및 owned idle server 실제 version/PID/readiness를 확인한다. mock RPC만으로 재시작 PASS를 선언하지 않는다. drain 중 새 turn·service 중단·부분 실패·반복 실패·rollback·GC 참조 보호도 검증한다.
- runtime package를 Codex sandbox tool로 수정할 수 없는지, package의 bwrap/resource 실행과 `/config` 일반 RW/network/API helper·fixed deny가 유지되는지 실제 확인한다.
- amd64와 **native aarch64** build/full smoke 7종(terminal/browser approval/managed auth/managed sandbox/memory/user files/feedback) 및 새 updater smoke를 수행한다. QEMU와 native는 구분하고 실제 없어 실행하지 못한 native/HAOS 항목은 NOT RUN이다.
- `0.7.0` → `0.7.1` 일반 업데이트의 auth/config/AGENTS/SSH/browser/memory byte/mode 보존, updater OFF·pending·selected override의 restart/image-update persistence·fallback을 확인한다. 이전 계획과 달리 override가 존재할 때 active version과 bundled version을 따로 assertion한다.
- updater의 log/state/RPC 오류에 credential·본문·command·thread ID가 노출되지 않고 service에 ambient SUPERVISOR_TOKEN이 없는지 검증한다. raw subprocess stderr를 무조건 기록하지 않는다.

### C. HAOS 후속 수용과 배포 구분

- 승인된 amd64/aarch64 HAOS에서 App `0.7.1` 노출·일반 업데이트, configured timezone schedule, Web/SSH/Remote active session 보호, idle 후 자동 적용, actual process version과 `/data` 보존을 확인한다.
- 특히 AppArmor 활성 상태의 `/data` package 실행·bwrap·deny·browser/memory MCP와 Remote 재접속을 확인한다. 기존 `0.7.0` waiver를 새 runtime/updater에 재사용하지 않는다.
- 실제 4개 시간대를 기다리지 않고 frozen-clock/synthetic smoke로 schedule를 검증할 수 있지만 실제 HAOS 관측과 구분한다. 실제 장비 변경은 별도 요청/승인 범위에서만 한다.
- 코드 검토 준비는 로컬 구현·증거·미검증 공백이 기록된 상태다. 자동 적용 기능의 배포 준비에는 두 native architecture와 실제 HAOS 핵심 경로 증거 또는 이번 변경에 대한 명시적 위험 수용이 필요하다.
- 새 version/image publication·서명/SBOM·PR/main merge·tag/release는 현재 승인 범위 밖이며 `releasing.md` 절차에 따른다. 내부 runtime update를 HA App version/image update로 표시하지 않는다.

## Executor REPORT 필수 내용

- 선택한 App/bundled/selected package 버전과 실제 hash, Git 상태·변경 파일, 서버 참고 구현에서 채택/제외한 내용.
- session/transport별 지원표: idle 판정 가능 여부, automatic activation/restart 여부, pending 이유. stdio Remote와 loaded idle conversation 제한을 숨기지 않는다.
- 스케줄/동시성/real drain/보호 경로/실행 파일 read-only/rollback 및 업데이트 보존의 실제 명령·결과·image ID·architecture.
- 지원하지 않는 새 upstream format/policy/protocol의 처리, 공급망 검증 범위 변화, offline/disk full/부분 실패의 복구 방법.
- NOT RUN/FAIL/blocker·계획 편차와 외부 발행·실제 HA 변경 여부. 수행하지 않은 것을 PASS로 적지 않는다.

## Planner 검증 기록

- 수행: 서버 timer/service/source 읽기 및 source hash, repository runtime/AppArmor/config/기존 계획 검토, 공식 Codex command/App Server·HA App configuration 문서 조회.
- 미수행: 서버 maintenance 실행, 세션 RPC/환경/인증 조회, artifact 다운로드·binary 실행·구현·build/smoke·HAOS 변경·외부 Git 작업.
- 문서 검증: tracked diff와 신규 PLAN의 `git diff --check` 통과. Python 표준 라이브러리로 UTF-8/newline·최상위 heading·handoff 링크·task artifact 단독 존재·SHA-256 형식·신규 PLAN의 대표 credential 패턴 부재를 확인했다. 전체 계획 내용과 progress diff를 검토했다.
- Markdown lint는 이전 작업에서 확인한 로컬 도구/cache 부재로 NOT RUN이며 임의 설치하지 않았다. 이 문서 검증은 updater 구현·실행·보안 검증 PASS가 아니다.
