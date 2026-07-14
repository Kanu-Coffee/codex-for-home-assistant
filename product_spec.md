# product_spec.md — 제품 요구사항

## 1. 제품 정의

`Codex for Home Assistant`는 HAOS의 Supervisor가 관리하는 Home Assistant App이다. 사용자는 Home Assistant 안의 웹 터미널, 일반 SSH, desktop app의 SSH 프로젝트 또는 그 desktop host에 연결된 mobile Remote를 통해 동일한 Codex 환경에 접근한다.

Codex는 Home Assistant 설정과 런타임을 관찰·수정·시험하는 신뢰된 운영 에이전트로 사용된다.

## 2. 목표

- 대시보드, 자동화, 스크립트, 테마, 패키지 등 `/config` 전체를 Codex가 직접 관리한다.
- 엔티티·기기·구역·통계·Trace·로그를 분석한다.
- 실제 서비스 호출로 조명·스위치 등 기기를 시험한다.
- 설정 변경 후 검사, 재로드/재시작, 재시험을 한 작업 흐름에서 수행한다.
- Codex가 개발한 Web UI와 Home Assistant 대시보드를 실제 Chromium으로 렌더링해 반응형 화면, 콘솔 오류, 네트워크·리소스 상태를 확인한다.
- 별도 SMB, 외부 Ubuntu 중계 서버, 별도 진단 프록시 없이 HAOS 내부에서 완결한다.

## 3. 주요 사용자 시나리오

### US-001 웹에서 즉시 Codex 사용

사용자는 Home Assistant의 App 화면에서 Web UI를 열고 일반 셸 또는 자동 실행된 Codex TUI를 사용한다.

### US-002 Windows 터미널에서 SSH 사용

사용자는 공개키로 App에 SSH 접속하고 `/config`에서 `codex`, Git, YAML 검사, API helper를 사용한다.

### US-003 Desktop SSH 프로젝트와 mobile Remote 사용

Desktop app은 SSH host를 발견하고 원격 `/config` 프로젝트를 열어 파일 수정, 명령 실행, 테스트를 수행한다. 사용자는 선택적으로 ChatGPT mobile Remote에서 연결된 desktop host를 통해 같은 원격 환경의 작업을 이어 간다.

### US-004 자동화 오류 진단

Codex는 자동화 YAML, 현재 상태, 과거 이력, Trace, Core/App 로그를 함께 분석하고 원인을 수정한다.

### US-005 실제 기기 검증

Codex는 대상 엔티티의 현재 상태를 기록하고 서비스를 호출한 뒤 상태·로그·Trace를 재확인한다. 안전한 경우 원래 상태로 복원한다.

### US-006 Home Assistant 운영

Codex는 설정 검사, Core 로그 조회, App 로그 조회, Core/App 재시작 등 `manager` 역할 범위의 운영 작업을 수행한다.

### US-007 실제 브라우저 UI 회귀 검사

Codex는 Playwright Headless Chromium으로 대상 URL을 열고 데스크톱과 모바일 viewport에서 스크린샷을 비교한다. 같은 세션에서 JavaScript console/page error와 성공·실패한 정적/API resource를 확인하고 수정 후 다시 렌더링한다. Home Assistant 대시보드는 외부에 새 포트를 열지 않는 App 내부 loopback gateway를 통해 검사한다.

## 4. 기능 요구사항

### FR-001 Codex CLI

- 컨테이너에 공식 Codex CLI를 포함한다.
- `codex`가 웹 터미널 및 SSH login shell의 PATH에서 동작한다.
- 기본 작업 디렉터리는 `/config`다.
- 버전은 App 이미지에 pin한다.

### FR-002 Codex 인증 영속화

- `CODEX_HOME=/data/codex`를 사용한다.
- `auth.json`, `config.toml`, 세션 데이터가 App 재시작/업데이트 후 유지된다.
- `ha-codex-login` 장치 코드 로그인 명령을 제공한다.
- 인증 파일은 로그와 Git에 노출하지 않는다.

### FR-003 Ingress 웹 터미널

- Home Assistant Ingress를 사용한다.
- 외부 웹 터미널 포트를 노출하지 않는다.
- WebSocket 스트리밍과 터미널 크기 변경을 지원한다.
- tmux로 브라우저 재접속 시 세션을 복구한다.

### FR-004 웹 터미널 Codex 자동 실행

App 옵션:

```yaml
web_terminal_auto_start_codex: false
```

- `false`: 일반 login shell 표시
- `true`: Codex를 한 번 실행, 종료 후 일반 shell로 복귀

