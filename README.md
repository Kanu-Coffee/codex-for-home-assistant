<p align="center">
  <img src="codex_home_assistant/logo.png" alt="Codex for Home Assistant logo" width="180">
</p>

# Codex for Home Assistant

Home Assistant OS 안에서 OpenAI Codex CLI를 운영하기 위한 amd64 Home Assistant App MVP입니다.

> 비공식 커뮤니티 프로젝트이며 OpenAI 또는 Home Assistant/Nabu Casa와 제휴하거나 이들의 보증을 받는 제품이 아닙니다.

- Home Assistant Ingress 웹 터미널: nginx ACL → ttyd → 공유 tmux 세션
- 공개키 전용 OpenSSH, desktop SSH 프로젝트와 mobile Remote 연결 기반
- Home Assistant `/config` 전체 read-write
- Home Assistant Core REST/WebSocket 접근
- Supervisor API `manager` 운영 helper
- Playwright MCP 기반 격리형 Headless Chromium UI 렌더링·진단
- `0.3.0+`: 검증된 HA 구조 인덱스와 대화에서 배운 의미 정보를 `/data`에 보존하는 bounded memory
- Codex 인증, 설정, SSH host key의 `/data` 영속화
- 기본적으로 사용자 파일을 보존하고 구성에서 선택할 때만 현재 App 기본본으로 갱신하는 전역 Home Assistant 운영 가드레일

현재 공개 사전 릴리스는 [`0.3.1`](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.3.1)이며 정확한 공개 이미지 자동 회귀는 PASS했습니다. 그러나 후속 실제 HAOS/Core `2026.7.2` 실기에서 automation-related 30건 중 2건의 `unknown_error` 때문에 catalog bootstrap은 **FAIL**했습니다. 설치 무결성·Core 연결·daemon/DB·privacy는 PASS, Core restart는 재연결 PASS와 fresh catalog 복구 FAIL을 합쳐 PARTIAL입니다. 이 저장소의 `0.3.2` 후보는 해당 실패를 격리하고 전체 로컬 이미지 회귀를 통과했지만 아직 공개 image/실제 HAOS 재시험 전입니다. `stage: experimental`, amd64 전용이며 Supervisor `admin`, Docker API, App `full_access`, host network는 사용하지 않습니다.

> 이 App은 `/config`의 비밀과 `SUPERVISOR_TOKEN`을 사용할 수 있는 강한 관리자 도구입니다. 신뢰하는 관리자만 사용하고 TCP 2223을 인터넷으로 직접 port-forward하지 마세요.

## Home Assistant에서 설치

이 저장소는 Home Assistant App Store에 추가할 수 있는 public App 저장소입니다.

```text
https://github.com/Kanu-Coffee/codex-for-home-assistant
```

