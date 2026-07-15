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
                               ├─ HA memory MCP (STDIO)
                               ├─ ha-memoryd + SQLite/FTS5
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

Codex ── bounded STDIO/CLI ── HA memory ── /data/codex-ha-memory/memory.sqlite3
                                      └─ ha-memoryd ── Core WebSocket allowlist
```

## 2. 신뢰 모델

이 App은 신뢰된 관리자 도구다.

- Codex shell은 `/config` 전체를 읽고 쓴다.
- shell은 `SUPERVISOR_TOKEN`을 이용해 Core 및 Supervisor API를 호출한다.
- isolated Chromium은 사용자가 요청한 Web UI와 loopback Home Assistant gateway에 접속하지만 Supervisor token은 받지 않는다.
- Home Assistant 자동 로그인은 검증된 local-only `system-read-only` 전용 user token만 사용한다.
- `ha-memoryd` refresh와 MCP/CLI fresh verify는 root-only runtime environment의 Core credential을 사용하지만 raw credential/response를 저장·출력하지 않고, memory MCP/search는 검증된 local store의 bounded 결과만 반환한다.
- Codex는 실제 기기를 작동시킬 수 있다.
- 컨테이너 밖의 Docker socket, host network, privileged hardware는 주지 않는다.

즉, Home Assistant 영역에서는 강한 권한을 주되 HAOS host/Docker 영역까지 무제한으로 확장하지 않는다.

## 3. 런타임 컴포넌트

### 3.1 Init 단계

컨테이너 시작 시 한 번 실행한다.

1. `/data` 디렉터리와 root-only `/data/codex-ha-memory` 생성 및 권한 설정
2. `codex_user_files_update_mode`와 image App version을 읽고 기본 `preserve`에서는 기존 Codex config/지침을 보존한다. 사용자가 명시한 refresh target만 안전성 preflight, root-only backup과 원자 교체를 거쳐 target별로 해당 version에 한 번 갱신한다.
3. 빠진 Codex 기본 config와 전역 운영 지침을 최초 생성한다.
4. SSH host key 생성 또는 기존 key 로드
5. App 옵션에서 `authorized_keys` 렌더링
6. 공통 runtime environment를 만들고 기본 ON 자동 인증 option에 따라 수동 override를 검증하거나 `/data/browser-auth` 관리형 identity를 생성·재사용한다. user/group/credential/single-token policy를 통과한 경우에만 runtime token 파일을 `/run`에 `0600`으로 생성하며 OFF이면 persistent identity를 보존하고 runtime token을 만들지 않음
7. 이전 기본 Playwright output을 지우고 runtime directory를 `/run` 아래 `0700`으로 재생성
8. `/config` 존재 및 RW 여부 검사
9. `sshd -t`, `nginx -t`, 옵션 형식 검사
10. S6가 ttyd, Ingress proxy, sshd와 독립 `ha-memoryd` 서비스를 시작. memory service는 interactive/browser 서비스의 dependency가 아니며 실패해도 App의 기존 기능은 계속 동작

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

기존 `config.toml`은 기본 `preserve`에서 전체 덮어쓰지 않는다. 파일이 없을 때만 현재 App approval/sandbox option 기반 기본본을 생성하며, 사용자가 `refresh_all`을 명시한 경우에만 안전한 backup 뒤 같은 App 기본본으로 교체한다.
wrapper는 현재 App의 approval/sandbox 옵션을 `-c` override로 주입해 파일을 덮어쓰지 않고 웹·SSH·Remote app-server에 같은 정책을 적용한다.

Playwright MCP는 user config에 append하지 않고 system config에서 제공한다. 같은 `/etc/codex/config.toml`의 top-level `developer_instructions`가 Home Assistant dashboard 작업에는 image-managed Playwright와 `http://127.0.0.1:8099/`를 첫 경로로 지정한다. enforcement proxy도 `browser_navigate` 도구 설명에 같은 안내를 추가해 일반 browser skill 탐색보다 현재 MCP를 바로 선택하게 한다. 공식 Codex config 우선순위에 따라 `/data/codex/config.toml`과 신뢰된 `/config/.codex/config.toml`이 `/etc/codex/config.toml`보다 우선하므로 사용자는 App 기본 server나 instruction을 재정의하거나 끌 수 있다. App 업데이트는 기본적으로 image의 system config만 교체한다. `/data` user config 또는 base `AGENTS.md` 교체는 사용자가 user-file refresh mode를 명시한 경우에만 일어난다.

