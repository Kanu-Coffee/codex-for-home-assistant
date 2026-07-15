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
│  ├─ playwright/
│  │  ├─ package.json
│  │  └─ package-lock.json
│  └─ rootfs/
│     ├─ etc/
│     │  ├─ codex/config.toml
│     │  ├─ cont-init.d/ 또는 s6-rc.d/
│     │  ├─ s6-overlay/s6-rc.d/ha-memoryd/
│     │  ├─ services.d/ 또는 s6-rc.d/
│     │  ├─ ssh/
│     │  └─ profile.d/
│     └─ usr/local/
│        ├─ bin/
│        │  ├─ ha-codex
│        │  ├─ ha-codex-login
│        │  ├─ ha-memory
│        │  ├─ ha-memory-mcp
│        │  ├─ ha-playwright-mcp
│        │  ├─ ha-api
│        │  ├─ supervisor-api
│        │  ├─ ha-config-check
│        │  ├─ ha-core-logs
│        │  ├─ ha-addon-logs
│        │  └─ web-terminal-entrypoint
│        └─ share/codex-ha/
│           ├─ ha-memory-core.mjs
│           ├─ ha-memory-ha-client.mjs
│           ├─ ha-memory.mjs
│           ├─ ha-memory-mcp.mjs
│           ├─ playwright-mcp-proxy.mjs
│           ├─ playwright-mcp.json
│           └─ playwright-init-page.ts
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
version: "0.3.2"
slug: codex_home_assistant
description: Codex CLI, Playwright browser, Ingress terminal, and SSH for Home Assistant
url: https://github.com/<owner>/codex-for-home-assistant
stage: experimental
startup: application
boot: manual
init: false
arch:
  - amd64
image: ghcr.io/kanu-coffee/codex-for-home-assistant

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
  codex_user_files_update_mode: preserve
  home_assistant_browser_auto_auth: true
  log_level: info

schema:
  authorized_keys:
    - str
  web_terminal_auto_start_codex: bool
  tmux_session_name: "match(^[A-Za-z0-9._-]{1,64}$)"
  codex_approval_policy: "list(untrusted|on-request|never)"
  codex_sandbox_mode: "list(workspace-write|danger-full-access)"
  codex_user_files_update_mode: "list(preserve|refresh_agents|refresh_all)"
  home_assistant_browser_auto_auth: bool
  home_assistant_browser_token: password?
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

### `codex_user_files_update_mode`

- 타입: `list(preserve|refresh_agents|refresh_all)`
- 기본: `preserve`; 이전 version의 option에 key가 없어도 `preserve`로 해석
- `preserve`: 기존 `/data/codex/config.toml`과 base `AGENTS.md`를 변경하지 않음
- `refresh_agents`: 현재 App version에서 아직 갱신하지 않은 base `AGENTS.md`만 image 기본 지침으로 한 번 교체
- `refresh_all`: 같은 target별 one-shot 규칙으로 base 지침과 현재 approval/sandbox option 기반 기본 `config.toml`로 교체
- 선택값을 유지하면 다음 App version에서 해당 target을 한 번 다시 갱신한다. 특정 update에만 쓰려면 성공 확인 뒤 `preserve`로 되돌린다.
- `AGENTS.override.md`, 인증/session, SSH/browser identity와 Home Assistant `/config`는 대상이 아니다.

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
chromium-headless-shell
curl
font-noto-cjk
font-noto-emoji
git
jq
nodejs
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

### Playwright 설치

