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
- Playwright MCP 기반 격리형 Headless Chromium UI 렌더링·진단
- Codex 인증, 설정, SSH host key의 `/data` 영속화
- 기존 사용자 파일을 보존하는 전역 Home Assistant 운영 가드레일

현재 공개 사전 릴리스는 [`0.2.1`](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.2.1)이고 이 소스의 다음 후보는 `0.2.2`입니다. `stage: experimental`, amd64 전용이며 `0.2.2`의 자동 browser 인증은 local container fixture까지 검증됐고 실제 HAOS/AppArmor dashboard E2E는 아직 검증 전입니다. AppArmor는 활성화되어 있고 Supervisor `admin`, Docker API, App `full_access`, host network는 사용하지 않습니다.

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

Supervisor는 public generic manifest `ghcr.io/kanu-coffee/codex-for-home-assistant:0.2.1`을 내려받습니다. 이 tag는 공식 Home Assistant builder action으로 게시됐으므로 App Store 설치 중 소스 컴파일을 요구하지 않습니다. 실제 HAOS 기능 결과는 `progress.md`의 M2 항목별 증거를 기준으로 합니다.

기존 App은 삭제하지 말고 일반 업데이트하세요. 브라우저 MCP는 image-owned system config로 제공되므로 `/data` 초기화나 MCP 재등록이 필요하지 않습니다. 업데이트가 끝난 뒤 실행 중이던 Codex는 종료하고 새 세션을 시작해야 새 system config를 읽습니다.

설치, Codex device login, Windows SSH config, Remote SSH, API helper, 안전한 서비스 호출과 복구 절차는 [App 사용 설명서](codex_home_assistant/DOCS.md)를 따르세요.

### HACS 지원 여부

