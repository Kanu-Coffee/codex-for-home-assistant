# decisions.md — Architecture Decision Records

## ADR-001 Home Assistant App으로 구현

- 상태: Accepted
- 결정: HACS integration이 아니라 Supervisor가 관리하는 Home Assistant App(구 Add-on) repository로 만든다.
- 이유: Codex CLI, ttyd, sshd, persistent `/data`, `/config` mount, Core/Supervisor API 권한이 필요하다.

## ADR-002 세 접근 방식을 동시에 제공

- 상태: Accepted
- 결정: Codex CLI, Ingress 웹 터미널, SSH/Remote SSH를 한 App에서 제공한다.
- 이유: Home Assistant Ingress, 일반 SSH와 ChatGPT mobile Remote의 직접 SSH 접근을 한 App에서 제공한다.

## ADR-003 `/config` 전체 RW

- 상태: Extended by ADR-039
- 결정: `homeassistant_config`를 `/config`에 RW로 매핑한다. ADR-039부터 고정 민감 경로는 AppArmor와 managed Codex requirements가 사용 가능 영역에서 제외한다.
- 이유: 대시보드뿐 아니라 자동화, scripts, packages, logs/DB 분석, 전체 운영을 맡기려는 제품 목표 때문이다.
- 결과: 설정 손상 위험을 Git/검사/backup 운영 규칙으로 관리한다.

## ADR-004 Core API + Supervisor manager

- 상태: Accepted
- 결정:

```yaml
homeassistant_api: true
hassio_api: true
hassio_role: manager
```

- 이유: 실제 기기 서비스 호출, 자동화 시험, 로그, 설정 검사, Core/App 운영이 필요하다.
- 제외: admin은 과도하며 보호 모드 등 무제한 Supervisor 권한은 제품 목표가 아니다.

## ADR-005 Raw token access 허용

- 상태: Superseded by ADR-039
- 결정: 웹 터미널과 SSH/Codex shell에서 `SUPERVISOR_TOKEN`을 사용할 수 있게 한다.
- 이유: 제한 프록시 없이 Codex가 전체 운영과 테스트를 직접 수행해야 한다.
- 결과: token redaction과 관리자 전용 접근을 강제한다.

## ADR-006 Host/Docker 특권은 주지 않음

- 상태: Accepted, AppArmor policy extended by ADR-039
- 결정: `docker_api`, `full_access`, `host_network`, admin 역할을 사용하지 않는다. AppArmor를 활성 상태로 유지하며 ADR-039부터 프로젝트 custom profile을 사용한다.
- 이유: Home Assistant 운영 기능에는 `/config`와 공식 API가 충분해야 하며, HAOS host 파괴 범위를 넓힐 필요가 없다.

## ADR-007 Web terminal은 ttyd + tmux

- 상태: Accepted
- 결정: Ingress terminal은 ttyd를 사용하고 tmux 세션에 attach한다.
- 이유: 구현이 단순하고 브라우저 연결이 끊겨도 Codex TUI를 유지할 수 있다.

## ADR-008 SSH port는 Network 설정

- 상태: Accepted
- 결정: 내부 port 22, 기본 host port 2223. 사용자는 App Network 설정에서 바꾼다.
- 이유: Supervisor의 `ports` mapping이 외부 포트 설정의 공식 위치다. JSON에 `ssh_port`를 중복 생성하지 않는다.

## ADR-009 SSH 공개키 전용

- 상태: Accepted
- 결정: 비밀번호 인증을 제공하지 않는다.
- 이유: 관리자 App에 LAN/원격 shell을 열므로 공개키가 적절한 기본값이다.

## ADR-010 Codex 인증은 `/data`

- 상태: Accepted
- 결정: `HOME=/data/home`, `CODEX_HOME=/data/codex`, file credential store를 사용한다.
- 이유: headless/container 환경에서 keyring보다 예측 가능하고 App update 후 로그인 유지가 필요하다.

## ADR-011 기본 Codex sandbox

- 상태: Superseded by ADR-039
- 결정: MVP 기본값은 `approval_policy=on-request`, `sandbox_mode=danger-full-access`다.
- 이유: 컨테이너 내부에서 `/config`와 API를 막힘없이 사용하고 HAOS의 nested sandbox 호환성 문제를 피한다.
- 검토 조건: `workspace-write` + network access가 실제 HAOS/Remote SSH에서 안정적으로 검증되면 더 제한적인 기본값을 재평가한다.

## ADR-012 앱 시작 정책

- 상태: Accepted
- 결정: `boot: manual` 기본.
- 이유: 상시 유지가 제품 목표가 아니며 필요할 때 시작한다. 사용자가 향후 UI에서 시작 정책을 조정할 여지는 남긴다.

## ADR-013 아키텍처 지원은 검증 기반

- 상태: Extended by ADR-038
- 결정: M1은 amd64. aarch64는 CI와 HAOS 실기 후 `arch`에 추가한다.
- 이유: Codex binary 및 Remote SSH app-server의 플랫폼 호환성을 실제로 증명해야 한다.

## ADR-014 GitHub delivery

- 상태: Accepted
- 결정: Codex가 구현 후 branch commit, origin push, 가능하면 PR 생성까지 수행한다.
- 이유: 사용자 Windows/Codex 환경에 GitHub 연동이 되어 있으며 완결된 자동 개발 흐름이 목표다.

## ADR-015 2026.06 Home Assistant BuildKit 구조 사용

- 상태: Accepted
- 결정: `ghcr.io/home-assistant/base:3.24`와 S6 Overlay v3 native `s6-rc.d` 서비스 그래프를 사용한다. legacy `build.yaml`은 만들지 않으며 Dockerfile에 base image 기본값을 둔다.
- 이유: Supervisor 2026.04부터 `BUILD_FROM` 자동 주입과 legacy builder가 폐기됐고, 현재 공식 base는 S6 Overlay 3.2.3.0을 포함한다.

## ADR-016 Codex CLI 0.144.1 standalone musl artifact

- 상태: Accepted
- 결정: 공식 release `rust-v0.144.1`의 `codex-x86_64-unknown-linux-musl.tar.gz`를 SHA-256 `84091ae20c65fcc7d4120db97d1bd57d7ff8df9c7609fb781c78c2ebbd4f5a28`로 검증해 설치한다.
- 이유: amd64 Alpine base와 맞는 공식 standalone target이며 Node runtime 없이 버전과 공급망 입력을 재현 가능하게 고정할 수 있다.
- 제약: OpenAI가 명시한 Linux 지원 OS는 Ubuntu/Debian 중심이다. 사용자가 이 amd64 Alpine/HAOS 이미지의 remote app server를 mobile Remote → HAOS App 직접 SSH 경로에서 확인했지만, Codex 버전 또는 아키텍처를 바꾸면 다시 실기 검증한다.

## ADR-017 Ingress ACL reverse proxy

- 상태: Accepted
- 결정: Supervisor Ingress port 7681의 nginx가 `172.30.32.2`와 loopback만 허용하고, loopback port 7682의 ttyd로 WebSocket을 전달한다. ttyd는 tmux 공유 세션을 실행한다.
- 이유: `host_network` 없이 ttyd를 사용할 때 다른 내부 App이 인증 없이 터미널에 직접 접근하지 못하도록 공식 Ingress source ACL을 적용한다.

## ADR-018 public 저장소의 소스 빌드 배포

- 상태: Superseded by ADR-021 after HAOS M2 acceptance
- 결정: public 저장소 MVP의 `config.yaml`에는 GHCR `image` 필드를 넣지 않고, 저장소 URL로 추가한 Home Assistant가 Dockerfile을 amd64 장치에서 소스 빌드하게 한다.
- 이유: 사용자가 App Store에서 즉시 설치·HAOS 검증할 수 있게 하면서 아직 실기 검증하지 않은 registry image를 릴리스하지 않기 위해서다. 첫 non-dev 배포 전에 공식 builder workflow와 generic image name을 별도로 활성화한다.

