# 릴리스 운영 가이드

[개발 문서로 돌아가기](README.md)

이 문서는 현재 `.github/workflows/ci.yaml`, `builder.yaml`, `build-app.yaml`과 `codex_home_assistant/config.yaml`의 계약을 요약합니다. 실제 릴리스 전에는 workflow 원문과 GitHub Actions 결과를 다시 확인하세요.

## 배포 모델

- Home Assistant App repository: `https://github.com/Kanu-Coffee/codex-for-home-assistant`
- DEV canary repository: `https://github.com/Kanu-Coffee/codex-for-home-assistant#dev`
- image: `ghcr.io/kanu-coffee/codex-for-home-assistant:<version>`
- public `0.6.0` architecture: `amd64`
- current published DEV `0.7.0-dev.2` architecture: `amd64`, `aarch64` (`armv7` 미지원)
- stable version tag: `X.Y.Z`
- numbered DEV version tag: `X.Y.Z-dev.N` (`N`은 1 이상의 정수이며 새 후보마다 사용하지 않은 번호 선택)
- mutable `latest` tag는 발행하지 않음
- 기존 version tag는 덮어쓰지 않음

Supervisor는 `config.yaml`의 `image`와 `version`으로 미리 빌드된 image를 받습니다. 사용자 장치에서 Dockerfile을 소스 빌드하는 배포 방식이 아닙니다. 따라서 canary 저장소에 DEV metadata가 보여도 정확한 version image가 발행되지 않았다면 원격 HAOS 설치·업데이트는 실패합니다. 현재 `ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.0-dev.2`는 발행과 익명 manifest resolution을 통과했습니다.

## 버전 일치 항목

릴리스 후보에서는 최소한 다음 값이 모두 같아야 합니다.

- `codex_home_assistant/config.yaml`의 `version`
- `codex_home_assistant/Dockerfile`의 `BUILD_VERSION`
- `codex_home_assistant/playwright/package.json`의 `version`
- `codex_home_assistant/playwright/package-lock.json`의 root/package version
- `codex_home_assistant/CHANGELOG.md`의 첫 release heading
- Git tag `X.Y.Z` 또는 `X.Y.Z-dev.N`

계약 테스트가 이 일치를 검사합니다. 사용자 README/DOCS의 current-version 문구와 upgrade note도 함께 검토합니다.

DEV version에서는 추가로 `repository.yaml`과 `config.yaml`의 표시명이 `Codex for Home Assistant (DEV)`, panel이 `Codex DEV`, description이 `[DEV]`로 시작하고 Docker OCI title과 MOTD도 `(DEV)`인지 검사합니다. Stable version에는 이 DEV 표식을 남기지 않습니다. `slug: codex_home_assistant`와 GHCR image 경로는 두 채널에서 고정합니다.

## Pull request 단계

1. 기능 브랜치에서 변경 범위와 사용자 영향을 검토합니다.
2. 로컬에서 관련 unit/contract/lint와 가능한 smoke를 실행합니다.
3. PR에서 `ci.yaml`의 lint, pytest, AppArmor parser, App linter와 amd64 image full smoke를 확인합니다.
4. Native `ubuntu-24.04-arm` job의 aarch64 build, image architecture/label, Codex/GitHub CLI/Node/Chromium runtime, `/usr/bin/tempio` 부재와 architecture-neutral 7개 smoke를 독립적으로 확인합니다. DEV `0.7.0-dev.1`은 [dev CI 31549518729](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/31549518729)에서 amd64와 native aarch64 full smoke를 PASS했으며 실제 aarch64 HAOS 수용은 별도 결과로 남깁니다.
5. 앱 경로가 바뀐 PR은 `builder.yaml`이 non-publishing amd64/aarch64 image build, architecture별 SPDX SBOM 생성, Critical 차단과 High/Critical 보고를 수행합니다. `0.7.0-dev.1` 후보의 이 dry-run은 [Builder 31548711713](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/31548711713)에서 PASS했습니다.
6. Dependabot의 action-pin 및 Playwright npm 갱신도 일반 PR과 같은 review/CI를 거칩니다. Third-party action은 full commit SHA, npm runtime은 lockfile exact version/integrity에 고정됐는지 확인합니다.
7. HAOS에서만 확인 가능한 경로는 PASS로 추정하지 않고 `NOT RUN` 또는 `PARTIAL`로 남깁니다.

