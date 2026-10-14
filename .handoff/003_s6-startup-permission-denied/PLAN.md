# PLAN — DEV 0.7.1-dev.6 S6 시작 Permission denied 트러블슈팅

## 목표와 작업 경계

- Planner, 2026-10-13 Asia/Seoul. 사용자 설치 로그를 근거로 초기화 실패를 진단하고 Executor의 최소 수정·검증·DEV 재배포 절차를 정의한다.
- 대상: DEV 0.7.1-dev.6, 배포 source `22fae4ffcf71750b8dccc8418ebb1b091a894ecf`, generic image digest `sha256:d4046cbeb2da1763f95471eb1d0df21881b77c6cd2c9b269a2c6c7b2517653b5`.
- 현재 root branch `feat/codex-auto-update`, HEAD `e94fd04`, 계획 시작 시 working tree clean. 배포 worktree `/tmp/codex-ha-dev-release`와 root의 버전/branding 차이를 확인한 뒤 작업한다.
- 이번 Planner는 계획과 progress만 작성한다. Runtime 구현, 프로필 kernel load, HAOS VM/App 변경, push/tag/게시를 실행하지 않는다. 다음 Executor는 본 PLAN에 대응하는 새 REPORT.md를 작성한다. 기존 001/002 handoff는 보존한다.
- 자동 업데이트와 보안 scanner 재설계를 확대하지 않는다. `/config` RW, manager API, 민감 경로 deny, token 경계와 bwrap child transition을 유지한다. AppArmor 해제, 보호 모드 해제, admin/docker_api/full_access/host_network 추가는 해결책으로 사용하지 않는다.

## 로그 판정

| 증거 | 판단 |
| --- | --- |
| S6가 codex-ha-init/run exec 시 Permission denied, exit 126 | 초기화 스크립트 실행 이전에 OS 실행 권한 검사 실패 |
| S6 rc.init이 container stop, Supervisor가 App exit 1 기록 | 초기화 실패의 후속 종료 |
| Ingress 7681 connection refused, App stats not running | App 미기동으로 인한 후속 증상 |
| 다른 slug의 Codex WebSocket proxy 정상 요청 | 실패한 DEV App의 정상 기동 증거가 아님 |
| Core custom integration·Music Assistant·ThinQ·mobile WebSocket 경고 | 제공된 로그만으로 S6 실행 거부와 인과관계 없음; 이번 수정 범위에서 제외 |

사용자 계정명/IP/기기 ID 등 로그 원문은 handoff에 복제하지 않는다. 실패 App 식별·시각·버전은 현장 확인 시 필요한 최소 정보로만 취급한다.

## 사전 조사 결과와 가장 유력한 원인