## ADR-019 비파괴 전역 Home Assistant 운영 지침

- 상태: Accepted
- 결정: 이미지에 기본 운영 가드레일 템플릿을 포함하고 `/data/codex/AGENTS.md`와 `AGENTS.override.md`가 모두 없을 때 복사한다. 기본 `preserve` 경로에서는 기존 파일을 빈 파일과 심볼릭 링크를 포함해 덮어쓰거나 mode를 변경하지 않는다. ADR-030의 명시적·백업형 base 파일 refresh만 예외다.
- 이유: Codex는 의도적으로 `/config` RW와 Core/Supervisor 운영 권한을 가지므로 진단과 변경 권한을 분리하고, 비밀값·`.storage`·DB·고위험 기기 동작에 대한 반복 안전 규칙이 모든 새 세션에 필요하다. 공식 Codex는 `CODEX_HOME/AGENTS.md`를 전역 지침으로 읽고 `/config`의 더 가까운 프로젝트 지침을 뒤에 결합한다.
- 제외: 이 지침을 강제 보안 경계로 간주하지 않는다. `/config/AGENTS.md` 자동 생성, 무선택 사용자 지침 덮어쓰기, Repairs/파일 권한/업데이트 자동 수정은 하지 않는다.

## ADR-020 로그 endpoint media type 명시

- 상태: Accepted
- 결정: 공용 API helper의 기본 `Accept`는 `application/json`으로 유지하고, `application/json`, `text/plain`, `text/x-log`만 명시적으로 선택할 수 있게 한다. Core/App 로그 wrapper는 `text/x-log`를 사용한다.
- 이유: Supervisor 로그 endpoint는 JSON이 아닌 log media type을 요구한다. `--raw` 출력 모드 전체의 요청 의미를 바꾸지 않으면서 실제 HAOS 실패를 수정하고, allowlist로 header injection을 막는다.

## ADR-021 tag-gated public GHCR 배포

- 상태: Extended by ADR-040
- 결정: `0.1.3`부터 `ghcr.io/kanu-coffee/codex-for-home-assistant` generic manifest를 사용한다. 공식 Home Assistant builder actions `2026.06.0`이 stable `X.Y.Z` 또는 번호형 DEV `X.Y.Z-dev.N` Git tag에서 image와 manifest를 게시하며 tag는 App version과 정확히 같아야 한다. `N`은 1 이상의 정수다. DEV tag는 repository/App 표시명 `Codex for Home Assistant (DEV)`, panel `Codex DEV`, `[DEV]` description, OCI title과 MOTD를 함께 강제한다.
- 이유: pre-built image는 HAOS의 느리고 실패 가능성이 높은 소스 빌드를 제거한다. tag-only publish, App version·DEV identity 일치 검사와 기존 generic/per-arch GHCR tag preflight는 이후 문서 변경이나 version bump 누락이 기존 release image를 덮어쓰는 것을 막는다.
- 제약: generic/per-arch GHCR package를 public으로 제공하고 인증 없는 linux/amd64 pull을 확인한다. `stage: experimental`과 amd64-only 지원은 유지한다.

## ADR-022 HACS 대신 Home Assistant App repository

- 상태: Accepted
- 결정: HACS metadata나 repository submission을 추가하지 않고 public `repository.yaml`, GitHub URL과 My Home Assistant `supervisor_store` 링크로 배포한다.
- 이유: HACS가 지원하는 Integration, Dashboard, Theme, Template, AppDaemon, Python Script 유형에는 Supervisor-managed Home Assistant App이 없다. 다른 유형으로 오분류해도 App Store 설치가 되지 않는다.

## ADR-023 Playwright MCP를 image-managed Codex system 기능으로 제공

- 상태: Accepted for 0.2.0
- 결정: pinned `@playwright/mcp`를 container-local stdio server로 설치하고 `/etc/codex/config.toml`의 `mcp_servers.playwright`에 등록한다. server는 `required = false`이며 wrapper와 MCP 설정도 image가 소유한다.
- 이유: Codex의 공식 system config 계층은 App 업데이트 때 새 browser 기본값과 보안 도구 목록을 함께 배포할 수 있고, stdio는 별도 인증·listener·port 없이 실제 browser 기능을 제공한다.
- 사용자 경계: `/data/codex/config.toml`은 사용자 계층으로 계속 보존하며 image 기본값을 복사·병합·수정하지 않는다. 공식 precedence에 따라 사용자와 프로젝트 설정은 system 기본값을 override하거나 server를 비활성화할 수 있다.
- 공급망: `@playwright/mcp` 0.0.78과 lockfile의 Playwright 의존성 1.62.0-alpha-1783623505000을 고정한다. runtime `npm install`, `npx`, `latest` 해석은 허용하지 않는다.

## ADR-024 Alpine system Chromium headless shell 사용

- 상태: Accepted after user-confirmed 0.2.3 HAOS validation
- 결정: upstream browser bundle을 내려받지 않고 Alpine package의 `/usr/bin/chromium-headless-shell`을 pinned Playwright MCP가 headless·isolated mode로 실행한다. CJK/emoji font를 image에 포함한다.
- 이유: 기존 `ghcr.io/home-assistant/base:3.24`/Alpine App 구조를 유지하고 browser runtime만 추가해 배포·업데이트 회귀 범위를 줄이기 위해서다.
- 제약: upstream Playwright의 공식 Linux browser target은 Ubuntu/Debian 계열 중심이며 이 Alpine system Chromium 조합은 공식 bundle과 동일한 지원 계약이 아니다. Public `0.2.3`의 실제 HAOS에서 AppArmor 활성 상태의 dashboard desktop/mobile 경로가 동작했다고 사용자가 확인했다. package revision이 바뀌면 local image smoke와 HAOS/AppArmor/dashboard 실기를 다시 수행한다.
- 재검토 조건: Chromium/MCP 호환 실패가 반복되거나 보안 패치 cadence를 맞출 수 없으면 Debian/Ubuntu browser sidecar 또는 지원 base로의 전환을 별도 ADR로 평가한다.

## ADR-025 HA dashboard는 loopback gateway와 컨테이너 수명 App token으로 렌더링

- 상태: Superseded by ADR-027
- 결정: container loopback `127.0.0.1:8099`의 gateway가 HA frontend resource와 전체 Core API/WebSocket을 전달한다. 현재 container의 `SUPERVISOR_TOKEN`은 MCP Node 환경에서 읽어 `http://127.0.0.1:8099` 또는 `http://localhost:8099`의 `hassTokens` localStorage에만 주입한다. `/run/codex-ha` mode 0600 secrets는 MCP exact-value masking에 사용한다.
- 이유: 실제 dashboard를 browser에서 검증하려면 frontend와 authenticated API/WebSocket이 같은 origin 계약으로 동작해야 한다. token을 URL, MCP 인수, 사용자 config 또는 영속 profile에 저장하지 않고도 App 자신의 공식 Core 권한을 재사용할 수 있다.
- 보안 경계: gateway는 범용 target forward proxy가 아니며 외부/Ingress listener, 새 `config.yaml` port, `host_network`, `full_access`, `privileged`, 추가 capability를 만들지 않는다. token은 argv, URL, 로그와 `/data` artifact에 의도적으로 기록하지 않는다. exact-value masking은 인코딩·분할된 출력의 구조적 sanitizer가 아니므로 결과 전체를 민감자료로 취급한다.
- TLS 경계: Core info가 HTTPS frontend를 보고하면 내부 `homeassistant` upstream에 `proxy_ssl_verify off`로 연결해 자체 서명/사용자 인증서를 허용한다. 이 신뢰는 container 내부 endpoint에만 한정하고 실제 HAOS에서 위험과 호환성을 재검증한다.
- 실패 정책: token이 없으면 일반 Web UI browser 기능은 유지하고 HA dashboard는 자동 인증 없이 login 화면을 표시할 수 있다. gateway upstream 실패는 sanitized navigation 오류로 보고한다. 실제 HAOS 검증 전에는 이 경로를 완성 판정하지 않는다.

