# Codex for Home Assistant 사용 설명서

> 공개 사전 릴리스 `0.2.0`은 amd64 전용이며 Home Assistant `stage: experimental`을 유지합니다. public image와 browser renderer 컨테이너 smoke는 PASS지만 새 renderer의 HAOS 실기 검증은 아직 전입니다. `/config` 전체를 쓰고 Home Assistant Core API와 Supervisor `manager` API를 호출할 수 있는 강한 관리자 도구이므로 인터넷에 SSH 포트를 직접 공개하지 마세요.

## 현재 제공 범위

- 컨테이너 안에 고정된 Codex CLI (`codex-cli 0.144.1`)
- Home Assistant Ingress 기반 웹 터미널 (`ttyd` + 공유 `tmux` 세션)
- 공개키 전용 OpenSSH, desktop SSH 프로젝트와 mobile Remote 연결 기반
- Home Assistant 설정 전체를 `/config`에 read-write로 매핑
- Core REST API와 Supervisor `manager` API helper
- Playwright MCP와 격리형 Headless Chromium을 이용한 웹 UI·dashboard 렌더링 진단
- `/data`에 Codex 인증, 설정, SSH host key 영속화
- 기존 사용자 지침을 덮어쓰지 않는 전역 Home Assistant 운영 가드레일

다음 권한은 의도적으로 제공하지 않습니다: Supervisor `admin`, Docker API, Home Assistant App `full_access`, host network, AppArmor 비활성화.

`codex_sandbox_mode: danger-full-access`는 **이 App 컨테이너 안에서의 Codex 정책**입니다. Home Assistant의 `full_access: true`나 HAOS host 권한을 뜻하지 않습니다.

## 설치: public App 저장소

