# REPORT — dev.6 S6 시작 Permission denied 최소 수정과 enforced 부팅 검증

- 역할: Executor, 2026-10-14 Asia/Seoul. `.handoff/003_s6-startup-permission-denied/PLAN.md`를 따랐다.
- 기준 Git: root `feat/codex-auto-update` HEAD `e94fd04`, 시작 시 working tree에 Planner의 progress.md 수정과 003 handoff 디렉터리만 존재했다. 배포 worktree `/tmp/codex-ha-dev-release`(`22fae4f`)는 건드리지 않았다.
- 결과: 원인을 audit으로 확정하고 `codex_home_assistant/apparmor.txt`에 S6 스크립트 실행 허용 1줄을 추가했다. 개발 HAOS VM에서 **공개 dev.6 image 그대로**로 before(exit 126)/after(전체 기동·서비스 up·Ingress 200·보호 경로 차단·정상 종료)를 재현·검증했다. 정적 계약 테스트와 양 architecture enforced 전체 부팅 CI gate를 추가했다. push·tag·dev.7 발행과 사용자 운영 HA 변경은 하지 않았다.

## 원인 확정 (audit 근거)

- 대상 image: `ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.1-dev.6`, VM이 ghcr에서 pull한 digest `sha256:d4046cbeb2da1763f95471eb1d0df21881b77c6cd2c9b269a2c6c7b2517653b5` — PLAN의 배포 digest와 동일.
- 대상 프로파일: dev.6 배포본 `apparmor.txt`(SHA-256 `6eeb596a336783bf47ceaa8ce81e28b36087a7edc2b1e5b13fce8fa11daded19`)를 HAOS 18.2 VM 커널에 고유 이름 `codexha003broken`으로 enforce 로드. seccomp=unconfined, 합성 fixture volume만 사용, production /config 미마운트.
- 컨테이너 결과: `s6-rc-oneshot-run: fatal: unable to exec /etc/s6-overlay/s6-rc.d/codex-ha-init/run: Permission denied`, `command exited 126`, rc.init가 컨테이너 중지(exit 1). 사용자 로그와 동일한 실패 경로.
- HAOS 감사 로그(`dmesg`가 아니라 `/var/log/audit/audit.log`, busybox `ausearch`는 AppArmor type 미지원이라 grep 추출):

  ```text
  type=AVC msg=audit(1791904050.761:349): apparmor="DENIED" operation="exec"
  class="file" profile="codexha003broken"
  name="/etc/s6-overlay/s6-rc.d/codex-ha-init/run" pid=6343 comm="s6-rc-oneshot-r"
  requested_mask="x" denied_mask="x" fsuid=0 ouid=0
  ```

- 따라서 DAC/노드(mode) 문제가 아니라 AppArmor exec deny가 확정 원인이다. image의 run 파일은 0755 유지(Git index 100755, Dockerfile chmod 확인)이므로 chmod/Dockerfile 변경은 하지 않았다.

## 구현 변경

1. `codex_home_assistant/apparmor.txt` — S6 섹션에 `/etc/s6-overlay/** ix,` 추가(수정 후 SHA-256 `b93d714e8c9b60d511733151f1575387c65655ae65d1eb75f1fe4969e316fb6b`).
   - 최소 범위 근거: 기존 `/** rwmkl,`가 r/w/l은 이미 허용하므로 실행(x)만 추가했다. 공식 예시의 `rwix` 대신 `ix`를 택했으며 아래 전체 기동·종료·degraded 시험에서 write권한이 필요한 경로는 없었다.
   - inventory 점검: 실행 대상 9개(run×6, finish×3)는 모두 `/etc/s6-overlay/s6-rc.d/*` 아래라 규칙 하나로 커버된다. finish가 호출하는 `/run/s6/basedir/bin/halt`, s6-pause(`s6-svstat` 포함), shebang `/command/with-contenv`, `node/ttyd/nginx/sshd/codex-ha-init`은 기존 규칙으로 이미 허용돼 있어 추가 완화는 불필요했다.
   - `/config` RW·manager 계약, secrets/.storage deny, proc environ deny, bwrap child profile 전환은 그대로 유지했다. `/etc/**`·전체 `file,`로 확대하지 않았다.
