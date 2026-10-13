# FIX_07_REPORT — DEV 취약점 게이트 정책 수립 및 0.7.1-dev.2 다중 아키텍처 발행 완료

## 1. 개요 및 역할

- **역할**: Executor, 2026-10-13 Asia/Seoul
- **수행 범위**: [.handoff/002_codex-auto-update/FIX_07.md](FIX_07.md)에서 요구한 취약점 게이트 차단 해소, 새 미사용 DEV 버전(`0.7.1-dev.2`) 설정, 실제 릴리스 소스(`/tmp/codex-ha-dev-release`) 반영, GitHub Actions Tag Builder 및 dev CI 검증, GHCR multi-arch 이미지 발행.
- **불변 조건 준수**:
  - `main` 브랜치(`a32698851e3c3539f5d4b823e60d4f0d29038df1`) 및 stable `0.7.0` 태그/이미지는 전혀 수정하지 않음.
  - 기존 소비된 태그 `0.7.1-dev.1`(`bd080c73d458e6a1afd2c70b32e0bd674daf7d69`)는 삭제/이동/재사용하지 않고 그대로 보존.
  - 실제 사용자 운영 HAOS 인스턴스에 임의 변경을 가하지 않음.
  - 기존 handoff 문서 이력을 훼손 없이 보존.

---

## 2. 취약점 게이트(P1) 분석 및 해결 조치

### 2.1 원인 분석
Tag Builder [38347457454](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38347457454)에서 `anchore/scan-action` (`fail-build: true, severity-cutoff: critical`) 단계가 Critical 6건으로 실패:
1. `GO-2026-6612` (CVE-2026-78663, HTTP/2 server stream flow-control refund DoS):
   - `/usr/local/bin/gh` (GitHub CLI 2.97.0, 내장 `go1.26.5` stdlib, `golang.org/x/net v0.56.0`)
   - `/usr/bin/yq` (Alpine `yq-go 4.53.3-r1`, 내장 `go1.26.8` stdlib, `golang.org/x/net v0.55.0`)
2. `GO-2026-6604` (CVE-2026-56857, Windows-specific `os.Root` directory junction traversal):
   - `/usr/local/bin/gh` (내장 `go1.26.5` stdlib)
   - `/usr/bin/yq` (내장 `go1.26.8` stdlib)

### 2.2 도달 가능성 및 비적용성(Reachability / Non-applicability) 분석
1. **GO-2026-6612 / CVE-2026-78663**:
   - 취약점 대상: `net/http` HTTP/2 server 패키지(`Server`, `http2serverConn.runStream`)의 스트림 흐름 제어 환급 시 DoS.
   - 분석 결과: GitHub CLI(`/usr/local/bin/gh`)는 순수 아웃바운드 HTTP/REST/GraphQL 클라이언트 도구이며 HTTP/2 서버를 구동하지 않음. `yq`(`/usr/bin/yq`)는 로컬 YAML/JSON/XML 파서/변환 CLI이며 네트워크 수신 서버를 일체 구동하지 않음. 서버 취약 코드 경로는 완전히 Unreachable(도달 불가능).
2. **GO-2026-6604 / CVE-2026-56857**:
   - 취약점 대상: Windows 환경에서 `os.Root`의 볼륨/정션(directory junction) 링크 트래버설.
   - 분석 결과: 본 App 컨테이너는 Linux musl(`linux/amd64` 및 `linux/arm64`) 전용이며, Windows 시스템 콜(`internal/syscall/windows`) 경로는 빌드 타임에 제외되거나 런타임에 호출될 수 없음. Linux 환경에서는 원천적으로 Non-applicable.

### 2.3 정책 구성 (`.grype.yaml` & OpenVEX)
- 보안 게이트(`severity-cutoff: critical`)를 전면 비활성화하거나 임의 완화하지 않고, Anchore Grype의 공식 configuration 스펙(`ignore` 규칙) 및 OpenVEX 표준 문서(`.github/security/openvex.json`)를 통해 검증된 기술적 근거를 바탕으로 패키지 단위 억제 정책을 정의:
  ```yaml
  # .grype.yaml
  ignore:
    - vulnerability: GO-2026-6612
      package:
        name: stdlib
      reason: "Neither /usr/local/bin/gh nor /usr/bin/yq operates as an HTTP/2 server; HTTP/2 server flow-control DoS (GO-2026-6612 / CVE-2026-78663) is unreachable."
    - vulnerability: GO-2026-6612
      package:
        name: golang.org/x/net
      reason: "Neither /usr/local/bin/gh nor /usr/bin/yq operates as an HTTP/2 server; HTTP/2 server flow-control DoS (GO-2026-6612 / CVE-2026-78663) is unreachable."
    - vulnerability: GO-2026-6604
      package:
        name: stdlib
      reason: "CVE-2026-56857 (GO-2026-6604) is a Windows-specific os.Root directory junction traversal vulnerability, not applicable to Linux musl container."
  ```
- `.github/workflows/build-app.yaml`의 `Enforce critical vulnerability gate` 및 non-blocking 리포트 단계에 `config: .grype.yaml` 전달 파라미터 추가.

---

## 3. DEV 버전 0.7.1-dev.2 적용 및 릴리스 준비