Home Assistant의 공식 [App repository](https://developers.home-assistant.io/docs/apps/repository/) 방식으로 다음 public GitHub URL을 App Store에 추가합니다.

```text
https://github.com/Kanu-Coffee/codex-for-home-assistant
```

`config.yaml`은 public generic manifest `ghcr.io/kanu-coffee/codex-for-home-assistant`를 사용합니다. Supervisor는 App version과 같은 공개 `0.2.0` tag의 미리 빌드된 amd64 이미지를 내려받으므로 설치 장치에서 소스 빌드를 하지 않습니다. generic/per-architecture tag의 인증 없는 pull과 `linux/amd64` manifest를 확인했습니다.

요구사항:

- Home Assistant OS/Supervised와 Supervisor
- amd64 시스템
- public GHCR image를 받을 수 있는 인터넷 연결
- update 중 old/new image를 함께 둘 수 있는 여유 저장 공간. 공개 `0.2.0`의 local Docker inspect size는 약 451 MB로 `0.1.3`의 약 134 MB보다 크므로 최소 1 GB 이상을 비워 두는 것을 권장합니다. 실제 registry 전송량과 공유 layer 사용량은 장치마다 달라질 수 있습니다.

설치 절차:

1. Home Assistant에서 **설정 → Apps → App store**를 엽니다.
2. 우측 상단 메뉴의 **Repositories**를 열고 위 GitHub URL을 붙여 넣어 추가합니다.
3. App Store를 새로고침하고 **Codex for Home Assistant**를 엽니다.
4. **Install**을 누릅니다. Supervisor가 public GHCR에서 미리 빌드된 amd64 이미지를 받습니다.
5. 아래 옵션에 SSH 공개키를 추가하고 **Network**에서 `22/tcp`의 호스트 포트를 확인합니다.
6. App을 수동으로 시작합니다. 기본 `boot: manual`이므로 Home Assistant 부팅 시 자동 시작하지 않습니다.

목록에 보이지 않으면 장치가 amd64인지 확인하고 App Store를 새로고침하세요. 설치 실패 시 App/Supervisor 로그를 보존해 보고하되 token이나 `auth.json`은 공유하지 마세요.

### 기존 App 업데이트

기존 App에서 `0.2.0`으로 갈 때는 App Store 저장소를 새로고침한 뒤 일반 업데이트하고, App 완전 삭제·재설치나 `/data` 초기화를 하지 마세요. Playwright runtime과 `/etc/codex/config.toml`의 system MCP 등록은 image가 제공하므로 사용자 `config.toml`에 server를 다시 등록할 필요가 없습니다. 업데이트 동안 Web UI/tmux와 SSH 연결이 잠시 종료되는 것은 정상입니다. 업데이트 전에 실행 중이던 Codex는 종료하고 새 세션을 시작해야 새 system config와 도구 목록을 읽습니다. 빈 `/data`의 최초 provisioning 자체를 다시 시험할 때만 별도의 완전 재설치 시험이 필요합니다.

### HACS에 등록하지 않는 이유

HACS는 Integration, Dashboard, Theme, Template, AppDaemon, Python Script 저장소를 지원하지만 Home Assistant App(구 Add-on) 유형은 지원하지 않습니다. 이 저장소를 HACS Integration이나 Dashboard로 추가해도 설치할 수 없습니다. [HACS repository types](https://hacs.xyz/docs/use/repositories/type/) 대신 위 공식 App repository URL을 사용하세요.

## App 설정

| 옵션 | 기본값 | 의미 |
| --- | --- | --- |
| `authorized_keys` | `[]` | root SSH 로그인을 허용할 OpenSSH 공개키 목록. 비어 있거나 모두 잘못되면 SSH만 비활성화되고 Web UI는 유지됩니다. |
| `web_terminal_auto_start_codex` | `false` | 새 웹 `tmux` 세션을 만들 때 Codex를 한 번 실행합니다. Codex가 끝나면 Bash로 돌아옵니다. |
| `tmux_session_name` | `codex-ha` | 모든 Web UI 연결이 공유하는 세션 이름. 영문, 숫자, `.`, `_`, `-`만 허용됩니다. |
| `codex_approval_policy` | `on-request` | Codex 명령 승인 정책 (`untrusted`, `on-request`, `never`). |
| `codex_sandbox_mode` | `danger-full-access` | 컨테이너 내부 Codex 샌드박스 (`workspace-write`, `danger-full-access`). |
| `log_level` | `info` | ttyd 웹 터미널 로그 수준. `trace`/`debug`에서 상세 로그를 켭니다. |

공개키 설정 예시에서 `AAAA...` 부분을 자신의 **공개키** 한 줄로 교체합니다. 개인키는 절대 붙여 넣지 마세요.

```yaml
authorized_keys:
  - ssh-ed25519 AAAA... windows-pc
web_terminal_auto_start_codex: false
tmux_session_name: codex-ha
codex_approval_policy: on-request
codex_sandbox_mode: danger-full-access
log_level: info
```

사용자 `config.toml`은 `/data/codex/config.toml`에 처음 한 번만 생성되고 이후 덮어쓰지 않습니다. `codex` wrapper는 파일을 수정하지 않은 채 현재 `codex_approval_policy`와 `codex_sandbox_mode` App 옵션을 모든 CLI/Remote app-server 실행에 우선 적용합니다. `0.2.0`부터 image-owned `/etc/codex/config.toml`은 공식 Codex system config layer에서 `playwright` MCP를 등록합니다. App 업데이트는 이 system layer만 교체하므로 `/data` 설정과 인증은 보존되며 수동 MCP 재설정이 필요하지 않습니다. 단, 사용자가 같은 `mcp_servers.playwright`를 더 높은 우선순위에서 명시적으로 재정의하거나 비활성화했다면 그 설정이 영향을 줄 수 있습니다. 옵션이나 image를 바꾼 뒤 이미 실행 중인 Codex는 종료하고 새로 시작하세요. 그 밖의 Codex 설정은 사용자 `config.toml`에서 관리합니다.

### 전역 Home Assistant 운영 지침

Codex 공식 [AGENTS.md 지침 계층](https://developers.openai.com/codex/agent-configuration/agents-md)에 따라 App은 `/data/codex/AGENTS.md`와 `AGENTS.override.md`가 모두 없을 때만 기본 운영 가드레일을 생성합니다. 비밀값 비노출, 진단과 변경 권한 분리, `.storage`/Recorder DB 보호, 변경 후 `ha-config-check`, 고위험 동작 승인 규칙을 새 Codex 세션에 제공합니다.

- 기존 `AGENTS.md`나 `AGENTS.override.md`는 빈 파일·심볼릭 링크를 포함해 덮어쓰거나 mode를 바꾸지 않습니다.
- 기본 파일을 비활성화하려면 삭제 대신 빈 `/data/codex/AGENTS.md`를 두면 init이 보존하고 Codex는 빈 지침을 건너뜁니다.
- 한 번 생성된 파일은 사용자 소유 설정으로 취급되어 다음 App 업데이트의 템플릿 변경을 자동 병합하지 않습니다. 새 기본본은 `/usr/local/share/codex-ha/AGENTS.md`와 직접 비교한 뒤 필요한 문장만 반영하세요.
- `/config` 아래에 둔 프로젝트/디렉터리별 지침은 더 나중에 적용되어 전역 지침보다 우선할 수 있습니다.
- 이 파일은 방어 심층화 지침이지 강제 보안 경계가 아닙니다. App 옵션의 approval/sandbox, App 권한 경계와 사람의 검토를 계속 사용해야 합니다.
- App 업데이트 뒤 이미 실행 중인 Codex에는 소급 적용되지 않으므로 새 Codex 세션을 시작하세요.

## Web UI와 공유 tmux 세션

App을 시작한 뒤 **OPEN WEB UI**를 누릅니다. 셸의 시작 디렉터리는 `/config`이고 다음 값이 적용됩니다.

```text
HOME=/data/home
CODEX_HOME=/data/codex
PATH=/usr/local/bin:...
```

기본값 `web_terminal_auto_start_codex: false`에서는 Bash가 열립니다. 다음 명령으로 Codex를 시작합니다.

```bash
ha-codex
```

`true`이면 **새 tmux 세션이 만들어질 때만** Codex를 한 번 자동 실행하고, 종료 후 Bash로 돌아갑니다. 이미 존재하는 세션에 재접속할 때는 다시 실행하지 않습니다.

브라우저를 닫아도 tmux와 그 안의 Codex 작업은 App이 살아 있는 동안 계속됩니다. 같은 `tmux_session_name`을 사용하는 브라우저 탭과 사용자는 동일한 화면과 키 입력을 공유하므로 신뢰하는 관리자만 Web UI를 열어야 합니다. SSH 셸에서 같은 세션에 들어가려면 다음을 실행합니다.

```bash
tmux attach -t codex-ha
```

세션을 강제로 초기화하면 그 안의 Codex와 실행 중인 명령이 종료됩니다.

```bash
tmux kill-session -t codex-ha
```

사용자 지정 세션 이름을 썼다면 `codex-ha`를 그 이름으로 바꾸세요.

## Playwright Headless Chromium renderer

`0.2.0` image는 Node.js, `@playwright/mcp 0.0.78`, Alpine `chromium-headless-shell`과 한글·emoji font를 함께 제공합니다. Codex는 image-owned `/etc/codex/config.toml`의 `playwright` MCP server를 새 세션에서 자동으로 읽습니다. 사용자가 npm package나 browser binary를 설치하거나 `/data/codex/config.toml`에 MCP 명령을 복사할 필요가 없습니다. 이미 열려 있던 Codex 세션은 App 업데이트 후 자동으로 도구 목록을 다시 읽지 않으므로 새 세션을 시작하세요.

### 어떤 URL을 여는가

| 대상 | Codex browser가 여는 URL | 주의점 |
| --- | --- | --- |
| Codex가 App 안에서 실행한 web 개발 서버 | 개발 서버가 출력한 정확한 URL. 예: `http://127.0.0.1:3000` | Headless Chromium도 같은 App container network namespace에 있으므로 외부 port mapping은 필요하지 않습니다. 서버 process는 계속 실행 중이어야 합니다. |
| Home Assistant dashboard/frontend | `http://127.0.0.1:8099` | renderer 전용 loopback gateway입니다. 일반 PC browser, Home Assistant Ingress URL 또는 외부 공개 URL로 사용하지 않습니다. |

`8099` gateway는 frontend document와 정적 파일을 내부 `homeassistant:<Core frontend port>`로 전달하고 `/api/`와 `/api/websocket`을 Supervisor의 Core proxy로 전달하도록 설계되었습니다. App init은 Supervisor Core info에서 frontend port와 HTTP/HTTPS 여부를 찾고, 찾지 못하면 내부 기본값 `http://homeassistant:8123`을 사용합니다. Headless browser init script는 오직 `http://127.0.0.1:8099`와 `http://localhost:8099` origin에서만 현재 `SUPERVISOR_TOKEN`을 Home Assistant frontend token storage에 주입합니다. 이 주소는 App 밖에 expose하지 않습니다.

개발 서버가 `localhost` 대신 별도 hostname을 출력하거나 다른 container에서 실행된다면 browser에서 실제로 도달 가능한 URL을 지정해야 합니다. TLS 인증서 오류를 우회하거나 host network를 켜는 것을 기본 해결책으로 삼지 말고 먼저 listen address, port와 인증서 chain을 확인하세요.

### Desktop에서 mobile까지 확인하는 순서

새 browser context의 기본 viewport는 desktop `1440x900`입니다. 다음처럼 한 번에 요청하면 화면과 런타임 증거를 함께 비교할 수 있습니다.

```text
http://127.0.0.1:3000을 실제 browser에서 열어 줘.
1. 1440x900에서 page가 안정될 때까지 기다리고 screenshot을 남겨.
2. console error/warning을 확인해.
3. 정적 resource를 포함한 network request에서 실패·취소·비정상 status를 확인해.
4. 390x844로 resize한 뒤 mobile screenshot과 console/network 상태를 다시 확인해.
5. desktop/mobile layout 차이와 재현 가능한 오류만 요약해.
```

Home Assistant 자체를 확인할 때는 첫 줄의 URL만 `http://127.0.0.1:8099`로 바꿉니다. 주로 쓰는 MCP 도구는 다음과 같습니다.

| 목적 | 도구 | 사용 메모 |
| --- | --- | --- |
| 실제 URL 열기 | `browser_navigate` | redirect 뒤 최종 URL과 page 상태도 확인합니다. |
| 접근 가능한 구조 확인 | `browser_snapshot` | screenshot만으로 찾기 어려운 label, control, text를 확인합니다. |
| 화면 크기 전환 | `browser_resize` | 먼저 `1440x900`, 다음 `390x844`를 사용합니다. |
| 시각 결과 확인 | `browser_take_screenshot` | 각 viewport에서 별도 screenshot 응답을 받고 민감 정보가 없는지 검토합니다. 임의 파일명 저장은 차단됩니다. |
| console 진단 | `browser_console_messages` | renderer 기본 수집 수준은 warning 이상이므로 error와 warning을 모두 봅니다. |
| resource loading 진단 | `browser_network_requests` | `static: true`로 JS, CSS, font, image를 포함하고 URL·method·status·failure를 확인합니다. 상세 request/response header와 body는 제공하지 않습니다. |

`browser_resize`는 CSS responsive breakpoint를 확인하는 viewport 변경입니다. mobile User-Agent, touch input, device pixel ratio, 느린 CPU/network 또는 실제 모바일 browser 차이까지 에뮬레이션하지 않습니다. 그 수준의 검증이 필요하면 별도의 실제 기기 또는 device-emulation test를 추가하세요.

### 결과물과 보안 경계

- 각 MCP 실행은 격리된 headless context를 사용하며 browser session을 저장하거나 다른 Codex 세션과 공유하지 않습니다.
- screenshot 등 파일 output은 `/run/codex-ha/playwright-output`에 mode `0700`으로 두고 최대 50 MiB로 제한합니다. managed MCP proxy는 모든 도구의 임의 `filename` 인수를 거부합니다. App init은 시작·재시작 때 이 디렉터리의 기존 결과를 삭제하고 다시 만들며, `/data` 영속 영역이나 Home Assistant backup 대상이 아닙니다. 필요한 비민감 증거만 별도 보관하세요.
- runtime token은 mode `0600`인 `/run/codex-ha/playwright-secrets.env`를 통해 MCP redaction에 전달됩니다. MCP text output에 exact token 문자열이 나타나면 마스킹하지만 인코딩·분할된 비밀, image나 화면 전체를 구조적으로 정화하지는 않습니다.
- screenshot, accessibility snapshot, console message와 request URL에는 entity 이름, 위치, 사용자 정보, 내부 hostname, dashboard 내용이나 integration data가 포함될 수 있습니다. Git, 이슈, 채팅 또는 공개 CI artifact에 올리기 전에 직접 검토하고 필요하면 폐기하세요.
- token 주입은 `8099` 두 loopback origin으로 제한됩니다. 일반 개발 서버와 외부 사이트에는 Home Assistant token을 주입하지 않습니다. 그렇더라도 신뢰하지 않는 페이지 탐색과 파일 download/upload를 허용하지 마세요.
- `browser_click`, `browser_fill_form`, `browser_type`, `browser_press_key`, `browser_select_option`은 실제 dashboard 설정이나 기기 상태를 바꿀 수 있습니다. 사용자 요청이 렌더링·진단뿐이면 snapshot, screenshot, console, network 같은 read-only 확인에 머무르고 변경은 별도 승인받습니다.

### 현재 검증 경계

공개 `0.2.0` amd64 image의 인증 없는 pull과 전체 Docker smoke는 PASS입니다. 이 image에서 managed MCP proxy와 실제 browser server를 시작해 initialize, 제한된 `tools/list`, local fixture navigation, desktop `1440x900`·mobile `390x844` DOM viewport와 PNG, console error와 uncaught page error, network 200/302/404/500 및 전송 실패를 확인했습니다. 모의 Supervisor/Core를 연결한 local gateway에서는 token bootstrap, 인증된 `/api/config`, frontend marker, `/api/websocket` upgrade와 container loopback 외부 차단을 확인했습니다. Public `0.1.3` image를 `0.2.0`으로 교체한 update smoke는 동일 named `/data`·`/config` volume의 사용자 Codex config, valid auth marker, 운영 지침, Home Assistant config marker와 SSH host fingerprint를 byte/fingerprint 수준으로 보존하고 새 MCP smoke를 통과했습니다. 큰 desktop PNG는 MCP 응답 한도에 맞춰 같은 종횡비로 축소될 수 있습니다. 임의 `filename`, 상세 network 도구와 다른 금지 도구가 proxy에서 거부되고 stdout/stderr/container log에 token 원문이 없는 것도 검증했습니다. 다만 Playwright upstream의 공식 browser binary는 Alpine/musl을 지원하지 않습니다. 이 App은 Playwright browser download를 생략하고 Alpine repository의 system Chromium을 명시적으로 사용하므로 Alpine/Chromium/Playwright package revision이 바뀔 때마다 build와 smoke를 다시 확인해야 합니다.

이 local smoke는 fixture page를 대상으로 하며 AppArmor가 적용된 실제 HAOS에서 `8099` dashboard document, 인증 bootstrap, 정적 resource, `/api/websocket`, console 상태를 끝까지 확인하지 않았습니다. 따라서 **HAOS dashboard browser E2E는 NOT RUN**이며 local renderer PASS를 HAOS PASS로 확대하지 않습니다.

## Codex 로그인

### 권장: device code 인증 (OpenAI 문서상 beta)

OpenAI의 현재 headless 인증 권장 경로는 문서상 beta인 device code 방식입니다. 개인 계정의 ChatGPT 보안 설정 또는 workspace 관리자의 권한 설정에서 device code 로그인을 허용해야 할 수 있습니다.

```bash
ha-codex-login
```

표시된 URL을 신뢰하는 다른 브라우저에서 열고 일회용 코드를 입력합니다. 완료 후 확인합니다.

```bash
codex login status
```

인증은 `/data/codex/auth.json`에 저장됩니다. 사용자가 App을 삭제하지 않고 여러 버전을 일반 업데이트한 환경에서 로그인 상태와 인증된 Codex 실행이 유지되어 **업데이트 영속성은 실기 PASS**입니다. 최초 로그인에 device code 방식을 사용했는지와 그 UI 흐름은 별도 미검증 항목입니다.

### 대안: 로컬 `auth.json` 복사

Device code 로그인이 불가능하면 브라우저가 있는 로컬 PC에서 `codex login`을 완료하고 파일 자격 증명을 복사할 수 있습니다. 로컬 Codex가 OS keyring을 사용하면 `~/.codex/auth.json`이 없을 수 있습니다. 그 경우 device code를 사용하거나, 로컬 Codex의 `cli_auth_credentials_store = "file"` 설정을 검토한 뒤 다시 로그인하세요.

Windows PowerShell에서 먼저 파일과 일반 SSH 연결을 확인합니다.

```powershell
Test-Path "$HOME\.codex\auth.json"
ssh codex-ha
```

그다음 App의 실제 `CODEX_HOME`으로 복사하고 권한을 고정합니다.

```powershell
scp "$HOME\.codex\auth.json" codex-ha:/data/codex/auth.json
ssh codex-ha "chmod 700 /data/codex && chmod 600 /data/codex/auth.json"
```

`auth.json`은 access token을 담은 평문 비밀 파일이므로 비밀번호처럼 취급합니다.

- Git, 이슈, 채팅, 로그에 넣지 않습니다.
- 다른 Home Assistant App이나 공유 폴더에 복사하지 않습니다.
- `/data/codex`는 `0700`, `auth.json`은 `0600`이어야 합니다.
- App backup에 포함될 수 있으므로 backup도 비밀 자료로 취급합니다.

표준 브라우저 callback 로그인이 필요하면 OpenAI 공식 문서의 SSH local forwarding (`localhost:1455`) 대안도 사용할 수 있지만, 먼저 device code를 권장합니다. 자세한 최신 절차는 [Codex authentication](https://developers.openai.com/codex/auth)을 확인하세요.

## 공개키 SSH

### 1. Windows 키 생성

이미 사용할 ed25519 키가 없다면 Windows PowerShell에서 생성합니다.

```powershell
ssh-keygen -t ed25519
Get-Content "$HOME\.ssh\id_ed25519.pub"
```

출력된 `ssh-ed25519 ...` 공개키 한 줄을 App의 `authorized_keys` 목록에 넣습니다. `id_ed25519` 개인키를 복사하거나 App 설정에 붙여 넣으면 안 됩니다. 옵션 저장 후 App을 재시작해야 키가 다시 렌더링됩니다.

### 2. Network 포트

App의 **Configuration → Network**에서 컨테이너 `22/tcp`의 호스트 포트를 설정합니다.

- 기본 호스트 포트: `2223`
- 비어 있음/비활성: 외부 SSH mapping 없음
- 내부 sshd 포트: 항상 `22`

`ssh_port` JSON 옵션은 없습니다. 포트를 바꾸면 아래 SSH config의 `Port`도 함께 바꿉니다.

### 3. Windows `~/.ssh/config`

Windows 파일 위치는 보통 `C:\Users\<사용자>\.ssh\config`입니다. Codex Desktop이 자동 발견할 수 있도록 wildcard가 아닌 **구체적인 Host 별칭**을 만듭니다.

```sshconfig
Host codex-ha
  HostName homeassistant.local
  User root
  Port 2223
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
```

먼저 일반 OpenSSH 연결을 확인합니다.

```powershell
ssh codex-ha
```

성공하면 `/config`에서 시작하며 `codex`, `ha-api`, `supervisor-api`가 PATH에 있어야 합니다.

```bash
pwd
command -v codex
codex --version
printf '%s\n' "$CODEX_HOME"
```

`authorized_keys`가 비어 있으면 sshd는 로그인 대기 상태로 열리지 않고 App 로그에 degraded 경고를 남깁니다. 비밀번호, keyboard-interactive 로그인은 항상 차단됩니다.

## Desktop SSH 프로젝트와 mobile Remote 연결

OpenAI의 현재 공식 [Remote connections](https://developers.openai.com/codex/remote-connections) 문서는 desktop app이 SSH host의 프로젝트를 열고, ChatGPT mobile의 Remote가 페어링된 desktop host를 통해 그 원격 환경을 제어하는 구조를 설명합니다. 휴대폰이 HAOS sshd에 직접 접속하는 구조가 아닙니다.

1. 데스크톱을 실행하는 PC의 `~/.ssh/config`에 pattern이 아닌 구체적인 Host 별칭이 있어야 합니다.
2. 같은 PC에서 `ssh codex-ha`가 먼저 성공해야 합니다.
3. 원격 사용자의 login shell PATH에서 `codex`를 찾을 수 있어야 합니다.
4. 원격 host의 Codex가 인증되어 있어야 합니다.
5. 데스크톱 App의 **Settings → Connections → SSH**에서 host를 추가/활성화하고 원격 프로젝트 폴더 `/config`를 선택합니다.

Desktop app은 SSH로 원격 login shell을 사용해 Codex app server를 시작합니다. 사용자가 `0.1.2-dev`에서 **mobile Remote → 연결된 desktop app → HAOS App SSH 프로젝트 `/config`** 경로의 작업을 확인했으므로 공개키 SSH, 원격 PATH와 Alpine/musl app server의 이 실기 경로는 PASS입니다. App 재시작/업데이트 뒤 host identity 유지도 확인했습니다. 외부 비밀번호 인증의 실제 거부 시도만 별도 미검증이며 실효 설정과 로컬 negative smoke는 PASS입니다.

## `/config`와 API 권한

Codex와 root 셸은 `/config` 전체를 read-write로 사용합니다. 여기에는 다음과 같은 민감하거나 손상 위험이 큰 데이터가 포함될 수 있습니다.

- `configuration.yaml`, automations, scripts, dashboards, packages
- `secrets.yaml`
- `.storage`
- Recorder SQLite 데이터베이스
- custom components와 `www`

`.storage`는 가능하면 UI/공식 API를 통해 변경하고, SQLite는 분석 시 read-only 연결을 우선하세요. 비밀값이나 실제 entity/user/internal URL이 들어간 진단 결과를 채팅, Git, 로그에 복사하지 마세요.

셸에는 App 실행 중 `SUPERVISOR_TOKEN`이 전달됩니다. 이 토큰으로 Core API 전체와 Supervisor `manager` 역할 범위를 호출할 수 있습니다. `env`, `printenv`, `set`, `export -p`, `curl -v` 같은 명령으로 토큰을 화면·로그에 노출하지 마세요.

## helper 명령

| 명령 | 기능 |
| --- | --- |
| `ha-codex [ARGS...]` | `/config`에서 Codex 실행 |
| `ha-codex-login` | `codex login --device-auth` 실행 |
| `ha-api [--raw] [--accept TYPE] METHOD /path [JSON_BODY\|-]` | Core REST proxy 호출 |
| `supervisor-api [--raw] [--accept TYPE] METHOD /path [JSON_BODY\|-]` | Supervisor API 호출, 일반 JSON 응답의 `result` 누락/오류도 실패 처리 |
| `ha-config-check` | `POST /core/check` |
| `ha-core-logs` | Core 로그 원문 조회 |
| `ha-addon-logs ADDON_SLUG` | 지정 App 로그 원문 조회 |

요청 body는 유효한 JSON이어야 합니다. `-`를 쓰면 stdin에서 JSON을 읽습니다. HTTP 4xx/5xx와 전송 오류는 non-zero로 반환되며 Authorization header와 토큰은 출력하지 않도록 구현되어 있습니다. `supervisor-api` 일반 모드는 JSON envelope의 `result`가 없거나 `ok`가 아니어도 실패합니다. `--raw`는 Core/App 로그처럼 envelope가 아닌 원문 endpoint를 위한 예외입니다. `--accept`는 header injection을 막기 위해 `application/json`, `text/plain`, `text/x-log`만 허용하며 두 로그 helper는 공식 로그 media type인 `text/x-log`를 자동 사용합니다.

조회 예시:

```bash
ha-api GET /config
ha-api GET /states
ha-api GET /services
supervisor-api GET /core/info
supervisor-api GET /supervisor/info
ha-config-check
ha-core-logs
ha-addon-logs local_example
```

마지막 명령의 `local_example`은 실제 조회할 App slug로 바꾸세요. `manager`가 어떤 endpoint를 허용하는지는 Supervisor/버전에 따라 실제 HAOS에서 확인해야 합니다. 권한 거부가 나와도 `admin`으로 자동 승격하지 않습니다.

### Supervisor manager 실기 검증표

아래 표는 M2에서 실제 HAOS 버전·응답 코드와 함께 갱신해야 합니다. 로컬 Docker 성공으로 대체하지 않습니다.

| 기능 | Endpoint/helper | HAOS 실기 상태 |
| --- | --- | --- |
| Supervisor 정보 | `GET /supervisor/info` | PASS — HAOS 18.1 실기 진단 |
| Core 정보 | `GET /core/info` | PASS — Core 2026.7.1 실기 진단 |
| Core 로그 endpoint | 직접 `GET /core/logs` | PASS — `Accept: text/x-log`, HTTP 200, 비어 있지 않은 본문 |
| Core 로그 helper | `ha-core-logs` | PASS — `0.1.3-dev` rc 0, nonempty; 직접 요청과 helper 모두 성공 |
| 설정 검사 | `ha-config-check` (`POST /core/check`) | PASS — HTTP 200, `result: ok` |
| App 정보/로그 endpoint | `GET /addons/self/info`, 직접 `GET /addons/self/logs` | PASS — self 정보와 `text/x-log` 로그 HTTP 200 |
| App 로그 helper | `ha-addon-logs self` | PASS — `0.1.3-dev` rc 0, nonempty; 직접 요청과 helper 모두 성공 |
| 테스트 App 재시작 | `POST /addons/{slug}/restart` | NOT RUN — 명시적 테스트 대상 필요 |
| Core 재시작 | `POST /core/restart` | NOT RUN — 설정 검사 성공 및 명시적 승인 필요 |

추가로 `/supervisor/logs`, `/host/info`, `/os/info`, App 목록 조회와 Core REST `/config`, `/states`, `/services`가 성공했습니다. 임시 persistent notification 생성·dismiss로 저위험 Core POST service call과 정리도 확인했습니다. Supervisor start/stop/restart 전체는 운영 중단 위험 때문에 실행하지 않았습니다.

### Core REST 직접 사용

helper가 필요를 충족하지 못할 때 App 내부에서 runtime 환경변수로 공식 REST endpoint를 호출할 수 있습니다. 토큰 값을 명령줄 인수나 shell history에 직접 붙여 넣지 마세요. 아래처럼 `0600` 임시 header 파일을 사용하고 반드시 지웁니다.

```bash
header_file=$(mktemp)
trap 'rm -f "$header_file"' EXIT
chmod 600 "$header_file"
printf 'Authorization: Bearer %s\n' "$SUPERVISOR_TOKEN" > "$header_file"
curl --fail --silent --show-error \
  --header "@${header_file}" \
  "${HA_URL}/states"
```

Base URL은 `http://supervisor/core/api`, Supervisor Base URL은 `http://supervisor`입니다.

### Core WebSocket

Core WebSocket endpoint는 다음과 같습니다.

```text
ws://supervisor/core/websocket
```

WebSocket client는 첫 인증 frame의 `access_token`을 실행 시점에 `SUPERVISOR_TOKEN` 환경변수에서 읽어 구성해야 합니다. 예를 들어 프로토콜상 첫 두 outbound message는 다음 형태입니다. `<runtime token>`을 실제 값으로 문서나 스크립트에 저장하지 마세요.

```json
{"type":"auth","access_token":"<runtime token>"}
{"id":1,"type":"get_states"}
```

이 MVP에는 전용 `ha-ws` helper나 범용 WebSocket CLI가 포함되지 않았습니다. 필요한 경우 token redaction을 지키는 코드/클라이언트를 사용하세요. Ingress WebSocket transport는 HAOS에서 PASS했지만 실제 Core WebSocket API 호출은 M2 실기 미검증입니다.

## 안전한 서비스 호출

서비스 호출은 실제 기기를 움직입니다. 사용자가 지정한 테스트용 조명/스위치처럼 영향이 낮은 entity만 대상으로 하고, 호출 전후 상태와 로그를 기록하세요. 아래는 단순 on/off entity의 최소 패턴이며 실제 테스트 entity로 바꾼 뒤 검토하고 실행합니다.

```bash
entity=light.codex_test
domain=${entity%%.*}
body=$(jq -cn --arg entity_id "$entity" '{entity_id:$entity_id}')
before=$(ha-api GET "/states/${entity}" | jq -r '.state')

ha-api POST "/services/${domain}/turn_on" "$body"
ha-api GET "/states/${entity}" | jq '{entity_id,state,last_changed}'

case "$before" in
  on)  ha-api POST "/services/${domain}/turn_on" "$body" ;;
  off) ha-api POST "/services/${domain}/turn_off" "$body" ;;
  *)   printf 'Automatic restore skipped for prior state: %s\n' "$before" >&2 ;;
esac
```

이 예시는 brightness, color, cover position 같은 attribute까지 복원하지 않습니다. 복합 entity는 원래 attribute와 서비스 의미를 따로 확인하세요.

다음 동작은 사용자의 현재 요청에 명시되어 있거나 실행 직전 명시적 승인이 없으면 수행하지 마세요.

- 도어록 해제, 차고문/대문 열기, 경보 해제
- 난방·급수·출입처럼 안전/재산에 영향을 주는 동작
- HAOS host 종료/재부팅
- backup 복원
- App 제거, OS 업데이트, 데이터베이스 삭제

설정을 바꾸기 전에는 가능한 경우 `/config` Git checkpoint 또는 Home Assistant backup을 만들고, diff를 검토한 뒤 `ha-config-check`가 성공한 경우에만 Core 재시작을 고려하세요.

## 진단 결과를 다루는 범위

시스템 진단은 변경 권한이 아닙니다. Repairs 항목, 업데이트 가능 상태, 서드파티 통합 경고, 높은 메모리/Swap, `/config` 파일 mode를 발견해도 진단 요청만으로 자동화·권한·통합·Core/App을 수정하거나 재시작하지 않습니다.

- 자동화의 삭제된 device/entity 내부 ID는 실제 장치를 확인한 뒤 Home Assistant UI에서 다시 선택하는 작업으로 분리합니다.
- `secrets.yaml`이나 통합 private key의 mode는 owner/group과 통합 호환성, backup을 확인한 뒤 파일별로 판단하며 App 시작 시 재귀 `chmod`하지 않습니다.
- Core/OS/App/custom integration 업데이트는 backup과 rollback 계획을 확인하고 사용자가 요청한 별도 작업으로 수행합니다.
- 외부 통합 경고와 자원 사용량은 시점별 관측값으로 보고 장기 장애나 App 결함으로 확대 해석하지 않습니다.

## 외부 접속 보안

**공유기에서 TCP 2223을 인터넷으로 port-forward하지 마세요.** 공개키 인증만으로도 이 App의 `/config`와 runtime API token이 인터넷 공격면에 놓입니다.

- SSH는 신뢰하는 LAN에서만 사용합니다.
- 외부에서는 검증된 VPN 또는 신뢰하는 mesh VPN으로 먼저 내부망에 접속합니다.
- VPN에서도 source device와 사용자 접근을 제한합니다.
- 키를 분실하거나 PC가 침해되면 즉시 해당 공개키를 `authorized_keys`에서 제거하고 App을 재시작합니다.

Ingress 패널은 관리자 전용이지만, SSH Network mapping은 Home Assistant Frontend 인증과 별개의 네트워크 리스너입니다.

## 복구와 사고 대응

### 로그와 시작 실패

Home Assistant의 **설정 → Apps → Codex for Home Assistant → Log**에서 시작 단계와 degraded 이유를 확인합니다. `/config`가 없거나 쓰기 불가능하면 App은 의도적으로 시작에 실패합니다. 공개키가 없다는 경고만 있고 Web UI가 동작한다면 정상 degraded 상태입니다.

### Web UI가 재연결 상태이거나 clear 오류를 표시할 때

`0.1.0-dev`에는 S6가 ttyd의 `TERM=xterm-256color`를 제거해 tmux가 `terminal does not support clear`로 종료되는 문제가 있었습니다. `0.1.1-dev`는 web entrypoint에서 외부 TERM을 복원하고 tmux 내부 `TERM=tmux-256color`를 보존합니다.

App Store 저장소를 새로고침한 뒤 `0.1.1-dev` 이상으로 업데이트하고 App을 재시작하세요. 계속 실패하면 App 로그에서 `/`, `/token`, `/ws` 응답과 ttyd 오류를 함께 확인해 보고하세요.

### Playwright browser 도구나 page가 열리지 않을 때

1. `0.2.0` image인지 확인하고 이미 실행 중이던 Codex를 종료한 뒤 새 세션을 시작합니다. `codex mcp list`에서 system server `playwright`가 enabled 상태인지 확인하되, token이나 전체 환경변수는 출력하지 않습니다.
2. `/data/codex/config.toml`에 같은 `mcp_servers.playwright`를 끄거나 다른 command로 바꾼 사용자 설정이 있는지 확인합니다. 문제 해결을 위해 `/data` 전체를 초기화하지 마세요.
3. 개발 UI라면 server process가 살아 있고 App shell에서 지정한 loopback URL에 응답하는지 확인합니다. browser가 외부 PC의 `localhost`를 대신 볼 수는 없습니다.
4. Home Assistant dashboard라면 App shell에서 `http://127.0.0.1:8099`가 응답하는지 확인하고 App 로그의 loopback gateway 초기화 경고를 봅니다. `SUPERVISOR_TOKEN` 값을 직접 출력하거나 URL/query에 붙이지 마세요.
5. browser process가 멈추거나 50 MiB output 한도에 걸렸다면 해당 Codex 세션을 끝내고 새 세션에서 재현합니다. `/run/codex-ha/playwright-output`의 민감한 screenshot은 보존하지 말고 필요한 범위에서 정리합니다.

Alpine Chromium crash, 빈 page, 인증 반복, `/api/websocket` 실패가 계속되면 App version, HAOS/Core version, console error와 token을 제거한 network status만 보존해 보고하세요. upstream Playwright가 Alpine/musl을 공식 browser 플랫폼으로 지원하지 않는다는 현재 검증 경계를 함께 고려해야 합니다.

### 설정 손상

1. Codex 작업과 관련 자동화를 중지합니다.
2. Git diff/commit 또는 사전에 만든 파일 사본으로 변경을 되돌립니다.
3. `ha-config-check`를 실행합니다.
4. 필요한 경우에만 Home Assistant backup 복원을 검토합니다. 복원은 명시적 승인 대상입니다.

### Codex 로그인 폐기

노출이 의심되면:

1. App을 중지합니다.
2. Codex/ChatGPT 계정에서 관련 세션 또는 연결을 폐기하고 필요하면 logout합니다.
3. Web UI에서 안전하게 접근할 수 있게 App을 다시 시작한 뒤 `/data/codex/auth.json`을 삭제합니다.
4. 공유한 로그, Git history, backup의 노출 여부를 확인합니다.
5. 원인을 제거한 뒤 `ha-codex-login`으로 다시 인증합니다.

```bash
rm -f /data/codex/auth.json
```

`SUPERVISOR_TOKEN` 노출이 의심되면 App을 즉시 중지하고 노출 파일/로그 접근을 차단하세요. App 재시작 뒤 runtime token 상태를 확인하되, 회전을 가정하지 말고 Home Assistant 관리자 자격 증명과 관련 세션도 점검합니다.

### SSH host key 경고

SSH host private key는 `/data/ssh`에 `0600`으로 저장되므로 정상 App 재시작에서는 fingerprint가 유지되어야 합니다. Windows의 host key changed 경고를 무시하거나 즉시 삭제하지 말고 먼저 App Web UI/로그의 신뢰 경로에서 fingerprint를 확인합니다.

```bash
ssh-keygen -lf /data/ssh/ssh_host_ed25519_key.pub
```

App 재설치 등으로 key가 정말 바뀐 것을 확인한 경우에만 Windows의 이전 항목을 제거하고 다시 연결합니다.

```powershell
ssh-keygen -R "[homeassistant.local]:2223"
ssh codex-ha
```

HostName이나 포트를 바꿨다면 실제 값을 사용하세요. 예상하지 않은 변경이면 중간자 공격 또는 `/data` 유실 가능성을 먼저 조사합니다.

## 검증 상태

| 단계 | 상태 |
| --- | --- |
| M1 로컬 amd64 이미지 빌드, 공식 SHA-256 검증, `codex-cli 0.144.1` | **PASS** |
| S6 init, 공개키 미설정 시 SSH degraded, ttyd/nginx 서비스 기동 | **PASS (로컬 컨테이너)** |
| `/config` RW probe, Codex config/host key 생성과 권한, nginx/sshd 구문 | **PASS (로컬 컨테이너)** |
| loopback nginx → ttyd HTML 응답 | **PASS (로컬 컨테이너)** |
| 공개키 SSH/비밀번호 거부, host key/config 영속성, API helper mock·token redaction, 전체 lint | **PASS (로컬 컨테이너/Windows OpenSSH)** |
| 실제 HAOS amd64 public repository 설치/시작 | **PASS — 사용자 실기 로그** |
| Ingress HTTP/token/WebSocket transport | **PASS — HAOS 200/200/101** |
| ttyd/tmux TERM 수정과 shell/Codex 실행 | **PASS — HAOS 사용자 실기 확인** |
| auto-start false/true와 Codex 종료 후 shell 복귀 | **PASS — HAOS 사용자 실기 확인** |
| resize, 브라우저 종료 후 tmux 재접속 | **PASS — HAOS 기능적 복구/resize와 로컬 동일 session/pane/pid smoke** |
| 인증된 Codex 실행 | **PASS — HAOS Web UI 사용자 실기 확인** |
| App 업데이트 후 Codex 인증 영속성 | **PASS — 삭제 없는 연속 업데이트 사용자 실기 확인** |
| Device code 로그인 UI 흐름 | **PASS — HAOS 사용자 실기 확인** |
| 공개키 SSH와 desktop SSH project의 Alpine/musl app server | **PASS — mobile Remote 경유 사용자 E2E 확인** |
| App 재시작/업데이트 뒤 SSH host key 동일성 | **PASS — HAOS 사용자 실기 확인** |
| 외부 비밀번호 인증 실제 거부 | **NOT RUN — 실효 설정과 로컬 negative smoke는 PASS** |
| `/config` 실제 write와 Supervisor 설정 검사 | **PASS — 진단 보고서 생성, `/core/check` ok** |
| Core REST `/config`·`/states`·`/services` 조회 | **PASS — Core 2026.7.1 실기 확인** |
| 저위험 Core service call | **PASS — 임시 persistent notification 생성·dismiss 각각 rc 0, 정리 확인** |
| Supervisor 정보와 직접 Core/App 로그 조회 | **PASS — 일부 manager endpoint** |
| `0.1.3-dev` Core/App 로그 helper | **PASS — 직접 `text/x-log` 요청과 두 helper 모두 rc 0/nonempty** |
| Supervisor/Core/App start/stop/restart 운영 | **M2 미검증** |
| 기본 전역 운영 지침 생성·기본본 일치·사용자 override 보존 | **PASS — 로컬 컨테이너와 HAOS 0.1.2-dev** |
| Alpine 3.24 system Chromium + Playwright MCP dependency spike | **PASS — public page navigation/resize/screenshot/console/network와 text redaction에 한정** |
| 완성된 `0.2.0` local image build와 실제 MCP smoke | **PASS — 제한된 tools, 1440x900·390x844 DOM/PNG, console/uncaught, 200/302/404/500/전송 실패, filename·금지 도구 거부, token 비노출** |
| 모의 Supervisor/Core `8099` gateway | **PASS — token bootstrap, 인증 REST, frontend marker, WebSocket upgrade, loopback 외부 차단** |
| Public `0.1.3` → local `0.2.0` container update | **PASS — 동일 `/data`·`/config`, 설정·auth marker·지침·SSH identity 보존과 새 MCP 실행** |
| Public `0.2.0` GHCR publish, anonymous pull과 release-image full smoke | **PASS — linux/amd64, version/arch label, immutable digest, `latest` 부재** |
| 실제 HAOS 일반 App 업데이트 후 MCP 노출 | **NOT RUN — Supervisor/App Store 경로 미검증** |
| 실제 HAOS `8099` dashboard 인증·resource·WebSocket E2E | **NOT RUN** |

위 상태는 이 문서 작성 시점의 사실이며 최종 명령·결과는 저장소 `progress.md`가 기준입니다. 기존 `0.1.3` 범위의 amd64 runtime M1/M2 수용 기준과 새 `0.2.0` browser renderer의 public image/MCP smoke는 PASS이지만, browser renderer의 HAOS 완료까지 PASS라는 뜻은 아닙니다. `0.2.0` GHCR image의 public pull은 확인했으며 기존 설치의 실제 Supervisor 일반 업데이트와 HAOS browser 경로는 별도 확인합니다. Supervisor/Core/App lifecycle 실동작과 실제 물리 장치 제어는 운영 중단·오작동 위험 때문에 자동 완료 시험에서 제외합니다. Home Assistant `stage`는 M3 평가 전까지 `experimental`을 유지합니다.
