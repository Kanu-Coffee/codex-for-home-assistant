# PLAN — 내장 Codex CLI 버전 업데이트

## 역할과 목표

- 작성: Planner, 2026-10-12 (Asia/Seoul).
- 요청: Codex for Home Assistant 이미지에 포함된 Codex 바이너리 업데이트를 위한 실행 계획.
- 목표: 현재 `0.144.1`을 공식 stable `0.162.1`로 올리고, amd64/aarch64의 기존 제품·보안·영속성 계약을 유지하는 로컬 구현 및 검증 결과를 준비한다.
- 이 문서는 실행 지침이다. Planner가 바이너리나 App 버전을 이미 변경한 것이 아니다.
- Executor는 구현 후 이 디렉터리에 `REPORT.md`를 새로 작성한다. 기존 PLAN과 다른 handoff 문서를 덮어쓰지 않는다. Reviewer는 필요할 때 다음 `FIX_NN.md`를 작성한다.

## 기준 상태와 조사 결과

- 저장소: `/home/lee/projects/codex_for_HA`, origin `Kanu-Coffee/codex-for-home-assistant`.
- 시작 branch `main`, HEAD `a32698851e3c3539f5d4b823e60d4f0d29038df1`; 작업 전 `git status --short`는 비어 있었다.
- `.handoff/`는 없었으므로 첫 task 번호 `001`을 사용한다.
- App stable 버전은 `0.7.0`; Dockerfile은 Codex `0.144.1`, 아키텍처별 SHA-256과 설치 후 exact version을 고정한다.
- 실제 실행 파일은 `/usr/local/libexec/codex-real`, 진입점은 정책을 적용하는 `/usr/local/bin/codex` wrapper다. wrapper를 upstream 바이너리로 교체하지 않는다.
- Dockerfile은 musl tarball 안의 `codex-<target>` 한 파일을 설치한다. 최신 release에는 별도 package/app-server/code-mode-host/bwrap asset도 있으므로 기존 단일 파일 설치가 충분한지 먼저 확인해야 한다.
- `.github/workflows/ci.yaml`의 native ARM job과 두 Python contract test에 버전·checksum이 하드코딩되어 있다. `docker-smoke.sh`의 버전 검사는 현재 형식만 검사한다.
- 현재 업데이트 smoke 기본 baseline과 amd64 CI 입력은 public `0.6.0`이다. 이번 변경은 직전 stable `0.7.0`에서의 업데이트도 검증해야 한다.
- `0.7.0` native CI·공개 image 증거는 기존 기록이다. 실제 aarch64 HAOS와 일부 syscall-level deny 행렬은 NOT RUN이며 기존 waiver를 이번 runtime 변경에 재사용하지 않는다.

## 읽어야 할 지침

Executor는 최신 Git 상태와 루트/하위 `AGENTS.md`·`GEMINI.md`를 다시 확인하고 다음을 순서대로 읽는다.

1. `docs/development/rules.md`, `progress.md`.
2. `product_spec.md`, `architecture.md`, `addon_spec.md`, `security.md`, `test_plan.md`.
3. `docs/development/releasing.md`와 실제 `.github/workflows/{ci,builder,build-app}.yaml`.

문서는 `docs/development/` 기준이며 archive는 현재 지침이 아니다. 런타임에 배포하는 `rootfs/usr/local/share/codex-ha/AGENTS.md`는 별개의 파일이다.

## 공식 근거와 고정할 후보

Planner는 공식 OpenAI 문서와 upstream GitHub Releases API를 조회했다. 실행자는 구현 시작 시 동일 tag의 metadata와 asset을 재확인한다. 계획 이후 새 stable이 나왔다는 이유만으로 목표를 자동 변경하지 않는다. 목표가 unavailable하거나 호환성에 문제가 있으면 증거와 대안을 REPORT에 남기고, 제품 계약을 바꾸는 결정은 사용자에게 확인한다.