## ADR-026 browser QA 표면과 artifact를 제한

- 상태: Accepted for 0.2.0
- 결정: 기본 desktop viewport는 1440x900, mobile 회귀 viewport는 390x844로 정한다. navigation, accessibility snapshot, resize, screenshot, console/page error, network request 목록의 URL/status와 기본 UI 조작을 허용한다. 민감 header/body를 포함할 수 있는 단일 request 상세, 임의 code 실행, codegen, unrestricted file access/upload는 제외한다.
- 이유: 사용자가 요구한 responsive 화면·console 오류·resource loading 검증에는 실제 Chromium과 관찰 도구가 필요하지만 범용 browser automation code와 영속 profile은 불필요한 공격 표면이다.
- artifact: browser output은 mode 0700의 `/run/codex-ha/playwright-output`에 두고 50 MiB로 제한하며 init 때 이전 output을 제거한다. enforcement proxy가 tool call의 `filename`을 거부해 `/config`·`/data` 우회를 막는다. screenshot과 console/network 결과는 민감자료로 취급한다.
- 완료 기준: local fixture에서 두 viewport와 오류/resource 수집을 자동 검증하고, 실제 HAOS에서 AppArmor 활성 상태의 dashboard를 별도 E2E로 검증한다. Public `0.2.3`의 실제 HAOS dashboard desktop/mobile·console·network 경로는 사용자 확인 PASS이며 token 원문 비노출은 자동 fixture/redaction smoke로 보완한다.

## ADR-027 동적 App IP를 인증 신원으로 사용하지 않고 전용 read-only token을 사용

- 상태: Accepted
- 판정: Chromium이 loopback gateway에 연결한 뒤 nginx가 Core에 만드는 socket의 source는 현재 App container IP다. Supervisor의 일반 App 주소는 `172.30.33.0/24`에서 동적 할당되고 update/recreate 뒤 유지·전용성이 보장되지 않는다. 현재 `/32`는 순간적으로 좁아도 나중에 다른 App에 재할당될 수 있고, 전체 대역은 즉시 모든 App을 신뢰한다. 둘 다 영구 `trusted_networks` 신원으로 사용하지 않는다.
- proxy 판정: App IP 또는 Docker 대역이 `trusted_proxies`에도 포함되면 Home Assistant가 trusted-network 로그인을 거부한다. App을 proxy로 신뢰하고 합성 X-Forwarded-For를 보내는 우회는 같은 주소 재사용과 다른 App의 header spoofing 위험을 키우므로 사용하지 않는다.
- 결정: Home Assistant의 `configuration.yaml`, `auth_providers`, `trusted_networks`, `trusted_proxies`와 `.storage`를 App이 편집하지 않는다. 기존 `homeassistant` provider를 그대로 유지한다. browser identity는 활성·일반·`local_only` 사용자이면서 유일한 group이 `system-read-only`여야 한다. optional `home_assistant_browser_token`은 명시적 수동 override다.
- 검증: App init과 각 MCP launch는 browser token으로 `auth/current_user`/`auth/refresh_tokens`, Supervisor runtime credential로 `config/auth/list`를 읽어 user ID, 정확한 group/local-only/non-admin/credential 상태와 관리형 exact single LLAT를 교차검증한다. 실패·미설정·과권한 상태에서는 token을 Chromium에 전달하지 않고 login page로 fail closed한다.
- 전달 경계: 검증된 token은 수동 App option 또는 `/data/browser-auth` private storage에 영속되고, 실행 중에는 mode `0600`의 `/run` 파일에서 Playwright init script 환경으로만 전달된다. system MCP는 `env -i`로 wrapper를 시작하고 wrapper가 `PLAYWRIGHT_MCP_*`, `NODE_OPTIONS`, `NODE_PATH`와 shell startup 변수를 검증 전에 제거한다. Node proxy/browser child는 상속 환경이 아니라 고정 allowlist만 받으며 `SUPERVISOR_TOKEN`은 전달하지 않는다. token 주입 origin은 `127.0.0.1:8099`와 `localhost:8099`뿐이다. Playwright `--secrets`는 사용하지 않고 관리 proxy가 stdout/stderr의 exact 문자열만 직접 마스킹한다.
- 권한 경계: gateway의 document, `/auth/`, `/api/`, `/api/websocket`은 모두 `homeassistant:<port>` Core로 직접 전달하고 X-Forwarded-For, X-Real-IP, Forwarded를 제거한다. Supervisor Core proxy를 섞지 않아 dedicated user의 Core permission이 전체 세션에 적용되게 한다.
- 운영: `ha-browser-network-info`는 socket local IP와 Supervisor self IP를 읽기 전용으로 교차확인하고 이 주소가 persistent trusted-network identity가 아님을 명시한다. 전용 사용자 생성·password credential 제거는 Core의 지원되는 admin WebSocket API만 사용하며 `.storage`를 직접 수정하지 않는다.
- 제한: `system-read-only`도 모든 entity state를 읽을 수 있으며 특정 dashboard 하나만으로 축소된 권한은 아니다. custom integration의 권한 검사 결함까지 보장하지 않으므로 화면·console·network 결과를 계속 민감자료로 취급한다.

## ADR-028 Home Assistant API 기반 관리형 browser identity

- 상태: Accepted for 0.2.2
- 결정: 사용자는 App terminal에서 `ha-browser-auth-setup`을 한 번 실행한다. App은 `/auth/providers` preflight 뒤 공식 admin/user WebSocket과 `homeassistant` login/token/revoke HTTP flow로 전용 read-only/local-only user와 LLAT를 만들고 임시 password credential/OAuth token을 자동 제거한다. `ha-browser-auth-remove`는 exact identity만 삭제한다.
- 복구: state와 LLAT는 `/data/browser-auth`에 `0700`/`0600`, atomic rename/fsync, no-follow/owner/type/link 검증으로 저장한다. LLAT는 state가 non-ready일 때 먼저 저장해 hard crash에서도 revoke/retry material을 보존하며 ready state만 Chromium runtime으로 승격한다.
- 동시성/폐기: setup/remove는 kernel `flock`으로 직렬화한다. current LLAT self-delete는 WebSocket response가 connection close와 경쟁하므로 같은 credential 재접속의 definitive rejection으로 확인한다. ambiguous local-only rejection과 Core/DNS/TLS outage에서는 persistent material을 지우지 않는다.
- TLS: auth bootstrap과 nginx direct Core gateway는 image CA bundle, SNI와 `homeassistant` hostname을 검증한다. 자체 서명 또는 hostname 불일치 호환을 위해 검증을 끄지 않으며, 필요한 경우 운영자가 신뢰 가능한 내부 인증서 경로를 구성하거나 HTTP 내부 endpoint를 사용한다.
- 제외: 설치 시 무조건 자동 mutation, HTTP setup button, `trusted_networks`/`trusted_proxies`, provider order 변경, `.storage` 편집은 선택하지 않는다. 명시적 terminal command는 관리자 의도와 audit trail을 유지하면서 token 복사·붙여넣기만 제거한다.

## ADR-029 기본 ON browser identity 자동 ensure와 Codex 8099 route

