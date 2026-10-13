# FIX_09_REPORT — Fail-Closed 바이너리 식별 사전 검증 게이트 구축 및 DEV 0.7.1-dev.5 발행 완료

## 1. 개요 및 역할

- **역할**: Executor, 2026-10-13 Asia/Seoul
- **수행 범위**: [.handoff/002_codex-auto-update/FIX_09.md](FIX_09.md)의 P1(동일 버전을 사용하는 미검토 바이너리에 대한 예외 승계 차단 및 exact artifact 경계 확립)과 P2(실제 Grype 스캐너 및 경계 조건 계약 검증 체계 구축)를 전수 해결하고 신규 DEV 버전(`0.7.1-dev.5`)을 발행함.
- **불변 조건 준수**:
  - `main` 브랜치(`a32698851e3c3539f5d4b823e60d4f0d29038df1`) 및 stable `0.7.0` 태그/이미지는 일체 변경하지 않음.
  - 이미 소비된 태그 `0.7.1-dev.1`, `0.7.1-dev.2`, `0.7.1-dev.3`, `0.7.1-dev.4`는 삭제·이동·재사용하지 않고 원본 그대로 보존함.
  - 실제 사용자 운영 HAOS 인스턴스에 임의 변경을 가하지 않음.
  - 기존 handoff 문서 이력을 훼손 없이 보존함.

---

## 2. 해결 내용

### 2.1 P1: Fail-Closed 바이너리 식별 사전 검증 게이트 구축 (`.github/scripts/sbom-go-binary-preflight.py`)

