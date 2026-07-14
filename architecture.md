# architecture.md — 시스템 아키텍처

## 1. 컨텍스트

```text
ChatGPT mobile Remote ── Desktop App ── SSH ───┐
Windows Terminal ─────────────────────── SSH ───┤
Home Assistant Frontend ──── Ingress/WebSocket ┤
                                               ▼
                              Codex for Home Assistant App
                              ├─ Codex CLI
                              ├─ ttyd
                              ├─ tmux
                              ├─ OpenSSH server
                              ├─ Git/YAML/API tools
                              ├─ Playwright MCP (STDIO)
                              ├─ Chromium headless shell
                              ├─ HA dashboard loopback gateway
                              ├─ /data   (persistent)
                              └─ /config (HA config RW)
                                      │
                  ┌───────────────────┴──────────────────┐
                  ▼                                      ▼
       Home Assistant Core API                Supervisor API
       http://supervisor/core/api/             http://supervisor/
       ws://supervisor/core/websocket          manager role

Codex ── STDIO MCP ── Playwright ── Chromium
                                  ├─ arbitrary authorized Web UI URL
                                  └─ http://127.0.0.1:8099
                                       └─ HA frontend/auth/API/WebSocket direct Core proxy
```

## 2. 신뢰 모델

이 App은 신뢰된 관리자 도구다.

- Codex shell은 `/config` 전체를 읽고 쓴다.
- shell은 `SUPERVISOR_TOKEN`을 이용해 Core 및 Supervisor API를 호출한다.
- isolated Chromium은 사용자가 요청한 Web UI와 loopback Home Assistant gateway에 접속하지만 Supervisor token은 받지 않는다.
- Home Assistant 자동 로그인은 검증된 local-only `system-read-only` 전용 user token만 사용한다.
- Codex는 실제 기기를 작동시킬 수 있다.
- 컨테이너 밖의 Docker socket, host network, privileged hardware는 주지 않는다.

즉, Home Assistant 영역에서는 강한 권한을 주되 HAOS host/Docker 영역까지 무제한으로 확장하지 않는다.

## 3. 런타임 컴포넌트

### 3.1 Init 단계

컨테이너 시작 시 한 번 실행한다.

1. `/data` 디렉터리 생성 및 권한 설정
2. Codex 기본 config 생성(기존 파일 보존)
3. Codex 전역 운영 지침 생성(기존 `AGENTS.md` 보존)
4. SSH host key 생성 또는 기존 key 로드
5. App 옵션에서 `authorized_keys` 렌더링
6. 공통 runtime environment를 만들고 optional browser token의 user/group policy를 검증해 통과한 경우에만 runtime token 파일을 `/run`에 `0600`으로 생성
7. 이전 기본 Playwright output을 지우고 runtime directory를 `/run` 아래 `0700`으로 재생성
8. `/config` 존재 및 RW 여부 검사
9. `sshd -t`, `nginx -t`, 옵션 형식 검사
10. S6가 ttyd, Ingress proxy, sshd 서비스를 시작

### 3.2 ttyd 서비스

- Ingress port `7681`: nginx가 Supervisor gateway `172.30.32.2`와 loopback만 허용
- ttyd port `7682`: loopback에만 bind하고 nginx가 WebSocket reverse proxy
- 두 포트 모두 `ports`에 넣지 않아 외부 포트 미노출
- 실행 대상: `web-terminal-entrypoint`
- S6 `with-contenv`가 ttyd의 연결별 TERM을 제거하므로 entrypoint가 외부 `TERM=xterm-256color`를 복원
- entrypoint는 tmux 세션에 attach/create
- tmux 내부 session shell은 일반 Bash shebang으로 tmux의 `TERM=tmux-256color`를 보존
- tmux working directory: `/config`
- auto-start 옵션에 따라 Codex를 한 번 실행

### 3.3 sshd 서비스

