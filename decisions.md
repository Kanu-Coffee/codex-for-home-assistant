# decisions.md — Architecture Decision Records

## ADR-001 Home Assistant App으로 구현

- 상태: Accepted
- 결정: HACS integration이 아니라 Supervisor가 관리하는 Home Assistant App(구 Add-on) repository로 만든다.
- 이유: Codex CLI, ttyd, sshd, persistent `/data`, `/config` mount, Core/Supervisor API 권한이 필요하다.

## ADR-002 세 접근 방식을 동시에 제공

- 상태: Accepted
- 결정: Codex CLI, Ingress 웹 터미널, SSH/Remote SSH를 한 App에서 제공한다.
- 이유: 모바일/브라우저 즉시 접근과 Windows Codex Desktop의 편집 UX를 모두 확보한다.

## ADR-003 `/config` 전체 RW

- 상태: Accepted
- 결정: `homeassistant_config` 전체를 `/config`에 RW로 매핑한다.
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

- 상태: Accepted
- 결정: 웹 터미널과 SSH/Codex shell에서 `SUPERVISOR_TOKEN`을 사용할 수 있게 한다.
- 이유: 제한 프록시 없이 Codex가 전체 운영과 테스트를 직접 수행해야 한다.
- 결과: token redaction과 관리자 전용 접근을 강제한다.

## ADR-006 Host/Docker 특권은 주지 않음

- 상태: Accepted
- 결정: `docker_api`, `full_access`, `host_network`, admin 역할을 사용하지 않는다. 기본 AppArmor를 유지한다.
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

- 상태: Provisional Accepted
- 결정: MVP 기본값은 `approval_policy=on-request`, `sandbox_mode=danger-full-access`다.
- 이유: 컨테이너 내부에서 `/config`와 API를 막힘없이 사용하고 HAOS의 nested sandbox 호환성 문제를 피한다.
- 검토 조건: `workspace-write` + network access가 실제 HAOS/Remote SSH에서 안정적으로 검증되면 더 제한적인 기본값을 재평가한다.

## ADR-012 앱 시작 정책

- 상태: Accepted
- 결정: `boot: manual` 기본.
- 이유: 상시 유지가 제품 목표가 아니며 필요할 때 시작한다. 사용자가 향후 UI에서 시작 정책을 조정할 여지는 남긴다.

## ADR-013 아키텍처 지원은 검증 기반

- 상태: Accepted
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
- 제약: OpenAI가 명시한 Linux 지원 OS는 Ubuntu/Debian 중심이다. 사용자가 이 amd64 Alpine/HAOS 이미지의 remote app server를 mobile Remote → desktop SSH project 경로에서 확인했지만, Codex 버전 또는 아키텍처를 바꾸면 다시 실기 검증한다.

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
- 결정: 이미지에 기본 운영 가드레일 템플릿을 포함하고 `/data/codex/AGENTS.md`와 `AGENTS.override.md`가 모두 없을 때 복사한다. 기존 파일은 빈 파일과 심볼릭 링크를 포함해 덮어쓰거나 mode를 변경하지 않는다.
- 이유: Codex는 의도적으로 `/config` RW와 Core/Supervisor 운영 권한을 가지므로 진단과 변경 권한을 분리하고, 비밀값·`.storage`·DB·고위험 기기 동작에 대한 반복 안전 규칙이 모든 새 세션에 필요하다. 공식 Codex는 `CODEX_HOME/AGENTS.md`를 전역 지침으로 읽고 `/config`의 더 가까운 프로젝트 지침을 뒤에 결합한다.
- 제외: 이 지침을 강제 보안 경계로 간주하지 않는다. `/config/AGENTS.md` 자동 생성, 기존 사용자 지침 덮어쓰기, Repairs/파일 권한/업데이트 자동 수정은 하지 않는다.

## ADR-020 로그 endpoint media type 명시

- 상태: Accepted
- 결정: 공용 API helper의 기본 `Accept`는 `application/json`으로 유지하고, `application/json`, `text/plain`, `text/x-log`만 명시적으로 선택할 수 있게 한다. Core/App 로그 wrapper는 `text/x-log`를 사용한다.
- 이유: Supervisor 로그 endpoint는 JSON이 아닌 log media type을 요구한다. `--raw` 출력 모드 전체의 요청 의미를 바꾸지 않으면서 실제 HAOS 실패를 수정하고, allowlist로 header injection을 막는다.

## ADR-021 tag-gated public GHCR 배포

- 상태: Accepted
- 결정: `0.1.3`부터 `ghcr.io/kanu-coffee/codex-for-home-assistant` generic manifest를 사용한다. 공식 Home Assistant builder actions `2026.06.0`이 amd64 image와 manifest를 숫자 Git tag에서만 게시하며 tag는 App version과 정확히 같아야 한다.
- 이유: pre-built image는 HAOS의 느리고 실패 가능성이 높은 소스 빌드를 제거한다. tag-only publish, App version 일치 검사와 기존 generic/per-arch GHCR tag preflight는 이후 문서 변경이나 version bump 누락이 기존 release image를 덮어쓰는 것을 막는다.
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