1. 공개 dev.6 amd64 이미지에서 network none, 별도 shell entrypoint로 `stat` 확인: `/etc/s6-overlay/s6-rc.d/codex-ha-init/run`은 **755 root:root**다. Git index도 100755이고 Dockerfile에 chmod 0755가 있다. 무조건 chmod를 추가하는 것으로 해결될 근거는 없다. ARM/사용자 설치 image의 실제 mode는 별도 확인한다.
2. Shebang은 `#!/command/with-contenv bashio`; interpreter symlink는 `/package/admin/s6-overlay-3.2.2.0/command/with-contenv`로 해석된다. 현재 profile은 /command, /package, /usr/bin 등 실행을 허용한다.
3. `codex_home_assistant/apparmor.txt`의 `/** rwmkl,`에는 **x가 없고**, `/etc/services.d`, cont-init/finish는 허용하지만 **`/etc/s6-overlay/**` 실행 규칙이 없다**. 실제 S6 서비스 스크립트 위치가 이 누락 범위에 해당한다. 가장 유력한 원인은 AppArmor exec deny다. 사용자 host audit의 해당 경로 denied_mask x 확인 전에는 확정 재현으로 쓰지 않는다.
4. 최신 [Home Assistant 공식 AppArmor 예시](https://developers.home-assistant.io/docs/apps/presentation/#apparmor)는 S6 부분에 `/etc/s6-overlay/** rwix,`를 명시한다. 공식 문서는 custom profile이 기본 profile을 대체한다고 설명한다. 2026-10-13 확인.
5. 검증 공백: `tests/docker-smoke.sh`의 전체 부팅은 AppArmor 사용 host에서 apparmor=unconfined로 실행한다. 실제 custom profile을 쓰는 `tests/codex-update-smoke.sh`는 entrypoint를 /bin/sleep으로 바꾸고 updater 모듈을 직접 호출한다. 따라서 둘의 성공을 **custom profile 하의 /init 전체 기동 성공**으로 해석할 수 없다. `.github/workflows/ci.yaml` 양 architecture에서도 이 공백이 있다.
6. 로컬 실제 profile 적용 재현은 Docker/runc가 profile 적용 단계에서 `attr/apparmor/exec: no such file or directory`로 실패했다. App init까지 도달하지 않았으므로 사용자 오류 재현 PASS가 아니다. 이 상태에서 host 보안 설정을 임의 변경하지 않았다. Executor는 지원되는 native CI 또는 개발 HAOS VM에서 검증한다.

## Executor 절차

### 1. 배포 대상과 원인 확정

- Git status/HEAD, 관련 AGENTS 및 현행 docs와 002의 FIX_10_REPORT를 확인한다. 서로 다른 worktree의 변경을 덮어쓰지 않는다.
- 테스트 대상의 버전, architecture, image digest, 실제 적용 AppArmor profile을 연결한다. 사용자 로그에는 stable/DEV 등 여러 slug가 섞여 있으므로 실패 DEV와 테스트 VM App을 명확히 구분한다.
- 개발 HAOS VM의 기존 접근·테스트 방법과 현재 사용 여부부터 확인한다. 인증값·options 전체·docker inspect 전체를 출력하지 않는다. 실제 사용자 운영 HA는 진단/복구 대상으로 자동 선택하지 않는다.
- VM 또는 native runner에서 **기존 profile + 기존 image + 실제 /init**으로 1회 한정 재현한다. fixture config/data만 사용하고 production /config는 마운트하지 않는다. 제한시간과 cleanup을 설정해 restart loop를 만들지 않는다.
- 같은 시각 audit에서 `apparmor=DENIED`, operation exec, 서비스 스크립트 경로, requested/denied mask x를 최소 추출한다. AppArmor 재현이 안 되면 파일/부모 디렉터리 mode, shebang/interpreter 존재·mode·LF, mount noexec, 실제 image 불일치를 순서대로 조사한다. raw secret/session log를 수집하지 않는다.

### 2. 최소 수정

- 원인이 확인되면 `codex_home_assistant/apparmor.txt`의 S6 영역에 실행 허용을 추가한다. 공식 패턴 `/etc/s6-overlay/** rwix,` 또는 현재 `/** rwmkl,`에 이미 있는 권한을 고려한 `/etc/s6-overlay/** ix,`가 후보이며, 전체 기동·종료 시험으로 필요한 최소 범위를 결정하고 근거를 기록한다.
- init 하나만 허용하고 종료하지 않는다. updater, memoryd, ingress/ttyd/sshd의 run/finish 및 S6 up/down 호출 경로를 inventory로 점검한다. 필요 이상의 `/etc/** ix`나 전체 `file,` 허용으로 확대하지 않는다.
- 기존 보호 경로 deny, proc environ deny, bwrap child profile의 deny와 transitions를 보존한다. 새 정책 허용이 민감 파일 실행/읽기 우회가 되지 않는지 확인한다.
- Dockerfile/파일 mode 수정은 실제 artifact에서 결함이 확인된 경우에만 한다. 자동 업데이트 스케줄/예산/재시작 로직과 Grype gate는 이번 기동 오류 때문에 변경하지 않는다.

### 3. 의미 있는 회귀 시험과 CI

- 정적 계약에 **현재 S6 entrypoint들이 parent profile에서 실행 가능**한지 확인하는 회귀를 추가한다. `test_runtime_contract.py`, `test_addon_contract.py`의 기존 규칙을 활용하고 단순히 permission denied 문자열의 부재만 검사하지 않는다.
- custom AppArmor를 강제한 실제 **기본 entrypoint /init 전체 기동 smoke**를 추가한다. 기존 docker-smoke에 명시적 profile 입력을 지원하거나 작은 전용 boot smoke를 둘 수 있다. 실제 profile 시험에서 지원 안 됨을 성공/skip으로 숨기거나 자동 unconfined로 fallback하지 않는다.
- 합성 `/data/options.json`과 보호 경로를 포함한 fixture `/config`를 사용한다. mock API 또는 browser auto-auth OFF처럼 외부 HA 의존성을 통제하며, 이 시험의 성공을 실제 HA API 인증 성공으로 과장하지 않는다.
- init 완료, S6 서비스 up, ttyd/nginx HTTP 응답, updater 서비스 등록/동작, SSH key 미설정 degraded 기동, 명시적 stop 완료를 제한시간 안에 확인한다. 실패 시 최소 로그와 exit code를 저장하고 임시 container/volume/network를 cleanup한다.
- 같은 enforced profile 아래 합성 root/nested secrets.yaml 및 .storage content read 실패, 일반 configuration YAML read/write 성공을 확인한다. bwrap managed sandbox와 updater smoke도 유지한다.
- `.github/workflows/ci.yaml`의 amd64/native ARM에 새 boot gate를 연결한다. parser 성공은 runtime enforce 성공의 대체가 아니다. 원래 전체 smoke/updater/persistence 검사도 유지한다.

### 4. 개발 HAOS VM 검증과 DEV 전달

- 수정 candidate를 **개발 HAOS VM**의 별도 테스트 App으로 설치해 Supervisor가 로드하는 실제 custom profile로 시작한다. 기존 테스트 data는 보존하고 production App/Core를 재시작하지 않는다. 개발 VM이 사용자 운영 환경과 공유되거나 비가역 설치/데이터 변환이 필요하면 실행 전에 범위를 분명히 한다.
- App 시작 1회, 최소 2분 running/Ingress 확인, stop/start 1회, 실행 중 updater status의 현재 Codex 버전 확인. SSH/Remote는 테스트 공개키가 있을 때만 확인한다. restart 반복은 최대 정해진 2회로 제한하고 실패하면 원인 로그 수집 후 중단한다.
- 신규 DEV 번호는 remote에서 미사용임을 확인한다. 현 시점 후보는 **0.7.1-dev.7**이다. 이미 사용되었다면 다음 번호를 선택한다. App metadata, Docker BUILD_VERSION, package/lock, app-version fallback, version 계약/예시와 한국어·영어 문서, changelog를 함께 점검한다. Codex binary 자체 버전 상승은 이번 수정의 필수 조건이 아니다.
- exact candidate SHA의 lint/unit/native 양 architecture CI 및 enforced boot smoke 성공 후 새 태그 Builder를 실행한다. 기존 dev.6 태그/image를 이동하거나 덮어쓰지 않는다. 외부 배포는 기존 사용자 승인 범위를 확인하고 수행하며, 이번 Planner 단계에서는 게시하지 않는다.
- Builder security gate/signing/attestation 및 public manifest/config version 확인. 가능하면 공개 최종 image의 동일 profile boot를 재검증한다. main/stable 승격은 별도 요청 없이는 수행하지 않는다.

## 수용 기준과 보고

- 기존 오류 원인에 대한 audit 또는 enforced-profile before/after 재현 근거가 있고, 수정 후 실제 /init이 실행되어 서비스가 정상 시작한다.
- amd64/native ARM의 enforced boot, 기존 updater·sandbox·persistence 회귀가 성공한다. 불가능한 환경은 사유와 NOT RUN을 명시한다.
- 개발 HAOS VM에서 Supervisor 적용 profile과 App running/Ingress/한정 stop-start 확인 결과를 기록한다. VM 시험을 실행하지 못했으면 공개 전달 시 이를 숨기지 않는다.
- 민감 경로 content 차단과 일반 /config RW·manager 계약을 유지한다. 옵션/세션/auth를 초기화하지 않는다.
- 자동 업데이트의 날짜별 idle 12회와 rolling 24시간 restart 제한이 유지된다. 이번 부팅 실패는 updater가 동작하기 전이므로 업데이트 retry 정책으로 고치려 하지 않는다.
- REPORT.md에 변경 파일, 정확한 명령/결과, 원인 확정 수준, 새 image/commit/CI/VM 근거, 아직 안 한 사용자 HAOS/mobile 수용을 기록한다. progress 상태를 실기 결과에 맞춰 갱신한다.
- 현재 계획의 조사만으로 구현 완료/HAOS 재현 성공을 선언하지 않는다. 사용자가 올린 Core의 별도 경고는 후속 별도 이슈로 분리한다.
