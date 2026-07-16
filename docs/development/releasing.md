# 릴리스 운영 가이드

[개발 문서로 돌아가기](README.md)

이 문서는 현재 `.github/workflows/ci.yaml`, `builder.yaml`, `build-app.yaml`과 `codex_home_assistant/config.yaml`의 계약을 요약합니다. 실제 릴리스 전에는 workflow 원문과 GitHub Actions 결과를 다시 확인하세요.

## 배포 모델

- Home Assistant App repository: `https://github.com/Kanu-Coffee/codex-for-home-assistant`
- image: `ghcr.io/kanu-coffee/codex-for-home-assistant:<version>`
- architecture: `amd64`
- version tag: 숫자 SemVer `X.Y.Z`
- mutable `latest` tag는 발행하지 않음
- 기존 version tag는 덮어쓰지 않음

Supervisor는 `config.yaml`의 `image`와 `version`으로 미리 빌드된 public image를 받습니다. 사용자 장치에서 Dockerfile을 소스 빌드하는 배포 방식이 아닙니다.

## 버전 일치 항목

릴리스 후보에서는 최소한 다음 값이 모두 같아야 합니다.

- `codex_home_assistant/config.yaml`의 `version`
- `codex_home_assistant/Dockerfile`의 `BUILD_VERSION`
- `codex_home_assistant/playwright/package.json`의 `version`
- `codex_home_assistant/playwright/package-lock.json`의 root/package version
- `codex_home_assistant/CHANGELOG.md`의 첫 release heading
- Git tag `X.Y.Z`

계약 테스트가 이 일치를 검사합니다. 사용자 README/DOCS의 current-version 문구와 upgrade note도 함께 검토합니다.

## Pull request 단계

1. 기능 브랜치에서 변경 범위와 사용자 영향을 검토합니다.
2. 로컬에서 관련 unit/contract/lint와 가능한 smoke를 실행합니다.
3. PR에서 `ci.yaml`의 lint, pytest, App linter와 amd64 image smoke를 확인합니다.
4. 앱 경로가 바뀐 PR은 `builder.yaml`이 non-publishing image build도 수행합니다.
5. HAOS에서만 확인 가능한 경로는 PASS로 추정하지 않고 `NOT RUN` 또는 `PARTIAL`로 남깁니다.

## 태그와 image 게시

1. release commit이 `main`에 있고 main CI가 PASS인지 확인합니다.
2. 변경 기록과 사용자 문서가 실제 동작·제약과 일치하는지 검토합니다.
3. 같은 SHA에 앱 version과 동일한 annotated numeric tag를 생성합니다.
4. tag push가 `builder.yaml`을 시작합니다.
5. release guard가 generic/per-architecture package에 같은 version tag가 없는지 확인합니다.
6. 공식 Home Assistant builder action이 amd64 image와 generic manifest를 게시합니다.

기존 tag나 GHCR version을 수정·덮어쓰지 마세요. 릴리스에 문제가 있으면 tag를 재사용하지 말고 원인을 수정한 새 patch version을 준비합니다.

## 게시 후 확인

- tag Builder와 관련 CI 결과
- 인증 없는 generic/per-architecture image 조회와 pull
- image의 `io.hass.version`, `io.hass.arch`, source label
- 예상 architecture가 `linux/amd64`인지
- generic tag와 runtime manifest digest 기록
- mutable `latest`가 생기지 않았는지
- GitHub release와 사용자용 upgrade note
- Home Assistant App repository 새로고침에서 새 version 노출
- 가능한 경우 실제 HAOS의 일반 update와 `/data` 보존

검증에 실제 token, `/config`, entity, 내부 URL이나 screenshot을 반입하지 마세요. 결과는 [progress.md](progress.md)에 PASS/PARTIAL/NOT RUN 경계를 유지해 기록합니다.

## 롤백 원칙

- 사용자는 앱 완전 삭제·재설치보다 Home Assistant backup과 검증된 version 전환을 우선합니다.
- 유지보수자는 immutable image/tag를 보존하고 새 patch에서 수정합니다.
- downgrade가 `/data` schema나 사용자 config와 호환되는지 검증되지 않았다면 자동 권장하지 않습니다.
- credential 노출이나 image 신뢰 문제가 있으면 배포 편의보다 secret 폐기와 접근 차단을 우선합니다.
