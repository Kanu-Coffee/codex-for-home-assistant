# addon_spec.md — Home Assistant App 계약

## 1. 권장 저장소 구조

```text
codex-for-home-assistant/
├─ .github/
│  └─ workflows/
│     ├─ lint.yaml
│     ├─ builder.yaml
│     └─ build-app.yaml
├─ codex_home_assistant/
│  ├─ config.yaml
│  ├─ Dockerfile
│  ├─ DOCS.md
│  ├─ CHANGELOG.md
│  ├─ icon.png
│  ├─ logo.png
│  ├─ translations/
│  │  ├─ en.yaml
│  │  └─ ko.yaml
│  └─ rootfs/
│     ├─ etc/
│     │  ├─ cont-init.d/ 또는 s6-rc.d/
│     │  ├─ services.d/ 또는 s6-rc.d/
│     │  ├─ ssh/
│     │  └─ profile.d/
│     └─ usr/local/bin/
│        ├─ ha-codex
│        ├─ ha-codex-login
│        ├─ ha-api
│        ├─ supervisor-api
│        ├─ ha-config-check
│        ├─ ha-core-logs
│        ├─ ha-addon-logs
│        └─ web-terminal-entrypoint
├─ tests/
├─ repository.yaml
├─ README.md
├─ LICENSE
├─ AGENTS.md
├─ rules.md
├─ progress.md
└─ 기타 설계 문서
```

S6 디렉터리 방식은 선택한 최신 Home Assistant base image의 공식 예제를 그대로 따른다. 과거 경로를 추측해 고정하지 않는다.

## 2. `repository.yaml` 초안

```yaml
name: Codex for Home Assistant
url: https://github.com/<owner>/codex-for-home-assistant
maintainer: <owner>
```

GitHub owner는 실제 계정에 맞춰 Codex가 채운다.

## 3. `config.yaml` 목표 초안

M1에서 실제 검증 전에는 amd64만 표시한다.

```yaml
name: Codex for Home Assistant
version: "0.1.0-dev"
slug: codex_home_assistant
description: Codex CLI, Web Terminal, and Remote SSH for Home Assistant
url: https://github.com/<owner>/codex-for-home-assistant
stage: experimental
startup: application
boot: manual
init: false
arch:
  - amd64

ingress: true
ingress_port: 7681
ingress_stream: true
panel_icon: mdi:console
panel_title: Codex
panel_admin: true

ports:
  22/tcp: 2223
ports_description:
  22/tcp: SSH and Codex Remote SSH port

map:
  - type: homeassistant_config
    path: /config
    read_only: false

homeassistant_api: true
hassio_api: true
hassio_role: manager
apparmor: true

options:
  authorized_keys: []
  web_terminal_auto_start_codex: false
  tmux_session_name: codex-ha
  codex_approval_policy: on-request
  codex_sandbox_mode: danger-full-access
  log_level: info

schema:
  authorized_keys:
    - str
  web_terminal_auto_start_codex: bool
  tmux_session_name: "match(^[A-Za-z0-9._-]{1,64}$)"
  codex_approval_policy: "list(untrusted|on-request|never)"
  codex_sandbox_mode: "list(workspace-write|danger-full-access)"
  log_level: "list(trace|debug|info|notice|warning|error|fatal)"
```

### 명시적으로 넣지 않는 항목

```yaml
# 금지/불필요
hassio_role: admin
docker_api: true
full_access: true
host_network: true
apparmor: false
```

## 4. SSH 포트 설정 UX

사용자 요구사항인 SSH 포트 변경은 Home Assistant UI의 App **Network** 영역에서 제공한다.

```text
Settings → Apps → Codex for Home Assistant → Configuration/Network
22/tcp → 원하는 host port
```

- 기본값: `2223`
- 빈 값/null: 포트 매핑 비활성화 가능
- sshd 내부 포트는 22로 고정
- `ssh_port` JSON 옵션은 만들지 않음

`translations/ko.yaml`의 `network` 설명으로 이 사실을 안내한다.

## 5. App JSON 옵션

### `authorized_keys`

- 타입: string list
- 기본: `[]`
- OpenSSH public key만 허용
- 빈 목록이면 SSH 로그인 기능 degraded/disabled

### `web_terminal_auto_start_codex`

- 타입: bool
- 기본: false
- Web UI 진입 시 Codex 자동 실행 여부

### `tmux_session_name`