- 내부 port: 22
- 공개키 전용
- root 또는 `/config`를 확실히 쓸 수 있는 전용 운영 사용자 사용
- MVP 권장: 컨테이너 root login을 공개키로만 허용하되 App 경계 밖 권한은 부여하지 않음
- host keys와 authorized_keys는 `/data/ssh`
- login shell에서 `/config`로 이동
- non-interactive SSH는 root의 Bash `BASH_ENV`로 동일 runtime environment와 `/config` 시작 경로 적용

전용 non-root 사용자를 선택하려면 `/config`의 host 권한을 바꾸지 않고 RW를 보장하는 방법을 먼저 증명해야 한다. 검증 없이 host-mounted `/config`에 `chown -R`하지 않는다.

### 3.4 Codex CLI

- command wrapper: `/usr/local/bin/codex`
- pinned binary: `/usr/local/libexec/codex-real`
- `HOME=/data/home`
- `CODEX_HOME=/data/codex`
- working directory: `/config`
- user config: `/data/codex/config.toml`
- image-managed system config: `/etc/codex/config.toml`

기본 config 초안:

```toml
approval_policy = "on-request"
sandbox_mode = "danger-full-access"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
```

기존 `config.toml`이 있으면 전체 덮어쓰지 않는다. 누락된 필수 키만 안전하게 초기화하거나 샘플을 별도 제공한다.
wrapper는 현재 App의 approval/sandbox 옵션을 `-c` override로 주입해 파일을 덮어쓰지 않고 웹·SSH·Remote app-server에 같은 정책을 적용한다.

Playwright MCP는 user config에 append하지 않고 system config에서 제공한다. 공식 Codex config 우선순위에 따라 `/data/codex/config.toml`과 신뢰된 `/config/.codex/config.toml`이 `/etc/codex/config.toml`보다 우선하므로 사용자는 App 기본 server를 재정의하거나 끌 수 있다. App 업데이트는 image의 system config만 교체하고 `/data` user config 내용은 건드리지 않는다.

`/data/codex/AGENTS.md`와 `AGENTS.override.md`가 모두 없으면 이미지에 포함된 Home Assistant 운영 가드레일을 원자적으로 복사한다. 이 전역 지침은 진단 결과를 자동 변경 권한으로 해석하지 않고, 비밀값·`.storage`·Recorder DB·고위험 기기 동작을 보호하며, 설정 변경 후 `ha-config-check`를 요구한다. 기존 파일·빈 파일·심볼릭 링크는 그대로 보존하므로 사용자가 비활성화하거나 교체할 수 있다. `/config` 아래의 프로젝트별 지침은 Codex 공식 계층 규칙에 따라 나중에 적용되므로 이 파일은 방어 심층화이지 강제 보안 경계가 아니다.

### 3.5 Playwright MCP와 Chromium

- Microsoft `@playwright/mcp`는 package lock과 함께 App image에 설치한다.
- Playwright가 browser를 runtime에 다운로드하지 않고 Alpine package `/usr/bin/chromium-headless-shell`을 `executablePath`로 사용한다.
- Codex system config는 `/usr/local/bin/ha-playwright-mcp`를 STDIO child process로 시작한다. wrapper는 command-line 인수를 거부하고 enforcement proxy만 실행하므로 App service는 HTTP/SSE MCP listener나 host port를 열지 않는다.
- system MCP entry는 `required=false`, `startup_timeout_sec=30`, `tool_timeout_sec=120`으로 browser 실패를 Codex 전체 시작 실패와 분리한다.
- Chromium context는 `headless=true`, `isolated=true`, `chromiumSandbox=false`, `--no-sandbox`, `--disable-dev-shm-usage`로 실행한다. sandbox 비활성화는 App 컨테이너 안의 browser process에만 적용하며 Home Assistant App privilege를 늘리지 않는다.
- 기본 context는 `1440x900`, `ko-KR`, dark color scheme이다. mobile 회귀는 같은 page를 `390x844`로 resize한 뒤 새 snapshot/screenshot과 console/network 결과를 얻는다.
- output은 `/run/codex-ha/playwright-output`에 두고 `0700`, 최대 50 MiB, session 저장 비활성으로 관리한다. enforcement proxy는 tool call의 `filename` 인수를 거부해 `/config`·`/data` 우회를 막고 init은 이전 output directory를 지운 뒤 다시 만든다.
- enforcement proxy와 Codex system config가 같은 allowlist를 적용한다. 허용 도구는 navigate, snapshot, resize, screenshot, console, network request 목록과 일반 UI 상호작용이며 arbitrary code 실행, 단일 network request의 header/body 상세, code generation과 file upload는 허용하지 않는다.