- 상태: Provisional Accepted for 0.2.0
- 결정: upstream browser bundle을 내려받지 않고 Alpine package의 `/usr/bin/chromium-headless-shell`을 pinned Playwright MCP가 headless·isolated mode로 실행한다. CJK/emoji font를 image에 포함한다.
- 이유: 기존 `ghcr.io/home-assistant/base:3.24`/Alpine App 구조를 유지하고 browser runtime만 추가해 배포·업데이트 회귀 범위를 줄이기 위해서다.
- 제약: upstream Playwright의 공식 Linux browser target은 Ubuntu/Debian 계열 중심이며 이 Alpine system Chromium 조합은 공식 bundle과 동일한 지원 계약이 아니다. 로컬 fixture와 image smoke 외에 실제 HAOS/AppArmor/dashboard 실기가 필요하며 완료 전에는 **HAOS unverified**다.
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
- 완료 기준: local fixture에서 두 viewport와 오류/resource 수집을 자동 검증하고, 실제 HAOS에서 AppArmor 활성 상태의 dashboard와 token 비노출을 별도 E2E로 검증한다.

## ADR-027 동적 App IP를 인증 신원으로 사용하지 않고 전용 read-only token을 사용

- 상태: Accepted
- 판정: Chromium이 loopback gateway에 연결한 뒤 nginx가 Core에 만드는 socket의 source는 현재 App container IP다. Supervisor의 일반 App 주소는 `172.30.33.0/24`에서 동적 할당되고 update/recreate 뒤 유지·전용성이 보장되지 않는다. 현재 `/32`는 순간적으로 좁아도 나중에 다른 App에 재할당될 수 있고, 전체 대역은 즉시 모든 App을 신뢰한다. 둘 다 영구 `trusted_networks` 신원으로 사용하지 않는다.
- proxy 판정: App IP 또는 Docker 대역이 `trusted_proxies`에도 포함되면 Home Assistant가 trusted-network 로그인을 거부한다. App을 proxy로 신뢰하고 합성 X-Forwarded-For를 보내는 우회는 같은 주소 재사용과 다른 App의 header spoofing 위험을 키우므로 사용하지 않는다.
- 결정: Home Assistant의 `configuration.yaml`, `auth_providers`, `trusted_networks`, `trusted_proxies`와 `.storage`를 App이 편집하지 않는다. 기존 `homeassistant` provider를 그대로 유지한다. 선택적인 `home_assistant_browser_token`에는 활성·일반·`local_only` 사용자이면서 유일한 group이 `system-read-only`인 사용자의 long-lived token만 허용한다.
- 검증: App init은 browser token으로 `auth/current_user`, Supervisor의 기존 runtime credential로 `config/auth/list`를 읽어 user ID와 정확한 group/local-only/non-admin 상태를 교차검증한다. 실패·미설정·과권한 상태에서는 token을 Chromium에 전달하지 않고 login page로 fail closed한다.
- 전달 경계: 검증된 token은 Supervisor가 관리하는 App option에 영속되고, 실행 중에는 mode `0600`의 `/run` 파일에서 Playwright init script 환경으로만 전달된다. system MCP는 `env -i`로 wrapper를 시작하고 wrapper가 `PLAYWRIGHT_MCP_*`, `NODE_OPTIONS`, `NODE_PATH`와 shell startup 변수를 검증 전에 제거한다. Node proxy/browser child는 상속 환경이 아니라 고정 allowlist만 받으며 `SUPERVISOR_TOKEN`은 전달하지 않는다. token 주입 origin은 `127.0.0.1:8099`와 `localhost:8099`뿐이다. Playwright `--secrets`는 입력 도구에서 secret 이름을 실제 값으로 치환할 수 있으므로 사용하지 않고, 관리 proxy가 stdout/stderr의 exact 문자열만 직접 마스킹한다.
- 권한 경계: gateway의 document, `/auth/`, `/api/`, `/api/websocket`은 모두 `homeassistant:<port>` Core로 직접 전달하고 X-Forwarded-For, X-Real-IP, Forwarded를 제거한다. Supervisor Core proxy를 섞지 않아 dedicated user의 Core permission이 전체 세션에 적용되게 한다.
- 운영: `ha-browser-network-info`는 socket local IP와 Supervisor self IP를 읽기 전용으로 교차확인하고 이 주소가 persistent trusted-network identity가 아님을 명시한다. 전용 사용자 생성·password credential 제거는 Core의 지원되는 admin WebSocket API만 사용하며 `.storage`를 직접 수정하지 않는다.
- 제한: `system-read-only`도 모든 entity state를 읽을 수 있으며 특정 dashboard 하나만으로 축소된 권한은 아니다. custom integration의 권한 검사 결함까지 보장하지 않으므로 화면·console·network 결과를 계속 민감자료로 취급한다.
