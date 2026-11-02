# FIX_08_REPORT — DEV 0.7.3-dev.6 공개 배포 완료 보고서

작성일: 2026-11-02 (Asia/Seoul)  
Executor: Antigravity  
지침 문서: `.handoff/007_work-aware-runtime-update/FIX_08.md`  
판정: **COMPLETED — DEV 후보 0.7.3-dev.6 공개 배포 및 검증 완결**

---

## 1. 배포 개요 및 식별 정보

- **확정 App 버전**: `0.7.3-dev.6`
- **원 코드 (`adfbaaa`) 포함 여부**: 포함 (`adfbaaa` 기반으로 후속 커밋 작성)
- **릴리스 준비 및 수정 커밋**:
  - `d73022e`: `release(dev): prepare 0.7.3-dev.6 release candidate and CI fixture/peer gates`
  - `40c7b6f`: `fix(ci): clean up test binaries before lint and fix markdown list spacing`
- **DEV PR**: [#66](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/66) (`feat/fix03-mobile-proxy-bootstrap` -> `dev`)
  - PR HEAD SHA: `40c7b6fb8b683255564f04c0b5ee98f5d1b91a62`
  - PR Checks: 12 successful, 2 skipped, 0 failing
    - CI Run: [41389594783](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/41389594783) (SUCCESS)
    - Builder Run: [41389594832](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/41389594832) (SUCCESS)
- **DEV Merge Commit SHA**: `93722a446912e0094568b43124653b80b864b992`
  - DEV CI Run: [41390227295](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/41390227295) (SUCCESS, 4/4 jobs passed)
- **불변 Annotated Tag**:
  - 태그명: `0.7.3-dev.6`
  - 태그 Annotation: `0.7.3-dev.6 — mobile proxy bootstrap, kernel peer verification, and thread restoration`
  - 태그 Dereference SHA: `93722a446912e0094568b43124653b80b864b992` (exact DEV merge SHA 일치)
  - 원격 태그 Ref: `refs/tags/0.7.3-dev.6` (`52e746107c30293827702742550f909be4cb8b02`), dereferenced: `93722a446912e0094568b43124653b80b864b992`
- **Tag Publication Builder Run**: [41390768112](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/41390768112) (SUCCESS)
- **GitHub Pre-release URL**: [https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.7.3-dev.6](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.7.3-dev.6)
  - 상태: `draft: false`, `prerelease: true`, `targetCommitish: dev`
- **DEV 설치 경로**: `https://github.com/Kanu-Coffee/codex-for-home-assistant#dev`

---

## 2. CI Fixture 자동 프로비저닝 및 이미지 피어 관측 게이트

### 2.1 공식 바이너리 자동 프로비저닝 (`tests/prepare-test-binaries.sh`)
- CI 및 로컬 환경에서 공식 0.162.1(베이스라인) 및 0.166.0(후보) 바이너리를 아키텍처별로 안전하게 프로비저닝하는 스크립트를 구현했습니다.
  - x86_64: 0.162.1 (`a676f572...`), 0.166.0 (`1d44b28b...`)
  - aarch64: 0.162.1 (`53a9ce0b...`), 0.166.0 (`7821b77d...`)
- `sha256sum --check --strict` 검증 및 안전한 디렉터리/파일 권한(`0755`/`0644`) 부여.
- 아카이브 파일을 테스트 대상 패키지 폴더 외부에 격리하여 불필요한 아카이브 복제 부하 방지.
- `.github/workflows/ci.yaml`의 pytest 전 단계에 자동 실행되도록 배치하여 깨끗한 CI 러너에서 바이너리 의존성 결함 없이 테스트 재현 완료.

### 2.2 테스트 아키텍처 독립화 (`tests/test_codex_wrapper_proxy.py`)
- `get_test_binary` 헬퍼 함수를 도입하여 환경 변수(`CODEX_TEST_BINARY_*`) 우선 검색 및 기본 경로 연동.
- 릴리스 폴더 명명 규칙을 `0.162.1-${target_suffix}` (x86_64/aarch64 동적 감지)로 개선하여 ARM CI 러너에서도 네이티브 호환성 확보.

### 2.3 이미지 피어 관측 게이트 (`tests/mobile-ssh-smoke.py`)
- 실제 컨테이너 내에서 백그라운드 `app-server`와 SSH 래퍼 프록시 연결이 유지되는 동안 `inspectAllSessions()`를 호출하여 `helpers >= 1, unknown == 0, canApply: true`를 엄격히 검증하는 게이트를 스모크 테스트에 통합.
- CI의 `amd64-build-and-smoke` 및 `aarch64-build-and-smoke` 양쪽 작업에서 모두 통과함을 확인.

---

## 3. 로컬 및 CI 검증 결과

| 검사 항목 | 도구 / 명령 | 결과 | 상세 / 증거 |
| --- | --- | --- | --- |
| **Python 전체 pytest** | `.venv/bin/python -m pytest -ra` | **320 passed, 5 skipped** (142.65s) | 스킵 5건: `test_codex_live_handover.py` (4건, 수동 페어 미지정), `test_vulnerability_gate_policy.py` (1건, 로컬 Grype 부재) |
| **Wrapper Proxy 회귀** | `pytest tests/test_codex_wrapper_proxy.py` | **9 passed** (10.49s) | 프록시 전송, 분할 프레임, 다중 턴 보호, 실 트랜잭션 연속성, 비영속 대화 보류 전건 통과 |
| **Node.js 문법** | `node --check .../*.mjs` | **PASS** (exit 0) | runtime manager, server transaction, session host, integrity, remote setup 전건 확인 |
| **ShellCheck** | `koalaman/shellcheck:stable` | **PASS** (exit 0) | rootfs 및 tests 내 모든 셸 스크립트 무경고 통과 |
| **Dockerfile Hadolint** | `hadolint/hadolint:v2.14.0-alpine` | **PASS** (exit 0) | Dockerfile 규칙 준수 |
| **GitHub Actions Lint** | `rhysd/actionlint:1.7.12` | **PASS** (exit 0) | `ci.yaml`, `build-app.yaml`, `builder.yaml` 전건 통과 |
| **비밀값 및 누출 검사** | `zricethezav/gitleaks:latest` | **PASS** (`no leaks found`) | `b7b3479..HEAD` diff 276KB 스캔 결과 누출 없음 |
| **공백 및 포맷 검사** | `git diff --check` | **PASS** (exit 0) | 후행 공백 및 충돌 마커 없음 |
| **로컬 Docker 빌드** | `docker build -t codex-ha:0.7.3-dev.6-test` | **PASS** (exit 0) | 라벨 `io.hass.version: 0.7.3-dev.6` 확인 |
| **로컬 모바일 SSH 스모크** | `python3 tests/mobile-ssh-smoke.py` | **PASS** | `actual image wrapper proxy mapped to kernel peer owner {'helpers': 1, 'unknown': 0, 'canApply': True}` 확인 |
| **PR CI (Run 41389594783)** | GitHub Actions PR CI | **SUCCESS** | Add-on lint, Lint & unit tests, native amd64 smoke, native aarch64 smoke 전건 성공 |
| **PR Builder (Run 41389594832)** | GitHub Actions PR Builder | **SUCCESS** | Validate release metadata, build amd64, build aarch64 전건 성공 |
| **DEV Branch CI (Run 41390227295)** | GitHub Actions DEV Push CI | **SUCCESS** | Exact merge SHA `93722a44...`에서 4개 작업 전건 성공 |
| **Tag Builder (Run 41390768112)** | GitHub Actions Tag Builder | **SUCCESS** | 메타데이터 검증, amd64/aarch64 빌드, SBOM/취약점 게이트, Multi-arch manifest, 서명, attestation, 태그 프로모션 전건 성공 |

---

## 4. OCI 레지스트리 및 익명 접근 검증

- **Multi-arch Manifest Digest**:
  `sha256:0e84de4645da80a9bb4b7047f5bcb020f1215a9e88ed2e6ea329427739c93495`
- **Sub-manifest Digests**:
  - `linux/amd64`: `sha256:abe5499b8fb28b65c8ff0fa7305fb84057bd843d8763eda97bb27c41cd9935e6`
  - `linux/arm64`: `sha256:a2286c9f87973626842e93f3ba7a8b9166c1bf388da8dc84dd76e604400389b5`
- **익명 OCI 이미지 라벨 확인 (`linux/amd64` config blob 조회)**:
  - `io.hass.version`: `0.7.3-dev.6`
  - `org.opencontainers.image.version`: `0.7.3-dev.6`
  - `io.hass.arch`: `amd64`
  - `org.opencontainers.image.title`: `Home Assistant App: Codex for Home Assistant (DEV)`
- **익명 HTTP 소스 파일 접근 확인**:
  - `https://raw.githubusercontent.com/Kanu-Coffee/codex-for-home-assistant/dev/codex_home_assistant/config.yaml`:
    `name: Codex for Home Assistant (DEV)`, `version: "0.7.3-dev.6"`, `image: ghcr.io/kanu-coffee/codex-for-home-assistant`
  - `https://raw.githubusercontent.com/Kanu-Coffee/codex-for-home-assistant/dev/repository.yaml`:
    `name: "Codex for Home Assistant (DEV)"`
- **공개 배포 이미지 pull 및 스모크 재검증**:
  - `docker pull ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.3-dev.6`: 다운로드 및 레이어 추출 완료 (Digest 일치).
  - `python3 tests/mobile-ssh-smoke.py ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.3-dev.6`:
    대화형 키 생성, PEM SSH 인증, revoke 차단, S6 데몬 기동 및 재시작 보존, SSH 프록시 부트스트랩, 커널 Netlink 피어 관측(`helpers: 1, unknown: 0, canApply: True`) 전건 PASS.
- **서명 및 Attestation 독립 검증 구분**:
  - Builder 워크플로 내에서 Cosign 서명 및 GitHub Actions Provenance Attestation, SBOM Attestation이 성공적으로 완료되었습니다.
  - 비인가(익명) 레지스트리 환경에서 `cosign verify`를 실행할 경우 OCI 서명 태그(`.sig`) 목록 조회가 차단되어 `no signatures found`를 반환합니다. 이는 비인가 레지스트리 접근 제한에 따른 것이며 서명 자체는 빌더 워크플로에서 정상 게시되었습니다.

---

## 5. 변경 문서 및 메타데이터 일람

- `codex_home_assistant/config.yaml`: `version: "0.7.3-dev.6"`
- `codex_home_assistant/Dockerfile`: `ARG BUILD_VERSION=0.7.3-dev.6`
- `codex_home_assistant/playwright/package.json`: `"version": "0.7.3-dev.6"`
- `codex_home_assistant/playwright/package-lock.json`: `"version": "0.7.3-dev.6"`
- `tests/test_addon_contract.py`: `addon_config["version"] == "0.7.3-dev.6"`
- `codex_home_assistant/CHANGELOG.md`: `## [0.7.3-dev.6] - 2026-11-02` 항목 신설
- `README.md`, `README.en.md`, `codex_home_assistant/README.md`, `codex_home_assistant/README.en.md`: `DEV 0.7.3-dev.6` 안내 배너 갱신
- `codex_home_assistant/DOCS.md`, `codex_home_assistant/DOCS.en.md`: `DEV 0.7.3-dev.6` 기능 및 안전성 개선 안내 섹션 추가
- `docs/development/progress.md`: 배포 진행 및 완료 상태 반영

---

## 6. 검증 범위 및 수용 경계 (Acceptance Boundaries)

- **PASS**:
  - 로컬/CI 단위·계약·정적 분석 전체 통과
  - CI native amd64 및 aarch64 에뮬레이션/네이티브 빌드·스모크(피어 게이트 포함) 통과
  - Multi-arch OCI 이미지 게시 및 익명 접근성 확인
  - 공개된 새 이미지(`ghcr.io/kanu-coffee/codex-for-home-assistant:0.7.3-dev.6`)에서의 컨테이너 스모크 통과
  - GitHub Pre-release 게시 완료 (`isDraft: false`, `isPrerelease: true`)
- **NOT RUN / 사용자 실기기 확인 대상**:
  - 실제 ChatGPT 모바일 앱에서의 SSH 접속 및 자동 reconnect / resume 동작은 이번 DEV 후보 설치 후 실기기 확인 대상입니다.
  - 물리 ARM 하드웨어 실기 및 운영 HAOS 환경에서의 최종 수용은 미검증 상태입니다.
  - 운영 Home Assistant OS 설정 및 데이터는 본 작업으로 변경되지 않았습니다.

---

## 7. 사용자 인계 가이드

1. **설치 및 업데이트**:
   - Home Assistant Add-on Store 저장소에 `https://github.com/Kanu-Coffee/codex-for-home-assistant#dev`를 추가(또는 이미 추가된 경우 저장소 새로고침)하여 **`0.7.3-dev.6`**으로 업데이트합니다.
2. **모바일 SSH 연결 확인**:
   - 기존에 발급받은 모바일 SSH 키는 그대로 유지되므로 키 재생성이나 재등록은 필요하지 않습니다.
   - ChatGPT 모바일 앱에서 SSH endpoint로 접속하여 모델 응답 및 연속 대화가 정상 작동하는지 확인합니다.
3. **업데이트 후 대화 복원 확인**:
   - 지원되는 영속 대화 세션 상태에서 백그라운드 갱신 발생 시 유휴 상태에서 안전하게 전환되고 이전 세대의 대화가 복원되는지 확인합니다.
4. **문제 발생 시 피드백**:
   - 비밀값이나 개인정보를 제외하고 인증 후 bootstrap/transport의 정제된 오류 메시지와 버전 정보만 수집하여 제보해 주시기 바랍니다.
