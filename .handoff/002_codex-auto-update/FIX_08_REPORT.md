# FIX_08_REPORT — 취약점 게이트 정밀 스코프 한정·OpenVEX 연동 및 DEV 0.7.1-dev.4 다중 아키텍처 발행 완료

## 1. 개요 및 역할

- **역할**: Executor, 2026-10-13 Asia/Seoul
- **수행 범위**: [.handoff/002_codex-auto-update/FIX_08.md](FIX_08.md)의 P1(광범위한 보안 제외 규칙의 엄격한 한정 및 음성 대조군 검증)과 P2(OpenVEX 정식 워크플로우 연동 및 도달 가능성 상세 소명), 그리고 보고서 정정 사항을 전수 해결하고 신규 DEV 버전(`0.7.1-dev.4`)을 발행함.
- **불변 조건 준수**:
  - `main` 브랜치(`a32698851e3c3539f5d4b823e60d4f0d29038df1`) 및 stable `0.7.0` 태그/이미지는 일체 변경하지 않음.
  - 이미 소비된 태그 `0.7.1-dev.1`, `0.7.1-dev.2`, `0.7.1-dev.3`는 삭제·이동·재사용하지 않고 그대로 보존함.
  - 실제 사용자 운영 HAOS 인스턴스에 임의 변경을 가하지 않음.
  - 기존 handoff 문서 이력을 훼손 없이 보존함.

---

## 2. 보안 정책 수정 및 취약점 게이트 연동

### 2.1 P1: 보안 제외 규칙의 엄격한 버전 및 모듈 한정 (`.grype.yaml`)
- **기존 결함 해소**: 이전 `.grype.yaml` 규칙은 패키지 이름(`stdlib`, `golang.org/x/net`)과 취약점 ID만으로 일치시켜, 검토되지 않은 다른 버전이나 다른 바이너리의 동일 모듈까지 광범위하게 제외할 위험이 있었음.
- **적용 조치**:
  1. 각 규칙에 정확히 검토된 버전(`version: go1.26.5`, `go1.26.8`, `v0.55.0`, `v0.56.0`) 및 타입(`type: go-module`)을 명시하여 스코프를 엄격히 한정.
  2. `show-suppressed: true`를 활성화하여 필터링된 항목이 감사 가능한 테이블 출력 및 JSON 결과에서 `(suppressed)` 또는 `(suppressed by VEX)`로 명확히 표시되도록 조치.
  3. `tests/test_vulnerability_gate_policy.py` 신규 구축:
     - 검토되지 않은 Go 버전(예: `go1.26.7`, `v0.60.0`)이나 다른 패키지 이름(예: `github.com/example/server`)이 나타날 경우 게이트가 실패(Exit 2)하도록 음성 대조군(negative control) 회귀 검증을 자동화.
     - 로컬 Grype 실제 실행 음성 시험: 변조된 SBOM(`stdlib go1.26.7`) 주입 시 Grype가 미제외 Critical 2건을 보고하며 정확히 **Exit 2**로 빌드를 차단함을 실증.

### 2.2 P2: OpenVEX 워크플로우 연동 및 도달 가능성 기술 소명 (`.github/security/openvex.json`)
- **기존 결함 해소**: 워크플로우에서 OpenVEX 파일이 `vex:` 파라미터로 전달되지 않아 스캐너가 VEX를 소비하지 않았던 문제를 해결.
- **적용 조치**:
  1. `.github/workflows/build-app.yaml`의 `Enforce critical vulnerability gate` 및 `Report high and critical vulnerabilities (non-blocking)` 단계에 `vex: .github/security/openvex.json`을 명시적으로 전달.
  2. `.grype.yaml`에 `vex-documents: [.github/security/openvex.json]` 설정. (초기 dev.3 시도 시 `vex-add: not_affected` 파싱 오류가 발생하여, VEX 기본 사양에 따라 `not_affected`가 기본 무시 대상임을 확인하고 해당 중복 설정을 제거하여 정상 파싱 확립).
  3. 상세 기술 소명 문서화:
     - `GO-2026-6612` (CVE-2026-78663, HTTP/2 server flow-control DoS):
       - `/usr/local/bin/gh` (2.97.0): GitHub REST/GraphQL API 호출용 아웃바운드 클라이언트. `gh auth login`의 로컬 OAuth 콜백 리스너는 루프백(`127.0.0.1`)에서 일반 unencrypted HTTP/1.1로 동작하며, TLS/ALPN 또는 `h2c`가 없어 HTTP/2 서버 스트림 핸들러 코드는 원천적으로 호출되지 않음(Unreachable).
       - `/usr/bin/yq` (4.53.3-r1): 순수 오프라인 CLI 문서 변환기로서 네트워크 소켓 수신 기능이 전무함(Unreachable).
     - `GO-2026-6604` (CVE-2026-56857, Windows `os.Root` junction traversal):
       - Windows 시스템 콜(`internal/syscall/windows`)에 한정된 정션 링크 순회 취약점임. 본 컨테이너는 Linux musl(`linux/amd64`, `linux/arm64`) 전용이며, Linux의 네이티브 `openat` 시스템 콜을 사용하므로 Windows 전용 코드는 비적용됨(Non-applicable).

---

## 3. 보고서 및 문서 정정