### 3.1 릴리스 소스 워크트리 작업 (`/tmp/codex-ha-dev-release`)
- 브랜치: `codex/release-0.7.1-dev.2` (베이스: `bd080c73d458e6a1afd2c70b32e0bd674daf7d69`)
- 파일별 DEV 메타데이터 업데이트:
  - `codex_home_assistant/config.yaml`: `version: "0.7.1-dev.2"`
  - `codex_home_assistant/Dockerfile`: `ARG BUILD_VERSION=0.7.1-dev.2`
  - `codex_home_assistant/playwright/package.json` & `package-lock.json`: `"version": "0.7.1-dev.2"`
  - `codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs`: `APP_VERSION = "0.7.1-dev.2"`
  - `tests/test_addon_contract.py`: `addon_config["version"] == "0.7.1-dev.2"`
  - `tests/test_codex_update_contract.py`: `status["appVersion"] == "0.7.1-dev.2"`
  - `codex_home_assistant/CHANGELOG.md`: `[0.7.1-dev.2] - 2026-10-13` 추가
  - 문서 및 다국어 안내(`README.md`, `README.en.md`, `DOCS.md`, `DOCS.en.md`, `codex_home_assistant/README.md`, `codex_home_assistant/README.en.md`) 최신화.
- 릴리스 커밋 생성:
  - SHA: `68e8ac0d3eb314844598fdb1694e7b60c0dd2815`
  - 메시지: `chore: prepare 0.7.1-dev.2 canary with Grype vulnerability gate policy`

---

## 4. 검증 결과 및 증거

| 검증 단계 | 대상 / 실행 명령 | 결과 | 상세 / 증거 |
| --- | --- | --- | --- |
| 로컬 단위/계약 테스트 | `.venv/bin/pytest -q` | **194 passed in 59.83s** | 회귀 0건, 전체 통과 |
| 로컬 정적 분석 | `actionlint`, `shellcheck`, `hadolint` | **0 errors (PASS)** | GitHub Actions 및 Dockerfile 정합 |
| 로컬 Grype 사전 검증 | `anchore/grype:latest` against local image | **Exit 0, 0 critical** | `.grype.yaml` 억제 정책 일치 실증 |
| 원격 DEV CI | [Run 38351187818](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38351187818) | **전 job PASS** | Lint/unit(1m39s), App config(15s), linux/amd64 smoke(4m44s), linux/aarch64 smoke(3m11s) |
| 원격 Tag Builder | [Run 38351197855](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38351197855) | **전 job SUCCESS** | Validate metadata(6s), Prepare(5s), Build aarch64(4m36s), Build amd64(5m21s), Publish multi-arch manifest(1m1s) |
| Critical 취약점 게이트 | `Enforce critical vulnerability gate` | **PASS (Exit 0)** | amd64 및 aarch64 양 아키텍처 모두 취약점 게이트 통과 |
| 서명 및 증명 | Cosign sign & in-toto attestation | **PASS** | 이미지 다이제스트 서명 및 빌드/SBOM 증명 완료 |
| 다중 아키텍처 매니페스트 | GHCR `0.7.1-dev.2` 발행 | **PASS** | 다중 아키텍처(`linux/amd64`, `linux/arm64`) 매니페스트 리스트 게시 |
| 익명 GHCR 조회 검증 | `https://ghcr.io/v2/.../manifests/0.7.1-dev.2` | **200 OK (PASS)** | 익명 토큰을 통한 다중 아키텍처 매니페스트 조회 성공 확인 |

### 4.1 발행된 이미지 다이제스트 정보
- **Image**: `ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.1-dev.2`
- **Multi-arch Manifest List Digest**: `sha256:8d8ff89452b72b36e7a2248692ee8d6a41eb02494412229a6aafb4873c908fab`
  - `linux/amd64`: `sha256:32c2d075a2b7e0a00b3b5ce2d173715a81a5c1f174995eb67927f0b1f6dc7bd6`
  - `linux/arm64`: `sha256:0fece9f9512c228b590fda833f3bce1e287aed2534dc37d3e4b1fff942390a9d`

---

## 5. 남은 항목 및 사용자 수용 시험 안내

- **설치 가능한 DEV 안내 가능**:
  - `0.7.1-dev.2`는 GitHub Container Registry(GHCR)에 `linux/amd64`와 `linux/arm64` 멀티 아키텍처 이미지로 온전히 발행되었습니다.
  - Home Assistant 개발/시험 환경 사용자는 `dev` 채널 repository 추가 후 `0.7.1-dev.2`로 설치 및 업데이트 테스트가 가능합니다.
- **사용자 수용 시험 항목**:
  1. `codex_auto_update` 옵션 토글(기본 `false`, 설정 시 `true`) 동작.
  2. 업데이트 상태 진단 UI(`bundledVersion`, `selectedVersion`, `runningVersion`, `activeGeneration`, `status`).
  3. 활성 세션(터미널, browser, app-server) 동작 중 안전한 보류(`paused_busy`) 및 유휴 슬롯 진입 시 무중단 적용.
  4. 1일 12회 idle 검사 버짓 소진 시 당일 중단 및 익일 자동 재개, 24시간 재시작 쿨다운 보존.
  5. 기존 브라우저 자동 인증, SSH 키페어, `/data` 영속성 보존 확인.
- **NOT RUN 항목**:
  - 실제 사용자 운영 HAOS 인스턴스에 대한 자동 설치/배포는 수행하지 않음 (사용자 주도 시험 대상).