- Microsoft `@playwright/mcp` `0.0.78`을 exact dependency로 사용하고 repository의 npm lockfile로 integrity와 transitive dependency를 고정한다.
- 같은 lockfile의 `ws` `8.18.3`을 browser administration과 HA memory의 privileged WebSocket runtime으로 공유하고 image build에서 package version과 `wrapper.mjs` import를 검사한다.
- 현재 lockfile의 `playwright`와 `playwright-core`는 `1.62.0-alpha-1783623505000`이며 세 항목은 함께 검증·업데이트한다.
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --ignore-scripts`로 npm runtime만 설치하고 runtime browser download를 금지한다.
- browser는 Alpine `chromium-headless-shell` package의 `/usr/bin/chromium-headless-shell`을 명시적 executable로 사용한다.
- npm은 image build에만 설치한 virtual package로 제거하고 final image에는 `nodejs`, MCP runtime, Chromium과 필요한 CJK/emoji font만 남긴다.
- image build에서 MCP/`ws` package version, `require('playwright-core')`, `ws/wrapper.mjs`와 `chromium-headless-shell --version`을 검사한다.
- image build/container contract에서 SQLite FTS5가 실제 활성화되고 memory schema를 생성할 수 있는지 검사한다.
- Playwright upstream이 Alpine/system Chromium 조합을 공식 지원한다고 표현하지 않는다. amd64 local smoke와 실제 HAOS/AppArmor 결과를 분리해 기록한다.

## 7. 초기화 계약

초기화 스크립트는 idempotent해야 한다.

- 디렉터리가 이미 있으면 데이터 보존
- 기본 `codex_user_files_update_mode: preserve`에서는 `config.toml`과 base `AGENTS.md`의 기존 사용자 변경 보존
- user-file refresh는 target별 App version one-shot state를 사용한다. 갱신할 모든 target을 먼저 검사하고 root-owned regular single-link file만 허용하며 symlink, 다중 hardlink와 비정상 file은 따라가지 않고 전체 선택을 fail closed한다.
- refresh 전에 `/data/codex/backups/user-files` 아래 고유 `0700` transaction directory에 기존 파일과 metadata를 `0600`으로 보존하고, journal → same-filesystem atomic replacement → version state commit 순서로 처리한다. 진단용 backup 경로는 보고할 수 있지만 credential을 포함할 수 있는 파일 내용은 로그에 출력하지 않는다.
- `/etc/codex/config.toml`은 image-managed system default로 설치하고 `/data/codex/config.toml`에 MCP table을 append하지 않음
- system config의 `developer_instructions`는 Home Assistant dashboard에서 image-managed Playwright와 `http://127.0.0.1:8099/`를 먼저 사용하게 하며, MCP proxy의 navigation tool 설명에도 같은 route를 제공함
- `CODEX_HOME/AGENTS.md`와 `AGENTS.override.md`가 모두 없을 때만 기본 운영 지침을 원자적으로 생성
- 기존 전역 지침은 기본 `preserve`에서 빈 파일과 심볼릭 링크를 포함해 내용과 권한 보존. 명시적 refresh에서도 `AGENTS.override.md`는 항상 보존
- host key가 있으면 재생성하지 않음
- authorized_keys는 App 옵션에서 원자적으로 렌더링
- 빈/잘못된 키는 로그로 알려주되 토큰/키 전체를 출력하지 않음
- `/config` 쓰기 테스트는 안전한 임시 파일을 생성 후 삭제해 수행
- 이전 기본 Playwright output을 init 시작 때 제거하고 `/run/codex-ha` 아래 `0700`으로 재생성한다. 검증된 browser token의 runtime file은 `0600`으로 만들고 browser profile을 `/data`에 만들지 않음
- guarded `ha-memory init`이 링크를 따라가지 않고 `/data/codex-ha-memory`를 root-owned `0700`, database/WAL/SHM을 `0600`으로 만들거나 검증한다. unsafe path는 memory만 fail closed하며 main init은 계속된다. main init은 Core catalog를 동기화하지 않고 독립 S6 `ha-memoryd`가 retry 가능한 bootstrap/refresh를 담당한다.
- `ha-memoryd`는 ttyd, ingress, sshd와 browser service의 dependency가 아니다. DB/Core/schema 실패는 catalog를 `degraded`/`stale`로 표시하거나 memory tool unavailable 오류를 반환하고 App의 기존 복구 표면은 계속 시작한다. daemon은 CLI 원문을 log하지 않고 closed allowlist의 token/DNS/transport/timeout/auth/protocol/command/snapshot reason만 기록한다.

## 7.1 검증형 Home Assistant 메모리 계약

### 영속 store와 schema

```text
/data/codex-ha-memory/       # 0700
├─ memory.sqlite3            # 0600
├─ memory.sqlite3-wal        # 존재 시 0600
└─ memory.sqlite3-shm        # 존재 시 0600
```