HACS가 지원하는 저장소 유형에는 Home Assistant App(구 Add-on)이 없으므로 이 저장소를 HACS custom/default repository로 등록할 수 없습니다. Integration이나 Dashboard로 잘못 등록해도 App 설치로 연결되지 않습니다. [HACS 공식 repository types](https://hacs.xyz/docs/use/repositories/type/) 대신 위 Home Assistant App repository 버튼이나 URL을 사용하세요.

## 실제 브라우저로 웹 UI 확인

`0.2.0` 이상 image에는 `@playwright/mcp`와 Alpine의 `chromium-headless-shell`이 포함됩니다. App의 `/etc/codex/config.toml`이 `playwright` MCP server를 system layer에 등록하므로 업데이트 뒤 시작한 새 Codex 세션에는 별도 설치나 사용자 `config.toml` 수정 없이 브라우저 도구가 나타납니다. `/data/codex/config.toml`은 그대로 보존되며, 사용자가 같은 server 이름을 명시적으로 재정의하거나 비활성화한 경우에는 그 설정을 먼저 확인하세요.

Codex에 다음 URL 중 하나와 확인 항목을 자연어로 요청합니다.

| 대상 | 브라우저에서 여는 URL |
| --- | --- |
| App 컨테이너에서 실행한 개발 서버 | 서버가 출력한 정확한 주소. 예: `http://127.0.0.1:3000` |
| Home Assistant 대시보드 | `http://127.0.0.1:8099` |

`8099`는 Headless Chromium 전용 loopback gateway이며 외부 브라우저나 Ingress에서 여는 주소가 아닙니다. 기본 desktop viewport는 `1440x900`입니다. desktop screenshot과 console error/warning, 정적 리소스를 포함한 network request를 먼저 확인한 다음 `browser_resize`로 `390x844`로 바꾸어 mobile screenshot과 같은 진단을 다시 확인하도록 요청하세요. `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`가 각각 화면, 콘솔, URL·method·status 중심의 로딩 상태를 담당합니다. 민감 정보 노출을 줄이기 위해 상세 request/response header와 body를 반환하는 도구는 제공하지 않습니다. viewport resize는 반응형 layout 검사이며 mobile User-Agent, touch, 실제 기기 성능까지 에뮬레이션하지는 않습니다.

`0.2.2` 후보에서는 App Web terminal에서 `ha-browser-auth-setup`을 한 번 명시적으로 실행하면 전용 활성·로컬 전용 `system-read-only` 사용자를 만들고, 공식 Home Assistant login/token API로 long-lived token을 발급한 뒤 임시 비밀번호 credential과 OAuth refresh token을 자동 제거합니다. 사용자가 token을 복사하거나 App 옵션에 붙여 넣을 필요가 없고, `/data/browser-auth`의 root-only 상태를 재시작·업데이트 뒤 자동 재검증해 재사용합니다. 설치·업데이트·재시작만으로 Home Assistant user/token을 만들거나 인증 설정을 바꾸지는 않습니다. `ha-browser-auth-remove`는 전용 identity를 안전하게 제거합니다. 기존 마스킹 `home_assistant_browser_token`은 명시적 수동 override/fallback으로 그대로 지원합니다.

Supervisor/system token은 Chromium에 전달하지 않습니다. App 시작과 각 MCP 시작 시 실제 사용자·credential·유일한 long-lived token을 교차검증하고 조금이라도 다르면 자동 로그인을 끕니다. App의 동적 Docker `/32`나 전체 Docker 대역을 `trusted_networks`/`trusted_proxies`에 추가하지 않고 기존 `homeassistant` provider와 Home Assistant 설정 파일을 변경하지 않습니다. 내부 Core가 HTTPS이면 image CA와 `homeassistant` hostname 검증에 실패할 때 우회하지 않고 fail closed합니다. 상세 절차와 수동 fallback은 [App 사용 설명서](codex_home_assistant/DOCS.md)를 따르세요.

```text
http://127.0.0.1:3000을 열어 1440x900 desktop 화면을 캡처하고,
console error/warning과 정적 파일을 포함한 실패 network request를 확인해 줘.
그다음 390x844로 resize해 mobile 화면을 다시 캡처하고 같은 항목을 비교해 줘.
```

브라우저 context는 세션별로 격리되고 저장하지 않습니다. screenshot 등 파일 결과는 최대 50 MiB의 `/run/codex-ha/playwright-output`에만 두며 임의 `filename` 저장을 거부합니다. App 시작·재시작 때 기존 결과를 삭제하고 `/data`에는 보존하지 않습니다. 검증된 browser token의 exact 문자열은 MCP text output에서 마스킹하지만, 인코딩되거나 분할된 비밀과 대시보드 화면·console·network 결과 전체를 정화하는 기능은 아닙니다. 결과에는 entity, 위치, 내부 URL 등 민감한 정보가 보일 수 있으므로 Git, 이슈, 채팅에 올리기 전에 반드시 검토하세요. read-only user도 모든 entity state를 볼 수 있으며 custom integration의 권한 결함까지 막는 경계는 아니므로 단순 렌더링 요청을 제어 작업 승인으로 간주하지 않습니다.

공개 `0.2.0` amd64 image의 인증 없는 pull과 전체 Docker smoke는 **PASS**입니다. generic manifest digest는 `sha256:2920cabd22969b8b8ce84048bba4d42398d633500de9576f6f493464af64e769`이며 mutable `latest` tag는 게시하지 않았습니다. 실제 MCP smoke에서 initialize와 제한된 `tools/list`, desktop `1440x900`·mobile `390x844` DOM viewport 및 PNG, console·uncaught error 수집, network 200/302/404/500 및 전송 실패 구분, 임의 `filename`·금지 도구 거부와 token 비노출을 확인했습니다. 모의 Supervisor/Core를 연결한 local gateway에서도 token bootstrap, 인증된 REST, frontend marker, WebSocket upgrade와 loopback 외부 차단이 통과했습니다. Public `0.1.3` container를 `0.2.0`으로 교체하는 update smoke는 동일 `/data`·`/config`에서 Codex 설정·인증 marker·운영 지침·SSH identity를 보존하면서 새 Playwright MCP가 동작함을 확인했습니다. 큰 desktop PNG는 MCP 응답 한도에 맞춰 같은 종횡비로 축소될 수 있습니다. 그러나 Playwright upstream은 Alpine/musl을 공식 browser 실행 플랫폼으로 지원하지 않으며, 이 구현은 Playwright 번들 browser 대신 Alpine Chromium을 사용합니다. AppArmor가 적용된 실제 HAOS의 `8099` dashboard 인증·WebSocket·resource loading과 실제 Supervisor update는 아직 **NOT RUN**입니다.

Local `0.2.2` 최종 후보 image는 managed-auth smoke, full Docker smoke와 public `0.2.1` replacement smoke를 통과했습니다. 자동 user/token 생성·재사용·회전·제거, 강제 종료 임시파일 회수, 응답 유실·지속 cleanup 실패 복구, App replacement, 동시 실행 차단, Core/provider 장애와 정책 변조 fail-closed를 확인했고, 내부 `8099` fixture는 desktop/mobile 실제 PNG, console/network, direct Core REST/WebSocket까지 통과했습니다. 이 결과는 실제 사용자 HAOS/AppArmor dashboard 실기 PASS를 뜻하지 않습니다.

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
| `ha-browser-auth-setup` | 전용 읽기 전용 dashboard identity와 token 자동 설정·재사용 |
| `ha-browser-auth-remove` | App이 관리하는 dashboard identity 안전 제거 |
| `ha-browser-auth-status` | browser 자동 로그인 검증 상태 조회 |

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