Alpine/musl 및 system Chromium 조합은 Playwright upstream의 공식 Ubuntu/Debian browser bundle 경로가 아니다. 따라서 image build와 local smoke를 통과해도 실제 HAOS의 kernel/AppArmor에서 확인하기 전에는 지원 완료로 판정하지 않는다.

### 3.6 Home Assistant dashboard gateway

브라우저의 frontend, auth, API와 WebSocket이 서로 다른 identity 경로를 쓰지 않도록 loopback gateway가 다음을 하나의 direct Core browser origin으로 합친다.

```text
Chromium
  → http://127.0.0.1:8099/              → <Core info의 scheme/port>/ frontend/assets
  → http://127.0.0.1:8099/auth/...       → <같은 Core>/auth/...
  → http://127.0.0.1:8099/api/...        → <같은 Core>/api/...
  → ws://127.0.0.1:8099/api/websocket    → <같은 Core>/api/websocket
```

- `8099`는 컨테이너 loopback 전용 internal listener이며 `config.yaml`의 `ports`, Ingress 또는 host network에 추가하지 않는다.
- browser init page는 origin이 정확히 `http://127.0.0.1:8099` 또는 `http://localhost:8099`일 때만 active·local-only·non-system·non-admin·sole `system-read-only` user로 검증된 token을 Home Assistant frontend local storage에 넣는다.
- browser가 보내는 전체 Core REST/WebSocket 인증은 direct Core로 전달하며 X-Forwarded-For, X-Real-IP와 Forwarded를 제거한다. gateway는 Core endpoint/method를 별도 allowlist하지 않지만 arbitrary target origin에는 token이나 header를 추가하지 않는다.
- Supervisor token은 MCP `env_vars`에서 제외한다. Codex는 `env -i`의 고정 최소 환경에서 wrapper를 시작하고 wrapper는 검증 전에 `PLAYWRIGHT_MCP_*`, `NODE_OPTIONS`, `NODE_PATH`, `BASH_ENV`, `ENV`를 제거한다. launcher는 App init과 각 MCP 시작 시 user policy 재검증에만 runtime credential을 사용한다. Node proxy/browser child는 상속 환경이 아니라 고정 allowlist만 받으며 dedicated browser token은 Supervisor-managed App option에 영속되고 재검증 후 `/run/codex-ha`의 임시 `0600` token 파일에서 Playwright init script 환경으로만 전달된다.
- Chromium→gateway peer는 loopback이고 gateway→Core source는 현재 App container IP다. 일반 App IP는 update/recreate 후 재할당될 수 있으므로 `/32`나 Docker pool을 `trusted_networks`/`trusted_proxies`에 저장하지 않고 기존 `homeassistant` provider를 유지한다.
- Playwright `--secrets`는 입력 도구에서 실제 값을 치환하므로 사용하지 않는다. 관리 proxy가 stdout/stderr의 exact token 문자열을 방어 심층화로 마스킹하되, token을 URL query나 command argument에 넣지 않고 screenshot·console/network 결과를 민감자료로 취급한다. 인코딩되거나 분할된 비밀까지 구조적으로 정화한다고 가정하지 않는다.
- Core info가 HTTPS frontend를 보고하면 gateway는 내부 `homeassistant` upstream에 TLS로 연결하지만 자체 서명·사용자 인증서 호환을 위해 현재 `proxy_ssl_verify off`다. 이 내부 신뢰 가정과 위험은 실제 HAOS에서 검증하며 외부 origin용 범용 TLS proxy로 사용하지 않는다.

### 3.7 Browser 검사 흐름