- 상태: Accepted for 0.2.3; ADR-028의 identity·저장·검증·폐기 경계는 유지하고 activation trigger만 대체
- 사용자 결정: `home_assistant_browser_auto_auth` boolean option을 기본 ON으로 제공하고 신규 설치와 option이 없는 기존 설치 모두 true로 해석한다. App init과 새 Playwright MCP 시작의 idempotent `ha-browser-auth-ensure`가 ADR-028 transaction을 자동 시작 또는 복구하므로 정상 경로에서 terminal setup이나 token 복사·붙여넣기를 요구하지 않는다.
- OFF 의미: 다음 App/MCP browser session부터 `/run` token 주입과 자동 mutation을 중지하되 `/data/browser-auth`와 Home Assistant identity는 보존한다. 이미 열린 context는 소급 로그아웃하지 않으므로 App/Codex session 재시작을 요구한다. ON 재시작은 같은 identity를 재사용하며 완전 삭제는 OFF 상태의 explicit `ha-browser-auth-remove`만 수행한다. ON에서는 다음 ensure의 즉시 재생성 경쟁을 막기 위해 remove를 거부한다. 수동 token은 ON에서만 override이고 invalid manual source에서 managed source로 fallback하지 않는다.
- Codex route: `/etc/codex/config.toml`의 공식 `developer_instructions`와 enforcement proxy의 `browser_navigate` description에 Home Assistant dashboard의 canonical first route를 image-managed Playwright MCP의 `http://127.0.0.1:8099/`로 명시한다. global Vercel/다른 browser skill disable은 일반 Web UI 작업까지 막으므로 사용하지 않는다. 이 route 배포 자체는 `/data/codex/config.toml`과 사용자 `AGENTS.md`를 갱신·병합하지 않는다. 별도 사용자 선택에 따른 reset은 ADR-030의 명시적 예외다.
- 보안 유지: 자동화는 기존 exact local-only/read-only/single-LLAT 검증, provider preflight, TLS 검증, crash journal과 fail-closed 정책 안에서만 동작한다. `configuration.yaml`, `.storage`, provider order, `trusted_networks`, `trusted_proxies`, App privilege와 external port는 바꾸지 않는다.
- 검증: option 누락/default ON 생성, restart reuse, OFF/ON 보존·재활성화, OFF-state remove, manual override ON/OFF와 failure no-fallback을 fixture로 확인한다. 기존 user config/AGENTS가 있는 update container의 `codex debug prompt-input`과 filtered MCP `tools/list`에서 8099 instruction을 확인하고 desktop/mobile browser smoke를 재실행한다.

## ADR-030 Home Assistant UI에서 선택하는 version별 Codex 사용자 파일 갱신

- 상태: Accepted for 0.2.3
- 배경: Home Assistant App 웹 업데이트에는 CLI flag를 전달할 수 없다. 기존 사용자 `config.toml`과 `AGENTS.md`를 무조건 교체하면 인증·MCP·model/provider·운영 지침을 손상하지만, image의 최신 기본본을 선택적으로 받아야 하는 사용자는 수동 복사 없이 구성 탭에서 정책을 정할 수 있어야 한다.
- 사용자 결정: `codex_user_files_update_mode`를 `preserve`, `refresh_agents`, `refresh_all`의 enum으로 제공한다. 누락/default는 `preserve`다. `refresh_agents`는 base `AGENTS.md`만 image 기본 지침으로, `refresh_all`은 base 지침과 user `config.toml`을 각각 image/current App option 기반 기본본으로 되돌린다. `AGENTS.override.md`는 항상 보존되고 Codex 공식 계층에서 더 높은 우선순위를 유지한다.
- 기존 설치 전환: `0.2.2` 사용자가 `0.2.3`으로 일반 업데이트할 때 첫 시작은 option key가 없으므로 `preserve`다. 새 구성 UI를 확인한 뒤 mode를 선택하고 App을 재시작해야 refresh가 실행된다. 선택값은 영속되므로 그대로 두면 이후 각 App version의 첫 시작에 target별 한 번 다시 적용된다. 특정 update에만 쓰려면 적용 확인 뒤 `preserve`로 되돌린다.
- 반복 방지: App image version과 target별 적용 이력을 `/data/codex`의 private state에 기록한다. 같은 version에서 `refresh_agents` 뒤 `refresh_all`로 바꾸면 이미 처리한 agents는 다시 쓰지 않고 config만 처리한다. 일반 재시작도 같은 target을 반복하지 않는다.
- 손실 경고: `refresh_all`은 user `config.toml`의 MCP server, model, provider, 내부 endpoint, trust와 기타 사용자 설정을 제거하고 current App option에서 만든 기본본으로 되돌린다. Codex 인증/session은 config target과 분리해 보존한다.
- transaction: 선택된 모든 target을 mutation 전에 검사하고 root-owned regular single-link file만 허용한다. symbolic link, 다중 hardlink, 비정상 file 또는 신뢰할 수 없는 ownership이면 링크를 따라가지 않고 선택 refresh 전체를 fail closed한다. 기존 bytes와 candidate/metadata는 `/data/codex/backups/user-files` 아래 root-only backup에 먼저 기록하며 journal → atomic replacement → target별 version state commit 순서로 crash recovery한다.
- 범위 제한: refresh allowlist는 `/data/codex/config.toml`과 `/data/codex/AGENTS.md`뿐이다. `AGENTS.override.md`, `auth.json`, session, SSH identity, browser identity, App options와 Home Assistant `/config`는 변경하지 않는다. backup 자체는 기존 config의 credential을 포함할 수 있으므로 Home Assistant App backup과 함께 비밀정보로 취급한다.
- SemVer 예외: 저장소 원칙상 사용자 기능은 MINOR지만 `0.2.3`은 기본 ON browser 인증/8099 route 후보로 이미 버전·업데이트 회귀·릴리스 전달이 고정된 상태에서 이 안전한 선택 UI를 같은 미공개 후보에 포함한다. 검증된 update 경로를 다시 번호 변경하지 않기 위한 1회 예외이며, public `0.2.2`와의 기본 동작은 `preserve`로 호환된다. 이후 새 사용자 기능은 다시 MINOR 규칙을 따른다.
- 검증 경계: enum/default, 기존 update 첫 preserve, 두 refresh scope, target별 version one-shot, private backup, crash recovery와 unsafe link fail-closed를 local container에서 검증한다. 실제 Home Assistant 구성 UI/Supervisor 일반 update와 HAOS/AppArmor dashboard E2E는 public `0.2.3`에서 사용자 확인 **PASS**로 기록하되 원본 진단 자료가 저장소의 자동 증거라는 뜻은 아니다.

## ADR-031 root-only SQLite/FTS5와 독립 `ha-memoryd`

- 상태: Accepted for the verified HA memory work
- 결정: 검증형 메모리는 `/data/codex-ha-memory/memory.sqlite3`의 SQLite와 FTS5로 구현한다. directory는 `0700`, database와 WAL/SHM은 `0600`이며 v1 schema initialization/version gating, foreign key, check constraint, WAL/busy-timeout transaction을 사용한다. 지원되지 않는 schema를 자동 migration하지 않는다. 고정 table은 `metadata`, `sync_runs`, `catalog_objects`, `catalog_relations`, `catalog_revisions`, `memory_items`, `memory_evidence`, `conflicts`, `change_records`, `audit_events`, `audit_changes`, `search_fts`다. 별도 S6 longrun `ha-memoryd`는 주기적 `ha-memory refresh` scheduler이고 scheduler/CLI/MCP는 같은 image-managed core module과 SQLite WAL store를 다중 process로 사용한다. 별도 Unix socket single-writer service는 만들지 않는다.
- 이유: SQLite는 App 하나의 `/data` 영속 경계 안에서 구조화 catalog, provenance, FTS 검색, conflict와 history-preserving audit를 transaction으로 함께 관리할 수 있다. JSON/YAML 전체 파일은 bounded retrieval과 동시 mutation, 상태 전이·rollback invariant를 안정적으로 강제하기 어렵고 외부 vector database는 새로운 network·privacy·복구 경계를 만든다.
- 수집 경계: Core WebSocket command는 entity/device/area registry list, `get_states`, `automation/config`와 `search/related`의 고정 allowlist다. 응답은 식별자, 허용된 표시명·설명과 관계만 정규화한다. raw state와 비허용 attributes, automation config, 임의 response, `/config` 원문, 대화 transcript, prompt와 secret/token은 저장하거나 FTS에 넣지 않는다.
- 실패 정책: snapshot은 모든 필수 수집·정규화가 성공한 뒤 한 transaction으로 교체한다. Core/API/schema/file 검증 실패에서는 last-known-good revision을 보존하고 stale/degraded를 표시한다. `ha-memoryd`는 ttyd, SSH, Codex, ingress 또는 browser service의 dependency가 아니며 실패가 App의 기존 기능을 중단시키지 않는다.
- 제외: `.storage` 직접 읽기, Recorder 복제, raw conversation archive, 외부 listener/sidecar/cloud vector service, 실패 시 DB 자동 삭제·무조건 재생성은 선택하지 않는다.

