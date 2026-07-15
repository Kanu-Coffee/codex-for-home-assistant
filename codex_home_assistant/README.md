# Codex for Home Assistant

Codex CLI, Home Assistant Ingress 웹 터미널, 공개키 SSH와 Playwright Headless Chromium renderer를 하나의 실험용 Home Assistant App에 제공합니다. Codex는 `/config` 전체를 read-write로 사용하고 Core API와 Supervisor `manager` API를 호출할 수 있습니다.

> 현재 공개 사전 릴리스는 `0.3.1`이며 amd64 전용 `experimental` 단계입니다. 정확한 공개 이미지 자동 회귀는 PASS했지만 후속 실제 HAOS/Core `2026.7.2`에서 automation-related 30건 중 2건의 `unknown_error` 때문에 catalog는 FAIL했습니다. Core 연결·daemon/DB·privacy는 PASS, Core restart는 PARTIAL입니다. `0.3.2` 후보는 이 명시적 related 거부만 격리하고 전체 로컬 image 회귀를 통과했으며, 아직 공개/실기 재시험 전입니다.

비공식 커뮤니티 프로젝트이며 OpenAI 또는 Home Assistant/Nabu Casa와 제휴하거나 이들의 보증을 받는 제품이 아닙니다.

로컬 M1에서는 amd64 image build, Codex archive SHA-256/버전, S6 init과 ttyd/nginx 기동, `/config` RW probe, 공개키 SSH와 비밀번호 거부, host key/config 재시작 영속성, API helper mock·token redaction, 전체 lint를 확인했습니다. 정확한 최신 결과는 저장소 `progress.md`를 기준으로 합니다.

## 설치

Home Assistant App Store의 **Repositories**에 다음 public URL을 추가하고 **Codex for Home Assistant**를 설치하세요.

```text
https://github.com/Kanu-Coffee/codex-for-home-assistant
```

Supervisor는 public GHCR에서 현재 공개 version `0.3.1`의 amd64 image를 내려받습니다. 공개 tag의 인증 없는 pull과 공개 이미지 회귀, 동일 merge SHA의 native Linux 전체 컨테이너 smoke를 확인했으며 설치 장치에서 Dockerfile을 소스 빌드하지 않습니다.

기존 App은 완전 삭제하거나 초기화하지 말고 일반 업데이트하세요. Playwright MCP는 image-owned system config로 추가되므로 `/data` 마이그레이션이나 수동 MCP 등록이 필요하지 않습니다. Public `0.2.2`에서 `0.2.3`으로 올린 첫 시작은 새 user-file option이 없어 기본 `preserve`로 동작합니다. 업데이트 뒤 새 Codex 세션을 시작해야 새 도구를 읽습니다.

## 핵심 동작

- Web UI는 `/config`에서 시작하고 브라우저 재접속 시 같은 `tmux` 세션에 붙습니다.
- `web_terminal_auto_start_codex: true`이면 새 tmux 세션에서 Codex를 한 번 실행한 뒤 Bash로 돌아옵니다.
- SSH는 공개키 전용이며 App **Network**의 기본 호스트 포트는 `2223`입니다.
- `CODEX_HOME=/data/codex`; `ha-codex-login`은 device code 로그인을 시작합니다.
- 새 Codex 세션은 `/etc/codex/config.toml`에 등록된 `playwright` MCP와 격리형 Headless Chromium을 자동으로 사용합니다.
- 전역 `AGENTS.md`와 `AGENTS.override.md`가 모두 없을 때 Home Assistant 운영 가드레일을 생성하며 기본 `preserve`에서는 사용자 파일을 보존합니다.
- 구성의 `codex_user_files_update_mode`로 base `AGENTS.md` 또는 base 지침과 user `config.toml`을 현재 App 기본본으로 선택 갱신할 수 있습니다.
- `ha-api`, `supervisor-api`, `ha-config-check`, `ha-core-logs`, `ha-addon-logs`를 제공합니다.
- `ha-memoryd`는 고정 Supervisor WebSocket proxy와 image-pinned `ws`로 catalog를 갱신합니다. Unavailable automation의 legal null config를 유지하고, `0.3.2` 후보는 공식 automation-related payload가 실기와 같은 `unknown_error`로 거부된 경우만 config-derived 관계와 bounded warning으로 격리합니다. 다른 server command code, server/client timeout, unauthorized, invalid format, transport/protocol/malformed/config 실패는 계속 fail closed하며 원문·token 없이 closed status code로 구분합니다.
- Supervisor `admin`, Docker API, App `full_access`, host network는 사용하지 않습니다.

