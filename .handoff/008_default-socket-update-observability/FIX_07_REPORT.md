# FIX_07_REPORT — 0.7.4-dev.1 준비·검증·공개 배포 완료 보고서

- 작성: 2026-11-10 (Asia/Seoul), Executor: Antigravity.
- 참조: `.handoff/008_default-socket-update-observability/FIX_07.md`.
- 상태: **배포 완료 (SUCCESS)**.
- 목표 버전: **0.7.4-dev.1** (DEV 후보).
- 공개 설치 경로: `https://github.com/Kanu-Coffee/codex-for-home-assistant#dev`.
- GitHub Prerelease: `https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.7.4-dev.1`.

---

## 1. 개요 및 실행 요약

Reviewer Codex의 `FIX_07.md` 배포 지시에 따라, 이슈 #71(기본 소켓 프록시 귀속, 업데이트 가시성/진단, 예산 경계 전이 보존)의 모든 구현 및 검증 수용 사항을 토대로 **0.7.4-dev.1 DEV 공개 배포**를 완수하였다.

| 항목 | 내용 |
| --- | --- |
| 배포 대상 버전 | `0.7.4-dev.1` |
| 대상 브랜치 | `dev` (main 브랜치 및 Stable 0.7.3 미변경) |
| Exact Merge Commit | `5ca726d087c571701eca68f61f970e8cbc7ea975` |
| Annotated Git Tag | `0.7.4-dev.1` (dereferences to `5ca726d087c571701eca68f61f970e8cbc7ea975`) |
| PR 내역 | PR #72 (구현 및 메타데이터), PR #73 (CI TUI picker 레이스 수정) |
| dev CI Run | `42785764339` (4 jobs all green: amd64, aarch64 native, linter, addon config) |
| Tag Builder Run | `42786765959` (amd64/arm64 build, SBOM, Cosign signing, attestations green) |
| GHCR 이미지 | `ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.4-dev.1` |
| GitHub Release | Prerelease `0.7.4-dev.1` (`isPrerelease: true`, `isDraft: false`) |

---

## 2. DEV 메타데이터 정합성 및 계약 일치 (§3)

Home Assistant 공식 App configuration 및 저장소 표준에 따라 모든 DEV 메타데이터를 일관되게 정합화하였다.

1. **App 및 저장소 메타데이터**:
   - `codex_home_assistant/config.yaml`:
     - `name: Codex for Home Assistant (DEV)`
     - `version: "0.7.4-dev.1"`
     - `description: "[DEV] Open-source AI pair programmer for Home Assistant with web terminal, SSH, and supervisor automation"`
     - `stage: experimental`
     - `panel_title: Codex DEV`
   - `repository.yaml`: `name: Codex for Home Assistant (DEV)`
   - `codex_home_assistant/Dockerfile`:
     - `ARG BUILD_VERSION=0.7.4-dev.1`
     - OCI Labels: `io.hass.name="Codex for Home Assistant (DEV)"`, `org.opencontainers.image.title="Codex for Home Assistant (DEV)"`, `org.opencontainers.image.description="[DEV] ..."`
   - `codex_home_assistant/rootfs/etc/motd`: `Codex for Home Assistant (DEV)`
2. **런타임 및 의존성 버전**:
   - `codex_home_assistant/playwright/package.json` & `package-lock.json`: `"version": "0.7.4-dev.1"`
   - `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`: `APP_VERSION = "0.7.4-dev.1"`
3. **문서 및 CHANGELOG**:
   - `codex_home_assistant/CHANGELOG.md`: `## [0.7.4-dev.1] - 2026-11-10` 섹션 분리 및 #71 주요 기능 반영.
   - `README.md`, `README.en.md`, `codex_home_assistant/README.md`, `codex_home_assistant/README.en.md`: 상단에 DEV 채널 안내 배너 추가.
4. **테스트 계약 갱신**:
   - `tests/test_addon_contract.py`: `test_development_candidate_is_visible_in_home_assistant_and_image` 단언을 DEV 명칭/버전/stage 규격에 맞게 갱신.
   - `tests/test_codex_update_contract.py`: `appVersion == "0.7.4-dev.1"` 반영.