## ADR-032 사실 종류별 authority와 검증 상태·보상 rollback

- 상태: Accepted for the verified HA memory work
- candidate lifecycle: 대화나 분석에서 얻은 alias, 실제 용도, preference와 semantic relation은 provenance가 있는 `pending`으로 시작해 허용 evidence와 transactional current-row/status를 확인한 뒤 `verified`, conflict 검사를 통과한 뒤 `applied`가 된다. 모델 추론이나 일시 state만으로 단계를 건너뛰지 않는다.
- authority: HA entity/device/area/automation 구조, 현재 존재 여부, registry relation과 Codex change 결과는 fresh Core API가 canonical이다. HA schema가 표현하지 않는 alias·실제 용도·preference는 사용자의 명시적 설명이 semantic authority다. 두 범주를 하나의 전역 우선순위로 덮어쓰지 않고 fact kind별 validator를 사용한다.
- change 검증: Codex mutation 전 기존 또는 생성 예정 subject와 closed-schema machine-readable expectation의 digest·field summary를 기록한다. mutation 뒤 cache가 아닌 새 Core WebSocket/API round trip이 같은 exact expectation을 만족한 경우에만 change를 verified evidence로 사용한다. `codex_change` relationship candidate는 동일 source·relation·target의 성공한 존재 predicate와만 연결한다. 같은 subject의 무관한 check, config check 성공, HTTP 2xx, service call 반환 또는 추론만으로 applied semantic memory를 갱신하지 않는다.
- conflict: 기존 applied fact와 새 authority evidence가 충돌하면 source, before/current row와 resolution을 conflict record에 남긴다. authority가 불명확하면 unresolved로 유지하고 일반 context에서 확정 사실처럼 반환하지 않는다.
- rollback: 모든 candidate/evidence/verify/apply/conflict resolution은 history-preserving before/after audit event를 남긴다. rollback은 current-row precondition을 확인한 compensating event이며 과거 event를 삭제하지 않고 원 event에는 rollback linkage만 기록한다. HA-derived catalog는 rollback하지 않고 fresh refresh로 교정하며 memory rollback이 HA config, registry, automation 또는 기기를 변경해서는 안 된다.

## ADR-033 bounded MCP/CLI retrieval과 기존 AGENTS preserve 공존

- 상태: Accepted for the verified HA memory work
- 결정: `/usr/local/bin/ha-memory` CLI와 `/etc/codex/config.toml`의 optional STDIO `[mcp_servers.ha_memory]`가 exact ID/alias와 FTS5 기반 bounded search/show를 제공한다. Query는 최대 256자, search는 기본 8·최대 20 subject와 JSON 32 KiB, subject별 outgoing/incoming relation 각각 기본 12개, applied memory 20개, open conflict 10개로 제한한다. Exact show는 relation을 각각 30개까지 허용한다. 기본 결과는 관련 canonical/applied memory만 포함하고 pending candidate, evidence, conflict 전체와 full audit는 명시적 workflow 도구에서만 조회한다.
- 이유: 매 요청에 전체 JSON/DB를 읽는 방식은 context 비용, stale fact 확산과 민감정보 노출을 키운다. local prepared query와 제한된 결과는 질문과 관련된 검증 사실만 주입하고 전체 catalog dump를 피한다.
- Codex 지침: 새 설치용 `AGENTS.md`에는 entity별 데이터를 쓰지 않고 helper 위치, bounded lookup, candidate·post-change verification 규칙만 둔다. ADR-019/030 때문에 기존 base `AGENTS.md`와 user config는 기본 update에서 보존되므로 image-managed system MCP, developer instruction과 tool description에도 같은 경로를 제공한다. 사용자의 더 높은 우선순위 config/지침이 system default를 재정의할 수 있다는 기존 Codex 계약은 유지한다.
- 보안 경계: memory MCP는 container-local STDIO이며 HTTP/SSE listener나 host/Ingress port를 만들지 않는다. wrapper는 `/usr/bin/env -i` 최소 환경에서 시작한 뒤 root-only ephemeral `/run/codex-ha/runtime.env`를 source해 fresh verify CLI child에 필요한 allowlist 환경만 넘긴다. Core token은 이 mode `0600` 파일에서 process environment로 읽되 영속 `/data`, DB, argv, stdout/stderr, tool output과 App log에 기록하지 않는다. search output은 provenance/staleness/conflict 상태를 포함하되 raw API/evidence/secret을 반환하지 않는다. MCP 실패는 Codex 전체 시작 실패로 승격하지 않는다.
- 검증: 기존 사용자 config/AGENTS가 있는 update fixture에서 system MCP discovery와 model-visible bounded retrieval instruction, query limit, candidate 상태 분리와 non-fatal startup을 자동 검사한다. 실제 HAOS에서는 first bootstrap, Core restart/reconnect, App update persistence와 실제 registry/automation 관계를 별도 E2E로 확인한다.

## ADR-034 고정 Supervisor WebSocket transport와 closed memory 진단

- 상태: Accepted for 0.3.1; related command rejection 정책은 ADR-035가 부분 대체
- 배경: public 0.3.0 read-only HAOS audit에서 REST, daemon scheduler, MCP와 SQLite는 정상이나 catalog refresh가 즉시 `ha_unavailable`로 반복 실패했다. daemon이 CLI stderr를 폐기하고 DB가 모든 HA 오류를 한 code로 축약해 auth/transport/command/snapshot 경계를 사후 확정할 수 없었다.
- endpoint/auth 결정: 공식 App 계약의 `ws://supervisor/core/websocket`과 첫 `auth` frame의 `SUPERVISOR_TOKEN`을 유지한다. Upgrade authorization header를 추가하거나 credential을 direct Core에 보내는 fallback은 만들지 않는다. production `HA_WS_URL` 환경 override는 임의 endpoint로 credential을 보낼 수 있어 제거한다. test endpoint는 명시적 URL과 명시적 test token을 함께 제공할 때만 module-level test에서 허용한다.
- transport 결정: image에 이미 version-pinned된 `ws` runtime을 memory client도 사용하고 handshake timeout, 32 MiB `maxPayload`, compression off와 기본 TLS 검증을 적용한다. 이는 Node built-in transport의 오류가 입증됐다는 뜻이 아니라 App의 privileged WebSocket helper와 connection/payload 경계를 통일하는 결정이다.
- snapshot 결정: Home Assistant Core가 unavailable automation에 성공 응답으로 반환할 수 있는 `{config: null}`은 protocol상 완전한 응답이다. 이를 빈 config와 bounded warning으로 정규화하고 entity/`search/related` graph는 유지한다. 실제 command rejection, 누락 envelope와 malformed/failed related 결과는 계속 전체 snapshot을 실패시켜 partial canonical commit을 막는다.
- 진단 결정: token, DNS, transport, timeout, auth, protocol, 고정 command와 snapshot의 closed low-cardinality code만 `sync_runs`, change verification과 CLI reason에 전달한다. 원격 message, hostname, entity ID와 token 일부를 code로 만들지 않는다. daemon은 captured stdout/stderr 원문을 log하지 않고 closed allowlist reason만 남긴 뒤 변수를 폐기한다.
- 검증 경계: legal null-config, 실제 installed `ws` Supervisor-style handshake, 단계별 code, secret/message suppression, endpoint redirection 거부와 last-known-good/recovery를 자동 검증한다. 후속 published 0.3.1 live re-test에서는 null-config가 관측되지 않았고 실제 실패 단계가 automation-related 2건의 Core `unknown_error`로 확인됐다.

## ADR-035 개별 automation related 거부를 optional enrichment로 격리