`/data/codex/AGENTS.md`와 `AGENTS.override.md`가 모두 없으면 이미지에 포함된 Home Assistant 운영 가드레일을 원자적으로 복사한다. 이 전역 지침은 진단 결과를 자동 변경 권한으로 해석하지 않고, 비밀값·`.storage`·Recorder DB·고위험 기기 동작을 보호하며, 설정 변경 후 `ha-config-check`를 요구한다. 기본 `preserve`는 기존 파일·빈 파일·심볼릭 링크를 그대로 보존하므로 사용자가 비활성화하거나 교체할 수 있다. `refresh_agents`와 `refresh_all`은 안전한 일반 파일인 base `AGENTS.md`만 교체하며, `AGENTS.override.md`는 건드리지 않아 더 높은 우선순위 지침을 유지한다. `/config` 아래의 프로젝트별 지침은 Codex 공식 계층 규칙에 따라 나중에 적용되므로 이 파일은 방어 심층화이지 강제 보안 경계가 아니다.

User-file refresh는 `preserve`, `refresh_agents`, `refresh_all`의 닫힌 enum이다. 갱신할 모든 target을 먼저 검사하고 symbolic link, 다중 hardlink, 비정상 file 또는 신뢰할 수 없는 소유권이 하나라도 있으면 링크를 따라가지 않고 갱신 전체를 중단한다. 안전한 경우 기존 bytes와 App candidate, mode/hash metadata를 `/data/codex/backups/user-files/refresh-<UTC>-<random>`의 `0700` transaction directory와 `0600` 파일에 보존한 뒤 같은 filesystem에서 atomic rename한다. journal을 먼저 기록하고 선택된 target 설치 뒤 target별 App version state를 durable commit record로 쓴다. state commit 전 중단은 다음 시작에서 검증된 backup으로 rollback하고, commit 후 남은 journal은 이후 사용자 편집을 되돌리지 않고 정리한다. 같은 version에서 이미 기록된 target은 일반 재시작이나 mode 변경으로 다시 덮어쓰지 않으며, option을 유지하면 다음 version에서 한 번 다시 적용한다.

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
- Supervisor token은 MCP `env_vars`에서 제외한다. Codex는 `env -i`의 고정 최소 환경에서 wrapper를 시작하고 wrapper는 검증 전에 `PLAYWRIGHT_MCP_*`, `NODE_OPTIONS`, `NODE_PATH`, `BASH_ENV`, `ENV`를 제거한다. launcher는 App init과 각 MCP 시작 시 user policy 재검증에만 runtime credential을 사용한다. Node proxy/browser child는 상속 환경이 아니라 고정 allowlist만 받는다. dedicated browser token은 명시적 App option override 또는 `/data/browser-auth`의 관리형 root-only storage에서 읽어 재검증한 뒤 `/run/codex-ha`의 임시 `0600` token 파일로만 전달한다.
- Chromium→gateway peer는 loopback이고 gateway→Core source는 현재 App container IP다. 일반 App IP는 update/recreate 후 재할당될 수 있으므로 `/32`나 Docker pool을 `trusted_networks`/`trusted_proxies`에 저장하지 않고 기존 `homeassistant` provider를 유지한다.
- Playwright `--secrets`는 입력 도구에서 실제 값을 치환하므로 사용하지 않는다. 관리 proxy가 stdout/stderr의 exact token 문자열을 방어 심층화로 마스킹하되, token을 URL query나 command argument에 넣지 않고 screenshot·console/network 결과를 민감자료로 취급한다. 인코딩되거나 분할된 비밀까지 구조적으로 정화한다고 가정하지 않는다.
- Core info가 HTTPS frontend를 보고하면 setup/check WebSocket·HTTP와 nginx gateway 모두 image CA bundle, SNI와 `homeassistant` hostname을 검증한다. 자체 서명·hostname 불일치·신뢰할 수 없는 chain은 자동 우회하지 않고 dashboard 자동 인증을 fail closed한다.

