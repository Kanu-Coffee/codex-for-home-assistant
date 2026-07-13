# Codex for Home Assistant

Home Assistant OS 안에서 OpenAI Codex CLI를 운영하기 위한 amd64 Home Assistant App MVP입니다.

- Home Assistant Ingress 웹 터미널: nginx ACL → ttyd → 공유 tmux 세션
- 공개키 전용 OpenSSH와 Codex Desktop SSH 연결 기반
- Home Assistant `/config` 전체 read-write
- Home Assistant Core REST/WebSocket 접근
- Supervisor API `manager` 운영 helper
- Codex 인증, 설정, SSH host key의 `/data` 영속화

현재 버전은 `0.1.1-dev`, `stage: experimental`, amd64 전용입니다. AppArmor는 활성화되어 있고 Supervisor `admin`, Docker API, App `full_access`, host network는 사용하지 않습니다.

> 이 App은 `/config`의 비밀과 `SUPERVISOR_TOKEN`을 사용할 수 있는 강한 관리자 도구입니다. 신뢰하는 관리자만 사용하고 TCP 2223을 인터넷으로 직접 port-forward하지 마세요.

## Home Assistant에서 설치

이 저장소는 Home Assistant App Store에 추가할 수 있는 public App 저장소입니다.

```text
https://github.com/Kanu-Coffee/codex-for-home-assistant
```

1. Home Assistant에서 **설정 → Apps → App store**를 엽니다.
2. 우측 상단 메뉴의 **Repositories**에 위 URL을 추가합니다.
3. 목록을 새로고침한 뒤 **Codex for Home Assistant**를 선택해 설치합니다.
4. 공개키와 Network 포트를 설정하고 App을 시작합니다.

현재 `config.yaml`에는 registry `image`가 없으므로 Supervisor가 저장소의 Dockerfile을 amd64 장치에서 빌드합니다. 첫 설치는 Home Assistant base image, Alpine 패키지와 Codex release 다운로드 때문에 시간이 걸릴 수 있습니다. `0.1.1-dev` experimental 버전이며 실제 HAOS 기능 결과는 사용자가 검증하는 M2 항목입니다.

설치, Codex device login, Windows SSH config, Remote SSH, API helper, 안전한 서비스 호출과 복구 절차는 [App 사용 설명서](codex_home_assistant/DOCS.md)를 따르세요.

## 로컬 빌드

```bash
docker build \
  --platform linux/amd64 \
  --build-arg BUILD_ARCH=amd64 \
  --tag codex-for-home-assistant:test \
  codex_home_assistant
```

Docker가 있는 Linux 개발 환경에서는 전체 컨테이너 smoke test를 실행할 수 있습니다.

```bash
tests/docker-smoke.sh codex-for-home-assistant:test
```

정적·단위 검사:

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -ra
yamllint -c .yamllint .
shellcheck <scripts...>
npx --yes markdownlint-cli2@0.23.0
```

GitHub Actions도 같은 amd64 build/smoke와 Home Assistant App linter를 실행합니다.

## 주요 명령

| 명령 | 기능 |
| --- | --- |
| `ha-codex` | `/config`에서 Codex 실행 |
| `ha-codex-login` | `codex login --device-auth` 실행 |
| `ha-api` | Core REST API proxy 호출 |
| `supervisor-api` | Supervisor API 호출 및 `result` 검사 |
| `ha-config-check` | Home Assistant 설정 검사 |
| `ha-core-logs` | Core 로그 조회 |
| `ha-addon-logs` | 지정 App 로그 조회 |

## 저장소 구조

```text
codex_home_assistant/  Home Assistant App manifest, image, rootfs, docs
tests/                 policy/unit/container smoke tests
.github/workflows/     lint, amd64 build, container smoke CI
AGENTS.md              에이전트 작업 진입점
rules.md               최상위 개발·보안·검증 규칙
progress.md            실제 완료/미검증 상태의 단일 기준
```

문서 우선순위와 전체 설계는 `AGENTS.md`의 읽기 순서를 따릅니다. 구현 상태는 [progress.md](progress.md), 권한과 위험은 [security.md](security.md), 검증 시나리오는 [test_plan.md](test_plan.md)를 기준으로 합니다.

## 검증 경계

로컬 Docker 검증은 image build, Codex 실행, S6 서비스, ttyd/nginx, 공개키 sshd, 영속 데이터와 helper 오류 처리를 다룹니다. 다음은 실제 HAOS amd64/Supervisor 환경에서 통과하기 전까지 완료가 아닙니다.

- Home Assistant App repository 설치와 Ingress/WebSocket/resize
- device code 인증 및 App update 뒤 인증 유지
- Home Assistant Network mapping을 통한 Windows SSH
- Codex Desktop Remote SSH app server on Alpine/musl
- 실제 `/config`, Core 서비스 호출, Supervisor `manager` endpoint

자세한 최신 결과와 명령 증거는 `progress.md`에 기록합니다.

## License

Project source is licensed under Apache License 2.0. Runtime dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