### FR-005 SSH

- OpenSSH server를 제공한다.
- 공개키 인증만 허용한다.
- 컨테이너 포트 `22/tcp`, 기본 host port `2223`을 사용한다.
- host port는 Home Assistant App의 Network 설정에서 변경 가능하다.
- SSH host keys는 `/data`에 영속화한다.

### FR-006 Remote SSH

- ChatGPT desktop app이 원격 host로 연결할 수 있어야 한다.
- login shell에서 `codex`가 PATH에 있어야 한다.
- 원격 Codex 인증이 완료되어 있어야 한다.
- `/config`를 원격 프로젝트로 열 수 있어야 한다.
- mobile Remote를 사용할 때는 페어링된 desktop host가 SSH 연결과 원격 app server를 담당한다.

### FR-007 `/config` 전체 관리

다음 매핑을 사용한다.

```yaml
map:
  - type: homeassistant_config
    path: /config
    read_only: false
```

하위 폴더를 별도 제한하지 않는다.

### FR-008 Home Assistant Core API

```yaml
homeassistant_api: true
```

Codex는 다음을 할 수 있어야 한다.

- 현재 상태 및 서비스 조회
- REST/WebSocket API 사용
- 서비스 호출 및 실제 기기 테스트
- 자동화/스크립트 실행
- 이력·통계·Trace 조회가 가능한 공식 API 사용

### FR-009 Supervisor API

```yaml
hassio_api: true
hassio_role: manager
```

Codex는 manager 역할이 허용하는 범위에서 다음을 수행한다.

- Core/Supervisor/App 로그 조회
- 설정 검사
- Core 및 App 정보/상태 조회
- Core/App 시작·중지·재시작 등 운영

실제 허용 범위는 통합 테스트로 확인하며, 실패했다고 자동으로 `admin`으로 올리지 않는다.

### FR-010 API helper 명령

최소 명령:

```text
ha-codex
ha-codex-login
ha-api
supervisor-api
ha-config-check
ha-core-logs
ha-addon-logs
```

helper는 토큰을 출력하지 않고 HTTP 오류를 명확히 반환한다. 로그 helper는 Supervisor가 지원하는 `text/x-log`를 요청하고 동적 response media type은 고정 allowlist만 허용한다.

### FR-011 App 설정

최소 JSON 옵션:

- `authorized_keys`
- `web_terminal_auto_start_codex`
- `tmux_session_name`
- `codex_approval_policy`
- `codex_sandbox_mode`
- `log_level`

SSH 외부 포트는 JSON 옵션이 아니라 Network 설정이다.

### FR-012 Git 도구

컨테이너에서 Git을 사용할 수 있어야 한다. 실제 Home Assistant `/config`의 Git 관리 여부는 사용자가 결정하며, App 소스 저장소와 HA 설정 저장소를 혼동하지 않는다.

### FR-013 Codex 운영 가드레일

- `CODEX_HOME/AGENTS.md`와 `AGENTS.override.md`가 모두 없으면 Home Assistant 운영 안전 지침을 생성한다.
- 기존 전역 지침은 빈 파일과 심볼릭 링크를 포함해 내용과 권한을 변경하지 않고 보존한다.
- 지침은 비밀값 비노출, 진단과 변경 권한의 분리, `.storage`/DB 보호, 변경 후 설정 검사, 고위험 동작 승인 규칙을 포함한다.
- `/config`에 사용자가 둔 프로젝트별 `AGENTS.md`는 공식 Codex 계층 규칙에 따라 더 구체적인 지침을 추가할 수 있다.

### FR-014 Playwright Headless Chromium renderer

- App 이미지에 Microsoft `@playwright/mcp`와 그 lockfile, Alpine `chromium-headless-shell`을 포함하고 버전 입력을 고정한다.
- Codex에는 `/etc/codex/config.toml`의 공식 STDIO MCP server로 노출하며 브라우저 실패가 Codex·웹 터미널·SSH 시작을 막지 않도록 optional server로 구성한다.
- 브라우저는 headless·isolated context로 실행하고 기본 desktop viewport `1440x900`과 mobile viewport `390x844`를 지원한다.
- 최소 도구 집합은 탐색·snapshot·resize·screenshot·console message와 network request/resource 목록의 URL/status 검사를 제공한다. 민감 header/body를 포함할 수 있는 단일 request 상세 도구는 노출하지 않는다.
- MCP enforcement proxy는 screenshot/console/network 호출의 선택적 `filename`을 거부해 image response와 `/run` output만 허용한다. 사용자가 영속 파일을 명시적으로 요청하면 browser tool 밖의 별도 파일 작업으로 취급한다.
- `browser_run_code_unsafe`, 임의 file upload, code generation처럼 요구사항에 필요하지 않은 고위험 기능은 노출하지 않는다.
- console warning/error와 uncaught page error, 2xx/3xx/4xx/5xx 및 전송 실패 resource를 구분해 보고할 수 있어야 한다.

