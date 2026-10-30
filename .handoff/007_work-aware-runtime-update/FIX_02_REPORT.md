# FIX_02_REPORT — DEV 0.7.3-dev.5 배포 및 검증 완료 보고

작성일: 2026-10-30  
역할: Executor  
상태: **배포 완료** (DEV 채널 공개 배포 완료 / HAOS 실기 및 물리 기기 수용은 **NOT RUN**)

---

## 1. 개요 및 확정 정보

[FIX_02](FIX_02.md)의 요구사항에 따라 `codex resume` 대화 복원 정상화와 모바일 SSH 간편 설정 도구(`ha-codex-remote`)를 포함한 새 DEV 버전 **`0.7.3-dev.5`**를 빌드, 검증, 게시 완료했습니다.

- **확정 버전**: `0.7.3-dev.5`
- **커밋 내역**:
  - `f0afa02`: `feat: fix resume conversation restoration and add mobile SSH quick setup (0.7.3-dev.5)`
  - `369751c`: `fix: resolve mobile smoke shellcheck shebang and review glib CVE-2026-58016`
- **DEV PR**: [#64 (feat/dev-0.7.3-dev.5 -> dev)](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/64)
- **DEV Merge Commit SHA**: `52fa74b5f83db3c42502ca5a98c94cc700de412a`
- **Immutable Tag**:
  - 태그명: `0.7.3-dev.5`
  - Tag Object SHA: `0a9177f467d77c5edec03676a5b4b1fbdd56f3e0`
  - Dereferenced Target Commit SHA: `52fa74b5f83db3c42502ca5a98c94cc700de412a`
- **GitHub Pre-release**:
  - URL: [https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.7.3-dev.5](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.7.3-dev.5)
  - 속성: `Draft: false`, `Prerelease: true`, `Latest: false`
- **DEV 설치 저장소**: `https://github.com/Kanu-Coffee/codex-for-home-assistant#dev`

---

## 2. 주요 개선 사항

1. **`codex resume` 대화 복원 정상화**:
   - `codex resume` TUI 대화 선택 후 Enter 입력 시 `Resuming session…` 상태에서 shell로 즉시 튕기는 문제 수정.
   - 관리형 CLI host의 소유권을 일회성 picker socket에서 부모 frontend 프로세스에 결합하고, 백엔드 중복 초기화(`Already initialized`) 거절을 방지하여 이전 초기화 결과를 안전하게 재사용.
2. **모바일 SSH 간편 설정 도구 (`ha-codex-remote`)**:
   - Web UI 터미널에서 실행 가능한 대화형 헬퍼 `ha-codex-remote setup/show/status/revoke` 도입.
   - P-256 ECDSA 전용 키를 `/data/ssh/mobile`에 생성하고 서버 `authorized_keys`에 자동 동기화.
   - 모바일 클라이언트 파서 호환을 위해 동일 키의 SEC1 및 PKCS#8 형식 변환 출력(`ha-codex-remote show --format sec1|pkcs8`) 지원.
   - SSH 비활성 상태에서 키 생성 시 S6를 통한 SSH 서비스 자동 기동 요청.

---

## 3. 로컬 및 사전 검증 결과

- **단위 및 계약 테스트**:
  - `pytest -q`: `300 passed, 6 skipped in 111.04s`
  - `tests/test_addon_contract.py`: 버전 `0.7.3-dev.5` 계약 검증 PASS
  - `tests/test_codex_remote_setup.py`: 10 passed
  - `tests/test_codex_live_handover.py`: 4 transport passed (CLI/WebSocket/PTY/Remote)
  - `tests/test_vulnerability_gate_policy.py`: 12 passed
- **정적 분석 및 린트**:
  - Node.js syntax check (`node --check`): PASS
  - ShellCheck (`koalaman/shellcheck-alpine:stable`): PASS
  - Hadolint (`hadolint/hadolint:v2.14.0-alpine`): PASS
  - Actionlint (`rhysd/actionlint:1.7.12`): PASS
  - Markdownlint: PASS
  - Git diff check (`git diff --check`): PASS
- **로컬 컨테이너 빌드 및 스모크**:
  - `docker build --build-arg BUILD_VERSION=0.7.3-dev.5 -t codex-ha:0.7.3-dev.5-test codex_home_assistant`: PASS
  - `python3 tests/mobile-ssh-smoke.py codex-ha:0.7.3-dev.5-test`: 대화형 키 생성, 양식별 SSH 인증, revoke 차단, S6 서비스 기동 및 재시작 보존 전체 PASS

---

## 4. CI 및 Builder 워크플로 결과

1. **PR #64 CI & Builder (Feature Branch)**:
   - PR CI Run [41033878028](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/41033878028): PASS (12 jobs successful, 2 skipped)
   - PR Builder Run [41034032126](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/41034032126): PASS (비게시 amd64/aarch64 빌드 및 취약점 검사 통과)
2. **DEV Merge Push CI**:
   - Merge Commit `52fa74b5f83db3c42502ca5a98c94cc700de412a` CI Run [41036439226](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/41036439226): PASS (모든 4개 작업 성공)
3. **Publication Builder (Tag 0.7.3-dev.5)**:
   - Builder Run [41037202760](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/41037202760): **성공 (SUCCESS)**
     - `Validate release metadata`: PASS
     - `Build amd64 image`: PASS (이미지 빌드, SBOM 생성, 취약점 게이트 통과, 서명, attestation)
     - `Build aarch64 image`: PASS (이미지 빌드, SBOM 생성, 취약점 게이트 통과, 서명, attestation)
     - `Publish multi-arch manifest`: PASS (매니페스트 생성, Cosign 서명, GitHub Provenance Attestation, 0.7.3-dev.5 promotion 완료)

---

## 5. 원격 저장소 및 익명 레지스트리 검증

- **Multi-arch Manifest Digest**:
  `sha256:25f6f6238bfc06f83f54815b6edd0c2fb36838987d8ad95c2747a40b70d36d12`
- **Sub-manifest Digests**:
  - `linux/amd64`: `sha256:9a75349dd28640e17db581229da804fd8d8ff43bfdf764da678509b37d5c8a7f`
  - `linux/arm64`: `sha256:1735ab112ff1065f115f02a20c7b0dbd6ca619e284b92b0ad10562cfcc323fcb`
- **OCI Image Labels (익명 조회 확인)**:
  - `io.hass.version`: `0.7.3-dev.5`
  - `org.opencontainers.image.version`: `0.7.3-dev.5`
  - `Title`: `Home Assistant App: Codex for Home Assistant (DEV)`
- **DEV 소스 익명 HTTP 확인**:
  - `https://raw.githubusercontent.com/Kanu-Coffee/codex-for-home-assistant/dev/codex_home_assistant/config.yaml`: `version: "0.7.3-dev.5"`
  - `https://raw.githubusercontent.com/Kanu-Coffee/codex-for-home-assistant/dev/repository.yaml`: `name: "Codex for Home Assistant (DEV)"`
- **서명 및 증명 독립 검증 구분**:
  - Builder 워크플로 내에서 Cosign 서명 및 GitHub Actions Attestation 작성이 성공적으로 완료되었습니다.
  - 레지스트리 비인가(익명) 환경에서 `cosign verify`를 실행할 경우 OCI 서명 태그(`.sig`) 목록 조회가 차단되어 `no signatures found`를 반환합니다. 이는 비인가 레지스트리 접근 제한에 따른 것이며 서명 자체는 정상 게시되었습니다.

---

## 6. 보안 게이트 (CVE-2026-58016)

- 2026-10-30 추가된 Grype 취약점 DB의 `glib 2.88.1-r1` (`CVE-2026-58016`, Critical)에 대해 심층 영향성 검토를 수행했습니다(`docs/development/glib-cve-2026-58016-review.md`).
- 컨테이너 내 D-Bus 데몬 및 D-Bus Introspection XML 파싱 경로가 부재하여 실제 공격 경로가 차단됨을 확인했습니다.
- `.github/security/openvex.json`과 `.github/scripts/sbom-go-binary-preflight.py`에 패키지 한정 예외 규칙을 적용하고 `tests/test_vulnerability_gate_policy.py` 회귀 테스트를 추가하여 보안 게이트를 정상 통과했습니다.

---

## 7. 검증 범위 및 지원 경계 (Boundaries)

- **PASS**:
  - 로컬/CI 단위·계약·정적 분석 전체 통과
  - CI native amd64 및 aarch64 에뮬레이션 빌드·스모크 통과
  - Multi-arch OCI 이미지 게시 및 익명 접근성 확인
  - GitHub Pre-release 게시 완료
- **PARTIAL (클라이언트 한계)**:
  - 모바일 클라이언트 앱 자체의 PEM 파서 오류(upstream [#52417](https://github.com/openai/codex/issues/52417), [#38264](https://github.com/openai/codex/issues/38264))는 서버 측에서 임의로 해결할 수 없습니다. `ha-codex-remote`를 통해 SEC1 및 PKCS#8 형식을 모두 제공하여 호환성을 극대화했으나, 클라이언트 자체 파그 버그가 지속될 수 있습니다.
- **NOT RUN**:
  - 실제 HAOS 하드웨어 기기 배포 및 App Store 업데이트 수용
  - 실제 모바일 기기에서의 물리적 SSH 접속 수용
  - 물리 ARM 하드웨어 기기 수용
  - Stable `main` 채널 배포 (DEV 채널 한정 작업임)

---

## 8. 사용자 인계 가이드

1. **설치 및 업데이트**:
   - Home Assistant App 저장소에 `https://github.com/Kanu-Coffee/codex-for-home-assistant#dev` 추가 후 새로고침하여 `0.7.3-dev.5`로 업데이트합니다.
2. **모바일 SSH 간편 설정**:
   - Web UI 터미널 shell에서 `ha-codex-remote setup`을 실행합니다.
   - 출력된 개인키를 복사하여 모바일 Codex 앱에 입력합니다.
   - 모바일 앱에서 "Invalid PEM" 등의 오류가 발생하는 경우:
     `ha-codex-remote show --format sec1`
     명령으로 다른 포맷의 키를 확인하여 입력해 봅니다.
   - 키 연결 상태 확인은 `ha-codex-remote status`, 키 폐기는 `ha-codex-remote revoke`를 사용합니다.
3. **오류 보고 시 주의사항**:
   - 지속적인 오류 발생 시 개인키나 비밀 토큰은 절대 공유하지 마시고, 모바일 앱 버전과 오류 문구만 정제하여 전달해 주시기 바랍니다.