---

## 3. 검증 결과 및 CI 레이스 수정 (§4)

### 3.1 로컬 전체 pytest suite 실행
공식 바이너리 3종(`0.162.1`, `0.166.0`, `0.167.0`)을 연결한 환경에서 전체 테스트를 수행하였다.
- 환경 변수:
  - `CODEX_WIRE_PROBE_BINARY=/home/lee/projects/codex_for_HA/.test-tmp/candidate-167/bin/codex`
  - `CODEX_HANDOVER_BASELINE=/home/lee/projects/codex_for_HA/.test-tmp/task007-baseline/bin/codex`
  - `CODEX_HANDOVER_CANDIDATE=/home/lee/projects/codex_for_HA/.test-tmp/candidate-167/bin/codex`
- 실행 결과: **337 passed, 1 skipped in 189.84s (100% PASS)**
  - (1 skipped: `test_playwright_mcp_starts_and_reports_healthy` - MCP binary 미설치 환경의 의도된 skip)
- 정적 검사:
  - `node --check`: PASS
  - `git diff --check`: PASS
  - `tests/test_secret_scan.py`: PASS (비밀값 누출 0건)

### 3.2 TUI Session Picker 레이스 컨디션 발견 및 해결 (PR #73)
- **증상**: dev CI run `42783428824` 중 느린 CI runner 환경에서 `test_codex_live_handover.py:175`의 `test_real_worker_handover[tui_resume]`가 간헐적으로 `No results for your search`로 실패.
- **원인 분석**: `Resume a previous session` 타이틀만 확인하고 즉시 `\r`을 입력할 경우, 백그라운드 세션 목록 로드(`Loading sessions...`) 중에 엔터가 소진되어 세션이 선택되지 않고 검색창에 `resumed-marker`가 타이핑됨.
- **수정**: `(b'first-marker' in screen or b'1 / 1' in screen)` 조건까지 기다려 목록이 완전히 렌더링된 후 `\r`을 전송하고 피커가 닫힐 때까지 대기하도록 강화.
- PR #73으로 dev에 신속히 병합하여 이후 CI 전체가 안정적으로 green을 유지함을 확인.

---

## 4. PR 생성 및 병합 내역 (§5)

1. **PR #72**: `feat/issue-71-default-socket-observability` -> `dev`
   - 내용: Default socket proxy attribution, update observability, and prepare 0.7.4-dev.1
   - CI: 12 checks all successful.
   - 병합 커밋: `a6e0f3fdfd576319547fdc91848a6231a0978bb6`
2. **PR #73**: TUI session picker race condition fix in live handover test -> `dev`
   - 내용: `test_codex_live_handover.py` 안정화
   - CI: 8 checks all successful.
   - 병합 커밋: `5ca726d087c571701eca68f61f970e8cbc7ea975`
3. **Exact dev HEAD**:
   - `git rev-parse origin/dev`: `5ca726d087c571701eca68f61f970e8cbc7ea975`

---

## 5. Tag 생성, dev CI 및 Builder 파이프라인 (§5)

### 5.1 dev 브랜치 CI 검증
- GitHub Actions Run ID: `42785764339` (commit `5ca726d`)
- 세부 결과:
  - `test (linux/amd64)`: **SUCCESS**
  - `test-arm64 (linux/arm64, native self-hosted)`: **SUCCESS**
  - `linter`: **SUCCESS**
  - `addon-config-validation`: **SUCCESS**

### 5.2 Annotated Git Tag 생성 및 푸시
- Tag: `0.7.4-dev.1`
- Dereference 확인:
  ```bash
  $ git rev-parse refs/tags/0.7.4-dev.1^{}
  5ca726d087c571701eca68f61f970e8cbc7ea975
  ```
  (dev HEAD와 100% 일치)

### 5.3 Tag Builder 실행 및 완료
- GitHub Actions Run ID: `42786765959`
- 수행 내용:
  - amd64 및 arm64 Docker 이미지 빌드
  - SBOM (Software Bill of Materials) 생성
  - Cosign 이미지 서명 및 GitHub Attestation 생성
  - Multi-arch OCI Manifest 생성 및 GHCR 배포