### FR-015 Home Assistant dashboard loopback gateway

- 인증된 대시보드 렌더링에는 컨테이너 loopback `127.0.0.1:8099` gateway를 사용하고 `config.yaml`의 Ingress·Network port를 추가하지 않는다.
- gateway는 Home Assistant frontend asset, auth, Core REST/WebSocket을 같은 direct Core browser origin으로 결합해 전용 사용자의 permission을 일관되게 적용한다.
- Supervisor token은 renderer에 전달하지 않는다. 권장 `ha-browser-auth-setup`은 지원되는 Home Assistant API로 전용 active·local-only·non-admin·sole `system-read-only` user와 long-lived token을 만들고 임시 password credential/OAuth refresh token을 제거한다. optional App secret의 수동 token은 명시적 override로 유지한다.
- 동적으로 재할당되는 App `/32`와 Docker 대역을 `trusted_networks`/`trusted_proxies`에 추가하지 않고 기존 `homeassistant` auth provider를 그대로 유지한다.
- 관리형 recovery state와 LLAT는 `/data/browser-auth`의 root-only `0700`/`0600` 파일에 원자 저장하고, exact ready state만 `/run`의 `0600` runtime token으로 활성화한다. token은 command argument, URL, MCP 응답, screenshot, console/network artifact 또는 App log에 원문으로 남기지 않는다. Playwright `--secrets` 입력값 치환은 사용하지 않고 관리 proxy가 stdout/stderr exact 문자열만 직접 마스킹한다.
- App init과 각 MCP 시작은 user policy, credential 부재와 exact single LLAT metadata를 재검증한다. token이 없거나 검증·Core/DNS/TLS가 실패하면 일반 Web UI 렌더링 기능은 유지하되 Home Assistant 자동 인증은 하지 않고 login 화면 또는 인증 부재를 결과에 명시한다. gateway HTTPS는 image CA와 `homeassistant` hostname을 검증한다.
- setup/remove는 kernel lock으로 직렬화하고 self-revoke를 재접속으로 확인한다. 모호한 `local_only` auth rejection이나 transport 실패에서는 영구 복구 자료를 보존하고 runtime만 fail closed한다.

### FR-016 업데이트와 사용자 Codex 설정 보존

- App이 관리하는 Playwright MCP 기본값은 이미지 계층의 `/etc/codex/config.toml`에 둔다.
- `/data/codex/config.toml`, 인증, 세션, 전역 지침의 기존 사용자 내용은 Playwright 기능 추가나 일반 App 업데이트 과정에서 수정·병합·초기화하지 않는다.
- 공식 Codex 우선순위에 따라 사용자·신뢰된 프로젝트 config가 system MCP 기본값을 재정의하거나 비활성화할 수 있어야 한다.
- Playwright/Chromium 설치는 image build에서 끝내고 App 시작 시 `npm install`, browser download 또는 `latest` resolution을 수행하지 않는다.

## 5. 비기능 요구사항

### NFR-001 재현성

Codex CLI, base image, `@playwright/mcp` lockfile, Playwright core와 Chromium을 포함한 주요 패키지는 버전 또는 digest로 추적 가능해야 한다.

### NFR-002 복구 가능성

App 재설치 전까지 `/data`의 Codex 인증, 사용자 Codex 설정, SSH host key와 관리형 browser identity recovery state가 유지된다. browser context와 screenshot/output은 enforcement proxy가 `/run`의 일시 데이터로 제한하며 App 업데이트에 필요한 영속 상태로 취급하지 않는다. 설정 변경은 Git checkpoint 및 Home Assistant 설정 검사 절차를 권장한다.

### NFR-003 보안 기본값

- Ingress 관리자 전용
- SSH 공개키 전용
- 기본 AppArmor 활성
- `manager` 역할
- Docker/host privileged 권한 없음
- Playwright MCP는 STDIO, Home Assistant gateway는 loopback 전용이며 새 host/Ingress port 없음
- Chromium `--no-sandbox`는 기존 App 컨테이너 경계 안에서만 허용하며 이를 위해 App privilege를 추가하지 않음
- 기존 사용자 지침을 덮어쓰지 않는 영속 Codex 운영 가드레일. 이 파일은 방어 심층화 지침이며 권한 강제 경계는 아니다.

