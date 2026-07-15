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

### US-008 검증된 Home Assistant 메모리 사용

Codex는 Home Assistant의 엔티티·장치·영역·자동화 관계를 빠르게 찾고, 사용자가 설명한 별칭·실제 용도·선호를 검증된 메모리로 재사용한다. 일시 상태나 단일 추론은 활성 메모리로 승격하지 않으며 실제 HA와 충돌하면 출처와 충돌을 기록한 뒤 권위 있는 근거로 교정한다.

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
- `browser_approval_policy` (기본 `safe`)
- `codex_user_files_update_mode` (기본 `preserve`)
- `home_assistant_browser_auto_auth` (기본 `true`)
- `log_level`

SSH 외부 포트는 JSON 옵션이 아니라 Network 설정이다.

### FR-012 Git 도구

컨테이너에서 Git을 사용할 수 있어야 한다. 실제 Home Assistant `/config`의 Git 관리 여부는 사용자가 결정하며, App 소스 저장소와 HA 설정 저장소를 혼동하지 않는다.

### FR-013 Codex 운영 가드레일

- `CODEX_HOME/AGENTS.md`와 `AGENTS.override.md`가 모두 없으면 Home Assistant 운영 안전 지침을 생성한다.
- 기존 전역 지침은 기본 `codex_user_files_update_mode: preserve`에서 빈 파일과 심볼릭 링크를 포함해 내용과 권한을 변경하지 않고 보존한다.
- 지침은 비밀값 비노출, 진단과 변경 권한의 분리, `.storage`/DB 보호, 변경 후 설정 검사, 고위험 동작 승인 규칙을 포함한다.
- `/config`에 사용자가 둔 프로젝트별 `AGENTS.md`는 공식 Codex 계층 규칙에 따라 더 구체적인 지침을 추가할 수 있다.
- 사용자가 `refresh_agents` 또는 `refresh_all`을 명시하면 현재 App version에서 아직 갱신하지 않은 base `AGENTS.md`만 image 기본 지침으로 한 번 교체할 수 있다. `AGENTS.override.md`는 항상 보존되며 더 높은 우선순위에서 계속 적용된다.

### FR-014 Playwright Headless Chromium renderer

- App 이미지에 Microsoft `@playwright/mcp`와 그 lockfile, Alpine `chromium-headless-shell`을 포함하고 버전 입력을 고정한다.
- Codex에는 `/etc/codex/config.toml`의 공식 STDIO MCP server로 노출하며 브라우저 실패가 Codex·웹 터미널·SSH 시작을 막지 않도록 optional server로 구성한다.
- 같은 image-managed system config의 `developer_instructions`와 MCP navigation tool 설명은 Home Assistant dashboard 요청에 `http://127.0.0.1:8099/`와 Playwright MCP를 첫 경로로 지정한다. 일반 업데이트는 기존 사용자 config나 `AGENTS.md`를 덮어쓰지 않으며, 별도의 명시적 사용자 파일 갱신 option만 예외다.
- 브라우저는 headless·isolated context로 실행하고 기본 desktop viewport `1440x900`과 mobile viewport `390x844`를 지원한다.
- 최소 도구 집합은 탐색·snapshot·resize·screenshot·console message와 network request/resource 목록의 URL/status 검사를 제공한다. 민감 header/body를 포함할 수 있는 단일 request 상세 도구는 노출하지 않는다.
- MCP enforcement proxy는 screenshot/console/network 호출의 선택적 `filename`을 거부해 image response와 `/run` output만 허용한다. 사용자가 영속 파일을 명시적으로 요청하면 browser tool 밖의 별도 파일 작업으로 취급한다.
- `browser_run_code_unsafe`, 임의 file upload, code generation처럼 요구사항에 필요하지 않은 고위험 기능은 노출하지 않는다.
- console warning/error와 uncaught page error, 2xx/3xx/4xx/5xx 및 전송 실패 resource를 구분해 보고할 수 있어야 한다.
- `browser_approval_policy`는 `safe`, `never`, `always`만 허용한다. 누락값은 `safe`; safe는 탐색·조회 11개를 자동 승인하고 click/form/key/select/type 5개는 prompt, never는 현재 allowlist 전체 approve, always는 현재 allowlist 전체 prompt로 매핑한다.
- server 기본은 prompt이고 현재 허용 도구 16개만 명시적으로 override해 미래 도구를 fail closed한다. 이 설정은 proxy allowlist나 Home Assistant 권한을 늘리지 않으며 top-level `codex_approval_policy=never`의 전역 자동 승인보다 강한 prompt 경계로 간주하지 않는다.

