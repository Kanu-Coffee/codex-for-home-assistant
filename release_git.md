# release_git.md — GitHub 및 릴리스 운영

## 1. 저장소 정책

- 권장 이름: `codex-for-home-assistant`
- visibility: public
- 기본 branch: `main`
- 기능 branch: `feat/*`, 수정 branch: `fix/*`
- HAOS 설치 테스트용 전달은 CI 통과 후 반드시 기본 branch에 병합

## 2. 첫 GitHub 연결

에이전트는 먼저 확인한다.

```bash
git status --short
git remote -v
gh auth status
```

### 이미 origin이 있으면

기존 저장소를 사용하고 새 repo를 만들지 않는다.

### origin이 없고 현재 폴더가 새 프로젝트면

```bash
git init -b main
gh repo create codex-for-home-assistant --public --source . --remote origin
```

문서 baseline을 main에 커밋하거나 현재 사용자가 원하는 초기 상태를 보존한 뒤 기능 branch를 만든다.

## 3. 작업 브랜치

```bash
git switch -c feat/mvp-runtime
```

커밋 예시:

```text
chore: scaffold Home Assistant app repository
feat: install and persist Codex CLI runtime
feat: add ingress web terminal with tmux
feat: add public-key SSH and remote workspace support
feat: add Home Assistant API helper commands
test: add app lint and container smoke tests
docs: document installation and security model
```

## 4. Push 및 PR

완료 후:

```bash
git push -u origin feat/mvp-runtime
gh pr create --fill
```

PR 본문에 반드시 포함:

- 구현한 기능
- 권한 선언(`/config` RW, Core API, manager)
- 자동 테스트 결과
- HAOS 실기 완료/미완료 항목
- 알려진 위험과 롤백 방법
- `progress.md`의 다음 단계

HAOS에서 저장소 URL을 연결해 설치·검증하도록 전달하는 작업은 기능 브랜치 push나 draft PR에서 멈추지 않는다. CI 통과, 미검증 항목 기록, `main` 병합, public 저장소 접근 확인까지 완료한다.

## 5. CI 구성

### `lint.yaml`

- yamllint
- shellcheck
- hadolint
- markdown lint
- secret scan
- config policy test

### `builder.yaml` / `build-app.yaml`

- 현재 공식 Home Assistant apps-example workflow를 기준으로 작성
- PR: build only
- main push/tag: GHCR publish
- 최소 amd64
- aarch64는 실제 검증 후 matrix에 추가

GitHub Action 버전은 구현 시점의 공식 예제 값을 사용한다. 이 문서의 날짜를 근거로 오래된 action version을 고정하지 않는다.

## 6. 이미지와 버전

### 개발

```text
0.1.0-dev
```

### 첫 release

```text
0.1.0
```

SemVer를 사용한다.

- PATCH: 버그/패키지/Codex patch 업데이트
- MINOR: 사용자 기능 및 호환 변경
- MAJOR: 설정/권한/데이터 호환성 파괴

`config.yaml` version과 image tag가 일치해야 한다.

## 7. GHCR

권장 image:

```text
ghcr.io/<owner>/codex-for-home-assistant
```

0.1.0 배포 시 multi-arch manifest 또는 amd64 image를 publish하고 `config.yaml`의 `image`에 반영한다.

## 8. 릴리스 체크리스트

- [ ] `progress.md` 일치
- [ ] 모든 자동 CI 통과
- [ ] HAOS 설치 및 Web UI 검증
- [ ] SSH 및 Remote SSH 검증
- [ ] Codex device auth/persistence 검증
- [ ] Core API service call 검증
- [ ] Supervisor manager 검증
- [ ] secret scan
- [ ] DOCS/CHANGELOG/version 갱신
- [ ] tag 생성
- [ ] GHCR publish
- [ ] GitHub release notes

## 9. 금지 사항

- main force push
- 미검증 architecture를 `arch`에 표시
- 인증 파일을 release asset에 포함
- CI 로그에 token 출력
- 실패한 test를 삭제해 green으로 만들기
- 사용자 동의 없이 공개 repo 생성/visibility 변경