2. `tests/test_runtime_contract.py` — AppArmor 경로를 실제로 매칭·판정하는 회귀 테스트 3개 추가(braces glob 변환, allow/deny 병합, transition 문자 x 판정):
   - 모든 S6 run/finish 경로와 interpreter·서비스 바이너리(inventory)의 exec 허용 확인 — dev.6 프로파일에서는 fail, 수정 프로파일에서는 pass로 확인했다(단순 문자열 검사가 아니다).
   - 범위 유지 확인: `/etc/s6-overlay.d/...` 등 S6 트리 밖 경로에 exec가 있으면 실패, secrets.yaml/.storage read deny 유지.
3. `tests/apparmor-boot-smoke.sh` 신규 — 실제 커스텀 프로파일 enforce 상태의 **전체 /init 부팅 smoke**:
   - 전자제약이 없으면 즉시 fail(host AppArmor 비활성, 프로파일 enforce 미로드). unconfined fallback/skip 없음.
   - 유효키/boot와 invalid-key/degraded 2종 부팅, s6-rc current.ok, 5개 서비스 `s6-svstat` up, updater 프로세스, Ingress 7681 HTTP 응답, 같은 enforce 프로파일에서 root/nested secrets.yaml read 거부·.storage content 접근 거부·일반 configuration.yaml RW 성공, 명시적 stop 완료(exit 0) 확인. 실패 시 synthetic 토큰을 redaction한 로그와 exit code(126 식별 포함)를 남기고 container/volume cleanup.
   - 첫 기동 직후 stop은 updater의 initial release check와 경쟁하여 SIGKILL(137)을 관찰했다. 검증 대상은 부팅 실패 원인이며 updater 재시작·스케줄 로직은 PLAN대로 변경하지 않았고, smoke는 settle 대기 후 idle 종료 경로를 검사한다.
4. `.github/workflows/ci.yaml` — amd64/native ARM 두 job에 `sudo apparmor_parser --replace` 후 boot smoke 실행 step을 기존 updater enforced smoke 뒤에 추가. parser 성공(정적)만 있던 공백을 실제 enforced 부팅 gate로 메웠다. 기존 smoke/updater/persistence 검사는 유지했다.
5. markdownlint 인수 동기화 — dev.6 CI 로그에서 실제 실행된 명령은 release tree 기준 `npx markdownlint-cli2@0.23.0 "**/*.md" "#**/.pytest_cache/**" "#.handoff/**"`로 `.handoff/**`를 의도적으로 제외했다(handoff 역사는 불변이며 제품 문서가 아니다). root ci.yaml에는 이 제외가 없어 push 시 기존 002 handoff 문서 다수가 lint 실패가 되는 상태였기에 release tree의 규칙(주석 포함)을 root로 옮겼다. root commit에만 있던 `progress.md`의 연속 빈 줄(MD012, root는 markdownlint CI 미통과라 검증된 적 없음) 한 곳을 정리했고 002 handoff 파일 내용은 수정하지 않았다.

## 검증 결과