### FR-015 Home Assistant dashboard loopback gateway

- 인증된 대시보드 렌더링에는 컨테이너 loopback `127.0.0.1:8099` gateway를 사용하고 `config.yaml`의 Ingress·Network port를 추가하지 않는다.
- gateway는 Home Assistant frontend asset, auth, Core REST/WebSocket을 같은 direct Core browser origin으로 결합해 전용 사용자의 permission을 일관되게 적용한다.
- Supervisor token은 renderer에 전달하지 않는다. 기본 `true`인 `home_assistant_browser_auto_auth`는 App init과 새 MCP 시작 시 지원되는 Home Assistant API로 전용 active·local-only·non-admin·sole `system-read-only` user와 long-lived token을 자동 생성 또는 재사용하고 임시 password credential/OAuth refresh token을 제거한다. option이 누락된 기존 설치도 `true`로 해석한다.
- 자동 인증 OFF는 다음 App/MCP browser session부터 runtime token 주입과 자동 생성을 중지하되 `/data`와 Home Assistant의 관리형 identity는 보존한다. ON 재시작은 같은 identity를 재사용한다. 완전 삭제는 OFF로 전환하고 App/browser session을 재시작한 뒤 명시적 `ha-browser-auth-remove`만 수행하며 ON에서는 재생성 경쟁을 막기 위해 삭제를 거부한다. optional App secret의 수동 token은 ON 상태에서만 명시적 override로 유지한다.
- 동적으로 재할당되는 App `/32`와 Docker 대역을 `trusted_networks`/`trusted_proxies`에 추가하지 않고 기존 `homeassistant` auth provider를 그대로 유지한다.
- 관리형 recovery state와 LLAT는 `/data/browser-auth`의 root-only `0700`/`0600` 파일에 원자 저장하고, exact ready state만 `/run`의 `0600` runtime token으로 활성화한다. token은 command argument, URL, MCP 응답, screenshot, console/network artifact 또는 App log에 원문으로 남기지 않는다. Playwright `--secrets` 입력값 치환은 사용하지 않고 관리 proxy가 stdout/stderr exact 문자열만 직접 마스킹한다.
- App init과 각 MCP 시작은 user policy, credential 부재와 exact single LLAT metadata를 재검증한다. token이 없거나 검증·Core/DNS/TLS가 실패하면 일반 Web UI 렌더링 기능은 유지하되 Home Assistant 자동 인증은 하지 않고 login 화면 또는 인증 부재를 결과에 명시한다. gateway HTTPS는 image CA와 `homeassistant` hostname을 검증한다.
- ensure/setup/remove는 kernel lock으로 직렬화하고 self-revoke를 재접속으로 확인한다. 모호한 `local_only` auth rejection이나 transport 실패에서는 영구 복구 자료를 보존하고 runtime만 fail closed한다. `ha-browser-auth-setup`은 자동 ensure 실패의 수동 재시도·진단용이며 OFF에서는 mutation 전에 거부한다.

### FR-016 업데이트와 사용자 Codex 설정 보존

- App이 관리하는 Playwright MCP 기본값은 이미지 계층의 `/etc/codex/config.toml`에 둔다.
- `codex_user_files_update_mode`는 `preserve`, `refresh_agents`, `refresh_all`만 허용하고 누락되거나 기본값이면 `preserve`로 해석한다. 따라서 기존 설치의 `0.2.3` 첫 시작도 사용자 파일을 변경하지 않는다.
- `preserve`에서는 `/data/codex/config.toml`과 전역 지침의 기존 사용자 내용을 일반 App 업데이트 과정에서 수정·병합·초기화하지 않는다. 파일이 없는 신규 설치에는 기존 최초 provisioning 계약에 따라 기본본을 생성한다.
- `refresh_agents`는 base `AGENTS.md`를 image 기본 지침으로, `refresh_all`은 `AGENTS.md`와 `config.toml`을 각각 image 지침/current App option 기반 기본 config로 교체한다. 선택은 target별로 같은 App version에 한 번만 적용되며 같은 version의 재시작에서는 반복하지 않는다. option을 유지하면 다음 App version에서 해당 target을 다시 한 번 갱신한다.
- `config.toml` 갱신은 사용자가 추가한 MCP, model, provider와 기타 Codex 설정을 기본본으로 되돌리는 파괴적 선택이다. 적용 전 기존 target을 `/data/codex/backups/user-files` 아래 root-only backup으로 보존한다.
- `AGENTS.override.md`, Codex 인증·session, SSH identity, browser identity와 Home Assistant `/config`는 어느 갱신 mode에서도 대상이 아니다.
- 갱신 target이 symbolic link, 다중 hardlink 또는 일반 파일이 아니거나 안전한 소유권 검사를 통과하지 못하면 링크를 따라가지 않고 전체 선택 갱신을 fail closed한다.
- 공식 Codex 우선순위에 따라 사용자·신뢰된 프로젝트 config가 system MCP 기본값을 재정의하거나 비활성화할 수 있어야 한다.
- Playwright/Chromium 설치는 image build에서 끝내고 App 시작 시 `npm install`, browser download 또는 `latest` resolution을 수행하지 않는다.

