<p align="center">
  <img src="codex_home_assistant/logo.png" alt="Codex for Home Assistant logo" width="180">
</p>

# Codex for Home Assistant

Home Assistant OS 안에서 OpenAI Codex CLI를 운영하기 위한 amd64 Home Assistant App MVP입니다.

> 비공식 커뮤니티 프로젝트이며 OpenAI 또는 Home Assistant/Nabu Casa와 제휴하거나 이들의 보증을 받는 제품이 아닙니다.

- Home Assistant Ingress 웹 터미널: nginx ACL → ttyd → 공유 tmux 세션
- 공개키 전용 OpenSSH, desktop SSH 프로젝트와 mobile Remote 연결 기반
- Home Assistant `/config` 전체 read-write
- Home Assistant Core REST/WebSocket 접근
- Supervisor API `manager` 운영 helper
- Codex 인증, 설정, SSH host key의 `/data` 영속화
- 기존 사용자 파일을 보존하는 전역 Home Assistant 운영 가드레일

현재 버전은 `0.1.3`, `stage: experimental`, amd64 전용입니다. AppArmor는 활성화되어 있고 Supervisor `admin`, Docker API, App `full_access`, host network는 사용하지 않습니다.

> 이 App은 `/config`의 비밀과 `SUPERVISOR_TOKEN`을 사용할 수 있는 강한 관리자 도구입니다. 신뢰하는 관리자만 사용하고 TCP 2223을 인터넷으로 직접 port-forward하지 마세요.

## Home Assistant에서 설치

이 저장소는 Home Assistant App Store에 추가할 수 있는 public App 저장소입니다.

```text
https://github.com/Kanu-Coffee/codex-for-home-assistant
```

[![Open your Home Assistant instance and add this App repository.](https://my.home-assistant.io/badges/supervisor_store.svg)](https://my.home-assistant.io/redirect/supervisor_store/?repository_url=https%3A%2F%2Fgithub.com%2FKanu-Coffee%2Fcodex-for-home-assistant)

1. Home Assistant에서 **설정 → Apps → App store**를 엽니다.
2. 우측 상단 메뉴의 **Repositories**에 위 URL을 추가합니다.
3. 목록을 새로고침한 뒤 **Codex for Home Assistant**를 선택해 설치합니다.
4. 공개키와 Network 포트를 설정하고 App을 시작합니다.

Supervisor는 public generic manifest `ghcr.io/kanu-coffee/codex-for-home-assistant:0.1.3`을 내려받습니다. 이미지는 공식 Home Assistant builder action으로 amd64에서 미리 빌드하며 App Store 설치 중 소스 컴파일을 요구하지 않습니다. 실제 HAOS 기능 결과는 `progress.md`의 M2 항목별 증거를 기준으로 합니다.

기존 `0.1.3-dev` App은 삭제하지 말고 일반 업데이트하세요. `0.1.3`은 `/data` 형식이나 영구 파일을 변경·초기화하지 않으므로 완전 삭제나 재설치가 필요하지 않습니다.

설치, Codex device login, Windows SSH config, Remote SSH, API helper, 안전한 서비스 호출과 복구 절차는 [App 사용 설명서](codex_home_assistant/DOCS.md)를 따르세요.

### HACS 지원 여부

HACS가 지원하는 저장소 유형에는 Home Assistant App(구 Add-on)이 없으므로 이 저장소를 HACS custom/default repository로 등록할 수 없습니다. Integration이나 Dashboard로 잘못 등록해도 App 설치로 연결되지 않습니다. [HACS 공식 repository types](https://hacs.xyz/docs/use/repositories/type/) 대신 위 Home Assistant App repository 버튼이나 URL을 사용하세요.

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

GitHub Actions는 같은 amd64 build/smoke와 Home Assistant App linter를 실행하고, version과 동일한 Git tag에서만 public GHCR image와 generic manifest를 게시합니다.

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

로컬 Docker 검증은 image build, Codex 실행, S6 서비스, ttyd/nginx, 동일 tmux pane 재접속·resize, 공개키 sshd, 영속 데이터와 helper 오류 처리를 다룹니다. 실제 HAOS에서는 public 설치·시작, auto-start false/true, device-code 로그인과 재시작 인증 유지, Web UI 재접속·resize, `/config` 쓰기, Core REST 조회·저위험 service call, Supervisor 정보·로그 helper·설정 검사, SSH host identity 유지와 mobile Remote SSH 프로젝트 작업을 확인했습니다. amd64 M1/M2 수용 기준은 PASS입니다.

Supervisor/Core/App start/stop/restart 실동작은 manager API 기능 범위에 포함되지만 운영 중단 위험이 있으므로, 명시적인 유지보수 승인 없이 완료 판정을 위해 자동 실행하지 않습니다.

자세한 최신 결과와 명령 증거는 `progress.md`에 기록합니다.

## License

Project source is licensed under Apache License 2.0. Runtime dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
