# FIX_07 — 0.7.4-dev.1 준비·검증·공개 배포 지시

- 작성: 2026-11-10 (Asia/Seoul), Reviewer/배포 handoff 작성: Codex.
- 근거: 사용자 지시 “별도 reviewer가 리뷰를 마쳤다. 내용검토 후 이상없으면, executor에게 dev버전으로 배포를 지시하는 fix를 발행하라”.
- 인수 자료: `FIX_06_REPORT.md`, 별도 Reviewer Antigravity의 `FIX_06_REVIEW.md` (**ACCEPT**), 기존 PLAN/REPORT/FIX_01~06와 각 보고서, 현재 작업 트리.
- 판정: **DEV 후보 준비·검증·게시 단계로 인수 가능.** 이번 문서는 단순 로컬 준비가 아니라, 아래 gate 통과 후 실제 DEV 배포까지 수행하도록 지시한다.
- 목표 버전: **0.7.4-dev.1**. 공개 설치 경로: `https://github.com/Kanu-Coffee/codex-for-home-assistant#dev`.
- 현재 작성자는 배포를 실행하지 않고 이 FIX와 progress를 작성한다. Executor는 이 문서를 실행하고 `FIX_07_REPORT.md`를 신규 작성한다.

## 1. 실행 범위와 승인

이번 사용자 지시에 따른 Executor 실행 범위는 **DEV에 한정된 로컬 구현·메타데이터 정리·검증, commit/push, base=dev PR 생성·병합, exact dev merge의 annotated DEV tag push, 기존 Builder를 통한 GHCR image 게시, GitHub prerelease 게시와 공개 접근 확인**이다. 통상적인 DEV 배포 단계마다 같은 승인을 다시 요청하지 않는다.

Stable main 병합·0.7.4 정식 tag/release·Stable latest 변경·기존 immutable tag/image 덮어쓰기·force push와 실제 운영 HA 업데이트/설정 변경은 포함하지 않는다. Stable 0.7.4는 DEV 설치·실기 수용 뒤 별도 지시에 따라 진행한다. 운영 HA에 배포하거나 사용자 데이터를 이동하는 대신 검증된 공개 DEV 설치 경로를 전달한다.

기존 보안·제품 계약을 유지한다. `/config` RW, Supervisor manager, 민감 경로 차단, ambient token 제거, 작업·신원·복원/cooldown 보호는 바꾸지 않는다. 금지된 admin/docker_api/full_access/host_network/AppArmor 비활성화를 도입하지 않는다.

## 2. 인수 기준과 작성 시점 확인

### Git·버전 상태

- 현재 branch: `feat/issue-71-default-socket-observability`, HEAD `59da709` (PLAN commit).
- 구현·시험·문서 변경과 FIX/REPORT/독립 REVIEW 대부분은 **미커밋/미추적**이다. 보고서만 전달하거나 HEAD만 push해서 기능을 빠뜨리지 않는다.
- 원격 dev: `0506f7490fea09d9572bfdf8c6cd177573fc43b3`.
- 원격 main: `03c572de01e4a733fd1b6d0e9da1f0bee4206ca9`, Stable 제품 0.7.3.
- `git ls-remote` 조회에서 0.7.4 계열 tag는 없었다. GHCR `0.7.4-dev.1` manifest 조회도 `not found`였다. 이는 번호 예약이 아니므로 실행 직전에 Git tag·GitHub Release·generic/per-architecture GHCR tag를 다시 확인한다. 이미 사용됐으면 덮어쓰지 말고 다음 미사용 `0.7.4-dev.N`으로 모든 참조를 일치시킨다.

### 이번 내용 검토와 독립 재확인