```text
1. 검사 대상과 허용된 URL 확인
2. desktop 1440x900으로 navigate 및 DOM snapshot
3. screenshot 저장
4. console warning/error와 uncaught page error 수집
5. 정적 resource를 포함한 network 요청의 status/실패 수집
6. mobile 390x844로 resize
7. snapshot/screenshot/console/network 재수집
8. 수정 후 동일 순서로 회귀 비교
```

Home Assistant dashboard는 persistent WebSocket을 사용하므로 무조건적인 `networkidle`을 완료 조건으로 삼지 않는다. 명확한 root element, navigation 완료와 제한된 안정화 시간을 사용한다. screenshot은 시각 증거이고 console/network 결과를 대체하지 않는다.

## 4. 영속 데이터

```text
/data/
├─ home/
│  └─ 사용자 shell 관련 영속 파일
├─ codex/
│  ├─ auth.json          # 비밀, 0600
│  ├─ AGENTS.md          # 영속 전역 운영 지침, 기존 파일 보존
│  ├─ config.toml
│  └─ sessions/...
├─ ssh/
│  ├─ authorized_keys   # 0600
│  ├─ ssh_host_*_key    # 0600
│  └─ *.pub             # 0644
└─ tmux/
```

`/data`는 Supervisor가 App 데이터와 `options.json`을 영속화한다. `auth.json`과 optional `home_assistant_browser_token`이 App backup에 포함될 가능성이 있으므로 backup은 비밀정보로 취급한다. Playwright 기능 추가는 기존 user config를 migration하거나 browser profile을 새 영속 상태로 만들지 않는다.

이미지·runtime 전용 경로는 다음처럼 분리한다.

```text
/etc/codex/config.toml                    # image-managed system MCP config
/usr/local/lib/codex-ha/playwright/       # pinned npm runtime
/usr/local/share/codex-ha/playwright-*    # image-managed browser config/init
/run/codex-ha/home-assistant-browser.token # validated ephemeral credential, 0600
/run/codex-ha/browser-auth-status.json    # credential-free validation status, 0600
/run/codex-ha/browser-network-info.json   # credential-free current socket path, 0600
/run/codex-ha/playwright-output/          # default ephemeral artifacts, 0700, 50 MiB cap
```

## 5. Home Assistant 설정 데이터

```text
/config/
├─ configuration.yaml
├─ automations.yaml
├─ scripts.yaml
├─ scenes.yaml
├─ dashboards/
├─ packages/
├─ custom_components/
├─ www/
├─ .storage/
├─ home-assistant_v2.db  # 기본 Recorder SQLite인 경우
└─ secrets.yaml
```

Codex는 전체를 관리할 수 있다. 다만 운영 규칙상:

- `.storage`는 직접 수정보다 공식 API/UI/YAML을 우선한다.
- SQLite DB는 분석 시 read-only 연결을 우선한다.
- `secrets.yaml` 내용과 토큰을 응답/로그에 복사하지 않는다.

## 6. API 경로

### Core REST

```text
Base: http://supervisor/core/api/
Authorization: Bearer ${SUPERVISOR_TOKEN}
```

### Core WebSocket

```text
ws://supervisor/core/websocket
```

### Supervisor

```text
Base: http://supervisor/
Authorization: Bearer ${SUPERVISOR_TOKEN}
Role: manager
```

## 7. API helper 설계

### `ha-api`

```bash
ha-api GET /states
ha-api POST /services/light/turn_on '{"entity_id":"light.test"}'
```

요구사항:

- method allowlist가 아니라 사용자가 요청한 전체 Core API를 전달
- JSON body validation
- HTTP status 보존
- Authorization header 미출력
- pretty JSON 출력, `--raw` 선택 가능
- 기본 `Accept: application/json`, 명시적 media type은 JSON/plain/x-log allowlist만 허용

### `supervisor-api`

```bash
supervisor-api GET /core/info
supervisor-api POST /core/check '{}'
```

manager 권한 거부는 정확히 표시하고 admin으로 자동 재시도하지 않는다.

### 진단 helper

- `ha-config-check`: `/core/check` 호출 및 결과 대기
- `ha-core-logs`: `Accept: text/x-log`로 Core log endpoint 조회
- `ha-addon-logs <slug>`: `Accept: text/x-log`로 대상 App 로그 조회