- 결과: **SUCCESS**

---

## 6. 공개 배포 산출물 및 검증 (§6)

### 6.1 GHCR 이미지 및 Manifest
- **Generic Multi-arch Manifest**: `ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.4-dev.1`
  - Digest: `sha256:71d9d9f5ba7d3ee8242f3ea0d832d201a052ff37c8ee100fcce7ce4358a98bf6`
- **amd64 이미지 Digest**:
  - `sha256:2a531927e879eea5f607cdcb9569d37ad3dd8c1165ec2b6578a54c1be3823889`
- **arm64 이미지 Digest**:
  - `sha256:a2f5273e43ce706fc4a6436361708630250d271363161fbd6d9cbe73468666bb`

### 6.2 배포된 이미지 런타임 검증
배포된 amd64 이미지를 pull하여 컨테이너 환경에서 검증 완료:
- `codex --version`: `codex-cli 0.162.1`
- `codex-runtime-manager.mjs app-version`: `0.7.4-dev.1`
- OCI Labels:
  - `io.hass.name`: `Codex for Home Assistant (DEV)`
  - `io.hass.version`: `0.7.4-dev.1`
  - `io.hass.type`: `addon`

### 6.3 익명 HTTP 원격 메타데이터 검증
Home Assistant Supervisor가 저장소를 추가할 때 접근하는 raw URL을 익명 HTTP로 조회하여 정상 응답 및 내용을 확인:
- `https://raw.githubusercontent.com/Kanu-Coffee/codex-for-home-assistant/dev/repository.yaml`:
  - `name: 'Codex for Home Assistant (DEV)'`
- `https://raw.githubusercontent.com/Kanu-Coffee/codex-for-home-assistant/dev/codex_home_assistant/config.yaml`:
  - `name: 'Codex for Home Assistant (DEV)'`
  - `version: '0.7.4-dev.1'`
  - `stage: 'experimental'`
  - `panel_title: 'Codex DEV'`

### 6.4 GitHub Prerelease
- URL: `https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.7.4-dev.1`
- 설정: `isPrerelease: true`, `isDraft: false`, Stable latest 아님.
- 릴리스 노트: 이슈 #71의 핵심 기능(default socket proxy attribution, 2단계 일일 예산, 가시성/진단 엔드포인트), DEV 설치 안내 및 운영 시 주의사항 포함.

---

## 7. 설치 및 저장소 분리 안내

- **공개 DEV 설치 경로**:
  ```text
  https://github.com/Kanu-Coffee/codex-for-home-assistant#dev
  ```
- **저장소 식별자 분리 안내**:
  - `main` 브랜치(공식 Stable 0.7.3)와 `#dev` 브랜치는 Home Assistant 내에서 별도의 저장소 식별자로 취급됩니다.
  - Stable 0.7.3의 기존 `/data` 및 설정은 `#dev` 설치본으로 자동 마이그레이션되지 않으므로, 테스트 목적의 독립 설치를 권장합니다.
  - 기존 Stable 0.7.3과 충돌 없이 공존하거나 별도 테스트 인스턴스에서 검증할 수 있습니다.

---

## 8. 잔여 미검증 Gate (NOT RUN)

`FIX_07.md` 지침에 따라 아래 항목은 현재 단계에서 수행하지 않았으며, 후속 Gate로 명시합니다.

1. **실제 물리 HAOS 기기 및 Raspberry Pi 실기 수용**:
   - **상태: NOT RUN**.
   - 공개된 `https://github.com/Kanu-Coffee/codex-for-home-assistant#dev`를 통해 사용자가 실제 HAOS 기기에서 Store 노출, 설치, Ingress/SSH 진입, 기본 소켓 연결 및 업데이트 상태 조회를 검증할 예정.
2. **main 브랜치 병합 및 Stable 0.7.4 정식 릴리스**:
   - **상태: NOT RUN**.
   - DEV 채널 실기 수용 및 사용자 최종 승인 전까지 `main` 브랜치는 Stable 0.7.3을 유지하며, 별도 사용자 지시에 따라 정식 릴리스 승격 절차를 진행함.