- 별도 Reviewer는 legacy 경계 복원, 동·서쪽 timezone 이동, 역행 보존, exact boundary, 멱등성, entrypoint parity, status 일치 등 12개 probe와 회귀를 근거로 ACCEPT했다. 그 판정은 로컬 코드 인수이며 image/실기·게시 완료가 아니다.
- 이번 작성자는 실제 작업 트리에서 예산 회귀 **2 passed, 141 deselected / 0.59s**와 기존 `budget-status-probe.mjs`를 다시 실행했다. legacy 03:00 이후 정상 reset, helper/checkUpdate의 소비량·경계 일치, persisted/status 경계 일치를 확인했다.
- ShellCheck, actionlint, `git diff --check`: PASS. 이번 작성자는 전체 suite·image build·외부 CI·실제 HA를 다시 실행하지 않았다.
- 별도 리뷰의 전체 suite **335 passed/6 skipped**는 real handover 필수 실행 완료의 대체물이 아니다. Executor는 아래 공식 binary pair를 연결한 최종 전체 pytest와 skip 이유를 새 버전에서 다시 기록한다.
- [Home Assistant 공식 App configuration](https://contributors.home-assistant.io/apps/reference/configuration/)의 image/version 및 stage 계약도 재확인했다. Supervisor가 받는 image tag와 manifest version을 일치시킨다.

검토 시 runtime SHA-256 (추적용이며 Git/최종 CI를 대체하지 않음):

| 파일 (`codex_home_assistant/rootfs/usr/local/` 기준) | SHA-256 |
| --- | --- |
| `bin/codex` | `fc8c251d2567b33694354cb6959d17e1b094e4e9f4ee3153c9b9715fb4188a8f` |
| `share/codex-ha/codex-runtime-manager.mjs` | `4588971777c0e89adba66d813ddb241b6381ed2013301d59409017ba9b6ad92e` |
| `share/codex-ha/codex-session-host.mjs` | `d1ecb1ff795b59d7719466422eb52a551516f51143aaf9f30372d256ef824941` |
| `share/codex-ha/codex-updater-daemon.mjs` | `bb02eee377148f9d4cc243fa90a8cfcc7bdd1b77b9ba07ac88c07447fbea9d92` |

APP_VERSION 등 후보 준비에 따른 차이는 예상 범위다. 실제 동작을 바꾸면 해당 차이와 회귀 검증을 별도로 기록한다.

## 3. 시작 상태 확인과 DEV 메타데이터

1. 루트 AGENTS, rules/progress, 관련 product_spec/architecture/addon_spec/security/test_plan/releasing와 handoff를 읽는다. Git status/diff, remote/auth, 최신 issue #71·DEV/main refs와 버전 충돌을 재확인한다. 기존 변경과 handoff를 보존한다.
2. 최신 dev와 기능 branch를 대조하고 필요한 동기화·충돌 해결을 수행한다. reset/clean이나 무분별한 add로 다른 작업·생성물·비밀을 포함하지 않는다. 현재 미커밋 구현, tests, CI, 문서와 필요한 handoff가 실제 commit 대상에 포함되는지 명시적 파일 목록으로 확인한다.
3. 확정 DEV version을 다음에 일치시킨다.
   - App config.yaml version, Dockerfile BUILD_VERSION 및 OCI version.
   - Playwright package.json/package-lock.json root version.
   - runtime manager APP_VERSION fallback.
   - CHANGELOG의 새 DEV release heading. Unreleased의 해당 변경을 후보 항목으로 정리하고 과거 0.7.3 기록을 덮어쓰지 않는다.
   - 테스트의 current-version 고정값과 사용자 문서의 current/candidate 표시. 버전·채널 검사를 삭제/skip하지 말고 확정 값을 검사한다.
4. DEV 표시를 맞춘다. repository.yaml/App name은 `Codex for Home Assistant (DEV)`, description은 `[DEV] ` prefix, panel_title은 `Codex DEV`, stage는 `experimental`로 설정한다. MOTD·OCI title/description은 builder.yaml의 DEV 계약과 일치시키고 slug와 GHCR image path는 유지한다.
5. bundled Codex 0.162.1과 기존 의존성 pin은 배포 때문에 임의로 올리지 않는다. 공식 0.162.1/0.166.0/0.167.0 fixture 공급·checksum·target 검증을 유지한다. bundled/selected/running version을 구분한다.
6. 한국어·영어 README/DOCS, CHANGELOG, development의 product_spec/architecture/test_plan/runtime-handover/releasing/progress를 검토한다. default socket, 두 단계 예산, 기간 전이, 진단·이력, 재연결 조건과 미검증을 반영하고 오래된 current-version 설명도 실제 후보 상태와 맞춘다. 공개 전에는 공개 완료로 쓰지 않는다.

## 4. 공개 전 필수 gate

### 자동 테스트와 최종 source

- 최종 version/source에서 `python -m pytest -ra` 전체를 실행한다. 기존 venv/의존성 관리를 사용하고 짧고 충분한 용량의 disposable basetemp를 사용한다.
- 최소한 다음 실제 패키지를 준비하고 CI와 같은 환경 변수를 연결한다.
  - CODEX_WIRE_PROBE_BINARY: `.test-tmp/candidate-167/bin/codex`.
  - CODEX_HANDOVER_BASELINE: `.test-tmp/task007-baseline/bin/codex`.
  - CODEX_HANDOVER_CANDIDATE: `.test-tmp/candidate-167/bin/codex`.
- 중요한 real handover, default proxy/negative peer, ephemeral 보호, 실제 loop·예산 전이, 성공/실패 이력 시험의 실행을 확인한다. binary 부재로 핵심 시험이 skip된 green은 수용하지 않는다. 선택형 skip도 이름·사유를 기록한다.
- Node/Bash syntax, ShellCheck, YAML/변경 Markdown, Dockerfile/Actions lint, App linter, secret scan과 diff check를 수행한다. 기존 workflow gate를 약화하지 않는다.

### 실제 image·policy·update

- 최종 DEV metadata의 amd64 image를 build하고 label/architecture/version, S6 시작, Web/SSH/remote bootstrap과 image 안의 bundled executable·Node/Python/Netlink 가용성을 확인한다.
- 실제 제품 wrapper의 pathless `--listen unix://`와 `--sock` 생략 proxy를 실제 profile 아래서 검증한다. `/proc/*/environ` deny를 유지한 fallback/peer 귀속이 helpers=1/unknown=0이며 busy/미검증 owner/ephemeral은 보호됨을 기존 smoke에 추가·연결한다. host의 수동 record·fault injection을 실제 SSH/S6/profile 증거로 대체하지 않는다.
- 기존 `tests/docker-smoke.sh`, `tests/mobile-ssh-smoke.py`, `tests/codex-update-smoke.sh` 등 관련 smoke를 최종 image에서 실행한다. fixture 준비의 일시적 unconfined 작업과 실제 profile enforced 검증 단계를 구분해 보고한다.
- synthetic volume에서 `tests/update-smoke.sh ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.3 <candidate-image>`를 실행해 auth/config/AGENTS, SSH identity, browser/memory와 일반 config marker를 검증한다. 같은 volume의 image update 증거를 main과 #dev의 repository identity 간 자동 데이터 이전 증거로 쓰지 않는다.
- native amd64/aarch64 기존 CI build/runtime/full smoke에 새 default-path gate를 연결해 양쪽에서 확인한다. native ARM CI와 실제 Raspberry Pi/aarch64 HAOS를 구분하며 후자는 미실행이면 NOT RUN으로 남긴다.

실패가 있으면 원인·최소 수정·필요한 재검증을 마친 뒤 진행한다. 새로운 runtime 설계 변경이 필요하면 차이와 증거를 review 가능한 상태로 정리하며 미해결 상태에서 tag를 만들지 않는다. 취약점/policy gate 무력화나 미검토 예외로 공개를 통과시키지 않는다.

## 5. dev PR·merge·immutable tag

1. 검증한 파일을 명시해 commit하고 기능/배포 준비 branch를 push한다. **base=dev** PR을 만든다. 본문은 issue #71의 문제→수정→검증→미검증과 확정 DEV version 순으로 작성한다. DEV 검증 단계에서 원 issue를 완료 처리하지 않는다.
2. PR exact HEAD의 CI와 non-publishing Builder를 확인한다. unit/lint, App metadata, native amd64/aarch64 build/full smoke, SBOM/Critical gate와 추가 image gate가 모두 성공한 뒤 dev에 merge한다. pending/skipped의 의미를 확인하고 admin bypass를 사용하지 않는다.
3. dev의 **exact merge SHA**를 기록하고 해당 SHA의 dev CI 성공을 기다린다. 이후 임의의 최신 HEAD를 tag 대상으로 바꾸지 않는다. main에는 merge하지 않는다.
4. 확정 version과 같은 annotated tag를 exact dev merge SHA에 만들고 해당 tag를 push한다. remote dereference와 의도한 SHA의 일치를 검증한다. 기존 tag/version image를 변경하지 않는다.
5. tag Builder의 완료를 기다려 양 architecture build/SBOM/scan, digest artifact, signature/provenance/SBOM attestation, generic manifest와 final version tag promotion을 확인한다.

## 6. 공개 artifact·prerelease와 설치 경로

1. GHCR generic/per-architecture version tag 및 linux/amd64·linux/arm64 manifest/config를 익명 registry 자격으로 조회·pull한다. version/source/architecture label과 Builder exact digest를 대조한다. token을 출력·기록하지 않는다.
2. Cosign/attestation workflow step 성공과 client 독립 검증 성공을 구분한다. expected repository/workflow/source tag·SHA/identity와 exact digest를 고정해 서명/provenance/SPDX를 검증한다. 미실행을 PASS로 쓰지 않는다.
3. 공개된 exact image에서 version, 실제 default proxy/SSH/peer와 관련 smoke를 확인한다. 로컬 build PASS만으로 공개 image의 PASS를 선언하지 않는다.
4. 익명 HTTP로 dev branch의 repository.yaml과 App config.yaml을 확인한다. DEV 표시·확정 version·공개 image가 일치하고 raw metadata를 가져올 수 있어야 한다.
5. 검증된 tag에서 **draft=false / prerelease=true / Stable latest 아님**인 GitHub Release를 공개한다. 새 version, issue #71, 주요 변경, 업데이트/재연결 주의와 HAOS/mobile/물리 ARM 미검증을 release note에 포함한다.
6. 완료 시 version, release URL, image/digest, `https://github.com/Kanu-Coffee/codex-for-home-assistant#dev`를 사용자에게 전달한다. metadata/image 없는 branch push만으로 배포 완료 처리하지 않는다. 실기 Store 노출/설치를 관측하지 않았다면 NOT RUN으로 남긴다.
7. #dev와 main은 별도 repository identity다. Stable 0.7.3의 `/data`가 #dev로 자동 이전된다고 안내하지 않는다. 삭제/재설치·credential/데이터 이동을 실행하지 않는다. 실제 장치 업데이트와 Stable 0.7.4 승격은 별도 단계다.

## 7. 실패 대응과 완료 보고

- CI/Builder 실패 시 로그·exact source/digest를 확인해 수정하고 필요한 gate를 재실행한다. 부분 promotion은 기존 immutable artifact 정책을 따른다. 같은 run의 failed jobs 재실행으로 복구 가능한지 확인하고 다른 digest의 덮어쓰기나 별도 run 산출물 결합을 하지 않는다. 번호가 소비됐다면 다음 N을 사용한다.
- 공개 도중 실패해도 Stable main/0.7.3을 임의 변경하지 않는다. 생성된 artifact와 미완료 항목을 명시한다.
- `FIX_07_REPORT.md`와 progress를 실제 결과로 갱신한다. version, source/PR HEAD/dev merge SHA, PR/CI/Builder URL·job 결론, annotated tag dereference, generic/architecture digest, 공개 pull, 서명 검증, release properties/URL, raw metadata, 실제 image/update smoke, 미검증/실패/계획 편차를 기록한다.
- 로컬 코드 인수, DEV 공개 artifact 인수, 실제 HAOS/mobile 인수, Stable 0.7.4 승격을 분리한다. **본 FIX는 검증된 DEV를 실제 공개하고 설치 경로를 전달한 시점에 완료**되며 Stable 공개나 실기 시험 완료를 의미하지 않는다.