- SQLite는 FTS5, foreign key, check constraint와 WAL/busy-timeout transaction을 사용한다. v1 schema를 초기화·검증하고 알 수 없는 과거/미래 version은 자동 migration 없이 memory만 fail closed한다. scheduler/CLI/MCP는 같은 WAL database를 다중 process로 사용하고 별도 Unix socket writer를 만들지 않는다.
- 고정 table은 `metadata`, `sync_runs`, `catalog_objects`, `catalog_relations`, `catalog_revisions`, `memory_items`, `memory_evidence`, `conflicts`, `change_records`, `audit_events`, `audit_changes`, `search_fts`다.
- `memory_items`는 candidate와 applied semantic fact를 통합한다. SQL check는 허용 status enum을 제한하고 application transaction이 `pending`, `verified`, `applied` 순서와 current-row/status precondition을 강제한다.
- catalog snapshot은 staging normalization이 모두 성공한 뒤 하나의 `catalog_revisions` transaction으로 교체한다. 실패한 `sync_runs`는 closed machine error code만 기록하고 last-known-good catalog를 변경하지 않는다.
- open/initialization 전 directory/file의 owner, regular file, single link와 mode를 검사한다. unsafe link/type/ownership, lock과 schema corruption에서 DB를 자동 삭제·초기화하지 않는다.

### Core 수집 계약

`ha-memoryd`는 다음 Core WebSocket command만 사용한다.

```text
config/entity_registry/list
config/device_registry/list
config/area_registry/list
get_states
automation/config
search/related
```

- entity registry와 state의 합집합에서 automation을 찾고 허용된 식별자, 표시명·description, area/device/entity relation만 저장한다. state가 없는 disabled registry automation도 index한다. active graph는 공식 payload `search/related(item_type=automation, item_id=<automation entity_id>)`로 요청하며 `item_type=entity`를 대체 graph로 사용하지 않는다. Core가 unavailable automation에 성공 응답으로 주는 explicit `config: null`은 빈 config와 bounded warning으로 수용한다. 개별 related 요청의 정상 result envelope가 실기에서 관측한 `success:false`, `error.code=unknown_error`인 경우만 빈 enrichment와 warning으로 격리하고 config-derived 직접 관계를 유지한다. 그 밖의 command code, config 실패, server/client timeout, unauthorized, invalid format, transport/close/protocol, 누락·malformed envelope와 malformed successful related 응답은 전체 refresh를 실패시킨다.
- `get_states`의 state와 임의 attributes는 fresh expectation 비교 뒤 폐기한다. 표시명, device class, icon, automation id/mode 같은 명시적 allowlist metadata만 catalog에 정규화할 수 있다.
- automation raw config, 임의 response, `/config` 원문, 대화 transcript/prompt, token·secret과 비허용 field는 DB, FTS, audit와 log에 쓰지 않는다.
- optional related의 관측된 `unknown_error`를 제외한 command/대상 실패, unsupported 또는 malformed response와 transport interruption은 partial canonical commit이 아니라 stale/degraded retry가 되며 고정 command별 또는 연결 단계별 allowlist code를 status에 남긴다. Related warning은 고정 prefix와 allowlisted automation ID만 포함하고 전체 snapshot에서 최대 100개로 제한한다.

### CLI와 MCP 계약

```toml
[mcp_servers.ha_memory]
command = "/usr/bin/env"
args = [
  "-i",
  "HOME=/data/home",
  "LANG=C.UTF-8",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "/usr/local/bin/ha-memory-mcp",
]
cwd = "/config"
env_vars = []
enabled = true
required = false
startup_timeout_sec = 10
tool_timeout_sec = 120
default_tools_approval_mode = "writes"
enabled_tools = [
  "memory_search",
  "memory_show",
  "memory_propose",
  "memory_add_evidence",
  "memory_verify_candidate",
  "memory_apply_candidate",
  "memory_begin_change",
  "memory_verify_change",
  "memory_status",
  "memory_history",
  "memory_conflicts",
  "memory_resolve_conflict",
  "memory_rollback",
]
```