### 3.6.1 관리형 browser identity lifecycle

`home_assistant_browser_auto_auth`는 default `true`이며 option이 없는 기존 설치도 true로 해석한다. App init과 새 Playwright MCP launcher의 `ha-browser-auth-ensure`는 먼저 수동 override 또는 ready 관리 상태를 재검증하고, 둘 다 없거나 관리형 복구가 필요하면 Supervisor admin WebSocket으로 exact read-only/local-only user와 임시 local credential을 만든다. direct Core의 명시적 `homeassistant` login flow로 해당 user session을 얻어 LLAT를 만들고, ownership/type/client를 확인한 직후 non-ready state로 먼저 원자 저장하므로 hard crash에서도 raw revocation material을 잃지 않는다. OAuth refresh와 임시 password credential을 제거하고 exact single-token/credential-free 상태를 재검증한 뒤에만 state를 `ready`로 전환한다. `ha-browser-auth-setup`은 같은 transaction의 수동 재시도·진단 경로다.

OFF는 refresh 초기에 `/run` token을 제거하고 `status: disabled`를 기록한다. 이미 열린 browser context에는 소급 적용하지 않으므로 App과 기존 Codex/MCP session을 재시작해야 한다. OFF는 `/data/browser-auth`와 Home Assistant user/token을 삭제하지 않으며, ON 재시작은 같은 identity를 재사용한다. `ha-browser-auth-remove`는 OFF 상태에서만 exact identity를 명시적으로 삭제해 다음 ensure의 즉시 재생성과 경쟁하지 않게 한다. 수동 token override도 ON일 때만 적용하며 invalid manual token에서 관리형 identity로 자동 fallback하지 않는다.

setup/remove는 `/data/browser-auth/operation.lock`의 kernel `flock`으로 직렬화한다. state와 token은 `O_NOFOLLOW`, owner·regular-file·single-link 검증, file/directory fsync와 atomic rename을 사용한다. token self-revoke는 current refresh token 삭제 뒤 같은 credential 재접속이 확정적으로 거부되는지 확인한다. `local_only` source policy처럼 의미가 모호한 `auth_invalid`, DNS/TLS/Core transport failure 또는 policy/credential mismatch는 `/run`만 비활성화하고 안전한 재시도에 필요한 영구 state/token을 보존한다.

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

### 3.8 검증형 Home Assistant 메모리

메모리는 App 안의 독립 S6 longrun `ha-memoryd`, 공용 transaction/schema 모듈, CLI와 optional STDIO MCP로 구성한다.

```text
Core WebSocket
  → ha-memoryd
  → allowlist normalize + complete-snapshot transaction
  → /data/codex-ha-memory/memory.sqlite3
                                ↑
Codex → ha_memory STDIO MCP ─────┤
shell → ha-memory CLI ───────────┘
```