엔드포인트 이름은 구현 시점의 공식 Supervisor API를 다시 확인한다.

## 8. 실제 기기 테스트 흐름

```text
1. 대상 entity와 기대 동작 확인
2. 현재 state/attributes 저장
3. 관련 automation trace/log 수집
4. service call 실행
5. 상태 변경 및 로그 확인
6. 실패 원인 분석
7. 안전하면 원래 상태 복원
8. 수행 내역 보고
```

도어록·경보·출입 장치 등 고위험 엔티티는 명시적 승인 규칙을 따른다.

## 9. Web Terminal 세션 흐름

```text
Ingress connection
  → ttyd
  → web-terminal-entrypoint
  → outer TERM=xterm-256color 복원
  → tmux new-session -A -s <name> -c /config
  → pane TERM=tmux-256color 보존
  → auto-start=false: login shell
  → auto-start=true: codex -C /config; then login shell
```

복수 브라우저가 동일 세션에 붙을 수 있는지, 각 연결별 별도 세션이 나은지는 MVP에서는 단일 공유 세션으로 시작하고 실제 UX를 평가한다.

자동 smoke는 ttyd protocol의 resize frame을 보낸 뒤 tmux client geometry를 확인하고, WebSocket을 닫았다 다시 연결해 같은 `session_id`, `pane_id`, `pane_pid`에 붙는지 검증한다. 이 보장은 App 프로세스가 살아 있는 동안만 적용된다. App 업데이트·재시작은 컨테이너 프로세스를 종료하므로 tmux 세션이 사라지는 것이 정상이다.

## 10. SSH/Remote SSH 흐름

```text
ChatGPT mobile Remote (선택)
  → paired desktop app
  → ~/.ssh/config alias
  → App host:2223
  → public key auth
  → login shell loads runtime env
  → command -v codex
  → Codex remote app-server bootstrap
  → remote project /config
```

SSH host key가 재시작마다 바뀌면 Remote SSH가 깨지므로 `/data` 영속화는 필수다.

## 11. 실패 모드

| 실패 | 기대 동작 |
|---|---|
| authorized_keys 비어 있음 | Web UI는 정상, SSH는 비활성/경고 |
| Codex 미인증 | shell은 정상, `ha-codex-login` 안내 |
| 사용자 `AGENTS.md`/`AGENTS.override.md` 존재 | 기본 지침으로 덮어쓰지 않고 그대로 보존 |
| Codex 다운로드/실행 실패 | build 또는 startup 실패를 명확히 표시 |
| `/config` RW 아님 | 치명적 startup 오류 |
| Core/Supervisor API 일시 실패 | shell 유지, helper가 오류 반환 |
| ttyd 실패 | App unhealthy 또는 명확한 service error |
| sshd 실패 | Web UI는 가능, SSH degraded 로그 |
| 브라우저 연결 끊김 | tmux/Codex 세션 유지 |
| Playwright MCP/Chromium 시작 실패 | Codex·shell은 유지, browser tool만 degraded 오류 |
| dedicated browser token 없음/검증 실패 또는 `SUPERVISOR_TOKEN` 없음 | 일반 URL 렌더 유지, HA dashboard는 fail-closed login 화면과 auth status 표시 |
| loopback gateway upstream 실패 | status와 sanitized 원인 보고, token 원문 미출력 |
| browser output 한도 도달 | MCP 한도 오류/정리 정책을 보고하고 `/data` 사용자 파일은 건드리지 않음 |

## 12. 아키텍처 제약

- App 하나에서 기능을 제공한다.
- 별도 sidecar/proxy/container를 요구하지 않는다.
- 외부 SMB/SSH relay를 요구하지 않는다.
- Ingress를 위해 host network를 사용하지 않는다.
- Playwright를 위해 새 host/Ingress port, Docker socket, capability 또는 App privilege를 추가하지 않는다.
- browser MCP는 image-managed system default지만 사용자 Codex config보다 우선하지 않는다.
- App 소스 저장소와 실제 HA `/config` 저장소는 별개일 수 있다.