- MCP는 container-local STDIO이고 HTTP/SSE listener나 host/Ingress port를 갖지 않는다. system config의 `env -i`로 시작한 wrapper가 root-only `/run/codex-ha/runtime.env`를 source하고 fresh verify CLI child에 필요한 allowlist 환경만 넘긴다.
- tool 표면은 `memory_search`, `memory_show`, `memory_propose`, `memory_add_evidence`, `memory_verify_candidate`, `memory_apply_candidate`, `memory_begin_change`, `memory_verify_change`, `memory_status`, `memory_history`, `memory_conflicts`, `memory_resolve_conflict`, `memory_rollback`이다. 모든 input은 고정 JSON schema와 size/current-row/status 검사를 통과한다.
- CLI의 candidate 값은 `ha-memory candidate add --value-json`, change 시작 대상과 pre-change 기대값은 `ha-memory change begin --subjects-json --expect-json`, fresh 재검증은 `ha-memory change verify --expect-json`으로 전달한다. begin은 기존/생성 예정 subject와 closed-schema expectation의 digest·field-only summary를 먼저 저장한다. verify는 같은 계약만 fresh API와 비교하고 raw expectation 값/state/attributes/config를 보존하지 않는다. `codex_change` relationship candidate에는 동일 source·relation·target의 성공한 존재 predicate만 evidence로 연결한다.
- search/show는 exact identifier/alias와 FTS5 rank를 사용한다. Query 최대 256자, search 기본 8·최대 20 subject와 JSON 32 KiB, subject별 outgoing/incoming relation 각각 기본 12개, applied memory 20개, open conflict 10개가 상한이고 exact show relation은 각각 30개다. exact show/history/conflict는 row/field limit와 MCP 2 MiB hard ceiling을 사용한다. pending/evidence/audit/full catalog는 기본 search에서 제외한다.
- mutation은 actor/source/before/after를 가진 history-preserving `audit_events`/`audit_changes`를 남긴다. rollback은 current-row precondition을 확인해 compensating event와 원 event linkage를 추가하며 `catalog_*`나 실제 HA를 변경하지 않는다.

### Codex instruction과 기존 설치

- image 기본 `AGENTS.md`에는 메모리 helper 경로, bounded lookup, candidate와 post-change 검증 규칙만 두고 entity별 data를 쓰지 않는다.
- 기존 base `AGENTS.md`와 user config는 기본 `preserve`에서 갱신되지 않는다. 따라서 `/etc/codex/config.toml`의 image-managed `ha_memory` MCP, developer instruction과 tool description에도 매 HA 요청의 관련 검색과 변경 후 fresh 검증을 제공한다.
- memory MCP/scheduler 실패는 Codex 전체 startup 실패가 아니며 tool 오류 또는 `empty`/`degraded`/`stale` catalog 상태와 last successful refresh를 정제해 보고한다.

## 8. 웹 터미널 계약

- ttyd는 loopback/internal network에서 Ingress port만 listen
- write mode 활성
- shell command는 인수 배열 또는 안전하게 인용된 wrapper 사용
- tmux 세션 attach/create
- `TERM=xterm-256color`
- UTF-8 locale 및 한글 입력/출력 검증
- auto-start Codex가 종료되면 shell을 제공

## 9. Browser renderer 계약

Codex system config의 최소 계약:

```toml
[mcp_servers.playwright]
command = "/usr/bin/env"
args = [
  "-i",
  "HOME=/run/codex-ha/playwright-home",
  "LANG=C.UTF-8",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "/usr/local/bin/ha-playwright-mcp",
]
cwd = "/config"
env_vars = []
enabled = true
required = false
startup_timeout_sec = 30
tool_timeout_sec = 120
default_tools_approval_mode = "writes"
```

- 위치는 `/etc/codex/config.toml`이며 user config `/data/codex/config.toml`보다 낮은 공식 system 계층이다.
- system MCP는 `/usr/bin/env -i`의 고정 최소 환경에서 wrapper를 시작한다. wrapper는 pinned local `cli.js`를 직접 실행하고 `npx`, network install 또는 `latest` resolution을 사용하지 않는다.
- browser는 headless, isolated, no-sandbox이며 기본 viewport `1440x900`; mobile 검사는 `390x844` resize를 사용한다.
- output은 `/run/codex-ha/playwright-output`, 최대 50 MiB, `saveSession=false`, `sharedBrowserContext=false`다. enforcement proxy는 tool call의 `filename`을 거부해 `/config`·`/data`로 artifact를 우회 저장하지 못하게 한다.
- console warning/error, network request 목록의 URL/status, snapshot, screenshot, resize와 일반 UI 상호작용만 proxy와 system config에서 동일하게 allowlist한다. 단일 request의 header/body 상세 도구는 제외한다.
- `browser_run_code_unsafe`, file upload, unrestricted file access와 code generation은 허용하지 않는다.
- Codex system MCP는 STDIO를 사용하며 App service는 HTTP MCP listener와 외부 browser/debug port를 열지 않는다. wrapper는 모든 command-line 인수를 거부하고 enforcement proxy만 실행한다.