1. **`codex_auto_update` 기본값 정정**:
   - `FIX_07_REPORT`의 안내 문구에서 기본값을 `false`로 잘못 표기하였으나, 실제 DEV 설정([`codex_home_assistant/config.yaml`](file:///home/lee/projects/codex_for_HA/codex_home_assistant/config.yaml))에서는 `options: codex_auto_update: true`로 승인된 기본값(`true`)이 정상 적용되어 있음을 정정 기록함.
2. **GitHub Release와 Git Tag / GHCR Image 구분**:
   - `0.7.1-dev.4`는 Git tag 및 GHCR 다중 아키텍처 컨테이너 이미지로 온전히 발행되었으며, GitHub Release는 생성하지 않음(안정판 공개 릴리스와 구분).
3. **Cosign 서명 및 증명 상태 구분**:
   - GitHub Actions Tag Builder 내부에서 Cosign 이미지 서명 및 in-toto 빌드/SBOM 증명 업로드가 성공(PASS)하였으며, 호스트 환경에는 로컬 `cosign` 바이너리가 없어 로컬 독립 검증은 수행하지 않음.

---

## 4. DEV 태그 및 발행 진행 이력

- **`0.7.1-dev.3` 시도 (커밋 `d50e98b`)**:
  - `origin/dev` 및 태그 `0.7.1-dev.3` 푸시 완료.
  - dev CI [38355833470](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38355833470)는 **전 job PASS**.
  - Tag Builder [38355845768](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38355845768)에서 `.grype.yaml`의 `vex-add: not_affected` 파싱 오류로 인한 게이트 실패 관측.
  - 태그 불변 원칙에 따라 `0.7.1-dev.3`는 덮어쓰거나 삭제하지 않고 보존 처리함.
- **`0.7.1-dev.4` 최종 발행 (커밋 `ce95cba`)**:
  - `vex-add` 제거 및 정책 정제 후 신규 브랜치 `codex/release-0.7.1-dev.4` 생성 및 커밋.
  - `origin/dev` 및 태그 `0.7.1-dev.4` 푸시 완료.

---

## 5. 최종 검증 결과 및 증거

| 검증 항목 | 대상 / 실행 명령 | 결과 | 상세 / 증거 |
| --- | --- | --- | --- |
| 단위/계약 테스트 | `.venv/bin/pytest -q` | **198 passed in 61.82s** | 취약점 정책 테스트 4종 포함 회귀 0건, 전체 통과 |
| 정적 분석 | `actionlint`, `git diff --check` | **PASS (0 errors)** | 워크플로우 및 소스 정합성 확인 |
| 정책 음성 대조군 | `test_policy_negative_controls_fail_on_unreviewed_components` | **PASS** | 미검토 버전/패키지 일치 거부 실증 |
| 원격 DEV CI | [Run 38357039179](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38357039179) | **전 job PASS** | lint/unit(1m48s), App config(18s), amd64 smoke(3m41s), native aarch64 smoke(3m9s) |
| 원격 Tag Builder | [Run 38357055889](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/38357055889) | **전 job SUCCESS** | Validate metadata(7s), Prepare(5s), aarch64 build & scan exit 0(5m17s), amd64 build & scan exit 0(5m52s), Publish multi-arch manifest(43s) |
| Critical 취약점 게이트 | `Enforce critical vulnerability gate` | **PASS (Exit 0)** | OpenVEX 및 버전 한정 정책 연동으로 amd64/arm64 양 아키텍처 게이트 정상 통과 |
| 서명 및 증명 | Cosign sign & in-toto attestation | **PASS** | Builder 내 이미지 서명 및 SBOM/빌드 증명 완료 |
| 다중 아키텍처 매니페스트 | GHCR `0.7.1-dev.4` 발행 | **PASS** | `linux/amd64`, `linux/arm64` 멀티 아키텍처 매니페스트 리스트 게시 |
| 익명 GHCR API 조회 | `https://ghcr.io/v2/.../manifests/0.7.1-dev.4` | **200 OK (PASS)** | 익명 토큰으로 다중 아키텍처 매니페스트 조회 성공 확인 |

### 5.1 발행된 이미지 다이제스트 정보
- **Image**: `ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.1-dev.4`
- **Multi-arch Manifest List Digest**: `sha256:6e3a421d8e3acca71adf1db0fd1a4a2b9101a3ae2b05f830d8c3f3dbf52e6f68`
  - `linux/amd64`: `sha256:ad6dabb4be304f6d640cd706bb6276af6d0438bd288e9750247a5af78c41ebb6`
  - `linux/arm64`: `sha256:f94e984fcaf2181355c58bfbd573a9b766863237eaf611e887de1455da5ffad9`

---

## 6. 설치 가능한 DEV 및 사용자 수용 시험 안내

- **설치 가능한 DEV 안내**:
  - `0.7.1-dev.4`는 GHCR에 `linux/amd64`와 `linux/arm64` 멀티 아키텍처 이미지로 온전히 게시되었습니다.
  - Home Assistant 개발/시험 환경 사용자는 `dev` 채널 repository 추가 후 `0.7.1-dev.4`로 설치하여 시험할 수 있습니다.
- **사용자 수용 시험 항목**:
  1. `codex_auto_update` 옵션(기본값 `true`, 필요 시 `false` 토글) 동작 확인.
  2. 업데이트 상태 진단 UI(`bundledVersion: 0.162.1`, `selectedVersion: 0.162.1`, `runningVersion`, `status`).
  3. 활성 터미널/브라우저/세션 동작 중 안전한 보류(`paused_busy`) 및 유휴 슬롯 진입 시 무중단 적용.
  4. 1일 12회 idle 검사 버짓 소진 시 당일 중단 및 익일 슬롯 자동 재개, 24시간 재시작 쿨다운 보존.
  5. 기존 브라우저 자동 인증, SSH 키페어, `/data` 영속성 보존 확인.
- **NOT RUN 항목**:
  - 실제 사용자 운영 HAOS 인스턴스에 대한 자동 설치/배포는 수행하지 않음 (사용자 주도 시험 대상).