### FR-017 검증형 Home Assistant 메모리 저장소와 bootstrap

- 영속 메모리는 root-only `/data/codex-ha-memory/memory.sqlite3`의 SQLite와 FTS5를 사용한다. 디렉터리는 `0700`, database와 journal 계열 파일은 `0600`으로 유지한다.
- 독립 S6 서비스 `ha-memoryd`가 Core 연결과 refresh를 담당한다. memory service나 Core가 준비되지 않아도 Codex, 웹 터미널, SSH, browser 기능은 계속 시작하며 메모리는 명확한 degraded/stale 상태와 closed token/DNS/transport/timeout/auth/protocol/command/snapshot code를 반환한다. daemon log에는 command 원문이 아니라 allowlist code만 남긴다.
- 최초 성공 실행과 이후 refresh는 고정 Supervisor Core WebSocket proxy와 image-pinned `ws` runtime을 통해 entity/device/area registry, `get_states`, automation config와 related 결과만 수집한다. automation graph는 공식 계약대로 `search/related`의 `item_type=automation`, `item_id=<automation entity_id>`로 요청하며 의미가 다른 `item_type=entity` 응답을 대체 graph로 합치지 않는다. `HA_WS_URL` 환경 override, Upgrade credential header나 direct-Core credential fallback을 제공하지 않는다. 공식 command의 지원 여부와 응답 오류를 검사하고 임의 WebSocket command나 `.storage` 직접 읽기로 우회하지 않는다.
- entity/device/area의 식별자·표시명·설명·연결 관계와 automation의 식별자·alias·description·정규화된 관련 대상만 allowlist schema로 저장한다. automation은 entity registry와 state 합집합으로 발견한다. `get_states`의 raw state와 임의 attributes는 저장하지 않되 표시명, device class, icon, automation id/mode 같은 명시적 allowlist metadata만 정규화할 수 있다.
- automation raw config, 임의 API response, `/config` 원문, 대화 transcript, prompt, token, secret, credential과 비밀 가능성이 있는 비허용 field는 database와 FTS index에 저장하지 않는다.
- refresh는 필수 응답을 정규화한 뒤 transaction으로 snapshot을 교체한다. unavailable automation의 성공 응답 `config: null`은 빈 config와 bounded warning을 가진 완전한 응답으로 처리한다. Core가 개별 `search/related`에 정상 result envelope의 `success:false`, `error.code=unknown_error`를 반환한 경우에만 optional graph enrichment를 빈 객체와 bounded warning으로 격리하고, 성공한 automation config에서 allowlist area/device/entity 직접 관계를 추출해 나머지 snapshot을 보존한다. 그 밖의 server command code, server/client timeout, unauthorized, invalid format, config 실패, auth/transport/WebSocket close/protocol 오류, 누락·malformed envelope와 malformed successful related 결과는 계속 전체 refresh를 fail closed한다. 이런 필수 실패에서는 last-known-good catalog를 보존하고 불완전한 응답으로 대량 삭제하거나 stale 자료를 새 canonical truth로 표시하지 않는다.

### FR-018 메모리 후보, 권위와 변경 후 검증