| 항목 | 결과 |
| --- | --- |
| `.venv/bin/pytest -q`(수정 포함) | **218 passed, 1 skipped** (skip은 기존 apparmor_parser 부재 test, 로컬 parser 미설치) |
| 회귀 유효성 | dev.6 프로파일 파일 입력 시 S6 exec 판정 fail → 수정 프로파일 pass (직접 확인) |
| ShellCheck(전체 `#!` 파일) / yamllint / actionlint | PASS (actionlint는 CI pin image·digest로 실행) |
| markdownlint(CI와 동일 명령, `#.handoff/**` 제외) | **50 files, 0 errors** (CI dev.6 green 원인 규명 후 root 인수 동기화 포함) |
| `apparmor_parser --skip-kernel-load`(컨테이너) | 수정 프로파일 parse PASS (로컬 미설치라 CI pin image 대신 ubuntu 컨테이너로 실행) |
| VM before(dev.6 프로파일+dev.6 image+실제 /init) | exit 126 재현 + audit `DENIED operation="exec" denied_mask="x"` 상단 인용 |
| VM after(수정 프로파일 `codexha003fixed`) | 기동 `Codex runtime ready: codex-cli 0.162.1`, 5서비스 up, updater 프로세스, Ingress HTTP 200, secrets/.storage read 차단, configuration.yaml RW, stop exit 0(3초) |
| VM after(레포 `apparmor.txt` 원본·실제 slug 이름 `codex_home_assistant` enforce) | Supervisor 적용 방식과 동일하게 로드한 원본 파일로 dev.6 image 전체 기동·Ingress 200·보호 read 차단 PASS |
| VM 정리·복원 | 테스트 컨테이너 4종·volume 2종 삭제, 3개 테스트 프로파일 `apparmor_parser -R` unload 확인(`/sys/kernel/security/apparmor/profiles` 잔존 0), /tmp 파일 삭제, VM은 `haos-vm stop`으로 기존 shut off 복원. VM Docker의 dev.6 image와 운영 Core/Supervisor·기존 앱은 변경하지 않았다 |
| 비밀/로그 위생 | handoff에 사용자 계정·IP·기기 ID·raw session 로그 없음. audit 1행은 실패 경로 확정에 필요한 최소 필드만 추출하고 VM IP 등 개인 식별값은 보고서에 남기지 않았다(접근 수단은 sibling 저장소 소유의 기존 관리 경로) |

## 계획에서 조정·분리

- PLAN §39의 "before 재현 1회 한정"은 audit 확정에 필요해 VM에서 image별 1회(image는 이미 VM에 있던 동일 digest)+프로파일 before/after로 수행했다. 로컬 workstation은 비특권이라 커널 프로파일 로드가 원천 불가해 재현에 쓰지 않았다(PLANNER 기록과 동일 제약).
- PLAN §60의 "Supervisor가 로드하는 실제 custom profile"은 dev.6 image에 대해 레포 프로파일을 **실제 slug 이름으로 enforce**해 등가 검증했다. UI 설치/Supervisor App 등록 자체는 dev.7 image 발행 후에 의미가 있으므로 다음 단계로 남긴다.

## 아직 하지 않은 것 (NOT RUN)

- `.github/workflows/ci.yaml` 새 gate의 실제 GitHub 실행(amd64/native ARM enforced boot): push 승인 전이라 **NOT RUN**. 정적 lint만 완료.
- dev.7 버전 상승(App metadata/BUILD_VERSION/package/lock/문서·changelog 점검), tag Builder/GHCR 발행, 사용자 HAOS 재설치 수용, mobile/UI 수용: **NOT RUN** — push·발행은 사용자 승인 범위다.
- aarch64 VM enforced 부팅 실기: VM은 amd64이며 native ARM은 CI gate로 대체 예정. 기존 ARM waiver를 이번 runtime 변경에 재사용하지 않는다.
- 공개 최종 image의 동일 프로파일 boot 재검증: 발행 후 수행 예정.
- 사용자 운영 HA(dev.6 실패 설치) 복구: 배포 승인 후 dev.7 설치로만 가능하다. 이번 Executor는 운영 HA를 건드리지 않았다.
- updater initial-check 중 SIGKILL race의 근본 원인은 조사·수정하지 않았다(PLAN §9 범위) — 관측 사실만 남긴다.

## 다음 행동

- Reviewer: 본 REPORT와 PLAN §수용 기준 대조 — audit 근거·before/after·회귀 gate·범위 유지 확인 후 승인 또는 `FIX_01.md` 작성.
- 승인 시 사용자와 push/native CI/dev.7 발행 승인 범위를 확인한 뒤 §4 절차(버전 상승, exact SHA CI 양 architecture enforced boot, Builder, VM App 설치)를 진행한다.