- 타입: 제한된 string
- 기본: `codex-ha`
- shell injection을 막기 위해 엄격한 regex 사용

### `codex_approval_policy`

- 기본: `on-request`
- Codex 공식 허용값만 사용

### `codex_sandbox_mode`

- 기본: `danger-full-access`
- App 컨테이너 내부의 Codex 실행 정책
- Home Assistant `full_access`와 다른 개념임을 문서화

### `log_level`

- bashio 표준 로그 수준

## 6. Dockerfile 요구사항

### Base image

- 2026-07-13 확인 기준 `ghcr.io/home-assistant/base:3.24` 사용
- Supervisor 2026.04 BuildKit 구조에 따라 Dockerfile에 base 기본값을 두고 legacy `build.yaml`은 사용하지 않음
- amd64에서 먼저 검증
- Alpine을 선택할 경우 Codex 바이너리의 musl/glibc 호환성을 컨테이너 실행으로 증명

### 필수 도구

```text
bash
ca-certificates
curl
git
jq
yq
yamllint
openssh
ttyd
tmux
sqlite
ripgrep
less
nano 또는 vim
```

추가 빌드 도구는 final image에서 제거한다.

### Codex 설치

우선순위:

1. 공식 release `0.144.1`의 amd64 musl artifact를 GitHub asset SHA-256으로 검증
2. 공식 standalone installer를 빌드 단계에서 사용한 뒤 결과 바이너리 고정
3. npm 방식은 Node 런타임 크기와 Remote SSH 호환성을 비교한 뒤 선택

`latest`만 의존하는 비재현 빌드는 release 전에 제거한다.

## 7. 초기화 계약

초기화 스크립트는 idempotent해야 한다.

- 디렉터리가 이미 있으면 데이터 보존
- `config.toml` 기존 사용자 변경 보존
- host key가 있으면 재생성하지 않음
- authorized_keys는 App 옵션에서 원자적으로 렌더링
- 빈/잘못된 키는 로그로 알려주되 토큰/키 전체를 출력하지 않음
- `/config` 쓰기 테스트는 안전한 임시 파일을 생성 후 삭제해 수행

## 8. 웹 터미널 계약

- ttyd는 loopback/internal network에서 Ingress port만 listen
- write mode 활성
- shell command는 인수 배열 또는 안전하게 인용된 wrapper 사용
- tmux 세션 attach/create
- `TERM=xterm-256color`
- UTF-8 locale 및 한글 입력/출력 검증
- auto-start Codex가 종료되면 shell을 제공

## 9. SSH 계약

권장 sshd 정책:

```text
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
X11Forwarding no
AllowAgentForwarding no (Remote SSH 검증 후 필요 시 조정)
AllowTcpForwarding 최소값 (Remote SSH 검증 후 결정)
Subsystem sftp internal-sftp 또는 필요 시 비활성
```

Codex Desktop Remote SSH가 요구하는 기능을 실제 테스트하기 전 과도하게 기능을 끄지 않는다. 최종 정책은 테스트 증거와 함께 기록한다.

## 10. Runtime environment

웹/SSH shell 모두 아래를 일관되게 가져야 한다. 구현은 `/run/codex-ha/runtime.env`와 root 전용 SSH environment 파일을 매 부팅마다 다시 만들며 비밀값을 `/data`에 복제하지 않는다.

```text
HOME=/data/home
CODEX_HOME=/data/codex
HA_URL=http://supervisor/core/api
SUPERVISOR_URL=http://supervisor
SUPERVISOR_TOKEN=<runtime secret>
PATH=/usr/local/bin:...
```

SSH 세션은 PID 1 환경변수를 자동으로 상속하지 않을 수 있으므로, 토큰을 출력하지 않는 root-only runtime env 파일 또는 안전한 shell initialization 방식을 구현하고 권한을 테스트한다.

## 11. App 문서/표현

- `DOCS.md`: 설치, Web UI, 장치 코드 로그인, SSH, Remote SSH, API helper, 위험 경고, 복구
- `CHANGELOG.md`: Keep a Changelog 스타일
- `icon.png`, `logo.png`: 배포 전 추가
- `translations/en.yaml`, `ko.yaml`: 옵션과 Network 설명
- 패널은 관리자만 표시

## 12. Release image

로컬 개발 단계에서는 local build를 허용한다. 0.1.0 배포 시 GHCR multi-arch 또는 amd64 image를 GitHub Actions로 미리 빌드하고 `config.yaml`의 `image` 필드를 사용한다.