- **결함 분석**: 기존 `.grype.yaml` 및 `openvex.json`은 Go 모듈 PURL 및 패키지 버전(`stdlib go1.26.5`, `golang.org/x/net v0.56.0` 등)만을 대조하여, 동일한 Go 버전을 사용하는 `/opt`의 미검토 서버 바이너리가 이미지에 추가되더라도 예외 정책이 무차별 적용되어 게이트를 우회할 수 있었음.
- **구현 조치**:
  1. **Fail-Closed 사전 검증 스크립트 구축** ([`.github/scripts/sbom-go-binary-preflight.py`](file:///home/lee/projects/codex_for_HA/.github/scripts/sbom-go-binary-preflight.py)):
     - 생성된 SPDX JSON SBOM의 모든 Go 모듈 `sourceInfo`에서 호스팅 바이너리 경로를 추출.
     - 오직 명시적으로 검토된 허용 목록(`REVIEWED_GO_BINARY_PATHS = {'/usr/local/bin/gh', '/usr/bin/yq'}`) 내의 바이너리만 허용.
     - 미검토 바이너리(예: `/opt/some-server`, `/opt/review08-http2-server` 등) 감지 시 즉시 **Exit 1**로 빌드를 전면 중단(Fail-Closed).
     - 검토 대상 바이너리별 모듈 및 버전 무결성 검증:
       - `/usr/local/bin/gh`: `stdlib` 정확히 `go1.26.5`, `golang.org/x/net` 정확히 `v0.56.0`.
       - `/usr/bin/yq`: `stdlib` 정확히 `go1.26.8`, `golang.org/x/net` 정확히 `v0.55.0`.
       - 변조되거나 미검토된 버전(예: `go1.26.7`) 발견 시 즉시 **Exit 1** 차단.
     - 아티팩트 루트 문서명(`name`) 및 `documentNamespace` 식별자 누락 시 즉시 차단.
  2. **정적 전역 일괄 예외 제거 (`.grype.yaml`)**:
     - 루트 [`.grype.yaml`](file:///home/lee/projects/codex_for_HA/.grype.yaml)의 정적 ignore 규칙을 전면 비우고 `ignore: []`로 fail-closed 기준점 확립.
     - 사전 검증 스크립트를 거치지 않은 임의의 Grype 실행이나 사전 검증 실패 시, 전역 탐색에 의한 예외 우회가 불가능하도록 원천 차단.
  3. **동적 게이트 정책 생성 연동 (`.github/workflows/build-app.yaml`)**:
     - SBOM 생성 직후 `Validate Go binary identities in SBOM before vulnerability scanning` 단계 실행.
     - 사전 검증 통과 시에만 exact 바이너리 검증 근거가 바인딩된 한정 정책(`.grype-gated-${arch}.yaml` 및 `openvex-gated-${arch}.json`)을 동적으로 생성하여 `scan-action`에 전달.

### 2.2 P2: 실제 Grype 스캐너 및 전체 경계 계약 회귀 테스트 체계 구축

- **실제 스캐너 및 결과 계약 테스트 구축** ([`tests/test_vulnerability_gate_policy.py`](file:///home/lee/projects/codex_for_HA/tests/test_vulnerability_gate_policy.py)):
  - 단순 Python 문자열 비교 함수를 배제하고, 실제 서브프로세스로 사전 검증 스크립트 및 Grype 스캐너를 구동하여 Exit Code를 엄격히 검증.
  - 합성 SPDX SBOM 테스트 픽스처 4종 생성 ([`tests/fixtures/sbom_vuln_gate/`](file:///home/lee/projects/codex_for_HA/tests/fixtures/sbom_vuln_gate/)):
    - `sbom-reviewed-only.spdx.json`: 검토된 바이너리만 포함 -> 사전 검증 Exit 0, 동적 정책 생성, 실제 Grype 스캔 **Exit 0 (PASS, suppressed 표시)**.
    - `sbom-unreviewed-binary.spdx.json`: 검토 바이너리 + `/opt/some-server` -> 사전 검증 **Exit 1 (FAIL)**, 동적 정책 미생성, 베이스라인 스캔 시 **Exit 2 (FAIL)**.
    - `sbom-mutated-version.spdx.json`: 허용 경로지만 `stdlib go1.26.7` 변조 -> 사전 검증 **Exit 1 (FAIL)**, 실제 Grype 스캔 시 **Exit 2 (FAIL, Critical 발견)**.
    - `sbom-no-go.spdx.json`: Go 바이너리 없는 비-Go 이미지 베이스라인 -> 사전 검증 **Exit 0 (PASS)**.
    - `anonymous.spdx.json`: 문서 식별자 누락 -> 사전 검증 **Exit 1 (FAIL)**.
    - Reviewer의 retargeted 픽스처(`/tmp/codex-ha-review09/retargeted.spdx.json`, `/opt/review08-*` 경로) 대조 -> 사전 검증 **Exit 1 (FAIL)** 실증.
  - 격리 모드 검증:
    - 사전 검증 없는 원본(raw) / 기본 `.grype.yaml` 스캔 시 항상 **Exit 2**로 취약점이 차단됨을 실증.

| 대조군 | 기대 결과 | 실제 검증 결과 |
| --- | --- | --- |
| 검토한 exact artifact와 유효한 identity·근거 | 필요한 비적용 finding만 제외 가능 | **Exit 0 (PASS, 6건 suppressed 표시)** |
| module 이름·버전 유지, binary를 `/opt`의 미검토 경로로 변경 | gate/preflight 실패 | **Exit 1 (FAIL, 게이트 차단 및 정책 미발급)** |
| 같은 module 버전의 미검토 server binary 추가 | 실패 | **Exit 1 (FAIL)** |
| 허용 경로지만 module 버전 변경 (`go1.26.7`) | 실패 | **Exit 1 (Preflight) / Exit 2 (Grype)** |
| product/image identity 또는 필수 metadata 누락 | 실패 | **Exit 1 (FAIL)** |
| raw / ignore-only / VEX-only / combined 격리 | 어느 예외 경로도 미검토 component를 숨기지 않음 | **PASS (기본 설정 ignore: [] fail-closed)** |

---

## 3. 로컬 테스트 및 검증 결과

- **취약점 게이트 계약 테스트**:
  - `uv run pytest tests/test_vulnerability_gate_policy.py -v`: **10 passed in 8.36s** (실제 Grype 스캐너 음성 대조군 포함).
- **전체 단위/통합 테스트**:
  - `uv run pytest -q`: **204 passed in 66.69s**.
- **정적 분석**:
  - `actionlint`: **PASS** (오류 0건).
  - `git diff --check`: **PASS** (공백/포맷 오류 0건).
  - `shellcheck`: **PASS** (테스트 픽스처 파이썬 shebang 제거로 shellcheck 정상 통과).

---

## 4. DEV 태그 및 발행 결과 (`0.7.1-dev.5`)

- **미사용 신규 DEV 버전 선택**:
  - 기존 태그 `0.7.1-dev.1` ~ `0.7.1-dev.4` 보존.
  - 신규 태그: **`0.7.1-dev.5`**.
- **커밋 및 브랜치**:
  - 릴리스 워크트리(`/tmp/codex-ha-dev-release`) 브랜치 `codex/release-0.7.1-dev.5`, 릴리스 커밋 `2c9cad274b781bb856703914f1c4af3176cb1547`, CI 픽스 커밋 `40559dbbaf69d17d94d10918fc673335eb9ff927`.
  - 원격 `origin/dev` 및 태그 `0.7.1-dev.5` 푸시 완료.
- **GitHub Actions 원격 검증 결과**:
  1. **Tag Builder run [38365844933](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38365844933)**: **ALL JOBS SUCCESS**
     - `Validate release metadata`: **SUCCESS** (6s)
     - `Prepare`: **SUCCESS** (8s)
     - `Build amd64 image`: **SUCCESS** (5m22s) — Preflight PASS, Grype gate PASS, Cosign 서명 PASS, Attestation PASS
     - `Build aarch64 image`: **SUCCESS** (4m38s) — Preflight PASS, Grype gate PASS, Cosign 서명 PASS, Attestation PASS
     - `Publish multi-arch manifest`: **SUCCESS** (33s) — 매니페스트 생성, Cosign 서명, 프로모션 완료
  2. **dev CI run [38366256596](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38366256596)**: **ALL JOBS PASS**
     - `Lint and unit tests`: **SUCCESS** (1m42s)
     - `Home Assistant App config`: **SUCCESS** (14s)
     - `linux/amd64 build and smoke`: **SUCCESS** (4m18s)
     - `linux/aarch64 native build and smoke`: **SUCCESS** (4m16s)
- **공개 배포 아티팩트 독립 검증**:
  - **Image**: `ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.1-dev.5`
  - **Multi-arch Manifest Digest**: `sha256:759f0f7b8917e539bcc3c603d798a8bd95b51085047ee638b7b337cbd6fc14bb`
    - `linux/amd64`: `sha256:812b3db7dd654d0a6d2c458e6e8e1aaae72a3c29718a6209bbedd6c055f5f8a6`
    - `linux/arm64`: `sha256:62df7d345d668eb7cd0c5f75a8dcee5380866ae35734e5b72247301a332ad77b`
  - **익명 GHCR API 조회 실증**:
    - `https://ghcr.io/v2/kanu-coffee/codex-for-home-assistant/manifests/0.7.1-dev.5` -> **HTTP 200 OK**, `manifest.list.v2+json` 정상 응답 확인.

---

## 5. 잔여 사항 및 비작업 내역

- **실제 사용자 운영 HAOS 설치**: 계속 **NOT RUN**. 실제 사용자 HAOS 환경에 대한 설치, 업데이트 수용 및 UI/모바일 테스트는 발행된 `0.7.1-dev.5`를 바탕으로 사용자가 직접 수행하는 수용 시험 대상임.
- **안정판 및 메인 브랜치**: `main` 브랜치(`a326988`) 및 stable `0.7.0`은 일체 변경하지 않았음.
- **GitHub Release**: 공식 Release는 안정판 전용이므로 생성하지 않음(Git tag 및 GHCR 컨테이너 이미지로만 발행).