## 10. Home Assistant browser gateway 계약

- `127.0.0.1:8099`에만 bind하고 host `ports`, Ingress port 또는 `host_network`를 추가하지 않는다.
- `/`, frontend asset, `/auth`, 전체 Core `/api`와 WebSocket은 Supervisor Core info에서 얻은 scheme/port의 internal `homeassistant` Core로 직접 전달하고, 조회 실패 시 `http://homeassistant:8123`을 사용한다. client identity forwarding header는 제거한다.
- init page는 `127.0.0.1:8099`와 `localhost:8099` origin에서만 검증된 dedicated browser token을 local storage에 주입한다.
- `SUPERVISOR_TOKEN`은 Playwright MCP `env_vars`에서 제외한다. system launch는 `env -i`를 사용하고 wrapper는 검증 전에 `PLAYWRIGHT_MCP_*`, `NODE_OPTIONS`, `NODE_PATH`, `BASH_ENV`, `ENV`를 제거한다. launcher는 App init과 각 MCP 시작의 user policy 재검증에만 Supervisor credential을 사용한다. proxy/browser child는 상속 환경이 아니라 고정 allowlist만 받으며, browser token은 active·local-only·non-admin·non-system·sole `system-read-only` user, credential 부재와 exact single managed LLAT 검증을 통과한 경우에만 `/run/codex-ha`의 `0600` token 파일에서 init script 환경으로 전달한다.
- App의 dynamic IP나 Docker 대역을 `trusted_networks`/`trusted_proxies`에 넣지 않고 Home Assistant auth provider/configuration을 수정하지 않는다.
- `home_assistant_browser_auto_auth`는 default true이고 option이 없는 기존 설치도 true로 해석한다. init과 각 MCP launcher의 `ha-browser-auth-ensure`는 `/auth/providers` preflight 뒤 지원되는 admin/user WebSocket과 login/token/revoke HTTP flow로 전용 user/LLAT를 자동 생성·복구한다. 임시 password credential과 OAuth token은 제거하고, non-ready state/token은 `/data/browser-auth`의 `0700`/`0600` private storage에 crash recovery용으로 보존한다. `ha-browser-auth-setup`은 자동 실패의 인수 없는 수동 재시도·진단이고, `ha-browser-auth-remove`는 OFF 상태에서만 exact identity를 확인한 뒤 제거한다.
- 관리형 setup/remove는 persistent regular lock file의 kernel `flock`으로 직렬화한다. self-revoke는 재접속 거부로 확인하고, ambiguous local-only rejection·TLS/DNS/Core failure·unexpected policy/credential에서는 runtime만 제거하며 recovery material을 보존한다.
- 자동 인증 OFF는 다음 App/MCP session부터 runtime token과 자동 setup을 막되 persistent 관리형 identity는 보존하고, 명시적 remove는 계속 허용한다. ON 상태의 remove는 다음 ensure가 즉시 identity를 재생성하는 경쟁을 막기 위해 거부한다. ON 재시작은 같은 identity를 재사용한다. optional `home_assistant_browser_token`은 ON일 때 수동 override로 관리형 token보다 우선하며 invalid manual token에서 관리형 token으로 fallback하지 않는다.
- Playwright `--secrets`의 입력값 치환은 사용하지 않는다. 관리 proxy의 stdout/stderr exact-value masking은 인코딩·분할된 비밀의 구조적 sanitizer가 아니다. console/network/screenshot과 dashboard 화면, `/data/browser-auth`와 App backup은 민감자료로 취급한다.
- HTTPS frontend upstream과 자동 auth bootstrap은 image CA bundle, SNI와 `homeassistant` hostname을 검증한다. 자체 서명·hostname 불일치·신뢰할 수 없는 chain을 자동 우회하지 않는다.
- browser/gateway 오류, token 부재 또는 user policy 검증 실패는 terminal, SSH와 Codex를 중단시키지 않는다. HA login 화면과 `ha-browser-auth-status`의 fail-closed 상태를 보고한다.

## 11. SSH 계약

권장 sshd 정책:

```text
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding local
Subsystem sftp internal-sftp 또는 필요 시 비활성
```

