# implementation_plan.md — 구현 계획

## 1. 구현 전략

MVP는 “모든 파일을 먼저 만든 뒤 나중에 디버깅”하지 않는다. 아래 수직 단계마다 컨테이너가 시작되고 관찰 가능해야 한다.

## Phase 0 — 환경 확인 및 저장소 준비

### 작업

1. `git status`, `git remote -v`, `gh auth status` 확인
2. 현재 공식 Home Assistant `apps-example`를 참고해 저장소 구조 확정
3. 현재 OpenAI Codex 설치·인증·Remote SSH 문서 재확인
4. remote가 없으면 private GitHub repo `codex-for-home-assistant` 생성
5. `feat/mvp-runtime` 브랜치 생성

### 완료 조건

- 저장소와 branch가 명확함
- 공식 근거 링크가 `references.md`에 최신화됨
- `progress.md` Current Work 작성

## Phase 1 — 최소 App 부팅

### 구현

- `repository.yaml`
- `codex_home_assistant/config.yaml`
- 최소 Dockerfile
- S6 init/service 구조
- ttyd 없이도 로그를 남기는 keepalive 또는 health service

### 테스트

- YAML schema/lint
- Docker build
- 컨테이너 start/exit code
- `/config`, `/data` path 검증

### 완료 조건

App 골격이 빌드되고 Supervisor local App로 인식 가능한 형태다.

## Phase 2 — 영속 디렉터리와 Codex CLI

### 구현

- 필수 package 설치
- Codex CLI pin 설치
- `/data/home`, `/data/codex` 초기화
- 기본 config merge/creation
- `ha-codex`, `ha-codex-login`

### 테스트

- `codex --version`
- 컨테이너 재생성 후 `/data` fixture 유지
- auth 파일 권한
- existing config 보존

### 완료 조건

일반 shell에서 `/config`를 작업 경로로 Codex를 실행할 수 있다.

## Phase 3 — Ingress Web Terminal

### 구현

- ttyd service
- Ingress config
- tmux wrapper
- auto-start option

### 테스트

- ttyd process health
- auto-start true/false command test
- tmux attach/create
- WebSocket/Ingress는 HAOS 실기 표시

### 완료 조건

HAOS Web UI에서 shell/Codex가 사용 가능하고 재접속 시 세션이 유지된다.

## Phase 4 — SSH 및 Remote SSH

### 구현

- sshd config
- host key persistence
- authorized_keys renderer
- runtime shell env
- SSH default port mapping

### 테스트

- `sshd -t`
- password auth 거부
- public key 성공
- host key 재시작 유지
- `ssh host 'command -v codex; codex --version; pwd'`
- Codex Desktop Remote SSH 실기

### 완료 조건

일반 SSH와 Codex Desktop remote project가 모두 동작한다.

## Phase 5 — Core/Supervisor API 운영 도구

### 구현

- 안전한 token runtime propagation
- `ha-api`, `supervisor-api`
- `ha-config-check`, log helpers
- API 사용 DOCS

### 테스트

- fake token fixture로 header redaction
- mock HTTP success/error
- 기본 JSON과 로그 `text/x-log` 협상, 잘못된 media type/header injection 거부
- Core `/config` 또는 `/states` 조회
- safe test entity service call
- Supervisor `/core/check` 및 logs
- manager permission matrix

### 완료 조건

Codex가 설정·상태·로그를 분석하고 안전한 실제 동작을 시험할 수 있다.

## Phase 6 — 품질, 문서, CI

### 구현

- shellcheck/yamllint/hadolint
- pytest 또는 shell-based integration tests
- GitHub Actions lint/build
- DOCS/CHANGELOG/translations
- GHCR publish 준비

### 완료 조건

모든 가능한 자동 검증이 CI에서 통과하고 미검증 HAOS 항목이 명시된다.

## Phase 7 — GitHub delivery

### 작업

1. 최종 diff 검토
2. `progress.md` 업데이트
3. 의미 있는 commit 생성
4. feature branch push
5. PR 생성
6. PR 본문에 테스트 결과, 실기 미검증, 보안 권한 명시

### 완료 조건

GitHub에서 코드를 검토하고 다음 HAOS 실기 작업을 바로 시작할 수 있다.

## 2. 첫 번째 코딩 작업의 구체적 범위

첫 에이전트는 가능한 한 M1 전체를 완성하되, 최소한 다음을 하나의 PR로 제공한다.

- 빌드 가능한 amd64 App 골격
- Codex CLI 설치 및 `/data` 영속 config
- ttyd + tmux Ingress
- 공개키 sshd
- `/config` RW 및 Core/Supervisor manager 권한 선언
- API helper 기본 구현
- lint/build CI
- 설치/인증/접속 문서

실제 HAOS가 없는 환경에서 Ingress, Supervisor token, Remote SSH를 완료 처리하지 않는다. 대신 실행 가능한 테스트와 정확한 실기 체크리스트를 제공한다.

## 3. 구현 선택 기준

### Base image

1. 공식 Home Assistant base image/예제와 호환
2. ttyd/openssh/tmux 패키지 가용성
3. Codex binary 호환
4. 이미지 크기보다 안정성 우선

M1 선택: 공식 Home Assistant Alpine base `3.24`와 S6 Overlay v3 native service graph.

### Codex 설치 방식

1. 재현 가능성
2. amd64/aarch64 확장 가능성
3. Remote SSH app-server 호환
4. 이미지 크기
5. 공급망 검증(checksum)

M1 선택: Codex CLI `0.144.1`의 `x86_64-unknown-linux-musl` standalone artifact와 고정 SHA-256.

### SSH 사용자

MVP는 `/config` write 및 token access를 확실히 보장해야 한다. root 공개키 login이 가장 단순하지만, 컨테이너 경계를 유지한다. non-root 전환은 host-mounted config의 권한을 안전하게 보장한 뒤 별도 ADR로 진행한다.

## 4. 금지된 우회

- Advanced SSH App 안에 런타임 설치하는 방식으로 되돌아가지 않음
- SMB 배포 워크플로를 핵심으로 만들지 않음
- API 권한을 진단 전용으로 축소하지 않음
- admin/full_access/docker_api로 테스트 문제를 덮지 않음
- Codex 인증 파일을 image에 bake하지 않음
- HAOS 실기 검증 없이 stable 표시하지 않음