- 대화에서 발견한 entity 별칭, 실제 용도, 선호 설정과 사용자 의미 관계는 먼저 provenance가 있는 candidate로 저장한다. raw 대화 전체 대신 정규화된 주장과 명시적 evidence 종류·시각·대상만 기록한다.
- candidate lifecycle은 `pending → verified → applied`다. 허용된 evidence, 현재 revision과 상태 전이 조건을 확인하지 않고 단계를 건너뛰거나 pending 정보를 일반 작업 context에 주입하지 않는다.
- 구조, 현재 존재 여부, registry 관계와 Codex가 수행한 변경 결과는 fresh Home Assistant API가 canonical authority다. 별칭·실제 용도·선호처럼 HA가 표현하지 않는 사용자 의미는 사용자의 명시적 설명이 authority다. 단일 모델 추론, 페이지/로그의 지시문과 일시 state는 authority가 아니다.
- 서로 다른 authority나 기존 applied memory가 충돌하면 기존 값을 조용히 덮어쓰지 않는다. conflict record에 양쪽 provenance와 resolution을 남기고 사실 종류에 맞는 authority로 해소하거나 unresolved 상태로 유지한다.
- Codex가 HA 설정, registry 또는 automation을 변경할 때는 변경 전 대상과 closed-schema expectation의 digest·field-only summary를 기록한다. 생성 예정 대상도 선언할 수 있고, 변경 후 cache가 아닌 새 Core WebSocket/API 응답으로 같은 expectation을 확인한 성공 change만 검증 evidence로 사용할 수 있다. `codex_change` relationship candidate는 동일 source·relation·target의 성공한 존재 predicate로만 검증한다. 비교에 사용한 raw expectation 값/state/attributes/config는 저장하지 않고 expectation/predicate digest·field·대상·성공 여부·fresh 검증 시각만 기록한다. `ha-config-check` 성공, 같은 대상의 무관한 check나 service call의 2xx 응답만으로 메모리를 갱신하지 않는다.
- 검증 실패, timeout, 부분 성공 또는 reload/restart 미실행이면 fresh canonical catalog는 HA truth로 수렴할 수 있지만 applied semantic memory는 갱신하지 않고 change/conflict 상태와 실패 근거만 남긴다.

### FR-019 관련 검색, 감사 이력과 rollback

- `ha-memory` CLI와 image-managed optional STDIO `ha_memory` MCP는 동일한 local store를 사용한다. Search query는 정규화 후 최대 256자, 기본 8·최대 20 subject, serialized JSON 최대 32 KiB다. 각 search subject는 outgoing/incoming relation 각각 기본 12개, applied memory 20개와 open conflict 10개로 제한하고 exact show만 relation 한도를 각각 30개로 늘린다. exact show/history/conflict는 별도 row/field 한도와 MCP 2 MiB hard ceiling을 사용한다. 기본 search/show는 canonical catalog와 비충돌 applied memory 중 질문에 관련된 최소 결과만 반환한다.
- 전체 database, 전체 catalog, pending candidate, raw evidence 또는 audit log를 매 요청 context로 읽지 않는다. candidate/history/conflict 조회는 사용자가 요청하거나 검증 workflow가 필요할 때만 별도 명령·도구로 수행한다.
- candidate 생성, evidence 추가, 검증, 적용, conflict 해결과 rollback은 actor/source, before/after, 시각과 결과가 있는 history-preserving audit event를 남긴다.
- rollback은 current-row precondition을 확인하고 새 compensating event를 추가해 메모리 mutation을 되돌린다. 감사 이력을 삭제하지 않고 원 event에는 rollback linkage만 기록하며 HA-derived catalog를 과거 snapshot으로 rollback하지 않는다. HA catalog는 fresh refresh로만 교정한다.
- 기본 `AGENTS.md`에는 메모리 사용·검색·검증 규칙과 helper 위치만 기록하고 entity별 데이터는 넣지 않는다. 기존 설치의 base `AGENTS.md`가 기본 `preserve`로 유지되므로 `/etc/codex/config.toml`의 image-managed MCP와 developer instruction에도 bounded search와 검증 규칙을 함께 제공한다.

## 5. 비기능 요구사항

### NFR-001 재현성

Codex CLI, base image, `@playwright/mcp` lockfile, Playwright core와 Chromium을 포함한 주요 패키지는 버전 또는 digest로 추적 가능해야 한다. Memory SQLite v1 schema version gating과 FTS5 가용성도 image build·contract test에서 추적한다. 지원 migration이 없는 schema는 자동 변경하지 않는다.

### NFR-002 복구 가능성