## Browser renderer 빠른 사용법

App 안에서 실행한 웹 개발 서버는 그 서버가 출력한 URL(예: `http://127.0.0.1:3000`)을 사용합니다. Home Assistant dashboard는 `0.2.3`의 image-managed Codex 지침과 Playwright 도구 설명이 browser 전용 `http://127.0.0.1:8099`를 바로 선택하므로 사용자가 매번 URL이나 별도 browser skill을 지정할 필요가 없습니다. 먼저 기본 `1440x900`에서 screenshot, console error/warning, 정적 리소스를 포함한 network URL·method·status를 확인하고, `browser_resize`로 `390x844`로 바꿔 mobile 화면을 다시 확인합니다. 관련 도구는 `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`입니다. 상세 request/response header와 body를 반환하는 도구는 제공하지 않습니다.

`0.2.3`에서는 App 설정의 **헤드리스 브라우저 자동 인증**이 기본 ON입니다. 신규 설치와 이 option이 없던 기존 설치는 App 시작 시 전용 active·local-only·sole `system-read-only` user와 long-lived token을 자동 생성하거나 재사용하므로 terminal 명령이 필요하지 않습니다. OFF로 저장하고 App을 재시작하면 다음 browser 세션부터 자동 로그인이 중지되며 관리형 identity는 보존됩니다. 다시 ON이면 같은 identity를 재사용합니다. 완전히 삭제하려면 OFF 상태와 기존 browser 세션 종료를 확인한 뒤 `ha-browser-auth-remove`를 실행합니다.

기존 마스킹 `home_assistant_browser_token`은 관리형 token보다 우선하는 명시적 수동 override/fallback으로 계속 지원합니다. 어느 방식이든 정책이나 token 검증에 실패하면 login page로 fail closed되며 Supervisor/system token은 Chromium에 전달하지 않습니다. `ha-browser-network-info`로 확인하는 현재 App `/32`는 동적 주소라 `trusted_networks` 또는 `trusted_proxies`에 넣지 않습니다. Home Assistant `configuration.yaml`, `.storage`, provider 순서와 기존 `homeassistant` provider는 수정하지 않습니다. 내부 Core가 HTTPS이면 image CA와 `homeassistant` hostname을 엄격히 검증합니다.

결과 파일은 `/run/codex-ha/playwright-output`에 최대 50 MiB만 저장하고 임의 `filename`을 거부합니다. App 시작·재시작 때 기존 결과를 삭제하며 `/data`에는 보존하지 않습니다. exact token 문자열은 text output에서 마스킹되지만 인코딩·분할된 비밀, screenshot과 page data 전체를 정화하지는 않으므로 민감한 Home Assistant 정보가 나타날 수 있습니다. 클릭·입력은 실제 상태를 변경할 수 있으므로 별도 승인이 필요합니다. 공개 `0.3.1` amd64 image의 인증 없는 generic/per-arch resolve·pull, version/arch/source label과 자동 smoke는 **PASS**입니다. generic/per-arch OCI index digest는 `sha256:6e726ad1ce95714fb4d4f29dcbb51f762cdd3e7b3eeb9c1be7edcbb6ff1c0126`, runtime manifest digest는 `sha256:175c1a2b4d45897f713ab37f71c96b96c9b182e2f74340843c18aa34e7d84954`이고 `latest`는 없습니다. 동일 merge SHA의 [main CI 29391446446](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29391446446)과 [Builder 29391579529](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29391579529)이 PASS했습니다. 별도 실제 HAOS `0.3.1` 실기에서는 catalog가 related `unknown_error`로 FAIL했고 Core restart는 PARTIAL, privacy는 PASS였습니다.