### NFR-004 관찰 가능성

App 시작 로그는 Codex readiness와 loopback gateway 구성을 토큰 없이 기록한다. Playwright/Chromium 버전은 image build·smoke 증거로 남기고, MCP 렌더 결과는 viewport, screenshot 증거, console severity와 resource URL/status를 포함하되 인증 header와 token 원문을 출력하지 않는다.

### NFR-005 플랫폼

- M1: amd64만 실제 지원 표시
- M3: aarch64 검증 후 추가
- Alpine system Chromium 조합은 Playwright upstream의 공식 Linux 배포 대상이 아니므로 로컬 amd64 container 검증과 별개로 실제 HAOS/AppArmor 검증 전에는 지원 완료로 표시하지 않음

## 6. 비목표

MVP에서는 다음을 만들지 않는다.

- 별도 GUI 관리 콘솔
- Codex 대화 기록 전용 웹 앱
- 읽기 전용 API 프록시
- 세밀한 AppArmor 경로 제한
- Docker socket 관리
- HAOS host shell 제공
- 비밀번호 SSH 로그인
- 멀티 사용자/역할 분리
- 자동 Bubble Card 생성 전용 마법사
- Codex API key를 GitHub Actions에 자동 복제
- headed browser, VNC, 원격 debugging port 또는 외부 공개 browser service
- Firefox/WebKit 다중 browser matrix와 영속 browser profile

## 7. MVP 수용 기준

아래가 모두 충족되어야 M1/M2 완료다.

1. App이 HAOS amd64에 설치·시작된다.
2. Web UI에서 ttyd가 열리고 `/config` shell을 제공한다.
3. auto-start 옵션이 false/true 모두 정확히 동작한다.
4. 웹 연결을 끊었다 다시 열어도 tmux 세션이 복구된다.
5. `codex login --device-auth` 후 인증이 App 재시작 뒤에도 남는다.
6. 공개키 SSH가 기본 host port 2223에서 동작한다.
7. ChatGPT desktop SSH 연결이 `/config` 프로젝트를 열며 mobile Remote에서도 해당 환경을 제어할 수 있다.
8. Codex가 `/config` 테스트 파일을 생성·수정·삭제할 수 있다.
9. Core API로 상태 조회와 안전한 서비스 호출을 성공한다.
10. Supervisor manager API로 로그 조회 및 설정 검사를 성공한다.
11. `admin`, Docker API, full access, host network 없이 위 기능이 동작한다.
12. CI build/lint가 통과하고 GitHub에 코드와 문서가 push된다.
13. 기본 운영 가드레일이 최초 생성되고 사용자 수정본은 App 재시작 뒤에도 보존된다.

## 8. 브라우저 렌더러 개선 수용 기준

기존 M1/M2 수용 결과와 별도로 다음을 모두 확인해야 Playwright 개선을 HAOS 완료로 판정한다.

1. `codex mcp list` 또는 동등한 공식 경로에서 image-managed Playwright server가 보이고 기존 `/data/codex/config.toml` 내용이 유지된다.
2. 로컬 fixture Web UI를 `1440x900`과 `390x844`로 렌더링하고 두 PNG screenshot과 viewport별 DOM snapshot을 만든다.
3. 의도한 console/page error와 2xx, 3xx, 4xx/5xx, 전송 실패 resource를 MCP 도구로 구분한다.
4. browser, MCP response, process argument, App log와 output artifact 어디에도 fixture Supervisor token과 dedicated browser token 원문이 없다.
5. 새 host port, Ingress port, `host_network`, Docker API, `full_access`, 추가 privilege 없이 동작한다.
6. 기존 설치를 삭제하거나 `/data`를 reset하지 않은 일반 App 업데이트 뒤 Codex 인증·사용자 config·SSH host identity와 Playwright system MCP가 함께 동작한다.
7. 실제 HAOS amd64에서 Chromium이 기본 AppArmor 아래 시작되고 loopback gateway로 인증된 Home Assistant dashboard를 desktop/mobile 양쪽에서 렌더링한다.

7번은 HAOS 전용이며 로컬 Docker 성공으로 대체하지 않는다. 실기 증거가 기록되기 전 상태는 **NOT RUN / HAOS unverified**다.