`AllowTcpForwarding local`은 remote app server가 요구하는 client-side local tunnel은 허용하고 reverse forwarding은 막는다. `AllowAgentForwarding no`와 함께 mobile Remote → desktop SSH project → HAOS App 실기 경로에서 동작을 확인했다.

## 12. Runtime environment

웹/SSH shell 모두 아래를 일관되게 가져야 한다. 구현은 `/run/codex-ha/runtime.env`와 root 전용 SSH environment 파일을 매 부팅마다 다시 만들며 Supervisor runtime credential을 `/data`에 복제하지 않는다. optional browser token은 Supervisor가 관리하는 기존 `/data/options.json`에만 영속되고 shell environment에는 넣지 않는다.

```text
HOME=/data/home
CODEX_HOME=/data/codex
HA_URL=http://supervisor/core/api
SUPERVISOR_URL=http://supervisor
SUPERVISOR_TOKEN=<runtime secret>
PATH=/usr/local/bin:...
```

SSH 세션은 PID 1 환경변수를 자동으로 상속하지 않을 수 있으므로, 토큰을 출력하지 않는 root-only runtime env 파일 또는 안전한 shell initialization 방식을 구현하고 권한을 테스트한다.

Playwright MCP child는 Supervisor token을 받지 않는다. 검증된 dedicated browser token만 exact Home Assistant loopback origin의 init page 환경에 사용하며 runtime 파일은 App 재시작 때 다시 만들고 browser profile로 영속화하지 않는다.

`ha-memoryd`는 주기적 `ha-memory refresh` scheduler이고 `ws://supervisor/core/websocket`의 첫 auth frame에만 root-only runtime Supervisor credential을 사용한다. client는 image-pinned `ws` runtime의 handshake timeout, 32 MiB payload cap, compression off와 기본 TLS 검증을 사용한다. `HA_WS_URL` 환경 override, Upgrade authorization header와 direct-Core credential fallback은 허용하지 않는다. `ha-memory` CLI와 `ha_memory` MCP의 change verify도 같은 고정 HA client로 fresh response를 얻는다. credential은 부팅 때 생성한 ephemeral mode `0600` `/run/codex-ha/runtime.env`에서 process environment로 읽고 MCP wrapper는 최소 환경에서 필요한 값만 CLI child에 전달한다. token은 영속 `/data`, command argument, DB, audit, stdout/stderr, MCP tool output과 App log에 기록하지 않고 모델이 raw credential이나 WebSocket frame을 다루지 않는다.

## 13. App 문서/표현

- `DOCS.md`: 설치, Web UI, 장치 코드 로그인, browser renderer, SSH, Remote SSH, API helper, 검증형 memory 검색·candidate·history/rollback, 위험 경고, 복구
- `CHANGELOG.md`: Keep a Changelog 스타일
- `icon.png`: 제공 원본을 왜곡 없이 축소하고 바깥 matte를 투명화한 128x128 RGBA PNG
- `logo.png`: 같은 방식의 250x250 RGBA PNG (공식 문서는 다른 비율도 허용)
- `translations/en.yaml`, `ko.yaml`: 옵션과 Network 설명
- 패널은 관리자만 표시

## 14. Release image

로컬 개발 단계에서는 `image`를 주석 처리한 local build를 허용한다. `0.1.3`부터 공식 Home Assistant builder actions `2026.06.0`으로 amd64 image와 generic manifest를 미리 빌드하고 `config.yaml`의 `image`에 `ghcr.io/kanu-coffee/codex-for-home-assistant`를 사용한다. Playwright renderer는 `0.2.0`, 최소권한 browser 경로는 `0.2.1`, 관리형 인증은 `0.2.2`, 기본 ON 자동 인증·Codex `8099` 라우팅과 선택형 user-file refresh는 `0.2.3`이다. `0.2.3`의 사용자 기능 포함은 이미 고정된 후보의 검증·배포 연속성을 위한 ADR-030의 1회 SemVer 예외이며, 이후 사용자 기능은 다시 MINOR 규칙을 따른다. 숫자 Git tag와 App version이 정확히 같을 때만 게시하고 기존 tag는 덮어쓰지 않는다. HAOS browser/AppArmor 실기는 public `0.2.3`에서 사용자 확인 PASS지만, Home Assistant `stage`는 별도 M3 평가 전까지 `experimental`을 유지한다.