## 선택형 user config/지침 갱신

App **구성**의 `codex_user_files_update_mode`는 `preserve`(기본), `refresh_agents`, `refresh_all` 중 하나입니다. `refresh_agents`는 base `AGENTS.md`를 image 지침으로, `refresh_all`은 base 지침과 `/data/codex/config.toml`을 현재 App version에서 target별 한 번 기본본으로 reset합니다. config 기본본은 현재 approval/sandbox option을 반영합니다. 같은 version의 재시작은 반복하지 않지만 mode를 유지하면 다음 version에서 다시 한 번 적용됩니다. 일회성 갱신 후에는 `preserve`로 되돌리세요.

App version별 1회 규칙은 향후 `0.3.2`에도 적용됩니다. `refresh_agents` 또는 `refresh_all`을 선택한 채로 업데이트하면 선택 target이 `0.3.2`에서 한 번 다시 갱신됩니다. 재적용을 원하지 않으면 **업데이트 전** Home Assistant App **구성**에서 `preserve`로 저장하세요.

`refresh_all`은 사용자가 추가한 MCP/model/provider와 기타 config를 제거할 수 있습니다. 적용 전 원본은 `/data/codex/backups/user-files`의 root-only transaction에 저장됩니다. `AGENTS.override.md`는 보존되어 base보다 높은 우선순위를 유지하며 인증/session, SSH/browser identity, App options와 Home Assistant `/config`도 갱신 대상이 아닙니다. symlink, 다중 hardlink 또는 일반 파일이 아닌 target은 따라가지 않고 전체 선택을 fail closed합니다. 기존 설치의 첫 `0.2.3` 시작은 `preserve`이므로 업데이트만으로 사용자 파일을 변경하지 않습니다. 자세한 backup/복구 절차는 [DOCS.md](./DOCS.md)를 따르세요.

공개 `0.3.1`의 browser 경로는 option 누락/default ON 자동 생성, restart identity 재사용, OFF/ON 보존·재활성화, ON 삭제 거부·OFF 삭제와 수동 override 억제를 fixture와 정확한 공개 이미지에서 확인했습니다. model-visible `8099` 지침, 내부 gateway의 desktop/mobile PNG·console/network·direct Core REST/WebSocket, 선택형 user-file refresh와 public `0.3.0` replacement smoke도 통과했습니다. 실제 Home Assistant 구성 UI/Supervisor 일반 업데이트와 HAOS AppArmor의 인증된 `8099` dashboard 경로는 public `0.2.3`에서 사용자 확인 **PASS**입니다. 별도로 0.3.0과 0.3.1 memory catalog live audit는 FAIL했습니다. 0.3.1 실기는 exact related failure와 privacy/restart 경계를 확정했고, 0.3.2 후보는 이를 자동 재현·격리하지만 실제 HAOS 재시험 전입니다.

설치, Windows SSH config, Codex Desktop 요구사항, 인증 파일 복사, API/서비스 호출 안전 절차와 복구 방법은 [DOCS.md](./DOCS.md)를 반드시 읽으세요.

## 보안 경고

이 App은 `secrets.yaml`, `.storage`, 데이터베이스를 포함한 `/config` 전체와 Home Assistant runtime API token에 접근합니다. TCP 2223을 인터넷으로 port-forward하지 말고 외부 접속은 제한된 VPN/mesh network를 사용하세요. Codex `auth.json`, `SUPERVISOR_TOKEN`, SSH 개인키를 Git·채팅·로그에 넣지 마세요.