- `ha-memoryd`는 주기적으로 `ha-memory refresh`를 실행하는 scheduler다. Core ready 전 연결 실패, Core restart와 transport 오류를 retry/backoff하며 last-known-good catalog를 유지한다. 성공 warning은 대상 ID 없이 bounded 개수만 log한다. readiness가 실패해도 Codex, ttyd, SSH, ingress, Playwright와 browser gateway 시작을 막지 않는다.
- `ha-memory-core.mjs`가 v1 schema 초기화·version gating, prepared statement, WAL/busy-timeout transaction, 상태 전이, current-row/status precondition, FTS5 query와 output limit을 한곳에서 구현한다. scheduler/CLI/MCP process가 같은 SQLite WAL database를 사용하며 Unix socket single-writer service를 별도로 만들지 않는다. 알려지지 않은 과거/미래 schema는 자동 변환하지 않고 memory만 fail closed한다.
- `ha-memory-ha-client.mjs`는 refresh와 fresh change verification 때 Supervisor runtime credential로 고정 Supervisor Core WebSocket proxy에 연결한다. image에 고정된 `ws` runtime에 handshake timeout, 32 MiB payload cap, compression off와 기본 TLS 검증을 적용하고, `HA_WS_URL` 같은 환경 endpoint override나 direct-Core credential fallback은 허용하지 않는다. raw token, endpoint response와 인증 frame은 database·argv·stdout/stderr·App log에 쓰지 않는다.
- 연결 실패는 token, DNS, transport, timeout, auth, protocol, 고정 command와 snapshot 범주의 closed code로만 분류한다. DB status/change verification과 CLI는 이 code를 보존하고 `ha-memoryd`는 CLI 원문을 폐기한 뒤 allowlist code만 log한다.
- `/usr/local/bin/ha-memory`와 `ha-memory.mjs`는 관리자용 local CLI다. image-managed `/usr/local/bin/ha-memory-mcp`와 `ha-memory-mcp.mjs`는 외부 listener 없이 STDIO tool만 제공한다. wrapper는 system MCP의 최소 환경에서 시작해 root-only `/run/codex-ha/runtime.env`를 source하고 필요한 allowlist 환경만 CLI child에 넘기므로 fresh verify는 Core를 직접 재조회할 수 있지만 credential을 모델 입력이나 MCP 결과에 노출하지 않는다.
- MCP의 기본 query 도구는 `memory_search`, `memory_show`, `memory_status`이며 candidate와 검증 workflow에는 `memory_propose`, `memory_add_evidence`, `memory_verify_candidate`, `memory_apply_candidate`, `memory_begin_change`, `memory_verify_change`, `memory_history`, `memory_conflicts`, `memory_resolve_conflict`, `memory_rollback`을 명시적으로 사용한다. 입력은 고정 schema와 current-row/status 검사를 통과한다. `search`는 row/32 KiB 한도를 함께 적용하고 exact `show`·history·conflict는 별도 row/field 한도와 MCP 2 MiB hard ceiling을 적용한다.
- 새 설치용 global `AGENTS.md`에는 helper 위치와 사용·검증 규칙만 넣는다. 기존 `AGENTS.md`는 기본 `preserve`로 갱신되지 않으므로 `/etc/codex/config.toml`의 image-managed `ha_memory` MCP와 developer instruction도 매 HA 요청의 bounded search, candidate 수집과 post-change 검증을 안내한다.

## 4. 영속 데이터

```text
/data/
├─ home/
│  └─ 사용자 shell 관련 영속 파일
├─ codex-ha-memory/      # 0700, 검증형 HA 메모리
│  ├─ memory.sqlite3     # 0600, catalog/candidate/audit/FTS5
│  ├─ memory.sqlite3-wal # 존재 시 0600
│  └─ memory.sqlite3-shm # 존재 시 0600
├─ codex/
│  ├─ auth.json          # 비밀, 0600
│  ├─ AGENTS.md          # 영속 전역 운영 지침, 기본 preserve
│  ├─ config.toml
│  ├─ .user-files-update-state.json   # target별 적용 App version, 0600
│  ├─ .user-files-update-journal.json # crash recovery 중에만 존재, 0600
│  ├─ .user-files-update.lock         # persistent inode + kernel flock, 0600
│  ├─ backups/user-files/             # refresh 전 원본·candidate·metadata, root-only
│  └─ sessions/...
├─ ssh/
│  ├─ authorized_keys   # 0600
│  ├─ ssh_host_*_key    # 0600
│  └─ *.pub             # 0644
├─ browser-auth/        # 관리형 dashboard identity, 0700
│  ├─ managed-user.json # credential-free lifecycle journal, 0600
│  ├─ managed-token     # 관리형 LLAT, 0600
│  └─ operation.lock    # persistent inode + kernel flock, 0600
└─ tmux/
```