- [OpenAI Codex changelog](https://developers.openai.com/codex/changelog) — 조회 시 공식 `learn.chatgpt.com/docs/changelog`로 이동했다. 이 페이지에서 정확한 최신 CLI 버전을 확정하지 않았다.
- [OpenAI Codex security](https://developers.openai.com/codex/security) — 조회 시 공식 `learn.chatgpt.com/docs/security`로 이동했다. 새 바이너리의 requirements 해석은 별도 검증 대상이다.
- [공식 stable 0.162.1](https://github.com/openai/codex/releases/tag/rust-v0.162.1) — `gh api repos/openai/codex/releases/latest` 결과: `draft=false`, `prerelease=false`, published `2026-10-09T19:44:51Z`.
- [0.162.0 변경 기록](https://github.com/openai/codex/releases/tag/rust-v0.162.0) — Linux sandbox의 복수 deny 파일 처리와 sandbox executable 검증 관련 변경을 확인했으므로 deny 회귀 시험을 필수로 한다.
- [전체 비교 범위](https://github.com/openai/codex/compare/rust-v0.144.1...rust-v0.162.1) — 중간 버전의 config/CLI/app-server/auth/packaging 변경은 Executor가 검토해야 한다.

| App architecture | 공식 archive | Releases API digest의 SHA-256 |
| --- | --- | --- |
| amd64 | `codex-x86_64-unknown-linux-musl.tar.gz` | `86f268d81b898f3e144c5ecff2ad2fda2c5802e042d6195b72538fe0fa125057` |
| aarch64 | `codex-aarch64-unknown-linux-musl.tar.gz` | `bf3ca2719f1143b1440fbd85c149379e696c782c50ad7991f8bfcec60b2600c1` |

Download URL 형식은 `https://github.com/openai/codex/releases/download/rust-v0.162.1/<archive>`다. 위 digest는 API metadata 확인값이며 Planner가 실제 다운로드 파일을 hash한 결과가 아니다. Executor는 두 archive를 임시 디렉터리에 다운로드하고 `sha256sum`으로 일치 여부를 확인한다. 다운로드 artifact를 Git에 넣지 않는다.

## 범위와 불변조건

- Codex 버전 업데이트, 이를 위한 최소 packaging/호환성 수정, 관련 테스트·CI·문서와 App 후보 버전 정합성까지 수행한다.
- `/config` RW와 Core/Supervisor 전체 API `manager` 계약을 유지한다. 보호 경로 밖의 정상 파일 작업과 network access를 보존한다.
- `workspace-write`, image-managed requirements, root/nested `secrets.yaml`·`.storage` 고정 deny, unsafe-link preflight와 ambient `SUPERVISOR_TOKEN` 비상속을 유지한다.
- `hassio_role: admin`, `docker_api`, `full_access`, `host_network`, `apparmor: false`를 도입하지 않는다. Sandbox 오류를 권한 확대나 보안 검사 삭제로 해결하지 않는다.
- 기본 `preserve`, 기존 Codex auth/config/AGENTS/override/session, SSH key, browser identity와 memory를 보존한다. 자동 로그인·logout·credential migration을 임의 실행하지 않는다.
- 런타임 자동 업데이트를 도입하지 않는다. 새 self-update 경로가 있다면 이미지 pin과 충돌하는지 조사하되 완전 차단을 검증 없이 주장하지 않는다.
- base image, GitHub CLI, Playwright/Chromium/Node, memory schema, HA 옵션·권한·배포 채널을 별도 목적 없이 함께 변경하지 않는다.
- 현재 요청은 계획 작성이다. 이 PLAN 자체는 commit/push/PR/merge/tag/release/image publication 또는 실제 HAOS 변경의 승인이 아니다.

## 구현 순서

### 1. 호환성 확인

1. 새 작업 세션의 Git 상태를 확인하고 사용자의 기존 변경을 보존한다. 구현은 `fix/codex-cli-update` 등 기능 branch에서 수행한다.
2. 두 archive의 checksum과 `tar -tzf` 결과를 확인한다. 실제 설치 파일명, 추가 executable/runtime/동봉 license 필요 여부를 기록한다.
3. 중간 stable release의 CLI/config/requirements/MCP approval/auth/Remote app-server 변경을 확인한다. 특히 `codex debug prompt-input`, `codex sandbox`, `codex mcp list --json`, `login --device-auth`, `app-server` 및 wrapper의 `-c`, `--add-dir` 호환성을 확인한다.
4. 기존 config와 requirements를 사용하는 Alpine 이미지에서 config parsing과 real sandbox 실행을 확인한다. `--version`만으로 정상 작동을 판정하지 않는다.
5. 기존 한 파일 설치가 부족하면 공식 package의 배치 방식과 추가 파일의 checksum·AppArmor 경로를 확인하고 필요한 최소 변경만 한다. 별도 app-server 배포나 rootfs 구조 변경의 필요성과 검증을 REPORT에 설명한다.

### 2. pin과 후보 metadata 갱신

필수 변경 표면:

- `codex_home_assistant/Dockerfile`: `CODEX_VERSION`, 두 `CODEX_SHA256_*`; checksum 검증과 real/wrapper exact-version 검사는 유지.
- `tests/test_runtime_contract.py`, `tests/test_multiarch_contract.py`: 새 버전·checksum 및 필요한 packaging 계약을 반영. 테스트를 제거하거나 검증을 느슨하게 하지 않는다.
- `.github/workflows/ci.yaml`: ARM exact-version 검사를 새 버전과 일치시킨다. 두 architecture와 기존 smoke parity를 유지한다.
- `tests/docker-smoke.sh`: Dockerfile의 pin을 기준으로 real binary와 wrapper의 exact version을 검증하도록 기존 검사를 보강한다. 별도 버전 관리 체계는 만들지 않는다.
- `tests/update-smoke.sh`, `.github/workflows/ci.yaml`, `tests/test_browser_contract.py`: `0.7.0` → 후보 보존 검증을 추가/갱신하고 baseline과 step-name 정적 계약도 함께 맞춘다. 기존 `0.6.0` 증거는 역사 기록으로 보존한다.

App 업데이트가 배포 표면에 나타나도록 로컬 patch 후보 `0.7.1`을 기본으로 준비한다. 시작 시 저장소가 이미 진행됐다면 아직 사용하지 않은 다음 patch를 선택해 기록한다. `config.yaml`, Dockerfile `BUILD_VERSION`, Playwright package/lock의 root version, changelog 첫 release heading과 App version contract test를 함께 맞춘다. 이는 로컬 후보 준비이며 stable 발행 완료를 뜻하지 않는다. 별도 승인 없이 DEV 채널로 전환하지 않는다.

### 3. 문서 동기화

- `THIRD_PARTY_NOTICES.md`: 현재 Codex component/tag/archive/checksum과 추가 동봉 파일의 license 정보를 반영한다.
- `docs/development/addon_spec.md`, `test_plan.md`, `releasing.md`, `references.md`: 현재 설치·시험·버전 확인 기준을 갱신한다.
- `docs/development/progress.md`: 실제 작업·테스트·미검증 상태를 갱신하되 과거 release와 digest/PASS/waiver 기록은 유지한다.
- `docs/development/decisions.md`: 과거 ADR을 새 사실로 덮어쓰지 않고, 설치 전략에 실질적 변경이 있으면 후속 ADR을 추가한다.
- 루트 및 App의 한국어·영어 README와 App `DOCS.md`/`DOCS.en.md`, 예시와 `CHANGELOG.md`를 검토한다. 현재 버전/업데이트 안내가 바뀌는 곳만 동기화한다. 과거 changelog의 `0.144.1`은 일괄 치환하지 않는다.
- `codex_home_assistant/apparmor.txt`의 구버전 설명은 새 동작을 확인해 정리한다. 정책은 확인된 새 실행 경로가 필요할 때만 최소 수정한다.
- `tests/fixtures/ha_feedback_*.json`의 구버전은 과거 synthetic report라면 유지한다. 현재 runtime 기대값과 구분한다.

## 검증과 수용 기준

### 자동·로컬 검증

기존 CI 명령을 우선한다. 도구가 없다고 설치·global config 변경·의존성 추가를 임의 수행하지 말고 가능한 대체 또는 NOT RUN 사유를 남긴다.

1. 두 공식 artifact의 실제 SHA-256, archive 내용, 설치 대상·license 확인.
2. `python3 -m pytest -ra`, YAML/Markdown lint, ShellCheck, Hadolint, workflow 수정 시 actionlint, App linter, `apparmor_parser --skip-kernel-load --skip-cache codex_home_assistant/apparmor.txt`.
3. `docker build --platform linux/amd64 --tag codex-for-home-assistant:test codex_home_assistant`; native ARM은 `--platform linux/arm64 --build-arg BUILD_ARCH=aarch64`로 별도 build한다. architecture mismatch 음성 검사도 유지한다.
4. 두 architecture에서 image label/platform, `codex-real --version`과 `codex --version`이 `codex-cli 0.162.1`인지 확인한다. `sshd -t`, nginx syntax, MCP config와 device-auth/app-server command parsing도 확인한다.
5. 다음 기존 smoke 7개를 동일 후보 image에 실행한다: `docker-smoke.sh`, `browser-approval-smoke.sh`, `managed-auth-smoke.sh`, `managed-sandbox-smoke.sh`, `memory-smoke.sh`, `user-files-update-smoke.sh`, `feedback-smoke.sh`. ARM은 `DOCKER_PLATFORM=linux/arm64`를 사용한다.
6. `managed-sandbox-smoke.sh`의 실제 Codex sandbox에서 일반 `/config` RW·network·helper 가용성과 보호 파일 deny를 확인한다. 사용자/project/CLI override 및 legacy danger 입력으로 deny를 약화할 수 없어야 한다. CI-only bubblewrap profile setup과 로컬 kernel 제한을 구분한다.
7. `bash tests/update-smoke.sh ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.0 codex-for-home-assistant:test`로 일반 업데이트 보존을 확인한다. preserve의 byte/mode, SSH fingerprint, browser identity, memory와 사용자 override 보존을 기존 fixture로 검증한다. 검사 로그에 credential을 출력하지 않는다.
8. Native ARM이 없는 로컬 환경에서는 NOT RUN으로 남기고 이후 승인된 CI의 native job 결과를 요구한다. QEMU 실행을 native PASS로 기록하지 않는다. 새 push/CI trigger를 실행 허가로 추정하지 않는다.
9. 저장소 secret scan과 `git diff --check`, 전체 diff/status를 확인한다. Pytest secret scan 또는 기존 검사 방식을 사용한다.

Browser approval smoke는 fake Codex를 사용하는 구간이 있으므로 해당 PASS만으로 새 Codex의 MCP approval 해석을 입증하지 않는다. 실제 바이너리의 config/prompt 검사와 HAOS acceptance를 함께 구분한다.

### HAOS 후속 수용 (별도 승인된 환경에서만)

- amd64와 aarch64 각각 일반 업데이트·재시작, Ingress TUI/resize/tmux 재접속, 일반 SSH와 ChatGPT mobile Remote의 직접 app-server bootstrap 및 `/config` 프로젝트 열기를 확인한다.
- 기존 인증 재사용과 device-auth, 사용자 설정/지침/SSH host key·browser identity·memory 보존을 확인한다. auth 원문을 보고서로 반출하지 않는다.
- 실제 AppArmor 적용 상태에서 보호 경로 content deny와 일반 `/config` RW·API helper 가용성을 synthetic fixture로 확인한다. 운영 secrets/storage를 읽어 검증하지 않는다.
- image-managed memory/Playwright MCP startup·browser approval 정책과 desktop/mobile loopback 대시보드 가용성을 확인한다.
- 해당 환경이 없으면 각각 NOT RUN이며 release-ready와 구분한다. 과거 stable `0.7.0` 위험 수용은 새 runtime에 적용되지 않는다.

### 완료 판단

- **구현 검토 준비 완료**: 새 pin·checksum·metadata·현재 문서가 일치하고 가능한 자동 검증을 수행했으며 FAIL/NOT RUN을 공개한 로컬 diff와 REPORT가 존재한다. 필수 검증 실패는 미해결 blocker로 남긴다.
- **배포 준비 완료**: 두 architecture native build/full smoke와 필요한 HAOS 수용을 확인한다. 공백이 있다면 사용자의 이번 변경에 대한 명시적 위험 수용이 필요하며 PASS로 바꾸지 않는다.
- **발행 완료**: 현재 요청 범위 밖이다. 추가 사용자 요청 후 기존 release workflow와 공급망 검증 절차를 따른다.

## REPORT에 남길 증거

- 시작/종료 branch·HEAD·Git 상태, 변경 파일, 선택한 App/Codex 버전과 실제 archive hash.
- compatibility 조사, 추가 설치 파일 필요 여부, config/requirements/approval/app-server 결과와 계획의 실질적 편차.
- 실제 실행 명령·exit/result, architecture·image ID, native/emulated 구분, smoke별 PASS/FAIL/NOT RUN과 사유.
- `0.7.0` 업데이트 보존 결과, HAOS 미검증 항목, 공급망/배포 검증이 수행되지 않았다는 사실.
- 문제가 있으면 release를 진행하지 않는다. image pin·설치 방식의 최소 수정안을 준비한다. 사용자 상태를 새 Codex가 변경했다면 downgrade 호환성을 확인하지 않은 자동 롤백을 권하지 않는다.

## Planner 검증 기록

- 실행: Git status/branch/log/remote와 `gh auth status`, repository instruction·현재 runtime/CI/test/doc 검토, 공식 OpenAI 문서 조회, 공식 Releases API의 tag/date/stable flag/asset digest 확인.
- 미실행: artifact 다운로드/hash/내용 확인, 바이너리 실행, Docker build, pytest/runtime smoke, native ARM 및 HAOS 시험. 모두 Executor 작업이며 이 계획은 구현 PASS 증거가 아니다.
- 문서 검증: `git diff --check` PASS. Python 표준 라이브러리로 PLAN UTF-8/종료 newline, 두 SHA-256 길이, progress 상대 링크와 task 내 PLAN 단독 존재를 확인해 PASS했다. 신규 PLAN 내용과 progress diff를 검토했다.
- Markdown lint: `npx --offline --no-install markdownlint-cli2 .handoff/001_codex-binary-update/PLAN.md docs/development/progress.md`는 로컬 cache 부재(`ENOTCACHED`)로 실행 불가. 도구를 설치하지 않았으며 lint PASS로 기록하지 않는다.