- 상태: Accepted for public 0.3.2
- 배경: 정확한 public 0.3.1 설치와 Core `2026.7.2` 실기에서 registry/state와 `automation/config` 30건은 성공했지만 `search/related(item_type=automation)` 30건 중 2건이 `unknown_error`를 반환해 첫 catalog 전체가 비었다. 동일 ID의 `item_type=entity` 요청은 성공했지만 공식 Core 구현상 이는 automation 내부 graph가 아니라 해당 entity를 참조하는 역방향 관계이므로 대체 payload가 아니다.
- 요청 계약: 기존 official payload `type=search/related`, `item_type=automation`, `item_id=<automation entity_id>`를 유지한다. `item_type=entity` 결과를 automation references로 합치거나 `.storage`/raw config parse로 우회하지 않는다.
- 격리 결정: matched result envelope의 `success:false`와 실기에서 관측된 `error.code=unknown_error`가 함께 확인된 개별 related command만 optional enrichment 부재로 처리한다. 성공한 automation config는 allowlist scanner로 area/device/entity 직접 관계를 만들고 related는 빈 객체, warning은 `automation_related_unavailable:<allowlisted entity id>`로 남긴다. warning은 100개로 제한하고 Core error message/body/code를 snapshot에 복사하지 않는다.
- fail-closed 경계: 공개 `ha_command_related_failed`가 같은 경우에도 내부 command-rejected type과 bounded remote code를 함께 확인한다. Server `timeout`, `unauthorized`, `invalid_format`, `home_assistant_error`, 그 밖의 command code, client timeout, config failure, auth, transport, WebSocket close, protocol error, 누락·malformed result envelope와 object가 아닌 successful related 결과는 계속 전체 snapshot을 실패시키고 last-known-good를 보존한다.
- provenance: config scanner에서만 발견한 관계는 `automation_config`, 실제 related 배열에 있던 관계만 `search_related`로 기록한다. 빈 related 객체를 source 증거로 취급하지 않는다.
- 검증 경계: source/installed `ws` fixture에서 explicit `unknown_error`, null-config 결합, remote-message 비노출과 exact outbound payload를 확인하고 server `timeout`/`unauthorized`/`invalid_format`/`home_assistant_error`, client timeout, malformed envelope/result 음성 테스트를 둔다. 정확한 public 0.3.2 image의 자동·공개 이미지 회귀는 실제 HAOS 재시험을 대체하지 않는다. 후속 실제 HAOS/Core `2026.7.2` 재시험은 동일 `unknown_error` 2/30을 격리하고 catalog/DB/CLI·MCP/privacy/candidate/restart 요청 후 fresh sync/App restart persistence를 PASS했지만 runtime OCI digest NOT RUN과 Core disconnect/reconnect·LKG 상태 미관측 때문에 최종 PARTIAL(FAIL 0)이며, 이를 0.4.0 browser 정책 실기나 미실행 update/device control 증거로 확대하지 않는다.

## ADR-036 Home Assistant UI 기반 Playwright 승인 정책