`/data`는 Supervisor가 App 데이터와 `options.json`을 영속화한다. `auth.json`, optional `home_assistant_browser_token`, `browser-auth/managed-token`과 user-file refresh backup이 App backup에 포함될 가능성이 있으므로 backup은 비밀정보로 취급한다. 특히 이전 `config.toml`에는 MCP/API credential이나 내부 endpoint가 있을 수 있다. browser context/profile/screenshot은 영속 상태로 만들지 않는다.

이미지·runtime 전용 경로는 다음처럼 분리한다.

```text
/etc/codex/config.toml                    # image-managed system MCP config
/usr/local/lib/codex-ha/playwright/       # pinned npm runtime
/usr/local/share/codex-ha/playwright-*    # image-managed browser config/init
/usr/local/share/codex-ha/ha-memory-*.mjs # image-managed memory core/HA client/MCP
/usr/local/bin/ha-memory*                 # local CLI와 MCP wrappers; scheduler는 S6 run script
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
first client frame after server auth_required:
{"type":"auth","access_token":"${SUPERVISOR_TOKEN}"}
```

이 endpoint와 auth frame은 Home Assistant App 통신 계약에 고정한다. Upgrade `Authorization` header를 추가하거나 Supervisor credential을 `homeassistant` direct Core endpoint에 보내지 않는다.

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

### 7.1 메모리 수집과 정규화

`ha-memoryd`가 호출할 수 있는 Core WebSocket command를 다음으로 제한한다.

```text
config/entity_registry/list
config/device_registry/list
config/area_registry/list
get_states
automation/config
search/related
```

automation command는 registry에서 확인한 automation 대상에만 호출한다. graph 요청은 공식 Core 의미를 유지해 `search/related(item_type=automation, item_id=<automation entity_id>)`를 사용하며, `item_type=entity`는 역방향 entity 관계이므로 fallback graph로 사용하지 않는다. Core가 unavailable automation에 성공 응답으로 반환할 수 있는 explicit `config: null`은 빈 config와 bounded warning으로 정규화한다. 개별 related 요청의 정상 result envelope가 실기와 같은 `success:false`, `error.code=unknown_error`인 경우에만 해당 enrichment를 빈 객체와 warning으로 격리하고 성공한 config의 allowlist area/device/entity 직접 참조를 사용한다. 다른 server command code, server/client timeout, unauthorized, invalid format, config 실패, auth/transport/close/protocol, 누락·malformed envelope와 malformed successful related 결과는 성공한 일부를 complete snapshot으로 가장하지 않고 stale/degraded 상태와 정제된 오류를 기록한다. `.storage` 직접 읽기, 임의 WebSocket command와 raw `/config` parse는 bootstrap 대체 경로가 아니다.

정규화 경계는 다음과 같다.

- entity: `entity_id`, 허용된 표시명/설명, `device_id`, `area_id`, platform과 disabled/hidden 여부처럼 관계 해석에 필요한 제한 field
- device: registry ID, 허용된 사용자/기본 표시명, 제조사·모델, `area_id`와 disabled 여부
- area: registry ID, 이름과 허용된 alias
- automation: entity registry와 state의 합집합에서 얻은 식별자, alias, description, mode와 config/related 응답에서 추출한 entity/device/area 식별자 관계. state가 없는 disabled registry automation도 index하되 Core가 detail command를 제공하는 active automation만 enrichment한다.
- `get_states`: entity 존재와 fresh expectation 비교에 사용한다. state 문자열과 임의 attributes는 폐기하지만 표시명, device class, icon, automation id/mode 같은 명시적 allowlist metadata만 정규화할 수 있다.

automation config 전체, API response JSON, raw state와 비허용 attributes, registry의 비허용 field, 대화 transcript, `/config` 원문과 secret/token은 catalog, evidence, audit payload와 FTS5 어디에도 저장하지 않는다. 허용 문자열도 size/type 검증과 secret-like field 차단을 통과해야 한다.

