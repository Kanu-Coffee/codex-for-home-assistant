# Codex for Home Assistant

Codex CLI, Home Assistant Ingress 웹 터미널, 공개키 SSH와 Playwright Headless Chromium renderer를 하나의 실험용 Home Assistant App에 제공합니다. Codex는 `/config` 전체를 read-write로 사용하고 Core API와 Supervisor `manager` API를 호출할 수 있습니다.

> 현재 공개 사전 릴리스는 `0.2.1`, 이 소스의 다음 후보는 `0.2.2`이며 amd64 전용 `experimental` 단계입니다. 기존 HAOS 자동 시작, Web UI, Codex 로그인·재시작 인증 보존, Core/Supervisor API, 공개키 SSH와 host identity 보존은 실기 확인했습니다. `0.2.2`의 자동 최소권한 browser 인증은 local container fixture까지 검증했고 실제 HAOS/AppArmor dashboard E2E는 아직 전입니다. 실제 장치 제어와 Core/App lifecycle 변경은 안전상 자동 수용 시험에서 제외합니다.

비공식 커뮤니티 프로젝트이며 OpenAI 또는 Home Assistant/Nabu Casa와 제휴하거나 이들의 보증을 받는 제품이 아닙니다.

로컬 M1에서는 amd64 image build, Codex archive SHA-256/버전, S6 init과 ttyd/nginx 기동, `/config` RW probe, 공개키 SSH와 비밀번호 거부, host key/config 재시작 영속성, API helper mock·token redaction, 전체 lint를 확인했습니다. 정확한 최신 결과는 저장소 `progress.md`를 기준으로 합니다.

## 설치

Home Assistant App Store의 **Repositories**에 다음 public URL을 추가하고 **Codex for Home Assistant**를 설치하세요.

```text
https://github.com/Kanu-Coffee/codex-for-home-assistant
```

Supervisor는 public GHCR에서 현재 공개 version `0.2.1`의 amd64 image를 내려받습니다. 공개 tag의 인증 없는 pull과 전체 컨테이너 smoke를 확인했으며 설치 장치에서 Dockerfile을 소스 빌드하지 않습니다.

기존 App은 완전 삭제하거나 초기화하지 말고 일반 업데이트하세요. Playwright MCP는 image-owned system config로 추가되므로 `/data` 마이그레이션이나 수동 MCP 등록이 필요하지 않습니다. 업데이트 뒤 새 Codex 세션을 시작해야 새 도구를 읽습니다.

## 핵심 동작

- Web UI는 `/config`에서 시작하고 브라우저 재접속 시 같은 `tmux` 세션에 붙습니다.
- `web_terminal_auto_start_codex: true`이면 새 tmux 세션에서 Codex를 한 번 실행한 뒤 Bash로 돌아옵니다.
- SSH는 공개키 전용이며 App **Network**의 기본 호스트 포트는 `2223`입니다.
- `CODEX_HOME=/data/codex`; `ha-codex-login`은 device code 로그인을 시작합니다.
- 새 Codex 세션은 `/etc/codex/config.toml`에 등록된 `playwright` MCP와 격리형 Headless Chromium을 자동으로 사용합니다.
- 전역 `AGENTS.md`와 `AGENTS.override.md`가 모두 없을 때만 Home Assistant 운영 가드레일을 생성하며 사용자 파일은 보존합니다.
- `ha-api`, `supervisor-api`, `ha-config-check`, `ha-core-logs`, `ha-addon-logs`를 제공합니다.
- Supervisor `admin`, Docker API, App `full_access`, host network는 사용하지 않습니다.

## Browser renderer 빠른 사용법

App 안에서 실행한 웹 개발 서버는 그 서버가 출력한 URL(예: `http://127.0.0.1:3000`)을, Home Assistant dashboard는 browser 전용 `http://127.0.0.1:8099`를 Codex에 열어 달라고 요청하세요. 먼저 기본 `1440x900`에서 screenshot, console error/warning, 정적 리소스를 포함한 network URL·method·status를 확인하고, `browser_resize`로 `390x844`로 바꿔 mobile 화면을 다시 확인합니다. 관련 도구는 `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`입니다. 상세 request/response header와 body를 반환하는 도구는 제공하지 않습니다.