- 상태: Accepted for public 0.4.0
- 사용자 결정: `browser_approval_policy`를 `safe`, `never`, `always`의 닫힌 enum으로 제공하고 신규·누락 option 기본값을 `safe`로 둔다. safe는 browser 탐색·관찰·session 동작을 자동 승인하고 click/form/key/select/type은 prompt, never는 현재 허용 도구 전체 approve, always는 전체 prompt다.
- 구현 결정: `/etc/codex/config.toml`의 Playwright 기본을 `prompt`로 두고 현재 16개 allowlist의 safe fallback을 명시한다. 공통 image helper를 init과 `codex` wrapper가 함께 사용하고 wrapper는 server default와 known tool 16개의 per-tool mode를 CLI config로 주입한다. 사용자 `config.toml`, `AGENTS.md`, browser identity는 수정하지 않는다.
- 보안 경계: enforcement proxy의 허용 도구 목록은 바꾸지 않는다. code evaluation, arbitrary upload/output와 상세 단일 network request는 계속 차단되고 미래 도구는 prompt를 상속한다. top-level `codex_approval_policy=never`는 Codex 전체 full-auto로 MCP prompt를 자동 승인할 수 있으므로 safe/always가 이를 다시 강제할 수 없음을 UI와 문서에 공개한다.
- 적용·검증: option 저장 뒤 App과 새 Codex session을 재시작한다. helper/config/proxy 집합 parity, static mode, fake pinned-binary argv, 실제 Codex parse, invalid type/enum exit 78와 public 0.3.2 update preservation을 자동 검증했다. Local candidate의 browser-policy/full/memory/managed-auth/user-file/update smoke를 통과한 뒤 [PR #26](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/26)을 merge commit `bca612661692e3d66d239c06b57b52921ea56af6`로 병합했고 동일 SHA의 [main CI 29408206017](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29408206017)이 PASS했다.
- 공개 증거: annotated `0.4.0` tag를 `2026-07-15T10:32:08Z`에 게시했고 [Builder 29408467932](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29408467932)이 GHCR image를 발행했다. 공개 image 검증 뒤 [GitHub prerelease](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.4.0)를 `2026-07-15T10:42:35Z`에 공개했다. Generic/per-arch OCI index digest는 `sha256:758837276c4247a304c58791bddab5912977d3445801dcd832a638f9a2af9342`, linux/amd64 runtime manifest digest는 `sha256:b586727e9a2ca724f32f8255f692cd32104aeed45bc0e65b8c12cb3cc151373b`다. 익명 tag 조회·pull, version/arch/source label, mutable `latest` 부재와 정확한 public image의 browser/full/memory/managed-auth/user-file/public 0.3.2 update smoke PASS를 확인했다.
- 실제 수용 증거: 후속 HAOS `never` mode 보고서에서 `navigate`, `tabs`, `resize`, `snapshot`, `take_screenshot`, `console_messages`, `network_requests`, `hover`, `wait_for`, `click`, `type`, `press_key`, `fill_form`, `navigate_back` 14개가 MCP 승인 요청 0회로 PASS했다. Desktop/mobile `127.0.0.1:8099` 자동 인증 dashboard도 렌더링됐고, 사용자 지정 screenshot `filename` 거부는 enforcement proxy의 의도된 artifact 경계로 확인됐다.
- 수용 경계: `select_option`은 안전한 대상이 없었고 `close`는 실행 기록이 없어 **NOT TESTED**다. `safe`, `always`, top-level global-never precedence, 금지 도구, Configuration UI/default, AppArmor 활성 여부, user config/AGENTS/browser identity 보존과 live update 감지는 **NOT RUN**이므로 전체 popup 행렬은 PARTIAL이며 자동·부분 실기 증거로 대체하지 않는다.

## ADR-037 사용자 명시 기억 폐루프와 지속 변경 검증

- 상태: Accepted for the next verified HA memory feature release
- 사용자 문제: 기존 엔진은 안전한 candidate lifecycle을 갖췄지만 일반 대화에서 명시적 사실 하나를 기억하려면 모델이 propose→verify→apply 세 write tool을 빠짐없이 연결해야 했다. Propose 뒤 멈추면 pending은 다음 기본 검색에서 보이지 않고, MCP에는 bounded candidate list/reject가 없어 후속 request도 닫히지 않았다. 변경 전 ledger도 model-visible 지침에서 `when practical`이라 사용자 목표보다 약했다.
- Explicit remember 결정: `memory_remember_explicit`와 CLI fallback `ha-memory remember`를 추가한다. 한 exact subject의 직접·명확한 durable semantic fact만 받고 source를 server-side `user_explicit`로 고정한다. 기존 `proposeMemory`, `verifyMemoryCandidate(user_explicit)`, `applyMemoryCandidate`를 순서대로 호출하므로 사용자 승인과 tool call은 하나지만 pending→verified→applied 상태, transaction과 audit event는 모두 유지한다. 같은 applied fact는 `already_applied`, 같은 slot의 동등 이상 권위 차이는 conflict를 반환하고 자동 resolve하지 않는다. 같은 unresolved correction은 기존 candidate/conflict를 idempotent하게 반환한다. Reserved HA canonical relation, transient key/value와 명백한 시간·불확실성 표현은 candidate 생성 전에 거부한다.
- Conversation 경계: 대상이나 의미가 모호하면 tool을 호출하지 않고 한 번 확인한다. Current state, time-local observation, page/log content와 model inference를 user-explicit로 라벨링하지 않는다. 새 key는 `user_alias`, `user_purpose`, `user_preference.<setting>`, `user_note.<topic>`, `user_relationship.<relation>`을 우선하고 correction은 기존 검색 key를 재사용하며 household-wide preference는 `home:household`에 둔다. 이 taxonomy는 기존 자유형 key를 migration하거나 삭제하지 않는다.
- 후속 관리: `memory_list_candidates`는 필수 exact subject와 status, 최대 20건만 반환하고 `memory_reject_candidate`는 non-applied candidate를 history-preserving rejected 상태로 만든다. 일반 search는 계속 pending/evidence/audit를 제외한다.
- Persistent change 결정: 지속 configuration/registry/automation mutation은 지원되는 expectation으로 `memory_begin_change`를 먼저 실행하고 mutation/reload 뒤 `memory_verify_change`의 fresh API 결과를 사용한다. Read/diagnostic/catalog refresh/transient device test는 제외한다. Schema가 결과를 표현하지 못하거나 memory가 unavailable이면 semantic memory를 갱신하지 않고 verification gap을 사용자에게 밝힌 뒤 mutation 진행 여부를 확인한다. Optional memory 장애가 App의 기존 기능을 자동 차단하지 않는 ADR-031 경계는 유지한다.
- AGENTS·상태 결정: Entity별 alias/purpose/preference/relationship/candidate/catalog data는 어떤 AGENTS 계열 파일에도 쓰지 않는다. System developer instruction, default AGENTS와 MCP instructions는 every-request bounded search, empty/degraded/stale 고지, same-request explicit remember와 결과 보고를 함께 제공한다.
- 검증 경계: Source unit은 세 audit transition, resume/idempotency, transient/canonical rejection, same-authority conflict dedupe, exact-subject candidate list/reject와 CLI를 검사한다. Installed-image smoke는 빈 store daemon first refresh, 실제 MCP remember/list/reject와 container replacement 뒤 새 MCP process recall을 검사하고 `codex debug prompt-input`은 model-visible 계약을 확인한다. 실제 자연어 발화→tool trace→새 task recall과 실제 HA persistent mutation은 별도 HAOS live acceptance 전까지 자동 fixture PASS로 확대하지 않는다. 현재 expectation schema가 표현하지 않는 automation trigger/condition/action/template logic은 `exists`/`name`으로 대체 검증하지 않고 이 경계에 남긴다.

## ADR-038 amd64+aarch64 후보와 검증 기반 공개 지원

- 상태: Implemented and published for DEV `0.7.0-dev.1`; native ARM CI PASS, HAOS acceptance NOT RUN
- 결정: App 후보의 `arch`를 `amd64`, `aarch64`로 선언한다. Dockerfile은 `BUILD_ARCH`별로 Codex CLI `0.144.1` musl과 GitHub CLI `2.97.0` official binary·SHA-256을 명시적으로 선택하고 그 밖의 architecture를 다운로드 전에 거부한다. Armv7과 32-bit ARM은 지원하지 않는다.
- 이유: 64-bit Raspberry Pi 계열 등 aarch64 HAOS에서 동일 App 기능을 제공하려면 upstream이 배포하는 native artifact와 architecture별 재현 가능한 checksum이 필요하다. QEMU-only 결과는 native runtime과 HAOS integration을 충분히 대변하지 않는다.
- 공개 경계: public `0.6.0`은 기존 amd64 release와 증거를 그대로 유지한다. DEV `0.7.0-dev.1`의 automated release publication과 native aarch64 CI는 PASS했지만, 실제 aarch64 HAOS의 설치·Ingress/SSH/Codex/API/browser·restart/update 수용 전에는 aarch64 HAOS platform acceptance 완료로 표시하지 않는다.
- CI 결정: amd64 기존 회귀와 독립된 native aarch64 job을 두고 image architecture/label, Codex/GitHub CLI/Node/Chromium runtime과 architecture-neutral 7개 smoke를 실행한다. [Dev CI 31549518729](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/31549518729)에서 amd64와 native aarch64 full smoke가 PASS했으며 실제 HAOS 수용은 별도다.

## ADR-039 고정 민감 경로, managed sandbox와 private Supervisor credential

- 상태: Implemented for DEV `0.7.0-dev.1`; actual HAOS direct-path acceptance PARTIAL (observed scope PASS)
- 고정 경로 결정: `/config` RW mount와 Core/Supervisor `manager` API 가용성은 유지한다. 동시에 custom AppArmor와 `/etc/codex/requirements.toml`이 `/config/secrets.yaml`, 모든 깊이의 `secrets.yaml`, `/config/.storage`와 descendants를 항상 거부한다. 사용자 옵션이나 project/user Codex config가 이 deny를 완화할 수 없다.
- alias 결정: AppArmor profile은 image validator에 필요한 `.storage` directory traversal/listing operation만 남기고 content operation은 계속 deny한다. Listing allowance는 profile 전체에 적용되지만 managed requirements가 Codex directory read를 별도 차단한다. Init과 매 Codex launch는 보호 tree의 symlink, special file과 `st_nlink != 1`을 값·경로 원문 없이 검사하고 unsafe shape이면 fail closed한다.
- sandbox 결정: 신규·현재 기본값과 wrapper 강제값은 network-enabled `workspace-write`다. Schema의 `danger-full-access`는 기존 저장값을 깨지 않기 위한 legacy 입력으로만 남고, 새 session에서는 warning 뒤 `workspace-write`로 변환된다. 이 결정은 ADR-011을 대체한다.
- credential 결정: init는 Supervisor credential을 mode `0600` fixed runtime file에 두고 S6 container environment에서 제거한다. Interactive/Web/SSH/Codex와 장기 scheduler는 ambient `SUPERVISOR_TOKEN`을 상속하지 않는다. 용도가 고정된 API/browser/memory helper만 실행 시 이 파일을 읽고 필요한 process lifetime으로 제한한다. Direct API helper는 공통 owner/type/link/mode validator와 고정 Core/Supervisor endpoint를 사용한다. 이 결정은 ADR-005를 대체한다.
- 가용성 이유: 일반 `/config` 수정, manager API raw request, browser/memory와 기존 운영 helper를 유지하면서 자주 사용되는 정적 credential store의 우발적 모델 노출 범위를 줄인다. 범용 read-only proxy로 제품 기능을 축소하지 않는다.
- 명시적 비보장: API helper는 raw response를 유지하므로 호출한 endpoint가 민감정보를 돌려주면 모델에 노출될 수 있다. Container interactive process가 root인 구조도 유지되므로 `/run/codex-ha/runtime.env`와 `/data/github-cli`를 의도적으로 직접 읽을 수 있다. File controls는 pathname 기반이라 preflight 뒤 외부 hardlink TOCTOU와 보호 값의 비보호 path 복사도 보장하지 않는다. Ambient env 제거, AppArmor 고정 경로와 managed requirements는 완전한 DLP·root 격리가 아니며 GitHub credential의 완전 격리에는 별도 broker가 필요하다.
- 검증 경계: AppArmor parser/negative fixture, nested path 우회, 일반 `/config` RW, managed config precedence, legacy option, ambient environment와 helper credential loader를 자동·container·실제 HAOS에서 각각 검사한다. Amd64와 native aarch64 자동 image/full smoke는 [dev CI 31549518729](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/31549518729)에서 PASS했다. 후속 사용자 증거에서 `#dev` `0.7.0-dev.1`의 Supervisor AppArmor profile load, 일반 `/config` RW, App/Ingress 가용성과 새 Codex session의 root·nested `secrets.yaml` 및 `.storage` 고정 접근 불가 정책 보고를 관측했다. 실제 read syscall 음성 출력, architecture와 Web/SSH root-shell, alias/special-file, ambient credential/helper 전체 행렬이 없어 실제 HAOS 통합 수용은 **PARTIAL**이며 aarch64 HAOS 판정은 **NOT RUN**이다.

## ADR-040 multi-arch 공급망 증거와 자동 갱신

- 상태: Implemented and exercised for DEV `0.7.0-dev.1`
- 결정: Third-party GitHub Actions는 full commit SHA로 고정한다. Builder는 architecture별 SPDX SBOM을 만들고 Critical 취약점을 publication 전 차단하며 High/Critical 결과를 보고한다. 검증 digest는 immutable Actions artifact로 job 사이에 전달하고 exact digest만으로 generic manifest를 만든다. Per-arch에는 Cosign/provenance/SBOM, generic에는 Cosign/provenance를 먼저 발행한 뒤 최종 version tag를 마지막에 digest-equality 방식으로 승격한다.
- 자동 갱신: Dependabot은 GitHub Actions와 `/codex_home_assistant/playwright` npm 생태계를 weekly로 점검한다. Action pin과 Playwright/`ws` 갱신 PR은 일반 CI와 native architecture 회귀를 통과한 뒤 수동 검토한다.
- 불필요 binary 결정: Grype `0.110`이 base에서 상속한 TempIO와 official `2026.07.0` 교체 후보 모두의 embedded `golang.org/x/crypto` `v0.31.0`에서 Critical 7건을 보고했다. Repository와 base init 경로에 사용처가 없으므로 version 교체 대신 final image에서 `/usr/bin/tempio`를 제거하고 image contract가 부재를 확인한다.
- 이유: architecture별 외부 binary, container base와 build action이 늘어날수록 digest·구성요소·출처 증거와 취약점 차단을 같은 release 계약으로 관리해야 한다.
- 실행 증거: [Tag Builder 31550037239](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/31550037239)는 두 architecture의 SPDX SBOM, Critical gate, Cosign signature, provenance/SBOM attestation, verified digest 기반 generic manifest, generic signature/provenance와 final-last promotion을 PASS했다. High 이상 scan 경고는 비차단으로 남았고 Critical publication gate는 통과했다.
- digest: Generic `sha256:703fd667d21c2b101b546652f9b781725a31b071377bf205cd130640e79d5ae5`, amd64 `sha256:e19882421cc86ac1042a6c512c808db35bb4b506134db482f2a5d6c9f78606b2`, aarch64 `sha256:dc43af845b5b60749e0599047f2cfeaa2ec0838b2783826ad872da2e990c27c5`다.
- 검증·전달 경계: 이 release evidence는 실제 Raspberry Pi/aarch64 HAOS 설치나 custom AppArmor/managed requirements의 HAOS runtime acceptance를 대체하지 않는다. Public `0.6.0`의 과거 amd64 결과는 그대로 유지하며 DEV `0.7.0-dev.1`의 multi-arch 증거를 소급 적용하지 않는다.

## ADR-041 restored automation의 exact config miss와 최소 Ingress log

- 상태: Accepted for DEV `0.7.0-dev.2`
- 배경: 실제 `#dev` HAOS 로그에서 App과 민감 경로 경계는 동작했지만 `ha-memoryd`가 약 2시간 28분 동안 `ha_command_automation_config_failed`로 retry해 catalog가 `degraded/stale`에 머물렀다. 같은 로그의 nginx combined format은 credential/body를 남기지 않았지만 개인 HA Referer와 User-Agent의 device/OS/browser를 기록했다.
- memory 결정: Core `2026.7.3`의 official `automation/config` handler는 요청 entity를 automation component에서 찾지 못하면 `not_found`를 반환한다. Registry/state에는 남은 restored/stale automation에서 내부 command type이 정확히 `automation/config`이고 remote code가 정확히 `not_found`일 때만 빈 config와 `automation_config_unavailable` warning으로 격리한다. Remote message는 저장·log하지 않는다. 다른 config code, auth, timeout, transport, protocol, malformed result와 다른 command 실패는 last-known-good를 보존하며 full snapshot을 계속 fail closed한다.
- log 결정: Ingress access log는 time, method, normalized path, protocol, status와 response bytes만 기록한다. Query string, client address, Referer와 User-Agent는 제거하고 browser-only `8099` access log off는 유지한다. Ordinary upstream failure의 built-in error line이 raw URI와 Referer를 반복하므로 nginx error log는 `crit` 이상만 남기고 4xx/5xx status는 minimal access log에서 관측한다. 이 변경은 request body/credential logging을 추가하지 않는다.
- 검증 경계: Source와 installed WebSocket fixture에서 exact `not_found`의 catalog 유지·warning·remote-message 비노출, 다른 code의 snapshot 거부를 확인한다. Nginx contract와 final image syntax/smoke를 확인하며 실제 `0.7.0-dev.2` HAOS update 뒤 memory `ready` 수렴과 새 minimal log shape는 별도 수용 항목이다.

## ADR-042 stable 0.7.0 승격과 aarch64 수용 예외

- 상태: Accepted for stable `0.7.0` on 2026-08-14
- 결정: App/repository 표면을 **Codex for Home Assistant**, panel **Codex**, version `0.7.0`, `stage: stable`로 승격하고 main base repository URL을 안정판 설치 경로로 사용한다. Stable metadata와 사용자 문서에는 DEV 표시명·prefix·canary 설치 버튼을 포함하지 않는다. 영속 slug와 GHCR image repository는 유지한다.
- 플랫폼 결정: `amd64`와 64비트 `aarch64`를 stable 지원 대상으로 선언한다. Aarch64는 native ARM CI, architecture-neutral full smoke, 공개 multi-architecture manifest와 architecture별 SBOM/Critical gate/signing·attestation payload evidence를 통과했다. 실제 Raspberry Pi/aarch64 HAOS는 **NOT RUN**이다.
- 규칙 예외: Maintainer는 실제 aarch64 HAOS 수용을 public 지원 전제조건으로 둔 R-303에 대해 `0.7.0` 한정의 좁은 위험 예외를 명시적으로 승인했다. 미실행 항목을 PASS로 바꾸지 않으며 이후 base, Codex binary, architecture 또는 핵심 runtime 변경에 이 예외를 자동 재사용하지 않는다.
- 보안 결정: Custom AppArmor와 managed requirements는 root/nested `secrets.yaml`과 `/config/.storage` content를 정상적인 Codex 직접 파일 접근에서 명시적으로 거부한다. 따라서 그 경로로 content가 Codex에 전달되지 않는다. 일반 `/config` RW와 manager API 가용성은 유지한다.
- 비보장: 위 보장은 완전한 DLP가 아니다. Raw Core/Supervisor API, 로그와 인증 browser response, 비보호 경로에 복사된 값, root process의 private runtime credential 직접 read와 pathname hardlink TOCTOU는 잔여 위험이다. Syscall-level 전체 음성 행렬, Web/SSH root-shell과 alias/special/helper 전체 조합, 독립 post-publication attestation 확인 및 일부 live feedback/UI/memory 흐름은 **NOT RUN/PARTIAL**이며 사용자가 2026-08-14 stable 승격 위험으로 승인했다.
- 수용 증거: 실제 amd64 HAOS `0.7.0-dev.2` 보고서는 App started, runtime hash 일치, protected-tree preflight, 일반 `/config` RW, AppArmor profile 적용, Ingress/ttyd, 관리형 browser, `ha-memoryd` ready/fresh와 bounded warning 상태를 관측했다. 이 보고서를 실행하지 않은 syscall/aarch64 행렬의 대체 PASS로 사용하지 않는다.
- 배포 경계: 기존 `#dev` 설치와 main repository 설치는 Supervisor repository identity가 다르다. `#dev` → main의 in-place `/data` 보존 전환은 검증하지 않았으므로 안정판 일반 update와 동일하다고 약속하지 않는다. Stable `0.6.0` → `0.7.0` 같은-repository update 보존 계약과 분리한다.