App 재설치 전까지 `/data`의 Codex 인증, 사용자 Codex 설정, SSH host key, 관리형 browser identity recovery state와 검증형 HA 메모리가 유지된다. 사용자가 명시적으로 user-file refresh를 선택한 경우에는 기존 config/지침을 root-only backup으로 남기고 target별 version 적용 기록으로 재시작 반복을 막는다. browser context와 screenshot/output은 enforcement proxy가 `/run`의 일시 데이터로 제한하며 App 업데이트에 필요한 영속 상태로 취급하지 않는다. 메모리 mutation은 history-preserving audit와 compensating rollback으로 복구하고 HA catalog는 과거 cache 복원이 아니라 fresh API refresh로 수렴시킨다. 설정 변경은 Git checkpoint 및 Home Assistant 설정 검사 절차를 권장한다.

### NFR-003 보안 기본값

- Ingress 관리자 전용
- SSH 공개키 전용
- 기본 AppArmor 활성
- `manager` 역할
- Docker/host privileged 권한 없음
- Playwright MCP는 STDIO, Home Assistant gateway는 loopback 전용이며 새 host/Ingress port 없음
- Chromium `--no-sandbox`는 기존 App 컨테이너 경계 안에서만 허용하며 이를 위해 App privilege를 추가하지 않음
- 기본 `preserve`에서 기존 사용자 지침을 덮어쓰지 않고, 명시적 refresh에서도 override/프로젝트 지침은 제외하는 영속 Codex 운영 가드레일. 이 파일은 방어 심층화 지침이며 권한 강제 경계는 아니다.
- HA 메모리는 root-only SQLite와 container-local STDIO MCP/CLI로만 접근하고 새 host/Ingress port, 외부 vector service 또는 cloud sync를 만들지 않음

### NFR-004 관찰 가능성

App 시작 로그는 Codex readiness와 loopback gateway 구성을 토큰 없이 기록한다. Playwright/Chromium 버전은 image build·smoke 증거로 남기고, MCP 렌더 결과는 viewport, screenshot 증거, console severity와 resource URL/status를 포함하되 인증 header와 token 원문을 출력하지 않는다. 메모리는 schema version, daemon readiness, 마지막 성공 refresh 시각, stale/degraded 상태, row 개수와 bounded warning 개수만 정제해 보고하고 저장 값·대화·evidence·warning 대상 ID 원문은 App log에 출력하지 않는다.

### NFR-005 플랫폼

- M1: amd64만 실제 지원 표시
- M3: aarch64 검증 후 추가
- Alpine system Chromium 조합은 Playwright upstream의 공식 Linux 배포 대상이 아니므로 로컬 amd64 container 검증과 별개로 실제 HAOS/AppArmor 검증 전에는 지원 완료로 표시하지 않음

### NFR-006 메모리 무결성과 제한된 context

- v1 schema initialization/version gating, snapshot refresh와 memory mutation은 transaction, foreign key, 허용 enum과 application current-row/status precondition을 사용한다.
- 검색은 FTS5와 exact identifier/alias lookup을 사용한다. 일반 search는 결과 row 수와 직렬화 크기를 함께 제한하고 다른 read 명령은 별도 row/field 한도와 MCP hard ceiling을 사용한다.
- database 손상, unsafe file type/link/ownership, lock 충돌이나 schema 불일치는 자동 재생성·덮어쓰기 대신 fail closed/degraded로 보고한다.
- 자동 fixture 검증과 실제 HAOS Core WebSocket·App update E2E 증거를 구분한다.

## 6. 비목표

MVP에서는 다음을 만들지 않는다.