`0.2.2` 후보에서는 App Web terminal에서 `ha-browser-auth-setup`을 한 번 명시적으로 실행하면 전용 active·local-only·sole `system-read-only` user와 long-lived token을 자동 설정합니다. 임시 비밀번호 credential과 OAuth refresh token은 제거하고, root-only 관리 상태를 App 재시작·업데이트 뒤 재검증해 재사용합니다. 설치·업데이트·재시작만으로 Home Assistant user/token을 만들거나 인증 설정을 바꾸지는 않습니다. 더 이상 사용하지 않을 때는 `ha-browser-auth-remove`로 App이 관리하는 identity를 제거합니다.

기존 마스킹 `home_assistant_browser_token`은 관리형 token보다 우선하는 명시적 수동 override/fallback으로 계속 지원합니다. 어느 방식이든 정책이나 token 검증에 실패하면 login page로 fail closed되며 Supervisor/system token은 Chromium에 전달하지 않습니다. `ha-browser-network-info`로 확인하는 현재 App `/32`는 동적 주소라 `trusted_networks` 또는 `trusted_proxies`에 넣지 않습니다. Home Assistant `configuration.yaml`, `.storage`, provider 순서와 기존 `homeassistant` provider는 수정하지 않습니다. 내부 Core가 HTTPS이면 image CA와 `homeassistant` hostname을 엄격히 검증합니다.

결과 파일은 `/run/codex-ha/playwright-output`에 최대 50 MiB만 저장하고 임의 `filename`을 거부합니다. App 시작·재시작 때 기존 결과를 삭제하며 `/data`에는 보존하지 않습니다. exact token 문자열은 text output에서 마스킹되지만 인코딩·분할된 비밀, screenshot과 page data 전체를 정화하지는 않으므로 민감한 Home Assistant 정보가 나타날 수 있습니다. 클릭·입력은 실제 상태를 변경할 수 있으므로 별도 승인이 필요합니다. 공개 `0.2.0` amd64 image에서 MCP initialize와 제한된 tool discovery, desktop `1440x900`·mobile `390x844` DOM viewport 및 PNG, console·uncaught error, network 200/302/404/500·전송 실패, `filename`·금지 도구 거부와 token 비노출을 포함한 전체 Docker smoke는 **PASS**입니다. 모의 Supervisor/Core gateway의 token bootstrap, 인증 REST, frontend marker, WebSocket upgrade와 loopback 외부 차단도 통과했습니다. Public `0.1.3` image에서 `0.2.0`으로 container만 교체한 update smoke도 `/data`·`/config`, Codex 인증 marker와 SSH identity 보존 및 새 MCP 실행을 확인했습니다. 큰 desktop PNG는 MCP 응답 한도에 맞춰 같은 종횡비로 축소될 수 있습니다. 현재 Alpine 3.24 + system Chromium 조합은 upstream Playwright의 공식 Alpine/musl 지원 대상이 아니며, 실제 HAOS의 dashboard 인증·WebSocket과 Supervisor update는 아직 **NOT RUN**입니다.

Local `0.2.2` 최종 후보 image는 관리형 user/token 생성·재사용·회전·제거, 강제 종료 임시파일 회수, 응답 유실·지속 cleanup 실패 복구, 동시 실행 차단, Core/provider 장애와 정책 변조 fail-closed를 fixture에서 확인했습니다. 내부 `8099` fixture의 desktop/mobile PNG, console/network와 direct Core REST/WebSocket, public `0.2.1` replacement smoke도 통과했습니다. 실제 HAOS dashboard/AppArmor 경로는 아직 **NOT RUN**입니다.

설치, Windows SSH config, Codex Desktop 요구사항, 인증 파일 복사, API/서비스 호출 안전 절차와 복구 방법은 [DOCS.md](./DOCS.md)를 반드시 읽으세요.

## 보안 경고

이 App은 `secrets.yaml`, `.storage`, 데이터베이스를 포함한 `/config` 전체와 Home Assistant runtime API token에 접근합니다. TCP 2223을 인터넷으로 port-forward하지 말고 외부 접속은 제한된 VPN/mesh network를 사용하세요. Codex `auth.json`, `SUPERVISOR_TOKEN`, SSH 개인키를 Git·채팅·로그에 넣지 마세요.