`0.7.0-dev.2`는 [PR #36 CI 31759991854](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/31759991854)와 non-publishing [Builder 31759992068](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/31759992068), merge commit `45c2062a4515f4663b83f68675b0091f3de67e3b`의 [dev CI 31760252237](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/31760252237)를 PASS했습니다.

## 태그와 image 게시

1. Stable release commit은 `main`, numbered DEV release commit은 `dev`에 있고 해당 branch CI가 PASS인지 확인합니다. DEV canary를 게시하기 위해 `main`을 변경하거나 DEV metadata를 `main`에 합치지 않습니다.
2. 변경 기록과 사용자 문서가 실제 동작·제약과 일치하는지 검토합니다.
3. 같은 SHA에 앱 version과 동일한 annotated stable `X.Y.Z` 또는 numbered DEV `X.Y.Z-dev.N` tag를 생성합니다. DEV tag는 DEV 표시명 계약을 충족하지 않으면 게시하지 않습니다.
4. tag push가 `builder.yaml`을 시작합니다.
5. 각 architecture를 local build/load한 뒤 SPDX SBOM과 Critical 차단·High/Critical 보고를 완료합니다. 검증 전에는 최종 version tag를 게시하지 않습니다.
6. 검증한 architecture digest를 immutable Actions artifact로 전달하고 run-scoped staging tag와 교차검증합니다. 그 exact digest에 Cosign signature, provenance와 SBOM attestation을 먼저 게시합니다.
7. Manifest job은 artifact의 exact per-architecture digest만으로 staging manifest를 만들고 digest 집합을 다시 확인한 뒤 signature와 provenance를 게시합니다. 모든 증거가 성공한 마지막 단계에서만 architecture/generic version tag를 승격하며, 기존 tag가 같은 digest면 재실행을 계속하고 다른 digest면 덮어쓰지 않고 실패합니다.

기존 tag나 GHCR version을 수정·덮어쓰지 마세요. Stable 릴리스에 문제가 있으면 tag를 재사용하지 말고 새 patch version을 준비합니다. DEV 후보에 문제가 있으면 `N`을 증가시킨 새 `X.Y.Z-dev.N` version을 사용합니다.

같은 workflow run의 promotion 단계가 네트워크 오류 등으로 일부 tag만 만든 경우에는 **failed jobs만** 재실행합니다. 같은 run의 immutable digest artifact와 staging digest를 다시 사용하므로 동일 content는 멱등 복구되고, 다른 content가 감지되면 workflow가 덮어쓰지 않고 실패합니다. 완료된 run을 새 산출물로 전체 재빌드하거나 다른 run/tag에서 부분 release를 이어 붙이지 말고, digest 충돌이나 artifact 만료 시 새 patch version을 준비합니다.

## 게시 후 확인

- tag Builder와 관련 CI 결과
- 인증 없는 generic/per-architecture image 조회와 pull
- image의 `io.hass.version`, `io.hass.arch`, source label
- 예상 architecture가 각각 `linux/amd64`, `linux/arm64`인지
- 각 image에서 Codex `0.144.1`, GitHub CLI `2.97.0` exact version과 architecture가 일치하고 `/usr/bin/tempio`가 없는지
- generic tag와 두 runtime manifest digest 기록
- architecture별 SPDX SBOM artifact, Critical gate와 High/Critical scan 결과
- per-architecture image의 Cosign signature, provenance와 SBOM attestation 검증
- generic manifest의 Cosign signature와 provenance attestation 검증
- mutable `latest`가 생기지 않았는지
- GitHub release와 사용자용 upgrade note
- Home Assistant App repository 새로고침에서 새 version 노출
- 가능한 경우 실제 HAOS의 일반 update와 `/data` 보존

검증에 실제 token, `/config`, entity, 내부 URL이나 screenshot을 반입하지 마세요. 결과는 [progress.md](progress.md)에 PASS/PARTIAL/NOT RUN 경계를 유지해 기록합니다.

DEV `0.7.0-dev.1`의 native amd64/aarch64 CI는 [dev CI 31549518729](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/31549518729)에서 PASS했습니다. [Tag Builder 31550037239](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/31550037239)는 두 architecture의 SPDX SBOM과 Critical gate, Cosign signature, provenance/SBOM attestation, generic manifest signature/provenance와 final tag promotion을 모두 PASS했습니다. High 이상 scan 경고는 두 architecture에 비차단으로 남았지만 Critical publication gate는 통과했습니다.

최종 digest는 generic `sha256:703fd667d21c2b101b546652f9b781725a31b071377bf205cd130640e79d5ae5`, amd64 `sha256:e19882421cc86ac1042a6c512c808db35bb4b506134db482f2a5d6c9f78606b2`, aarch64 `sha256:dc43af845b5b60749e0599047f2cfeaa2ec0838b2783826ad872da2e990c27c5`다. 실제 Raspberry Pi/aarch64 HAOS 설치·시작·업데이트와 새 AppArmor/managed-requirements의 HAOS runtime acceptance는 **NOT RUN**입니다. Public `0.6.0`의 과거 amd64 증거는 그대로 유지하며 DEV publish 결과를 그 stable release의 사실로 소급하지 않습니다.

Latest DEV `0.7.0-dev.2`의 annotated tag object `9c7fa71e33f45dcb2ec132297f1cfe0bbee5fc1c`은 위 `dev` merge commit으로 peel됩니다. [Tag Builder 31760484384](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/31760484384)는 양 architecture의 SBOM/Critical gate, signing/attestation 단계, manifest 검증과 final promotion을 PASS했습니다. 각 architecture scan은 Critical 0/High 68이며 High는 비차단입니다. 익명 조회한 digest는 generic `sha256:781c96531771d24e2263b09aef908e72fbbb8344d94e3ac3e601367d51190f85`, amd64 `sha256:aecf766814049068dcf08393f061a725f8c15025ccf9d1acfde3b7d3aaeb7206`, aarch64 `sha256:eaa2fb6ce85f7a522f0a2290a38b2183ab7e41940a608b6cd8cf52ba7da058eb`이며 config와 layer도 공개 조회됩니다. 독립 Cosign signature/attestation 검증과 실제 HAOS `0.7.0-dev.2` update/recovery는 **NOT RUN**입니다.

## 롤백 원칙

- 사용자는 앱 완전 삭제·재설치보다 Home Assistant backup과 검증된 version 전환을 우선합니다.
- 유지보수자는 immutable image/tag를 보존하고 새 patch에서 수정합니다.
- downgrade가 `/data` schema나 사용자 config와 호환되는지 검증되지 않았다면 자동 권장하지 않습니다.
- credential 노출이나 image 신뢰 문제가 있으면 배포 편의보다 secret 폐기와 접근 차단을 우선합니다.