SQLite의 고정 table은 `metadata`, `sync_runs`, `catalog_objects`, `catalog_relations`, `catalog_revisions`, `memory_items`, `memory_evidence`, `conflicts`, `change_records`, `audit_events`, `audit_changes`, `search_fts`다. `memory_items`가 candidate/verified/applied semantic fact를 통합하고 `search_fts`는 허용된 catalog/applied text만 index한다. foreign key와 check constraint는 참조 무결성과 허용 enum을 제한하고, application transaction이 `pending → verified → applied` 순서와 current-row/status precondition을 다시 확인한다. 전체 snapshot은 staging validation·normalization이 모두 성공한 뒤 한 transaction으로 commit하며 실패한 시도는 `sync_runs` 상태만 남기고 기존 catalog revision을 유지한다.

### 7.2 후보, 변경 검증, 검색과 rollback

```text
사용자 발화/분석
  → propose pending + provenance
  → evidence 추가
  → fact 종류별 authority 검증
  → verified
  → current row/status와 conflict 확인
  → applied + audit event
```

- HA가 표현할 수 있는 구조·존재·registry 관계와 Codex change result는 fresh Core 응답이 canonical이다. 별칭·실제 용도·선호처럼 HA schema 밖 사용자 의미는 명시적 사용자 설명이 authority다. 모델 추론과 일시 state는 pending evidence가 될 수 있어도 단독으로 verified/applied가 될 수 없다.
- 충돌은 양쪽 source, subject/predicate, revision과 resolution을 보존한다. authority가 명확하면 새 applied revision으로 수렴하고, 불명확하면 unresolved로 남겨 기본 context에서 단정하지 않는다.
- Codex change는 mutation 전에 subject와 closed-schema expectation의 digest·field-only summary를 기록하며 생성 예정 subject도 선언할 수 있다. 설정 검사와 mutation 후 같은 `--expect-json` 계약을 새 WebSocket/API round trip이 만족해야 change evidence가 verified된다. expectation 값과 API raw state/attributes/config는 process에서 비교한 뒤 폐기하고 `change_records`에는 subject, expectation/predicate digest, field summary, boolean result, fresh 검증 시각과 revision만 남긴다. `codex_change` relationship candidate는 동일 source·relation·target의 성공한 존재 predicate에만 연결하며 같은 subject의 무관한 check로 검증하지 않는다. cached catalog, HTTP 2xx, config check만으로 memory를 갱신하지 않는다.
- `search`는 최대 256자 query의 exact entity/alias lookup과 FTS5 rank로 관련 canonical/applied row와 가까운 relation만 반환한다. 기본 8·최대 20 subject, serialized JSON 32 KiB, subject별 outgoing/incoming relation 각각 기본 12개, applied memory 20개와 open conflict 10개가 상한이며 exact `show`의 relation만 각각 30개까지 허용한다. pending/evidence/audit/conflict 전체는 별도 명시 도구에서만 조회한다.
- candidate 생성, evidence/verify/apply, conflict resolution과 rollback은 history-preserving before/after audit event를 남긴다. rollback은 current-row precondition을 통과한 compensating event를 추가하고 원 event에 linkage만 기록해 semantic memory를 되돌리며 과거 event를 삭제하지 않는다.
- HA-derived catalog는 cache이므로 memory rollback 대상이 아니다. 잘못되거나 stale한 catalog는 fresh Core refresh로만 교정하며 rollback 명령이 Home Assistant config, registry, automation 또는 기기를 변경하지 않는다.

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
| 사용자 `AGENTS.md`/`AGENTS.override.md` 존재 | 기본 `preserve`는 그대로 보존. 명시적 refresh는 안전한 base `AGENTS.md`만 version당 한 번 교체하고 override는 보존 |
| user-file refresh target이 symlink/hardlink/non-regular 또는 안전하지 않은 소유권 | 링크를 따라가지 않고 선택한 갱신 전체를 중단하며 기존 파일로 계속 시작 |
| user-file refresh 중 종료 | private journal과 검증된 backup으로 rollback하거나 이미 commit된 target을 확인한 뒤 같은 version에서 반복하지 않음 |
| Codex 다운로드/실행 실패 | build 또는 startup 실패를 명확히 표시 |
| `/config` RW 아님 | 치명적 startup 오류 |
| Core/Supervisor API 일시 실패 | shell 유지, helper가 오류 반환 |
| ttyd 실패 | App unhealthy 또는 명확한 service error |
| sshd 실패 | Web UI는 가능, SSH degraded 로그 |
| 브라우저 연결 끊김 | tmux/Codex 세션 유지 |
| Playwright MCP/Chromium 시작 실패 | Codex·shell은 유지, browser tool만 degraded 오류 |
| 자동 인증 OFF | 기존 browser context 종료/App 재시작 뒤 일반 URL 렌더 유지, HA dashboard login 화면과 `disabled` auth status 표시; 관리형 identity 보존 |
| 자동 setup 실패, dedicated browser token 없음/검증 실패 또는 `SUPERVISOR_TOKEN` 없음 | 일반 URL 렌더 유지, HA dashboard는 fail-closed login 화면과 auth status 표시; 필요 시 수동 setup으로 정제된 오류 확인 |
| 관리형 setup 중 Core/provider/TLS 실패 | non-ready journal/token 보존, runtime 제거, 명시적 재실행으로 수렴 |
| 관리형 user policy/credential 변경 | 자동 수리·삭제 거부, owned token revocation 확인 또는 recovery material 보존 |
| loopback gateway upstream 실패 | status와 sanitized 원인 보고, token 원문 미출력 |
| browser output 한도 도달 | MCP 한도 오류/정리 정책을 보고하고 `/data` 사용자 파일은 건드리지 않음 |
| `ha-memoryd` 또는 Core WebSocket 시작 실패 | Codex/Web/SSH/browser는 계속 시작, last-known-good catalog를 유지하고 catalog를 `degraded`/`stale`로 표시하며 token/DNS/transport/timeout/auth/protocol의 allowlist code만 기록 |
| 개별 automation `search/related`가 정상 envelope의 `unknown_error`로 거부됨 | official automation payload는 유지하고 해당 enrichment만 빈 객체와 bounded warning으로 격리. 성공 config에서 직접 관계를 추출해 snapshot commit |
| memory 필수 command/transport/envelope 실패 | legal `config: null`은 빈 automation config로 수용하되 config 실패, related timeout/close/protocol 또는 malformed 결과는 부분 결과를 canonical로 commit하지 않고 이전 revision과 command/snapshot allowlist code 유지 |
| memory DB unsafe owner/type/link/mode 또는 schema 손상 | 자동 삭제·재생성하지 않고 memory만 fail closed; 기존 App 기능 유지 및 복구 안내 |
| post-change fresh expectation 불일치 | canonical catalog는 같은 fresh HA snapshot으로 수렴하지만 applied semantic memory는 바꾸지 않고 mismatch change와 conflict evidence만 기록 |
| memory rollback revision 충돌 | compensating event를 쓰지 않고 현재 history/conflict 재조회 요구; HA catalog와 실제 HA 비변경 |

## 12. 아키텍처 제약

- App 하나에서 기능을 제공한다.
- 별도 sidecar/proxy/container를 요구하지 않는다.
- 외부 SMB/SSH relay를 요구하지 않는다.
- Ingress를 위해 host network를 사용하지 않는다.
- Playwright를 위해 새 host/Ingress port, Docker socket, capability 또는 App privilege를 추가하지 않는다.
- browser MCP는 image-managed system default지만 사용자 Codex config보다 우선하지 않는다.
- memory MCP도 image-managed optional STDIO default이며 외부 listener, sidecar, cloud/vector service를 만들지 않는다.
- 메모리 장애는 App의 기존 운영 표면을 중단시키지 않지만 stale/unavailable 결과를 verified current fact처럼 반환해서는 안 된다.
- 기존 사용자 `AGENTS.md` preserve 계약 때문에 memory 사용 규칙은 image-managed developer instruction과 MCP tool description에서도 제공한다.
- App 소스 저장소와 실제 HA `/config` 저장소는 별개일 수 있다.