[![Open your Home Assistant instance and add this App repository.](https://my.home-assistant.io/badges/supervisor_store.svg)](https://my.home-assistant.io/redirect/supervisor_store/?repository_url=https%3A%2F%2Fgithub.com%2FKanu-Coffee%2Fcodex-for-home-assistant)

1. Home Assistant에서 **설정 → Apps → App store**를 엽니다.
2. 우측 상단 메뉴의 **Repositories**에 위 URL을 추가합니다.
3. 목록을 새로고침한 뒤 **Codex for Home Assistant**를 선택해 설치합니다.
4. 공개키와 Network 포트를 설정하고 App을 시작합니다.

Supervisor는 public generic manifest `ghcr.io/kanu-coffee/codex-for-home-assistant:0.3.1`을 내려받습니다. 이 tag는 공식 Home Assistant builder action으로 게시됐으므로 App Store 설치 중 소스 컴파일을 요구하지 않습니다. 실제 HAOS 기능 결과는 `progress.md`의 M2 항목별 증거를 기준으로 합니다.

기존 App은 삭제하지 말고 일반 업데이트하세요. 브라우저 MCP는 image-owned system config로 제공되므로 `/data` 초기화나 MCP 재등록이 필요하지 않습니다. Public `0.2.2`에서 `0.2.3`으로 업데이트하는 첫 시작은 새 `codex_user_files_update_mode`가 없으므로 기본 `preserve`로 동작해 기존 user config/지침을 바꾸지 않습니다. 업데이트가 끝난 뒤 실행 중이던 Codex는 종료하고 새 세션을 시작해야 새 system config를 읽습니다.

`0.2.3`에서는 Home Assistant App **구성**에서 현재 App 기본 사용자 파일을 선택적으로 받을 수 있습니다. `preserve`(기본)는 기존 파일을 그대로 두고, `refresh_agents`는 base `AGENTS.md`만, `refresh_all`은 base `AGENTS.md`와 user `config.toml`을 현재 App version에서 target별 한 번 reset합니다. config는 현재 approval/sandbox option을 반영한 App 기본본으로 생성됩니다. mode를 계속 두면 다음 App version에서도 한 번 다시 적용되므로 일회성 사용 뒤에는 `preserve`로 되돌리세요. `refresh_all`은 사용자 MCP/model/provider 설정을 제거할 수 있습니다. 갱신 전 원본은 `/data/codex/backups/user-files`의 root-only backup에 보관하며 `AGENTS.override.md`, 인증/session, SSH/browser identity와 Home Assistant `/config`는 건드리지 않습니다. symlink, 다중 hardlink와 비정상 file target은 따라가지 않고 거부합니다. 자세한 주의와 복구 절차는 [App 사용 설명서](codex_home_assistant/DOCS.md)를 따르세요.

향후 `0.3.2`로 App version이 바뀌면 `refresh_agents` 또는 `refresh_all`을 계속 선택한 설치는 선택 target을 `0.3.2`에서 한 번 다시 갱신합니다. 재적용을 원하지 않으면 **업데이트 전** App **구성**에서 `preserve`로 저장하세요.

설치, Codex device login, Windows SSH config, Remote SSH, API helper, 안전한 서비스 호출과 복구 절차는 [App 사용 설명서](codex_home_assistant/DOCS.md)를 따르세요.

## 검증 기반 Home Assistant 메모리

`0.3.0`부터 `/data/codex-ha-memory/memory.sqlite3`에 영역·장치·엔티티·자동화와 연결 관계의 정규화된 인덱스를 보존합니다. 별도 `ha-memoryd`가 Core WebSocket API에서 주기적으로 새 snapshot을 만들며, Core가 준비되지 않았거나 메모리 자체가 실패해도 Web UI, SSH, Codex와 browser 시작을 막지 않습니다. 정상 설치에서는 새 Codex 세션의 image-managed `ha_memory` MCP가 매 Home Assistant 요청에 질문과 관련된 작은 결과만 찾으므로 사용자가 DB 전체를 prompt에 넣거나 MCP를 수동 등록할 필요가 없습니다.

대화에서 배운 별칭·용도·선호·관계·note는 즉시 사실이 되지 않습니다. `pending candidate → verified → applied`를 각각 거치며, HA registry 구조는 fresh Core API가, HA 밖의 실제 용도와 선호는 사용자의 명시적 설명이 가장 높은 권위입니다. 단일 모델 추론이나 한 번의 관찰은 그대로 적용되지 않고, 같거나 더 강한 기존 근거와 다르면 conflict로 남습니다.

현재/과거 state 값과 timestamp, raw automation action/template, raw 대화, API 응답과 credential은 저장하지 않습니다. 변경 전 expectation은 값 대신 digest와 field summary를 먼저 기록하고, 변경 후 fresh state를 메모리 안에서 비교한 뒤 SQLite에는 predicate digest, 검사한 field 이름과 일치 여부만 더 남깁니다. `codex_change` 관계 후보는 동일 source·relation·target의 성공 predicate로만 검증되며, `ha-memory rollback`도 semantic memory event를 보상할 뿐 실제 HA catalog, 설정이나 기기 state를 되돌리지 않습니다.

관리자용 확인 명령은 다음과 같습니다. 모든 search는 query 256자, 기본 8·최대 20 subject와 응답 32 KiB로 제한됩니다.

```bash
ha-memory status
ha-memory search "주방 조명"
ha-memory show entity:light.kitchen_main
ha-memory conflicts --status open
ha-memory history --subject entity:light.kitchen_main
```

후보 검증·적용, 변경 전후 기록과 rollback 절차는 [App 사용 설명서의 검증 기반 메모리 절](codex_home_assistant/DOCS.md#검증-기반-home-assistant-메모리)을 따르세요. `status`가 `empty`, `degraded` 또는 `stale`이면 last-known-good와 최근 실패 상태를 먼저 확인하고 DB를 삭제해 재생성하지 마세요.

`0.3.1`에서는 unavailable automation이 Core에서 `config: null`을 반환해도 entity와 related graph를 유지합니다. `0.3.2` 후보는 공식 `item_type=automation` 요청을 그대로 사용하면서 개별 related가 정상 result envelope에서 실기와 같은 `error.code=unknown_error`를 반환한 경우만 빈 enrichment와 최대 100개 warning으로 격리하고, 성공 config에서 직접 area/device/entity 관계를 유지합니다. Server/client timeout, unauthorized, invalid format, auth/transport/WebSocket close/protocol, malformed envelope/result와 config 실패는 계속 전체 snapshot을 fail closed합니다. daemon log에는 원격 응답이나 token 대신 allowlist code만 남고, memory endpoint는 고정 Supervisor proxy라 `HA_WS_URL` 환경변수로 변경할 수 없습니다.

## HACS 지원 여부

HACS가 지원하는 저장소 유형에는 Home Assistant App(구 Add-on)이 없으므로 이 저장소를 HACS custom/default repository로 등록할 수 없습니다. Integration이나 Dashboard로 잘못 등록해도 App 설치로 연결되지 않습니다. [HACS 공식 repository types](https://hacs.xyz/docs/use/repositories/type/) 대신 위 Home Assistant App repository 버튼이나 URL을 사용하세요.

## 실제 브라우저로 웹 UI 확인

`0.2.0` 이상 image에는 `@playwright/mcp`와 Alpine의 `chromium-headless-shell`이 포함됩니다. App의 `/etc/codex/config.toml`이 `playwright` MCP server를 system layer에 등록하며, `0.2.3`부터 같은 image-managed system layer와 `browser_navigate` 도구 설명이 Home Assistant 요청에는 `http://127.0.0.1:8099/`를 바로 사용하도록 Codex에 알려 줍니다. 따라서 별도 Vercel/범용 browser skill 탐색이나 MCP 재등록이 필요하지 않습니다. 업데이트 뒤 실행 중이던 Codex를 종료하고 새 세션을 시작하세요. 기본 `preserve`에서는 `/data/codex/config.toml`과 사용자 `AGENTS.md`도 그대로 보존됩니다.

Codex에 다음 URL 중 하나와 확인 항목을 자연어로 요청합니다.

| 대상 | 브라우저에서 여는 URL |
| --- | --- |
| App 컨테이너에서 실행한 개발 서버 | 서버가 출력한 정확한 주소. 예: `http://127.0.0.1:3000` |
| Home Assistant 대시보드 | `http://127.0.0.1:8099` |

`8099`는 Headless Chromium 전용 loopback gateway이며 외부 브라우저나 Ingress에서 여는 주소가 아닙니다. 기본 desktop viewport는 `1440x900`입니다. desktop screenshot과 console error/warning, 정적 리소스를 포함한 network request를 먼저 확인한 다음 `browser_resize`로 `390x844`로 바꾸어 mobile screenshot과 같은 진단을 다시 확인하도록 요청하세요. `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`가 각각 화면, 콘솔, URL·method·status 중심의 로딩 상태를 담당합니다. 민감 정보 노출을 줄이기 위해 상세 request/response header와 body를 반환하는 도구는 제공하지 않습니다. viewport resize는 반응형 layout 검사이며 mobile User-Agent, touch, 실제 기기 성능까지 에뮬레이션하지는 않습니다.

`0.2.3`의 App 설정에는 **헤드리스 브라우저 자동 인증**이 기본 ON으로 제공됩니다. 신규 설치와 옵션 키가 없던 기존 설치 모두 App 시작 시 전용 활성·로컬 전용 `system-read-only` 사용자와 long-lived token을 자동 생성하거나 기존 관리 상태를 재사용하므로 `ha-browser-auth-setup`을 먼저 입력할 필요가 없습니다. 임시 비밀번호 credential과 OAuth refresh token은 자동 제거됩니다. 옵션을 OFF로 바꾸고 App을 재시작하면 다음 browser 세션부터 token 주입이 중지되고 일반 login page가 표시되지만, 관리형 identity는 다시 ON으로 복구할 수 있도록 보존됩니다. 완전히 삭제하려면 OFF로 저장하고 App과 기존 browser 세션을 재시작한 뒤 `ha-browser-auth-remove`를 실행합니다. 기존 마스킹 `home_assistant_browser_token`은 자동 인증이 ON일 때만 우선하는 수동 override로 유지됩니다.

Supervisor/system token은 Chromium에 전달하지 않습니다. App 시작과 각 MCP 시작 시 실제 사용자·credential·유일한 long-lived token을 교차검증하고 조금이라도 다르면 자동 로그인을 끕니다. App의 동적 Docker `/32`나 전체 Docker 대역을 `trusted_networks`/`trusted_proxies`에 추가하지 않고 기존 `homeassistant` provider와 Home Assistant 설정 파일을 변경하지 않습니다. 내부 Core가 HTTPS이면 image CA와 `homeassistant` hostname 검증에 실패할 때 우회하지 않고 fail closed합니다. 상세 절차와 수동 fallback은 [App 사용 설명서](codex_home_assistant/DOCS.md)를 따르세요.

```text
http://127.0.0.1:3000을 열어 1440x900 desktop 화면을 캡처하고,
console error/warning과 정적 파일을 포함한 실패 network request를 확인해 줘.
그다음 390x844로 resize해 mobile 화면을 다시 캡처하고 같은 항목을 비교해 줘.
```

브라우저 context는 세션별로 격리되고 저장하지 않습니다. screenshot 등 파일 결과는 최대 50 MiB의 `/run/codex-ha/playwright-output`에만 두며 임의 `filename` 저장을 거부합니다. App 시작·재시작 때 기존 결과를 삭제하고 `/data`에는 보존하지 않습니다. 검증된 browser token의 exact 문자열은 MCP text output에서 마스킹하지만, 인코딩되거나 분할된 비밀과 대시보드 화면·console·network 결과 전체를 정화하는 기능은 아닙니다. 결과에는 entity, 위치, 내부 URL 등 민감한 정보가 보일 수 있으므로 Git, 이슈, 채팅에 올리기 전에 반드시 검토하세요. read-only user도 모든 entity state를 볼 수 있으며 custom integration의 권한 결함까지 막는 경계는 아니므로 단순 렌더링 요청을 제어 작업 승인으로 간주하지 않습니다.

공개 `0.3.1` amd64 image의 인증 없는 generic/per-arch resolve·pull과 자동 회귀는 **PASS**였습니다. generic/per-arch OCI index digest는 `sha256:6e726ad1ce95714fb4d4f29dcbb51f762cdd3e7b3eeb9c1be7edcbb6ff1c0126`, runtime manifest digest는 `sha256:175c1a2b4d45897f713ab37f71c96b96c9b182e2f74340843c18aa34e7d84954`이며 mutable `latest` tag는 게시하지 않았습니다. 정확한 공개 이미지에서 memory와 실제 installed `ws`, browser/gateway/Core WebSocket/ttyd/SSH, managed-auth, user-file update와 public `0.3.0` → `0.3.1` update smoke를 확인했고 동일 merge SHA의 [main CI 29391446446](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29391446446)과 [Builder 29391579529](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29391579529)이 PASS했습니다. 별도 실제 HAOS `0.3.1` 실기에서는 Core 연결과 privacy가 PASS했지만 catalog/LKG/실제 CLI·MCP 조회가 related `unknown_error` 때문에 **FAIL**, Core restart는 **PARTIAL**, null-config는 **NOT OBSERVED**, candidate/change/App restart/update는 **NOT RUN**입니다. 기존 `0.2.3` browser/AppArmor 사용자 확인 PASS와 이 memory 실패를 혼합하지 않습니다.

## 로컬 빌드

```bash
docker build \
  --platform linux/amd64 \
  --build-arg BUILD_ARCH=amd64 \
  --tag codex-for-home-assistant:test \
  codex_home_assistant
```

Docker가 있는 Linux 개발 환경에서는 전체 컨테이너 smoke test를 실행할 수 있습니다.

```bash
tests/docker-smoke.sh codex-for-home-assistant:test
tests/memory-smoke.sh codex-for-home-assistant:test
```

정적·단위 검사:

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -ra
yamllint -c .yamllint .
shellcheck <scripts...>
npx --yes markdownlint-cli2@0.23.0
```

GitHub Actions는 같은 amd64 build/smoke와 Home Assistant App linter를 실행하고, version과 동일한 Git tag에서만 public GHCR image와 generic manifest를 게시합니다.

## 주요 명령

| 명령 | 기능 |
| --- | --- |
| `ha-codex` | `/config`에서 Codex 실행 |
| `ha-codex-login` | `codex login --device-auth` 실행 |
| `ha-api` | Core REST API proxy 호출 |
| `supervisor-api` | Supervisor API 호출 및 `result` 검사 |
| `ha-config-check` | Home Assistant 설정 검사 |
| `ha-core-logs` | Core 로그 조회 |
| `ha-addon-logs` | 지정 App 로그 조회 |
| `ha-browser-auth-ensure` | App 설정에 따라 dashboard 자동 인증 생성·재사용·비활성화 |
| `ha-browser-auth-setup` | 자동 설정 실패 시 전용 identity를 수동 재시도·진단 |
| `ha-memory status` | 영속 HA memory schema, refresh, conflict 상태 확인 |
| `ha-memory search QUERY` | 검증된 관련 HA 구조와 applied memory만 bounded 검색 |
| `ha-memory show SUBJECT` | 정확한 `kind:id` 한 대상의 canonical/applied context 확인 |
| `ha-browser-auth-remove` | 자동 인증 OFF 상태에서 관리형 dashboard identity 안전 제거 |
| `ha-browser-auth-status` | browser 자동 로그인 검증 상태 조회 |

## 저장소 구조

```text
codex_home_assistant/  Home Assistant App manifest, image, rootfs, docs
tests/                 policy/unit/container smoke tests
.github/workflows/     lint, amd64 build, container smoke CI
AGENTS.md              에이전트 작업 진입점
rules.md               최상위 개발·보안·검증 규칙
progress.md            실제 완료/미검증 상태의 단일 기준
```

문서 우선순위와 전체 설계는 `AGENTS.md`의 읽기 순서를 따릅니다. 구현 상태는 [progress.md](progress.md), 권한과 위험은 [security.md](security.md), 검증 시나리오는 [test_plan.md](test_plan.md)를 기준으로 합니다.

## 검증 경계

로컬 Docker 검증은 image build, Codex 실행, S6 서비스, ttyd/nginx, 동일 tmux pane 재접속·resize, 공개키 sshd, 영속 데이터와 helper 오류 처리를 다룹니다. 실제 HAOS에서는 public 설치·시작, auto-start false/true, device-code 로그인과 재시작 인증 유지, Web UI 재접속·resize, `/config` 쓰기, Core REST 조회·저위험 service call, Supervisor 정보·로그 helper·설정 검사, SSH host identity 유지와 mobile Remote SSH 프로젝트 작업을 확인했습니다. amd64 M1/M2 수용 기준은 PASS입니다.

Supervisor/Core/App start/stop/restart 실동작은 manager API 기능 범위에 포함되지만 운영 중단 위험이 있으므로 명시적인 유지보수 승인 없이 자동 실행하지 않습니다. 첨부된 0.3.1 실기에서는 승인된 Core restart만 수행해 daemon 생존·재연결은 확인했으나 catalog fresh 복구는 실패했고, Supervisor/App lifecycle은 실행하지 않았습니다.

자세한 최신 결과와 명령 증거는 `progress.md`에 기록합니다.

## License

Project source is licensed under Apache License 2.0. Runtime dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
