# FIX_16_REPORT — DEV 0.7.3-dev.1 실제 공개 배포 및 검증 완료 보고

## 1. 개요 및 요약

- **작업자:** Executor (Antigravity), 2026-10-29.
- **기준 handoff:** `.handoff/006_idle-gated-runtime-server-update/FIX_16.md` (Reviewer: Codex).
- **판정 및 목표:**
  - FIX_15에서 완료된 상태표시 수정, 회귀 테스트 및 DEV 메타데이터를 기반으로 **실제 DEV 0.7.3-dev.1 릴리스 게시 완료**.
  - PR/CI, non-publishing Builder, dev 브랜치 병합, dev CI, publishing Builder, Cosign 서명, SPDX SBOM/attestation, 멀티아키 GHCR 이미지 푸시, GitHub DEV Prerelease 게시 전 과정 완결.
  - 사용자가 Home Assistant `#dev` 저장소를 통해 설치 및 실기기 시험을 진행할 수 있도록 배포 정보와 인수 시험 절차 전달.

---

## 2. 배포 세부 정보 및 증거

### 2.1 릴리스 식별자
- **DEV 버전:** `0.7.3-dev.1`
- **Annotated Git Tag:** `0.7.3-dev.1`
- **Source Commit:** [`8e0cab75299bc633b827b9bff3dcbbffde20fe89`](https://github.com/Kanu-Coffee/codex-for-home-assistant/commit/8e0cab75299bc633b827b9bff3dcbbffde20fe89) (Merge commit on `dev`)
- **PR 브랜치:** `codex/release-0.7.3-dev.1` (Commit: `a22de8d7a7c73ffbb77b8b204e38ba88d44747c3`)

### 2.2 PR, CI 및 Builder 실행 URL
1. **GitHub Pull Request:**
   - [PR #59: release: prepare 0.7.3-dev.1 idle-gated runtime server update and session host relay](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/59) (Merged into `dev`)
2. **PR Checks (CI & non-publishing Builder):**
   - [PR #59 Workflow Runs](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/59/checks):
     - `CI/Home Assistant App compatibility`: PASS (15s)
     - `CI/Lint and unit tests`: PASS (2m 14s)
     - `Builder/Validate release candidate`: PASS (6s)
     - `CI/linux/aarch64 native build and smoke`: PASS (4m 5s)
     - `CI/linux/amd64 build and smoke`: PASS (6m 36s)
     - `Builder/Build codex_home_assistant (amd64 / aarch64 SBOM & Vuln gate)`: PASS (3m 51s)
     - 전체 8개 작업 성공 (0 실패).
3. **Dev Branch Merge CI:**
   - [CI Run 40826178307](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/40826178307):
     - `linux/aarch64 native build and smoke`: PASS (4m 6s)
     - `Home Assistant App config`: PASS (16s)
     - `linux/amd64 build and smoke`: PASS (6m 36s)
     - `Lint and unit tests`: PASS (2m 19s)
     - 전체 성공.
4. **Publishing Builder (Release Tag Triggered):**
   - [Builder Run 40826859164](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/40826859164):
     - `Validate release metadata`: PASS (5s)
     - `Build and publish aarch64 image`: PASS (6m 9s) (SBOM 생성, Go 바이너리 검증, Critical 게이트 통과, Cosign 서명, Provenance/SBOM attestation, staging image 푸시)
     - `Build and publish amd64 image`: PASS (6m 8s) (SBOM 생성, Go 바이너리 검증, Critical 게이트 통과, Cosign 서명, Provenance/SBOM attestation, staging image 푸시)
     - `Publish multi-arch manifest`: PASS (1m 18s) (Cosign 서명, multi-arch provenance attestation, 0.7.3-dev.1 태그 프로모션)
     - 전체 성공.
5. **GitHub Release:**
   - [GitHub Release 0.7.3-dev.1](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.7.3-dev.1) (Prerelease 공개 완료)

---

## 3. 발행된 멀티아키 이미지 및 공개 검증

### 3.1 이미지 다이제스트 (GHCR)
`docker buildx imagetools inspect ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.3-dev.1` 확인 결과:
- **Generic Multiarch Manifest Digest:**
  ```text
  sha256:27920e6e31711c8613c5984fca71fe79ce59584f4a48dbb693131915e5920503
  ```
- **Platform linux/amd64 Digest:**
  ```text
  sha256:cd60976448b508cdcfa27dd9435f964d3e7a6dfc14303e4495e9e5bca0f57523
  ```
- **Platform linux/arm64 Digest:**
  ```text
  sha256:0267d327a33544e13d623a9196a57112b0c360105a68ee4304c12c501868bdb4
  ```

### 3.2 공급망 보안 및 서명
- **SPDX SBOM:** amd64 및 aarch64 아키텍처별로 생성되어 GitHub Actions artifact 및 attestation으로 게시됨.
- **취약점 게이트:** Critical 레벨 취약점 0건 차단 통과 (비차단 High 경고는 보고서 보존).
- **Cosign 서명:** exact tag `0.7.3-dev.1`, GitHub Actions OIDC 토큰(`https://token.actions.githubusercontent.com`)을 통해 발행되어 이미지 다이제스트에 연결됨.
- **Provenance Attestation:** SLSA Provenance attestation 발행 완료.

---

## 4. 로컬 검증 결과

- **전체 pytest 회귀 테스트 스위트:** `268 passed, 1 skipped in 118.52s` (0 failures).
- **Addon 채널 계약 테스트:** `tests/test_addon_contract.py` 19/19 통과 (DEV 0.7.3-dev.1 메타데이터 완벽 일치).
- **구문 및 정적 분석:**
  - `node --check codex_home_assistant/rootfs/usr/local/share/codex-ha/*.mjs`: PASS
  - `bash -n codex_home_assistant/rootfs/usr/local/bin/* tests/*.sh`: PASS
  - `git diff --check`: PASS

---

## 5. 미수행 및 수용 경계 (NOT RUN)

- **NOT RUN 항목:**
  - 실제 Home Assistant OS (HAOS) 운영 장치에서의 Store 노출 및 자동 업데이트 설치 실행.
  - 실제 HAOS 상에서의 24시간 자동 스케줄러 4회 슬롯 전체 주기 관측.
  - 모바일 SSH 클라이언트를 통한 실기기 장시간 연결 시험.
  - 물리 Raspberry Pi 등 실제 aarch64 하드웨어 보드에서의 live update.
- **안전 보장:**
  - `main` 브랜치는 건드리지 않고 원본 stable 0.7.2 유지.
  - 사용자 운영 장치의 자동 강제 업데이트나 임의 재시작 미수행.

---

## 6. 사용자 DEV 운영시험 인수 안내

`0.7.3-dev.1` 이미지가 GHCR에 정상 배포되었으므로, 사용자는 다음 절차에 따라 Home Assistant 실기기 시험을 진행할 수 있습니다:

1. **저장소 확인:**
   - Home Assistant Add-on Store의 Repository에 Canary 저장소가 등록되어 있는지 확인:
     `https://github.com/Kanu-Coffee/codex-for-home-assistant#dev`
   - Store 우측 상단 "새로고침(Reload)"을 실행하여 `Codex for Home Assistant (DEV)`의 버전이 **`0.7.3-dev.1`**로 표시되는지 확인.
2. **업데이트 설치:**
   - `0.7.3-dev.1`로 업데이트를 실행하고, 시작 후 Ingress Web Terminal 및 SSH 접속 정상 확인.
3. **유휴 세션 전환 관측:**
   - 대화형 CLI (`codex`) 또는 Remote stdio 세션을 연결한 상태에서 백그라운드 활성 작업이 없을 때:
     - 수동: 터미널에서 `ha-codex-update apply` 실행.
     - 자동: 다음 4회 주기 슬롯(03:00, 09:00, 15:00, 21:00)까지 대기.
   - 기존 터미널 창과 세션이 끊기지 않고 백엔드 워커 프로세스의 running 버전이 신버전으로 전환되는지 확인 (`ha-codex-update status`로 selected 및 running 버전 일치 확인).
4. **문맥 보존 확인:**
   - 전환 완료 후 동일한 창에서 후속 프롬프트를 입력하여 이전 대화 문맥이 보존된 상태로 답변이 생성되는지 확인.
5. **활성 작업 중 보호 확인:**
   - 모델 응답 생성 중이거나 도구 승인 대기 중일 때 업데이트가 적용되지 않고 안전하게 보류되는지 확인.
6. **인증 및 데이터 보존:**
   - App 일반 재시작 후에도 `/data` 영속 볼륨의 인증(`auth.json`) 및 대화 기록이 정상 보존되는지 확인.
