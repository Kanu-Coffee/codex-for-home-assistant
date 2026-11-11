# FIX_08_REPORT — Stable 0.7.4 정식 공개 배포 완료 보고서

- 작성: 2026-11-11 (Asia/Seoul), Executor: Antigravity.
- 참조: `.handoff/008_default-socket-update-observability/FIX_08.md`.
- 상태: **배포 완료 (SUCCESS) / task 008 및 Issue #71 완수**.
- 정식 버전: **0.7.4** (GA).
- 공개 설치 경로: `https://github.com/Kanu-Coffee/codex-for-home-assistant`.
- GitHub Release: `https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.7.4`.

---

## 1. 개요 및 최종 결과 요약

사용자의 DEV(`0.7.4-dev.1`) 직접 설치 및 실기 테스트 수용(“dev 버전으로 내가 직접 설치 후 테스트 완료하였고 이상없다. 실제 0.7.4 배포를 지시하기 위한 fix를 발행하라.”)과 Reviewer Codex의 `FIX_08.md` 정식 배포 지시에 따라, **Stable `0.7.4` 공개 배포**를 완수하였다.

| 항목 | 내용 |
| --- | --- |
| 배포 버전 | **`0.7.4`** (GA Stable) |
| 대상 브랜치 | `main` (default branch) |
| Exact Merge Commit | `5c62a9187c603f42bfefa1fd106af8a234938f32` |
| Annotated Git Tag | `0.7.4` (dereferences to `5c62a9187c603f42bfefa1fd106af8a234938f32`) |
| PR 내역 | [PR #74](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/74) (`codex/release-0.7.4` -> `main`, CI 8 checks all green) |
| main CI Run | [Run 42965244821](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/42965244821) (4 jobs all green: amd64, aarch64 native, linter, addon-config) |
| Tag Builder Run | [Run 42966060323](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/42966060323) (amd64/arm64 build, SBOM, Cosign signing, attestations green) |
| GHCR 이미지 | `ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.4` (multi-arch manifest) |
| GitHub Release | [0.7.4](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.7.4) (`isDraft: false`, `isPrerelease: false`, `latest: true`) |
| 공개 설치 경로 | `https://github.com/Kanu-Coffee/codex-for-home-assistant` |

---

## 2. Stable 메타데이터 정합성 및 계약 일치 (§3)

Home Assistant 공식 App configuration 사양과 저장소 표준에 따라 DEV 표기를 제거하고 Stable 계약으로 전환하였다.

1. **App 및 저장소 메타데이터**:
   - `codex_home_assistant/config.yaml`:
     - `name: Codex for Home Assistant`
     - `version: "0.7.4"`
     - `description: "Codex CLI with verified feedback, browser, terminal, and SSH for Home Assistant"` (`[DEV]` prefix 제거)
     - `stage` 키: **생략** (Supervisor 암묵적 stable 채널 사용)
     - `panel_title: Codex`
     - `slug`: `codex_home_assistant` 유지
     - `image`: `ghcr.io/kanu-coffee/codex-for-home-assistant` 유지
   - `repository.yaml`: `name: Codex for Home Assistant`
   - `codex_home_assistant/Dockerfile`:
     - `ARG BUILD_VERSION=0.7.4`
     - OCI Labels: `io.hass.name="Codex for Home Assistant"`, `org.opencontainers.image.title="Home Assistant App: Codex for Home Assistant"`, `org.opencontainers.image.description="Codex CLI with verified feedback reports, Playwright browser, Ingress terminal, and public-key SSH for Home Assistant"`
   - `codex_home_assistant/rootfs/etc/motd`: `Codex for Home Assistant`
2. **런타임 및 의존성 버전**:
   - `codex_home_assistant/playwright/package.json` & `package-lock.json`: `"version": "0.7.4"`
   - `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`: `APP_VERSION = "0.7.4"`
3. **문서 및 CHANGELOG**:
   - `codex_home_assistant/CHANGELOG.md`: `## [0.7.4] - 2026-11-11` 정식 릴리스 섹션 추가 (0.7.4-dev.1 및 0.7.3 과거 이력 온전 보존).
   - `README.md`, `README.en.md`, `codex_home_assistant/README.md`, `codex_home_assistant/README.en.md`: DEV 상단 배너 제거 및 정식판 0.7.4 안내 반영.
   - `docs/development/releasing.md`: current stable 0.7.3 / 후보 0.7.4로 최신화.
4. **테스트 계약 갱신**:
   - `tests/test_addon_contract.py`: `assert "stage" not in addon_config`, `test_stable_release_is_visible_in_home_assistant_and_image` 통과.
   - `tests/test_codex_update_contract.py`: `assert status["appVersion"] == "0.7.4"` 반영.

---

## 3. 검증 결과 및 CI 버그 수정 (§4)

### 3.1 로컬 전체 pytest suite 실행
공식 바이너리 3종(`0.162.1`, `0.166.0`, `0.167.0`)을 연결한 환경에서 전체 테스트를 수행하였다.
- 환경 변수:
  - `CODEX_WIRE_PROBE_BINARY=$PWD/.test-tmp/candidate-167/bin/codex`
  - `CODEX_HANDOVER_BASELINE=$PWD/.test-tmp/task007-baseline/bin/codex`
  - `CODEX_HANDOVER_CANDIDATE=$PWD/.test-tmp/candidate-167/bin/codex`
- 실행 결과: **337 passed, 1 skipped in 197.53s (100% PASS)**
  - (1 skipped: `tests/test_vulnerability_gate_policy.py:169` - Grype 바이너리 부재로 인한 의도된 skip)
- 정적 검사:
  - `node --check`: PASS
  - `git diff --check`: PASS
  - `tests/test_secret_scan.py`: PASS (비밀값 누출 0건)

### 3.2 로컬 Docker 빌드 및 런타임 검증
- 이미지 빌드: `codex-ha:candidate-0.7.4` 빌드 성공 (Alpine 3.24 base, nodejs, python3, chromium, s6-overlay).
- 라벨 검증: `io.hass.version: 0.7.4`, `org.opencontainers.image.title: Home Assistant App: Codex for Home Assistant`.
- 런타임 검증: `app-version: 0.7.4`, `codex --version: codex-cli 0.162.1`.
- `tests/mobile-ssh-smoke.py`: PASS (`helpers: 1, unknown: 0, canApply: True`, S6 및 SSH wrapper 프록시 부트스트랩 통과).

### 3.3 CI 모바일 SSH Smoke 타이밍 레이스 컨디션 해결
- **증상**: PR #74의 `linux/amd64 build and smoke`에서 `tests/mobile-ssh-smoke.py` line 134의 `assert execute('ha-codex-remote status').stdout == identity`가 간헐적으로 AssertionError 발생.
- **원인 분석**: 컨테이너 재시작 후 `pgrep sshd`가 참이 된 직후에 `ha-codex-remote status`를 즉시 호출하면, sshd가 `/run/sshd.pid`를 작성하거나 listening 소켓을 바인드하기 전에 실행되어 `SSH service:` 필드가 `sshd_running / listener not_checked`로 출력되어 재시작 전 상태와 불일치함.
- **수정**: `tests/mobile-ssh-smoke.py`의 재시작 대기 루프에서 `pgrep sshd && execute('ha-codex-remote status', False).stdout == identity` 조건을 폴링하도록 수정하여 타이밍 레이스를 원천 해결.
- 수정 커밋 `8efe718` 반영 후 PR #74의 모든 CI가 100% GREEN으로 통과함.

---

## 4. PR 생성 및 main 병합 내역 (§5)

1. **PR #74**: `codex/release-0.7.4` -> `main`
   - 제목: `release: 0.7.4 Stable release (promotes 0.7.4-dev.1)`
   - CI 결과: 8 checks all successful (amd64, arm64 native, App linter, code linter, unit tests, builder dry-run).
   - 병합 방식: `--merge` (머지 커밋 생성)
2. **Exact main merge SHA**:
   - **`5c62a9187c603f42bfefa1fd106af8a234938f32`**
3. **main 브랜치 CI 검증**:
   - GitHub Actions Run ID: [42965244821](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/42965244821)
   - `linux/aarch64 native build and smoke`: **SUCCESS** (4m38s)
   - `linux/amd64 build and smoke`: **SUCCESS** (7m10s)
   - `Home Assistant App config`: **SUCCESS** (11s)
   - `Lint and unit tests`: **SUCCESS** (4m19s)

---

## 5. Tag 생성, Tag Builder 파이프라인 및 GHCR 배포 (§5, §6)

### 5.1 Annotated Git Tag 생성 및 푸시
- Tag: `0.7.4`
- Commit: `5c62a9187c603f42bfefa1fd106af8a234938f32`
- Dereference 검증:
  ```bash
  $ git ls-remote --tags origin "refs/tags/0.7.4*"
  4ec581d59aaf7f51a141eb19a78a904c5c888c76	refs/tags/0.7.4
  5c62a9187c603f42bfefa1fd106af8a234938f32	refs/tags/0.7.4^{}
  ```
  (exact merge SHA와 100% 일치 확인)

### 5.2 Tag Builder 실행 및 완료
- GitHub Actions Run ID: [42966060323](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/42966060323)
- 수행 내역:
  - amd64 및 aarch64 멀티아키텍처 이미지 빌드
  - SPDX SBOM 생성 및 Go 바이너리 ID 검증
  - Critical 취약점 게이트 검증
  - Cosign 이미지 서명 및 provenance/SBOM attestation 생성
  - Multi-arch OCI Manifest 생성 및 GHCR `0.7.4` immutable 태그 프로모션
- 결과: **SUCCESS**

### 5.3 GHCR 공개 이미지 및 Manifest Digest
- **Generic Multi-arch Manifest**: `ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.4`
  - Manifest Digest: `sha256:bb1462cfea96bd018442502643227ed3bc9f3944fe84a8d6621989f81a494bc0`
- **linux/amd64 Image Digest**:
  - `sha256:f2f774eee92b7eecd5d8b4df67bfd4581d9f8e77cde08f260469bdc73e09b26f`
- **linux/arm64 Image Digest**:
  - `sha256:d64a347c7612d02bf81906d95905c9564e48c482aea6d96fea37f10c9a2bff8a`

### 5.4 공개 이미지 런타임 E2E 검증
공개된 `ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.4` 이미지를 익명 pull하여 로컬에서 검증:
- `cat /usr/local/share/codex-ha/app-version`: `0.7.4`
- `codex --version`: `codex-cli 0.162.1`
- `node codex-runtime-manager.mjs APP_VERSION`: `0.7.4`
- `tests/mobile-ssh-smoke.py`: **PASS** (`helpers: 1, unknown: 0, canApply: True`)

---

## 6. 원격 메타데이터 검증 및 GitHub Release (§5, §6)

### 6.1 익명 HTTP Raw 메타데이터 검증
Home Assistant Supervisor가 저장소 인덱싱 시 조회하는 원격 URL을 익명 HTTP로 확인:
- `https://raw.githubusercontent.com/Kanu-Coffee/codex-for-home-assistant/main/repository.yaml`:
  - `name: Codex for Home Assistant`
- `https://raw.githubusercontent.com/Kanu-Coffee/codex-for-home-assistant/main/codex_home_assistant/config.yaml`:
  - `name: Codex for Home Assistant`
  - `version: "0.7.4"`
  - `stage`: 키 생략 (Supervisor 정식 stable 규격)
  - `panel_title: Codex`
  - `image: ghcr.io/kanu-coffee/codex-for-home-assistant`

### 6.2 GitHub Release 0.7.4 발행
- URL: `https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.7.4`
- 속성 검증:
  - `isDraft`: `false`
  - `isPrerelease`: `false`
  - `latest`: `true`
  - GHCR mutable `latest` 태그는 발행하지 않음 (불변 태그 정책 준수).
- 릴리스 노트: 이슈 #71의 핵심 기능(기본 소켓 프록시 귀속, 구조화된 관측성, 2단계 데몬 수명주기, 세션 롤아웃 준비 상태), 설치 및 업그레이드 안내, 검증 내역 포함.

---

## 7. 설치 및 저장소 분리 안내

- **공식 Stable 설치/업데이트 경로**:
  ```text
  https://github.com/Kanu-Coffee/codex-for-home-assistant
  ```
  - 기존 0.7.3 설치 사용자는 Home Assistant App Store에서 별도 재설치 없이 0.7.4로 즉시 업데이트할 수 있습니다.
- **DEV 채널(`https://github.com/Kanu-Coffee/codex-for-home-assistant#dev`)과의 관계**:
  - `#dev` 브랜치는 Home Assistant 내에서 별도의 repository identity로 관리됩니다.
  - DEV 채널에서 사용하던 `/data` 및 설정은 `main` 정식 채널로 자동 마이그레이션되지 않으므로, 정식판 사용을 원할 경우 정식 저장소에서 신규 설치하거나 필요 시 백업을 활용해야 합니다.

---

## 8. 최종 결론

`FIX_08.md`의 모든 지침과 필수 Gate가 100% 충족되었으며, Stable `0.7.4` 정식 배포 및 이슈 #71(task 008)이 성공적으로 완료되었습니다.