- 별도 GUI 관리 콘솔
- Codex 대화 기록 전용 웹 앱
- raw Codex 대화 transcript 또는 prompt archive
- Recorder 대체, entity state/attributes의 시계열 저장소 또는 장기 통계 database
- memory rollback을 이용한 Home Assistant 설정·registry·기기 상태 자동 되돌리기
- 외부 vector database, cloud embedding 또는 메모리 동기화 서비스
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
2. `codex debug prompt-input` 또는 동등한 공식 진단에서 기존 사용자 `AGENTS.md`를 보존한 채 image-managed developer instruction이 Home Assistant dashboard의 첫 browser 경로를 `http://127.0.0.1:8099/`로 지정하고, `browser_navigate` 도구 설명에도 같은 경로가 보인다.
3. 로컬 fixture Web UI를 `1440x900`과 `390x844`로 렌더링하고 두 PNG screenshot과 viewport별 DOM snapshot을 만든다.
4. 의도한 console/page error와 2xx, 3xx, 4xx/5xx, 전송 실패 resource를 MCP 도구로 구분한다.
5. browser, MCP response, process argument, App log와 output artifact 어디에도 fixture Supervisor token과 dedicated browser token 원문이 없다.
6. 새 host port, Ingress port, `host_network`, Docker API, `full_access`, 추가 privilege 없이 동작한다.
7. 기존 설치를 삭제하거나 `/data`를 reset하지 않은 일반 App 업데이트 뒤 Codex 인증·사용자 config·SSH host identity와 Playwright system MCP가 함께 동작한다.
8. 실제 HAOS amd64에서 Chromium이 기본 AppArmor 아래 시작되고 loopback gateway로 인증된 Home Assistant dashboard를 desktop/mobile 양쪽에서 렌더링한다.

8번은 HAOS 전용이며 로컬 Docker 성공으로 대체하지 않는다. Public `0.2.3`의 실제 HAOS에서 기본 AppArmor를 유지한 dashboard desktop/mobile 경로가 동작했다고 사용자가 확인해 **PASS**로 기록한다. 원본 진단 자료가 저장소에 포함된 자동 증거라는 뜻은 아니며 Chromium·Playwright package revision이 바뀌면 다시 검증한다.

## 9. 검증형 HA 메모리 수용 기준

기존 MVP와 browser 수용 결과와 별도로 다음을 모두 충족해야 메모리 기능을 완료로 판정한다.

1. 첫 성공 bootstrap이 `/data/codex-ha-memory` `0700`, `memory.sqlite3`와 SQLite journal 계열 파일 `0600`을 만들고 App 재시작·일반 업데이트 뒤 schema와 applied memory를 보존한다.
2. fixture가 entity/device/area registry, `get_states`, `automation/config`, `search/related` allowlist를 통과해 정규화된 catalog와 관계를 만들며 raw state, 비허용 attributes, automation config, API response, 대화와 fixture secret은 database·FTS·로그 어디에도 남지 않는다.
3. 동일 snapshot의 반복 refresh가 중복을 만들지 않는다. 개별 automation-related의 관측된 `unknown_error`만 config-derived 관계와 bounded warning으로 격리하며, 다른 command code·config·transport·timeout·protocol·malformed 응답 실패에서는 last-known-good catalog를 유지하고 stale/degraded 상태를 표시한다.
4. 별칭·용도·선호·관계 candidate가 `pending → verified → applied`를 순서대로 거치며 추론이나 일시 state만으로 승격되지 않는다.
5. HA canonical fact와 사용자 semantic fact의 authority가 사실 종류별로 적용되고 충돌은 provenance와 resolution이 있는 conflict record로 확인된다.
6. 변경 전 저장한 expectation digest와 변경 후 같은 계약의 fresh API response가 일치할 때만 change가 memory evidence가 되며 실패·timeout·부분 성공에서는 applied semantic memory가 바뀌지 않는다.
7. CLI와 MCP search가 관련 applied/canonical 결과만 정해진 row/32 KiB 한도 안에서 반환하고 exact show/history/conflict도 별도 한도 안에서 전체 database, pending 후보, raw evidence를 기본 context에 포함하지 않는다.
8. 모든 memory mutation의 audit history가 조회되고 current-row precondition을 지키는 compensating rollback이 동작한다. rollback 뒤에도 원래 event와 linkage가 남고 HA catalog와 실제 HA는 변경되지 않는다.
9. `ha-memoryd` 또는 Core WebSocket 실패가 Codex, Web UI, SSH와 browser 시작을 막지 않으며 catalog의 `degraded`/`stale` 상태 또는 memory tool unavailable 오류를 구분한다.
10. 기존 사용자 `AGENTS.md`와 `/data/codex/config.toml`을 보존한 일반 업데이트에서도 image-managed `ha_memory` MCP와 developer instruction이 bounded retrieval·검증 경로를 제공한다.
11. 1~10의 fixture·contract 검증과 별도로 실제 HAOS amd64에서 첫 bootstrap, Core restart 후 refresh, App restart/update 영속성, semantic candidate 적용, bounded retrieval과 non-fatal degradation을 확인한다. 이 E2E는 로컬 Node/SQLite 테스트로 대체하지 않는다.
