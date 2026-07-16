# Codex for Home Assistant 사용 설명서

> [!CAUTION]
> `0.4.0` 시점의 상세 운영·검증 기록을 보존한 문서입니다. 현재 설치와 사용 방법은 [`codex_home_assistant/DOCS.md`](../../codex_home_assistant/DOCS.md)를 사용하세요.

---

> 현재 공개 사전 릴리스는 [`0.4.0`](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.4.0)이며 amd64 전용 Home Assistant `stage: experimental`을 유지합니다. 정확한 공개 이미지 자동 회귀는 PASS했습니다. 이전 public `0.3.1`의 실제 HAOS/Core `2026.7.2` 실기에서는 automation-related 30건 중 2건의 `unknown_error`로 catalog가 **FAIL**했지만, public `0.3.2` 재시험에서는 같은 2/30 오류를 격리하고 핵심 memory 경로가 PASS했습니다. 최종 판정은 runtime OCI digest NOT RUN과 restart 중 LKG `stale/degraded` 미관측 때문에 **PARTIAL(FAIL 0)**입니다. `0.4.0`의 실제 HAOS `never` mode는 14개 도구에서 승인 요청 0회로 **PASS (검증 범위)**했고 전체 browser 승인 행렬은 **PARTIAL**입니다. `/config` 전체를 쓰고 Home Assistant Core API와 Supervisor `manager` API를 호출할 수 있는 강한 관리자 도구이므로 인터넷에 SSH 포트를 직접 공개하지 마세요.

## 현재 제공 범위

- 컨테이너 안에 고정된 Codex CLI (`codex-cli 0.144.1`)
- Home Assistant Ingress 기반 웹 터미널 (`ttyd` + 공유 `tmux` 세션)
- 공개키 전용 OpenSSH와 ChatGPT mobile Remote의 HA App 직접 SSH 연결
- Home Assistant 설정 전체를 `/config`에 read-write로 매핑
- Core REST API와 Supervisor `manager` API helper
- Playwright MCP와 격리형 Headless Chromium을 이용한 웹 UI·dashboard 렌더링 진단
- `0.3.0`: Core API로 검증한 HA 구조 인덱스와 출처 기반 semantic memory의 `/data` 영속화
- `/data`에 Codex 인증, 설정, SSH host key 영속화
- 기본적으로 기존 사용자 파일을 보존하고, 구성에서 명시할 때만 현재 App 기본 config/지침을 안전하게 갱신하는 전역 Home Assistant 운영 가드레일

다음 권한은 의도적으로 제공하지 않습니다: Supervisor `admin`, Docker API, Home Assistant App `full_access`, host network, AppArmor 비활성화.

`codex_sandbox_mode: danger-full-access`는 **이 App 컨테이너 안에서의 Codex 정책**입니다. Home Assistant의 `full_access: true`나 HAOS host 권한을 뜻하지 않습니다.

## 설치: public App 저장소

Home Assistant의 공식 [App repository](https://developers.home-assistant.io/docs/apps/repository/) 방식으로 다음 public GitHub URL을 App Store에 추가합니다.

```text
https://github.com/Kanu-Coffee/codex-for-home-assistant
```

`config.yaml`은 public generic manifest `ghcr.io/kanu-coffee/codex-for-home-assistant`를 사용합니다. Supervisor는 App version과 같은 공개 `0.4.0` tag의 미리 빌드된 amd64 이미지를 내려받으므로 설치 장치에서 소스 빌드를 하지 않습니다.

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

기존 App은 App Store 저장소를 새로고침한 뒤 일반 업데이트하고, App 완전 삭제·재설치나 `/data` 초기화를 하지 마세요. Playwright runtime과 `/etc/codex/config.toml`의 system MCP 등록은 image가 제공하므로 사용자 `config.toml`에 server를 다시 등록할 필요가 없습니다. `0.4.0` 업데이트에서 저장된 `browser_approval_policy`가 없으면 `safe`가 적용됩니다. 업데이트 동안 Web UI/tmux와 SSH 연결이 잠시 종료되는 것은 정상입니다. 업데이트 전에 실행 중이던 Codex는 종료하고 App을 재시작한 뒤 새 Codex 세션을 시작해야 새 system config와 도구 목록을 읽습니다. 빈 `/data`의 최초 provisioning 자체를 다시 시험할 때만 별도의 완전 재설치 시험이 필요합니다.

Public `0.2.2`에서 `0.2.3`으로 올리는 첫 시작은 새 option이 아직 저장되어 있지 않아 `codex_user_files_update_mode: preserve`로 동작합니다. 즉, 업데이트 버튼을 누르는 것만으로 기존 `config.toml`이나 `AGENTS.md`가 바뀌지 않습니다. 현재 App 기본본을 선택적으로 받고 싶다면 업데이트가 끝난 뒤 App의 **구성** 탭에서 아래 mode를 선택해 저장하고 App을 재시작하세요. 같은 App version의 같은 target에는 한 번만 적용됩니다.

`0.4.0`으로 App version이 바뀌면 target별 1회 규칙은 다시 적용됩니다. 현재 `refresh_agents` 또는 `refresh_all`을 계속 선택했다면 선택 target이 `0.4.0`에서 한 번 다시 갱신됩니다. 이 재적용을 원하지 않으면 **업데이트 전** App **구성**에서 `codex_user_files_update_mode: preserve`로 저장하세요.

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
| `browser_approval_policy` | `safe` | Playwright MCP 승인 정책 (`safe`, `never`, `always`). |
| `codex_user_files_update_mode` | `preserve` | App version별 user `config.toml`/base `AGENTS.md` 갱신 범위 (`preserve`, `refresh_agents`, `refresh_all`). |
| `log_level` | `info` | ttyd 웹 터미널 로그 수준. `trace`/`debug`에서 상세 로그를 켭니다. |

공개키 설정 예시에서 `AAAA...` 부분을 자신의 **공개키** 한 줄로 교체합니다. 개인키는 절대 붙여 넣지 마세요.

```yaml
authorized_keys:
  - ssh-ed25519 AAAA... windows-pc
web_terminal_auto_start_codex: false
tmux_session_name: codex-ha
codex_approval_policy: on-request
codex_sandbox_mode: danger-full-access
browser_approval_policy: safe
codex_user_files_update_mode: preserve
log_level: info
```

사용자 `config.toml`은 `/data/codex/config.toml`에 처음 한 번 생성되며 기본 `preserve`에서는 이후 덮어쓰지 않습니다. `codex` wrapper는 파일을 수정하지 않은 채 현재 command/sandbox/browser 승인 App 옵션을 모든 CLI/Remote app-server 실행의 CLI config 계층에 적용합니다. `0.2.0`부터 image-owned `/etc/codex/config.toml`은 공식 Codex system config layer에서 `playwright` MCP를 등록합니다. 일반 업데이트는 이 system layer만 교체하므로 `/data` 설정과 인증은 보존되며 수동 MCP 재설정이 필요하지 않습니다. 단, 사용자가 실행 시점에 별도 CLI override를 주면 같은 CLI 계층에서 영향을 줄 수 있습니다. 옵션이나 image를 바꾼 뒤 이미 실행 중인 Codex는 종료하고 새로 시작하세요. 그 밖의 Codex 설정은 사용자 `config.toml`에서 관리합니다.

### 선택형 Codex 사용자 파일 갱신

Home Assistant 웹 업데이트에는 CLI flag를 넣을 수 없으므로, 갱신 범위는 App **구성**의 `codex_user_files_update_mode`로 선택합니다.

| mode | 현재 App version의 동작 |
| --- | --- |
| `preserve` | 기존 `/data/codex/config.toml`과 base `AGENTS.md`를 그대로 둡니다. option이 없던 기존 설치도 이 값으로 해석합니다. |
| `refresh_agents` | 아직 이 version에서 처리하지 않은 `/data/codex/AGENTS.md`만 image 기본 운영 지침으로 한 번 교체합니다. |
| `refresh_all` | 아직 이 version에서 처리하지 않은 `AGENTS.md`를 image 지침으로, `/data/codex/config.toml`을 현재 App option 기반 기본 config로 각각 한 번 교체합니다. |

적용 단위는 target과 App version입니다. 같은 `0.2.3`에서 `refresh_agents`를 적용한 뒤 `refresh_all`로 바꾸면 agents는 다시 쓰지 않고 config만 처리합니다. App을 여러 번 재시작해도 같은 version의 target은 반복해서 덮어쓰지 않습니다. 반대로 mode를 `refresh_agents` 또는 `refresh_all`로 계속 두면 다음 App version에서 해당 target이 한 번 다시 갱신됩니다. 한 번만 받고 싶다면 결과를 확인한 뒤 `preserve`로 되돌려 저장하세요.

`refresh_all`은 **reset**입니다. 새 config에는 현재 `codex_approval_policy`와 `codex_sandbox_mode`, file credential store, startup update-check 기본값만 생성됩니다. 사용자 `config.toml`에 추가한 MCP server, model, provider, 내부 URL, trust와 기타 Codex 설정은 사라질 수 있습니다. 적용 전에 필요한 설정을 별도로 기록하고, 생성된 backup을 확인한 뒤 새 Codex 세션에서 `codex mcp list`와 실제 동작을 다시 검증하세요. Codex `auth.json`과 session은 reset 대상이 아니므로 로그인 자체를 의도적으로 삭제하지는 않습니다.

갱신 직전 원본은 `/data/codex/backups/user-files/refresh-<UTC>-<random>/` 아래에 보관됩니다. transaction directory는 `0700`, backup·candidate·metadata는 `0600`인 root-only 자료입니다. 이전 `config.toml`에 token, MCP credential, provider 정보 또는 내부 endpoint가 포함될 수 있으므로 이 디렉터리와 이를 포함하는 Home Assistant App backup을 비밀번호와 동일하게 취급하고 로그·이슈·채팅에 올리지 마세요. 자동 삭제하지 않으므로 refresh mode를 여러 version 유지하면 backup도 version마다 늘어납니다. 복구가 끝나고 private journal이 없는 것을 확인하기 전에는 transaction을 정리하지 마세요.

갱신 범위는 user `config.toml`과 base `AGENTS.md` 두 파일로 고정됩니다. 다음 자료는 mode와 관계없이 보존합니다.

- `/data/codex/AGENTS.override.md`; 같은 전역 위치에서 base보다 높은 우선순위를 계속 가지므로 refreshed `AGENTS.md`를 가릴 수 있습니다.
- Codex 인증과 session
- SSH host key/authorized keys
- 관리형 Home Assistant browser identity와 token
- App options와 Home Assistant `/config` 전체

선택된 target 중 하나라도 symbolic link, 다중 hardlink, 일반 파일이 아닌 path이거나 안전한 root ownership 검사를 통과하지 못하면 링크를 따라 쓰지 않고 선택한 refresh 전체를 거부합니다. 기존 파일은 유지되며 App 로그의 정제된 오류를 확인하세요. state commit 전 중간 종료는 private journal과 검증된 backup으로 다음 시작에서 rollback합니다. target별 version state가 이미 commit된 뒤 남은 journal은 그 이후의 사용자 편집을 되돌리지 않고 정리합니다. 안전한 recovery가 불가능하면 파일을 추측해 덮어쓰지 않습니다.

### 전역 Home Assistant 운영 지침

Codex 공식 [AGENTS.md 지침 계층](https://developers.openai.com/codex/agent-configuration/agents-md)에 따라 App은 `/data/codex/AGENTS.md`와 `AGENTS.override.md`가 모두 없을 때만 기본 운영 가드레일을 생성합니다. 비밀값 비노출, 진단과 변경 권한 분리, `.storage`/Recorder DB 보호, 변경 후 `ha-config-check`, 고위험 동작 승인 규칙을 새 Codex 세션에 제공합니다.

- 기본 `preserve`에서는 기존 `AGENTS.md`나 `AGENTS.override.md`를 빈 파일·심볼릭 링크를 포함해 덮어쓰거나 mode를 바꾸지 않습니다. 명시적 refresh는 안전한 일반 파일인 base `AGENTS.md`만 대상으로 하며 override는 항상 보존합니다.
- 기본 파일을 비활성화하려면 삭제 대신 빈 `/data/codex/AGENTS.md`를 두면 init이 보존하고 Codex는 빈 지침을 건너뜁니다.
- 한 번 생성된 파일은 사용자 소유 설정으로 취급되어 기본 `preserve`에서는 다음 App 업데이트의 템플릿 변경을 자동 병합하지 않습니다. 수동 비교 후 필요한 문장만 반영하거나, 의도적으로 전체 base를 reset하려면 `refresh_agents`를 사용하세요.
- `/config` 아래에 둔 프로젝트/디렉터리별 지침은 더 나중에 적용되어 전역 지침보다 우선할 수 있습니다.
- AGENTS 계열 파일은 규칙과 helper 위치만 담는 곳입니다. Entity별 별칭·용도·선호·관계·candidate나 catalog 값을 누적하지 말고 검증형 SQLite memory workflow를 사용하세요.
- 이 파일은 방어 심층화 지침이지 강제 보안 경계가 아닙니다. App 옵션의 approval/sandbox, App 권한 경계와 사람의 검토를 계속 사용해야 합니다.
- App 업데이트 뒤 이미 실행 중인 Codex에는 소급 적용되지 않으므로 새 Codex 세션을 시작하세요.

## 검증 기반 Home Assistant 메모리

`0.3.0`부터 image-owned `/etc/codex/config.toml`은 optional STDIO `ha_memory` MCP를 등록합니다. 새 Codex 세션은 Home Assistant 요청마다 현재 질문, 사용자가 이름 붙인 대상, 작은 result limit만으로 `memory_search`를 먼저 호출하도록 안내받습니다. MCP가 시작되지 않아도 App과 Codex 자체는 계속 사용할 수 있으며, 이때는 bounded `ha-memory search` CLI를 사용하거나 memory context가 없었다고 보고합니다. `/data/codex-ha-memory/memory.sqlite3`를 직접 열어 전체 table을 prompt에 넣지 마세요.

### 저장하는 것과 저장하지 않는 것

첫 성공 refresh는 Core WebSocket의 area/device/entity registry, `get_states`, `automation/config`, 공식 `search/related(item_type=automation, item_id=<automation entity_id>)`를 결합합니다. Automation은 entity registry와 state의 합집합으로 발견하며 state가 없는 disabled registry automation은 제한된 registry metadata로도 index합니다. Core가 unavailable automation에 성공 응답으로 `config: null`을 주면 빈 config와 bounded warning으로 수용합니다. 개별 related 요청의 정상 result envelope가 실기와 같은 `success:false`, `error.code=unknown_error`인 경우 해당 enrichment만 빈 객체와 최대 100개 warning으로 격리하고 성공 config에서 직접 area/device/entity 관계를 추출합니다. 의미가 다른 `item_type=entity` 결과를 automation graph로 합치지 않습니다. 다른 server command code, server/client timeout, unauthorized, invalid format, config 실패, auth/transport/WebSocket close/protocol, 누락·malformed envelope와 malformed successful related 결과는 partial snapshot으로 commit하지 않습니다. 다음 allowlist만 보존합니다.

- area ID, 표시명, alias, floor/icon/label
- device ID, 사용자 표시명, area, manufacturer/model, disabled/label
- entity ID, 표시명/alias, device/area 연결, platform, 제한된 category/class/icon/label
- automation ID, alias, description, mode와 정규화된 area/device/entity 참조 관계
- applied semantic memory의 값, 출처, 검증 방법과 시간, 충돌·감사 event

현재 또는 과거 state 값, `last_changed`/`last_updated`/`last_triggered`, 비허용 state attribute, automation trigger/condition/action/template 본문, registry unique ID/connections, 전체 API 응답, raw 대화·로그·웹 페이지, token/password/header는 보존하지 않습니다. `get_states`에서 표시명, device class, icon, automation id/mode 같은 명시적 allowlist metadata만 정규화할 수 있습니다. 변경 후 state 검증은 fresh response를 메모리에서 비교하지만 DB에는 expectation/predicate digest, `subject`, 검사 field와 `matched` boolean만 기록합니다. API 실패 때도 응답 body나 credential을 error/audit에 복사하지 않습니다.

저장소 directory는 root-owned `0700`, database/WAL/SHM은 `0600`입니다. 시작 전 regular file, ownership, symlink/hardlink와 schema/integrity를 확인하고 위험하면 기존 자료를 자동 삭제하지 않은 채 memory만 fail closed합니다. App을 일반 업데이트하거나 재시작해도 `/data`의 catalog, applied memory, conflict와 audit은 유지됩니다.

### 초기 인덱스와 검색

main init은 네트워크 없이 DB path와 v1 schema만 검증합니다. Unsafe link/file/schema는 따라가거나 자동 교체하지 않고 memory만 비활성화하므로 다른 App service 시작은 계속됩니다. 독립 S6 `ha-memoryd`가 Core 준비 전에는 정제된 경고와 exponential retry를 사용하고, 성공 뒤 정기 refresh합니다. 실패한 refresh는 진행 중 snapshot을 활성화하지 않고 마지막 성공 catalog를 그대로 보존합니다.

```bash
ha-memory status
ha-memory refresh --force
ha-memory search "주방 움직임 조명" --limit 8
ha-memory search "조명" --subject entity:light.kitchen_main --limit 4
ha-memory show automation:automation.kitchen_motion_lights
```

`search` query는 최대 256자이고 기본 8·최대 20 subject, serialized JSON 32 KiB입니다. 결과 subject마다 applied memory 20개, outgoing/incoming relation 각각 12개, open conflict 10개까지만 포함합니다. `show`도 정확한 한 subject만 반환하며 relation만 방향별 30개로 늘리고, show/history/conflict는 별도 row/field 한도와 MCP 2 MiB hard ceiling을 사용합니다. Pending candidate, 전체 evidence, 전체 conflict/audit은 일반 search/show에 포함되지 않습니다.

`status`의 의미는 다음과 같습니다.

| 상태 | 의미 |
| --- | --- |
| `empty` | local schema만 있고 성공한 Core bootstrap이 아직 없습니다. |
| `ready` | 마지막 refresh가 성공했고 active catalog가 있습니다. |
| `degraded` | 첫 성공 snapshot 전에 Core/validation 실패가 있었습니다. |
| `stale` | 이전 성공 snapshot은 보존됐지만 가장 최근 refresh가 실패했습니다. |

Codex는 `empty`·`degraded`·`stale`을 단순한 검색 결과 0건과 구분해 사용자에게 첫 학습 진행 중 또는 일시적인 memory 불가 상태로 알려야 합니다. DB를 직접 읽거나 삭제해 이를 우회하지 마세요.

`last_sync.error_code`와 실패한 CLI JSON의 `reason`은 다음 closed code만 사용합니다: `ha_token_unavailable`, `ha_ws_runtime_unavailable`, `ha_dns_failed`, `ha_transport_failed`, `ha_timeout`, `ha_auth_rejected`, `ha_protocol_error`, `ha_ws_closed`, 고정 command별 `ha_command_*_failed`, `ha_command_failed`, `ha_snapshot_incomplete`, fallback `ha_unavailable`. `ha-memoryd`는 captured CLI 원문·remote message를 log하지 않고 이 allowlist reason만 기록하며 알 수 없는 값은 `ha_unavailable`로 축약합니다. 따라서 App log와 status의 code를 먼저 확인하고 DB를 삭제하거나 token을 출력해 진단하지 마세요.

### Candidate → verified → applied

사용자가 한 exact subject의 비민감하고 지속적인 별칭, 실제 용도, 선호, note 또는 HA schema 밖 관계를 명확히 설명하면 새 Codex 세션은 `memory_remember_explicit` MCP를 같은 요청에서 호출하고 applied/already-known/conflict 결과를 짧게 알려야 합니다. Optional MCP가 unavailable이면 같은 필드의 bounded `ha-memory remember` CLI를 사용합니다. 대상이나 의미가 모호하면 candidate를 쓰지 않고 한 번 확인합니다. 현재 state, “지금/오늘” 같은 일시 정보와 “probably/아마” 같은 불확실성, 페이지·로그 내용, observation과 모델 inference를 user-explicit로 분류해서는 안 되며, 명백한 시간·불확실성 표현은 server도 적용 전에 거부합니다.

MCP 장애 때만 다음 CLI fallback을 사용합니다. Server가 source를 `user_explicit`로 고정하고 기존 candidate→verified→applied 함수를 순서대로 실행하므로 호출은 하나지만 세 audit event와 상태 전이는 생략되지 않습니다. JSON string은 shell에서 바깥 single quote와 안쪽 double quote를 모두 유지해야 합니다.

`--source-ref`와 evidence `--detail`은 대화 문장을 복사하는 칸이 아닙니다. 공백 없는 소문자 구조화 label만 허용되며 길이는 200 bytes 이하입니다. 예: `user-request:explicit-alias`, `observation:sample-2`.

```bash
ha-memory remember \
  --subject entity:light.kitchen_main \
  --memory-type alias \
  --key user_alias \
  --value-json '"준비등"' \
  --source-ref 'user-request:explicit-alias'
```

새 semantic key는 alias `user_alias`, 실제 용도 `user_purpose`, 설정 선호 `user_preference.<setting>`, note `user_note.<topic>`, 사용자 의미 관계 `user_relationship.<relation>`을 우선 사용합니다. 기존 값을 정정할 때는 search/show에 나온 같은 key를 재사용해야 conflict authority 검사가 작동합니다. 집 전체 선호의 유일한 home subject는 `home:household`이며 임의 `home:*`은 거부됩니다. Alias array는 일부 patch가 아니라 사용자가 의도한 전체 alias 집합이어야 합니다.

명시적 user 설명은 그 semantic fact의 권위 근거입니다. 동일 fact를 다시 remember하면 `already_applied`이고, 같거나 더 높은 기존 근거와 다른 값은 conflict입니다. `belongs_to`, `located_in`, `references` 같은 canonical 관계는 explicit remember가 생성 전에 거부하며 별도 candidate를 `--method ha_api`로 fresh Core snapshot과 검증해야 합니다. Observation/inference candidate는 아래처럼 서로 다른 observation evidence가 최소 2개 있어야 `repeated_observation`으로 검증할 수 있습니다. Verified candidate도 explicit apply 전에는 search 결과에 나타나지 않습니다.

```bash
ha-memory candidate add \
  --subject entity:light.kitchen_main \
  --memory-type preference \
  --key user_preference.evening_scene \
  --value-json '"부드러운 저녁 조명"' \
  --source observation \
  --source-ref 'observation:evening-scene-1'
ha-memory candidate evidence 2 \
  --evidence-type observation \
  --detail 'observation:independent-second-sample'
ha-memory candidate verify 2 --method repeated_observation
ha-memory candidate list \
  --status pending \
  --subject entity:light.kitchen_main \
  --limit 20
```

같은 subject/type/key에 값이 다르면 source authority를 비교합니다. Explicit user memory는 observation/inference보다 높고 자동으로 낮은 authority를 supersede하더라도 resolved conflict 이력을 남깁니다. 같거나 더 높은 기존 근거, HA canonical 관계 불일치 또는 사라진 HA subject는 open conflict가 되며 사용자의 명시적인 판단 없이 조용히 선택하지 않습니다.

### 변경 전후 fresh API 검증

Codex가 지속적인 HA 설정, registry 또는 automation을 바꾸기 전 영향 subject와 지원되는 closed-schema expectation을 반드시 commit하고, 변경과 필요한 reload 뒤 별도의 fresh Core API snapshot으로 같은 expectation을 확인합니다. 단순 조회·진단·catalog refresh와 원래부터 memory에 저장하지 않는 일시적 device-service 시험은 이 ledger 대상이 아닙니다. Expectation이 변경의 실제 결과를 표현할 수 없거나 memory가 unavailable이면 semantic memory를 갱신하지 않으며, Codex는 검증 공백과 미반영을 먼저 밝히고 사용자가 계속 진행할지 확인해야 합니다. 현재 schema는 automation trigger/condition/action/template logic을 표현하지 못하므로 logic-only 변경에 `exists`나 `name` 같은 약한 검사를 대신 사용해서는 안 됩니다. 명령 exit 0, 작성한 YAML, 의도한 값은 검증 증거가 아닙니다.

```bash
EXPECTATIONS='{
  "objects": {
    "entity:light.kitchen_main": {"exists": true, "area_id": "kitchen"}
  },
  "relationships": [{
    "source": "entity:light.kitchen_main",
    "relation": "located_in",
    "target": "area:kitchen",
    "exists": true
  }]
}'

ha-memory change begin \
  --summary 'change:move-kitchen-light-area' \
  --subject entity:light.kitchen_main \
  --subject area:kitchen \
  --expect-json "${EXPECTATIONS}"

# Home Assistant mutation and any required reload happen here.

ha-memory change verify 1 --expect-json "${EXPECTATIONS}"
```

Expectation은 object의 `exists`, `active`, `name`, `description`, `area_id`, `device_id`, 관계 존재 여부와 entity state/attribute의 exact 값을 지원합니다. 모든 참조 subject는 begin 대상에 포함되고 각 대상은 적어도 한 check로 덮여야 합니다. 생성할 object처럼 begin 시점에 아직 없는 subject도 선언할 수 있습니다. Begin은 canonical digest와 field-only summary만 저장하고 raw expectation 값은 결과가 맞거나 틀려도 저장하지 않습니다. Verify는 같은 계약만 허용합니다. Success는 `verified`, 불일치는 `mismatch`와 open conflict, Core/API 실패는 `unavailable`로 남습니다. `codex_change` source relationship candidate는 이 change가 `verified`이고 동일 source·relation·target의 존재 predicate가 성공해야 `change_verification` 증거로 검증할 수 있습니다. 같은 subject의 무관한 object/state check나 `exists: false` check는 candidate fact를 검증하지 않습니다.

### 충돌, 이력과 rollback

```bash
ha-memory conflicts --status open --limit 20
ha-memory conflict resolve 3 \
  --winner existing \
  --reason 'User confirmed the existing semantic meaning'
ha-memory history --subject entity:light.kitchen_main --limit 30
ha-memory rollback 12 --reason 'User withdrew the previously applied alias'
```

Semantic conflict winner는 `candidate` 또는 `existing`이며 실제 사용자 지시에 따라 선택합니다. `ha` winner는 HA canonical/change-result conflict에서만 허용됩니다. Audit event는 before/after row를 보존하고 rollback은 현재 row가 해당 event 직후 상태와 같고 후속 dependency가 없을 때만 compensating event를 만듭니다. 원 event는 삭제하지 않고 rollback linkage를 기록합니다. 나중 변경으로 값이 달라졌으면 `rollback_diverged`로 거부합니다. HA-derived catalog revision, change-verification history, 실제 configuration/device state는 rollback 대상이 아니며 다음 fresh refresh로만 교정합니다.

Memory DB가 unsafe/corrupt로 거부되면 App을 중지하고 `/data/codex-ha-memory`를 포함한 private backup을 먼저 확보하세요. DB/WAL을 임의 삭제·수정하거나 오래된 catalog로 HA를 되돌리지 말고, `ha-memory status`, 정제된 App log, App/Core version만 수집해 보고하세요. `database_busy`는 daemon/CLI/MCP의 정상 동시 접근이 5초 안에 해소되지 않았다는 재시도 가능 상태이며 corruption 판정이 아닙니다. Store가 정상이고 Core만 일시 중단됐다면 last-known-good를 유지한 채 daemon이 재시도하므로 수동 초기화가 필요하지 않습니다.

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

`0.2.0` 이상 image는 Node.js, `@playwright/mcp 0.0.78`, Alpine `chromium-headless-shell`과 한글·emoji font를 함께 제공합니다. Codex는 image-owned `/etc/codex/config.toml`의 `playwright` MCP server를 새 세션에서 자동으로 읽습니다. `0.2.3`부터 같은 system config의 `developer_instructions`와 Playwright의 `browser_navigate` 설명이 Home Assistant dashboard 요청을 곧바로 `http://127.0.0.1:8099/`로 보냅니다. 별도 Vercel/범용 browser skill을 먼저 실행하거나 `localhost:8123`·외부 URL을 탐색하지 않습니다. 사용자가 npm package나 browser binary를 설치하거나 `/data/codex/config.toml`에 MCP 명령을 복사할 필요가 없고, 기본 `preserve`에서는 기존 사용자 config와 `AGENTS.md`를 덮어쓰지 않습니다. 이미 열려 있던 Codex 세션은 App 업데이트 후 자동으로 system config를 다시 읽지 않으므로 새 세션을 시작하세요.

### 브라우저 승인 정책

App **구성**의 `browser_approval_policy`는 URL과 관계없이 image-managed `playwright` MCP 전체에 적용됩니다.

| mode | 허용된 Playwright 도구의 동작 |
| --- | --- |
| `safe` | 기본값. navigate/back, tabs, resize, hover, wait, close, snapshot, screenshot, console, network 목록은 자동 승인하고 click, form fill, key press, select, type은 승인 요청합니다. |
| `never` | 현재 proxy allowlist의 16개 도구를 자동 승인합니다. code evaluation, arbitrary upload/output와 상세 단일 network request처럼 차단된 도구는 계속 사용할 수 없습니다. |
| `always` | 현재 허용된 16개 도구를 모두 승인 요청으로 처리합니다. |

서버 기본값은 `prompt`라서 향후 도구가 image에 추가되더라도 정책 분류 전에는 자동 승인되지 않습니다. `codex_approval_policy`는 별도의 상위 command 정책이며, 이를 `never`로 두고 full-write 권한을 사용하면 Codex가 MCP prompt도 전역 자동 승인할 수 있으므로 `safe`나 `always`가 팝업을 강제하는 보안 경계는 아닙니다. 반대로 `browser_approval_policy=never`는 현재 Playwright allowlist에 명시적 `approve`를 적용합니다. 어느 mode도 사용자의 현재 요청에 없던 Home Assistant 변경을 새로 허가하지 않으며 고위험 장치 운영 지침은 유지됩니다.

기존 `/data/options.json`에 key가 없으면 `safe`로 동작하고 파일에 key를 자동 삽입하지 않습니다. 설정을 바꾼 뒤 App을 재시작하고 새 Codex 세션을 시작해야 하며 이미 열린 browser context에는 소급 적용되지 않습니다.

### 어떤 URL을 여는가

| 대상 | Codex browser가 여는 URL | 주의점 |
| --- | --- | --- |
| Codex가 App 안에서 실행한 web 개발 서버 | 개발 서버가 출력한 정확한 URL. 예: `http://127.0.0.1:3000` | Headless Chromium도 같은 App container network namespace에 있으므로 외부 port mapping은 필요하지 않습니다. 서버 process는 계속 실행 중이어야 합니다. |
| Home Assistant dashboard/frontend | `http://127.0.0.1:8099` | renderer 전용 loopback gateway입니다. 일반 PC browser, Home Assistant Ingress URL 또는 외부 공개 URL로 사용하지 않습니다. |

`8099` gateway는 frontend document, `/auth/`, `/api/`와 `/api/websocket`을 모두 내부 `homeassistant:<Core frontend port>`로 직접 전달합니다. App init은 Supervisor Core info에서 frontend port와 HTTP/HTTPS 여부를 찾고, 찾지 못하면 내부 기본값 `http://homeassistant:8123`을 사용합니다. direct Core 한 경로를 사용하므로 전용 사용자의 permission이 document·REST·WebSocket 전체에 동일하게 적용됩니다. gateway는 X-Forwarded-For, X-Real-IP와 Forwarded를 제거하고 App 밖에는 expose하지 않습니다. HTTPS이면 image CA bundle과 `homeassistant` hostname을 검증하며 자체 서명·hostname 불일치를 자동 우회하지 않습니다.

`localhost:8123`은 App container 자신을 가리키므로 별도 container인 Core에 연결되지 않습니다. Chromium은 `127.0.0.1:8099`를 열고 nginx가 `homeassistant:<port>`로 연결합니다. 이 두 번째 socket에서 Core가 보는 source는 현재 App의 `172.30.33.x`입니다. 다음 명령으로 실제 값을 비밀 없이 확인합니다.

```bash
ha-browser-network-info
```

출력의 `socket_source_ip`와 `supervisor_reported_app_ip`가 같으면 현재 경로가 확인된 것입니다. 하지만 일반 App IP는 update/recreate 뒤 다른 App에 재할당될 수 있습니다. 따라서 이 `/32`, `172.30.33.0/24` 또는 더 넓은 Docker 대역을 `trusted_networks`나 `trusted_proxies`에 넣지 마세요. App이 합성 X-Forwarded-For를 보내게 하는 구성도 다른 App의 header spoofing과 stale IP 위험을 해결하지 못합니다. 이 App은 `configuration.yaml`, `homeassistant.auth_providers`, HTTP proxy 설정 또는 `.storage`를 자동 편집하지 않으며 기존 `homeassistant` provider를 그대로 유지합니다.

다른 용도로 이미 `trusted_networks`를 수동 사용한다면 Home Assistant 규칙상 해당 source는 `trusted_proxies`와 겹치면 안 됩니다. provider 목록에서는 `trusted_networks` 뒤에 `homeassistant`를 두어 비밀번호 로그인을 fallback으로 유지해야 합니다. 이 App을 위해 그 순서나 대역을 자동 변경하지 않으며, 기존 broad Docker `trusted_proxies`가 있다면 다른 App의 forwarded-header 사칭 범위도 별도로 감사해야 합니다.

### 기본 ON: 자동 read-only browser 사용자 설정

App의 **구성** 탭에서 **헤드리스 브라우저 자동 인증**을 켜거나 끌 수 있으며 기본값은 ON입니다. 신규 설치뿐 아니라 이전 version의 `/data/options.json`에 이 option이 없는 기존 설치도 ON으로 해석합니다. App 시작과 새 Playwright MCP 시작은 `ha-browser-auth-ensure`를 실행해 관리형 identity를 자동 생성하거나 기존 상태를 재검증하므로 최초 설정 명령이 필요하지 않습니다.

option을 바꾼 뒤 App을 재시작하세요. OFF이면 다음 App/MCP browser 세션부터 `/run` token을 만들지 않고 `8099`에 일반 Home Assistant login page를 표시합니다. 이미 열린 browser context의 local storage를 소급 삭제하지는 않습니다. OFF는 장애 복구와 재활성화를 위해 `/data/browser-auth`의 관리형 user/token 상태와 Home Assistant identity를 보존합니다. 다시 ON으로 바꾸고 App을 재시작하면 같은 identity를 재사용합니다. 완전 삭제는 OFF로 저장하고 App과 기존 browser 세션을 재시작한 뒤 아래 `ha-browser-auth-remove`로 수행합니다.

자동 생성 또는 복구가 실패하면 다음으로 비밀값 없는 상태를 확인합니다. `ha-browser-auth-setup`은 자동 경로와 같은 transaction을 수동으로 한 번 재시도해 상세한 정제 오류를 확인하는 진단 명령이며, option이 OFF이면 identity를 만들지 않고 활성화 안내와 함께 거부됩니다.

```bash
ha-browser-auth-status
ha-browser-auth-setup
```

자동 ensure와 `ha-browser-auth-setup`은 Home Assistant의 지원되는 admin/user WebSocket과 `/auth/login_flow`, `/auth/token`, `/auth/revoke`만 사용해 다음 작업을 수행합니다.

1. 고유한 전용 일반 사용자를 `local_only: true`, 유일한 `system-read-only` group으로 생성합니다.
2. 고강도 임시 로컬 비밀번호 credential로 명시적인 `homeassistant` provider login flow를 완료합니다.
3. 해당 read-only 사용자 소유 long-lived token을 만들고 user·정책·token metadata를 다시 검증합니다.
4. 임시 비밀번호 credential과 OAuth refresh token을 제거하고, 유일한 active refresh token이 관리형 long-lived token인지 확인합니다.
5. `/data/browser-auth`의 `0700` 디렉터리에 recovery state와 token을 각각 `0600`으로 원자 저장하고, ready 상태만 `/run` runtime으로 활성화합니다.

사용자가 Home Assistant profile에서 token을 발급하거나 복사·붙여넣기할 필요가 없습니다. App 재시작·업데이트와 각 Playwright MCP 시작 때 같은 identity를 재검증해 재사용합니다. 중간에 Core/DNS/TLS가 불안정하거나 user policy·credential이 바뀌면 영구 복구 자료를 성급히 삭제하지 않고 `/run` token만 제거해 dashboard 자동 로그인을 차단합니다. 동시에 두 setup/remove가 실행되지 않도록 kernel lock을 사용합니다. 이 자동화는 `trusted_networks`, `trusted_proxies`, provider 순서, `configuration.yaml` 또는 `.storage`를 변경하지 않습니다.

`status: ready`, `source: managed`, `group_ids: ["system-read-only"]`, `local_only: true`, `is_admin: false`가 모두 보여야 합니다. 관리형 identity를 더 이상 쓰지 않을 때는 자동 인증을 OFF로 저장하고 App과 기존 Codex/browser 세션을 재시작한 다음, 다음 명령으로 App이 만든 user와 token을 정책 확인 후 제거합니다. ON 상태에서는 다음 ensure가 identity를 다시 만들 수 있으므로 명령이 삭제를 거부합니다.

```bash
ha-browser-auth-remove
```

사용자가 관리형 user의 이름, group, local-only 상태나 credential을 수동 변경한 경우 자동 삭제·수리를 거부할 수 있습니다. 먼저 변경 내용을 검토하고 원래 exact policy로 복구한 뒤 제거를 다시 실행하세요. App 완전 삭제 전에 관리형 identity가 필요 없다면 자동 인증을 OFF로 전환한 상태에서 `ha-browser-auth-remove`를 먼저 실행하는 것이 좋습니다.

### 수동 token override/fallback

기존 optional `home_assistant_browser_token`도 계속 지원합니다. **헤드리스 브라우저 자동 인증**이 ON인 동안 이 App option을 설정하면 관리형 token보다 우선하며, 다음 조건을 모두 만족할 때만 자동 로그인이 켜집니다. 자동 인증을 OFF로 바꾸면 저장된 수동 token도 browser runtime에 주입하지 않습니다.

- 일반 활성 사용자이며 system-generated user가 아님
- `local_only: true`
- 관리자가 아님
- 유일한 group이 `system-read-only`

수동 절차가 필요한 경우 App Web terminal에서 전용 사용자를 만듭니다. 명령은 비밀번호를 두 번 묻고 화면에 표시하지 않으며 CLI 인수·환경변수·로그로 전달하지 않습니다.

```bash
ha-browser-user-create "Codex Browser" codex-browser
```

명령이 출력한 user ID를 보관합니다. 다음 순서로 1회 정상 로그인을 완료합니다.

1. 현재 Home Assistant의 내부/LAN URL을 별도 private browser window에서 엽니다.
2. 방금 만든 `codex-browser`와 임시 비밀번호로 로그인합니다. `local_only` 사용자이므로 외부 cloud URL에서는 거부될 수 있습니다.
3. 사용자 profile의 **Security → Long-lived access tokens**에서 `Codex Browser` token을 만듭니다. token은 이때 한 번만 표시됩니다.
4. Home Assistant의 **설정 → Apps → Codex for Home Assistant → 구성**에서 `home_assistant_browser_token`에 token을 붙여 넣고 저장한 뒤 App을 재시작합니다. 이 필드는 password schema로 마스킹됩니다.
5. Web terminal에서 다음을 실행해 저장한 token과 실제 user policy가 일치하는지 확인합니다.

```bash
ha-browser-auth-status
```

`status: ready`, 같은 user ID, `group_ids: ["system-read-only"]`, `local_only: true`, `is_admin: false`가 모두 보여야 합니다. 미설정·만료·취소·다른 group·관리자·비로컬 user는 거부되며 Supervisor token으로 자동 대체하지 않습니다. 이때 `8099`는 정상 login page를 표시합니다.

ready 확인 뒤 Home Assistant 비밀번호 credential을 제거하면 이 계정은 browser token으로만 접근할 수 있습니다. user ID를 정확히 다시 지정해야 하며 helper는 ready status, user policy와 token 소유자를 재검증한 뒤 password credential만 지우고 token이 여전히 인증되는지 다시 확인합니다.

```bash
ha-browser-user-remove-password <user-id>
ha-browser-auth-status
```

수동 token을 취소하거나 만료시키면 App option을 지우거나 새 token으로 바꾸고 재시작하세요. 관리형 방식으로 전환하려면 수동 option을 비우고 자동 인증을 ON으로 저장한 뒤 App을 재시작하면 됩니다. `system-read-only`도 모든 entity state를 읽을 수 있으며 특정 dashboard 하나만으로 제한된 권한은 아닙니다. `/data/browser-auth`, App option과 backup, screenshot, snapshot, console/network 결과를 모두 민감자료로 취급하세요. Browser identity가 read-only여도 Codex/App shell 자체는 `/config` RW와 Supervisor `manager` 권한을 가진 관리자 도구라는 점은 바뀌지 않습니다.

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
- 검증된 browser token은 mode `0600`인 `/run/codex-ha/home-assistant-browser.token`에서 재검증에 성공한 Playwright child의 init script 환경으로만 전달됩니다. Supervisor token은 Codex MCP `env_vars`에 넣지 않습니다. Codex system MCP는 `/usr/bin/env -i`의 최소 환경으로 wrapper를 시작하고, wrapper는 검증 전에 `PLAYWRIGHT_MCP_*`, `NODE_OPTIONS`, `NODE_PATH`, `BASH_ENV`, `ENV`를 제거합니다. launcher가 App 시작과 각 MCP 시작 때 지원되는 WebSocket API로 user policy를 재검증하는 동안에만 Supervisor credential을 사용하고 Node proxy/browser child에는 고정 allowlist 환경만 전달합니다. Playwright의 `--secrets`는 폼 입력에서 실제 값을 치환할 수 있으므로 사용하지 않으며, 관리 proxy가 MCP stdout/stderr의 exact browser token만 직접 마스킹합니다. 인코딩·분할된 비밀, image나 화면 전체를 구조적으로 정화하지는 않습니다.
- screenshot, accessibility snapshot, console message와 request URL에는 entity 이름, 위치, 사용자 정보, 내부 hostname, dashboard 내용이나 integration data가 포함될 수 있습니다. Git, 이슈, 채팅 또는 공개 CI artifact에 올리기 전에 직접 검토하고 필요하면 폐기하세요.
- token 주입은 `8099` 두 loopback origin으로 제한됩니다. 일반 개발 서버와 외부 사이트에는 Home Assistant token을 주입하지 않습니다. init과 각 MCP launcher는 user policy를 다시 검증하고 실패하면 browser token을 전달하지 않습니다. 실행 중 사용자 group을 바꿨다면 기존 browser 세션을 종료하고 App 또는 새 Codex 세션을 다시 시작해 검증을 갱신하세요. 그렇더라도 신뢰하지 않는 페이지 탐색과 파일 download/upload를 허용하지 마세요.
- `browser_click`, `browser_fill_form`, `browser_type`, `browser_press_key`, `browser_select_option`은 실제 dashboard 설정이나 기기 상태를 바꿀 수 있습니다. 사용자 요청이 렌더링·진단뿐이면 snapshot, screenshot, console, network 같은 read-only 확인에 머무르고 변경은 별도 승인받습니다.

### 현재 검증 경계

공개 `0.2.0` amd64 image의 인증 없는 pull과 전체 Docker smoke는 PASS입니다. 이 image에서 managed MCP proxy와 실제 browser server를 시작해 initialize, 제한된 `tools/list`, local fixture navigation, desktop `1440x900`·mobile `390x844` DOM viewport와 PNG, console error와 uncaught page error, network 200/302/404/500 및 전송 실패를 확인했습니다. 모의 Supervisor/Core를 연결한 local gateway에서는 token bootstrap, 인증된 `/api/config`, frontend marker, `/api/websocket` upgrade와 container loopback 외부 차단을 확인했습니다. Public `0.1.3` image를 `0.2.0`으로 교체한 update smoke는 동일 named `/data`·`/config` volume의 사용자 Codex config, valid auth marker, 운영 지침, Home Assistant config marker와 SSH host fingerprint를 byte/fingerprint 수준으로 보존하고 새 MCP smoke를 통과했습니다. 큰 desktop PNG는 MCP 응답 한도에 맞춰 같은 종횡비로 축소될 수 있습니다. 임의 `filename`, 상세 network 도구와 다른 금지 도구가 proxy에서 거부되고 stdout/stderr/container log에 token 원문이 없는 것도 검증했습니다. 다만 Playwright upstream의 공식 browser binary는 Alpine/musl을 지원하지 않습니다. 이 App은 Playwright browser download를 생략하고 Alpine repository의 system Chromium을 명시적으로 사용하므로 Alpine/Chromium/Playwright package revision이 바뀔 때마다 build와 smoke를 다시 확인해야 합니다.

Public `0.3.2`의 정확한 이미지에서 memory lifecycle/privacy/MCP/persistence와 실제 installed `ws`, 관리형 user/token 생성·재사용·회전·제거, user-file update, browser/gateway/Core WebSocket/ttyd/SSH와 public `0.3.1` → `0.3.2` update smoke를 확인했습니다. 이전 실제 HAOS `0.3.1` 실기에서는 설치 무결성·Core 연결·daemon/DB·privacy가 PASS했지만 related `unknown_error` 때문에 catalog/LKG/실제 CLI·MCP 조회는 FAIL했습니다. 후속 실제 HAOS/Core `2026.7.2`의 public `0.3.2` 재시험은 동일 related `unknown_error` 2/30을 config 2/2, config-derived relation 4/4와 다른 automation 28/28을 보존한 warning으로 격리했습니다. Forced refresh/fresh revision, DB atomicity·WAL/FTS5, 실제 CLI/MCP, privacy, candidate lifecycle, restart 요청 수락·daemon 생존·요청 후 forced fresh sync와 App restart persistence는 PASS했습니다. Actual runtime OCI digest는 Supervisor가 제공하지 않아 NOT RUN이고, probe에 Core 단절이나 failed refresh가 없어 disconnect/reconnect와 순간 LKG `stale/degraded`는 NOT OBSERVED입니다. `config:null`도 NOT OBSERVED, 오류 주입과 version-tagged `0.3.1 → 0.3.2` live update는 NOT RUN이므로 최종은 **PARTIAL(FAIL 0)**입니다.

공개 [`0.4.0` GitHub Release](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.4.0)가 게시됐습니다. 기능 merge [`bca6126`](https://github.com/Kanu-Coffee/codex-for-home-assistant/commit/bca612661692e3d66d239c06b57b52921ea56af6)의 native Linux [main CI 29408206017](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29408206017)과 공식 [Builder 29408467932](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29408467932)이 PASS했습니다. Builder가 게시한 generic/per-arch OCI index digest는 `sha256:758837276c4247a304c58791bddab5912977d3445801dcd832a638f9a2af9342`, runtime manifest digest는 `sha256:b586727e9a2ca724f32f8255f692cd32104aeed45bc0e65b8c12cb3cc151373b`입니다. 인증 없는 두 tag의 resolve·pull, linux/amd64와 version/arch/source label, mutable `latest` 부재를 확인했습니다. 정확한 공개 이미지에서 full browser/gateway/Core WebSocket/ttyd/SSH, browser approval policy, memory, managed-auth, user-file update와 public `0.3.2` → `0.4.0` update smoke가 **PASS**했습니다.

이 자동 smoke는 fixture page 검증 증거입니다. 별도로 사용자가 public `0.2.3`의 AppArmor 활성 상태 실제 HAOS에서 인증된 `8099` dashboard의 desktop/mobile 렌더링, console, network/정적 resource, Core WebSocket 경로를 **PASS**로 확인했습니다. 상세 실행 로그와 HAOS 버전은 제공되지 않아 추정하거나 저장소 증거로 기록하지 않습니다. 후속 public `0.4.0` 실제 HAOS `never` run에서는 14개 허용 도구가 MCP 승인 요청 0회로 PASS했고 desktop/mobile 자동 인증 dashboard, 비파괴 click/type/form/key, console/network가 동작했습니다. 사용자 지정 screenshot `filename`은 proxy가 의도대로 거부했고 인자 제거 후 성공했습니다. `select_option`은 안전한 대상이 없었고 `close`는 실행 기록이 없어 NOT TESTED입니다. `safe`/`always`, 최상위 `codex_approval_policy=never` precedence, 금지 도구, Configuration UI/default, AppArmor 활성 여부, user config/AGENTS/browser identity 보존과 live update 감지는 아직 **NOT RUN**입니다. 따라서 자동 fixture 검증이나 이전 `0.2.3` 실기를 전체 `0.4.0` 수용 증거로 확대하지 않습니다.

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

인증은 `/data/codex/auth.json`에 저장됩니다. 사용자가 HAOS에서 device code 로그인 흐름을 완료했고, App을 삭제하지 않은 채 여러 버전을 일반 업데이트한 환경에서 로그인 상태와 인증된 Codex 실행이 유지되어 **device code 인증과 업데이트 영속성은 실기 PASS**입니다.

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

Windows 파일 위치는 보통 `C:\Users\<사용자>\.ssh\config`입니다. 일반 SSH client에서 사용하려면 wildcard가 아닌 **구체적인 Host 별칭**을 만듭니다.

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

## ChatGPT mobile Remote 직접 SSH 연결

이 App에서 검증된 경로는 **ChatGPT mobile Remote → 공개키 SSH → HAOS App의 내장 Codex app-server → `/config`**입니다. HA App 이미지가 SSH server와 Codex를 함께 제공하므로 별도의 Mac/Windows desktop app 또는 중계 host는 필요하지 않습니다.

1. mobile Remote가 사용할 공개키를 App `authorized_keys`에 등록하고 App을 재시작합니다.
2. mobile Remote의 SSH 연결에 HA hostname/IP, App Network port(기본 `2223`), 사용자 `root`와 대응 개인키를 등록합니다.
3. App Web UI에서 Codex 인증을 완료하고 remote login shell PATH에서 `codex`를 찾을 수 있는지 확인합니다.
4. 원격 프로젝트 폴더로 `/config`를 사용합니다.

mobile Remote는 SSH login shell을 통해 App 내장 Codex app-server를 시작합니다. 사용자가 `0.1.2-dev`에서 이 직접 SSH 경로를 확인했으므로 공개키 SSH, 원격 PATH와 Alpine/musl app-server 실기 경로는 PASS입니다. App 재시작/업데이트 뒤 host identity 유지도 확인했습니다. 일반 SSH client는 `/config` Bash를 열기 때문에 Codex를 수동 실행해야 합니다. 외부 비밀번호 인증의 실제 거부 시도만 별도 미검증이며 실효 설정과 로컬 negative smoke는 PASS입니다.

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
| Core 재시작 | `POST /core/restart` | PARTIAL — 0.3.1 실기에서 승인 후 daemon 생존·Core 재연결은 PASS, related 오류가 반복돼 fresh catalog 복구는 FAIL |

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

WebSocket client는 server의 `auth_required`를 받은 뒤 첫 client auth frame의 `access_token`을 실행 시점에 `SUPERVISOR_TOKEN` 환경변수에서 읽어 구성해야 합니다. 예를 들어 프로토콜상 첫 두 outbound message는 다음 형태입니다. `<runtime token>`을 실제 값으로 문서나 스크립트에 저장하지 마세요.

```json
{"type":"auth","access_token":"<runtime token>"}
{"id":1,"type":"get_states"}
```

Memory client는 이 Supervisor proxy를 고정 endpoint로 사용하고 image-pinned `ws`의 handshake timeout, 32 MiB payload cap, compression off와 기본 TLS 검증을 적용합니다. `HA_WS_URL` 환경변수는 무시하며 Upgrade authorization header나 direct-Core credential fallback을 사용하지 않습니다. 이 MVP에는 전용 `ha-ws` helper나 범용 WebSocket CLI가 포함되지 않았습니다. 필요한 경우 token redaction을 지키는 코드/클라이언트를 사용하세요. Ingress WebSocket transport와 인증된 `8099` dashboard의 Core WebSocket 경로는 HAOS에서 사용자 확인 PASS입니다. Memory의 실제 0.3.1 실기는 Core WebSocket 연결까지 PASS했지만 related graph 2건 때문에 catalog가 FAIL했으며, 이는 범용 Core WebSocket CLI/helper 검증과도 구분합니다.

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

1. `0.2.0` 이상 image인지 확인하고 이미 실행 중이던 Codex를 종료한 뒤 새 세션을 시작합니다. `codex mcp list`에서 system server `playwright`가 enabled 상태인지 확인하되, token이나 전체 환경변수는 출력하지 않습니다.
2. `/data/codex/config.toml`에 같은 `mcp_servers.playwright`를 끄거나 다른 command로 바꾼 사용자 설정이 있는지 확인합니다. 문제 해결을 위해 `/data` 전체를 초기화하지 마세요.
3. 개발 UI라면 server process가 살아 있고 App shell에서 지정한 loopback URL에 응답하는지 확인합니다. browser가 외부 PC의 `localhost`를 대신 볼 수는 없습니다.
4. Home Assistant dashboard라면 Codex가 image-managed Playwright로 `http://127.0.0.1:8099`를 바로 열어야 합니다. 그렇지 않으면 기존 Codex 세션을 종료하고 새 세션에서 다시 확인한 뒤 `ha-browser-network-info`와 `ha-browser-auth-status`를 봅니다. `disabled`이면 App 설정에서 자동 인증이 OFF인 의도된 상태입니다. ON인데 `unconfigured` 또는 `rejected`이면 App을 재시작하고, 계속 실패할 때만 `ha-browser-auth-setup`을 실행해 정제된 상세 오류를 확인합니다. provider 부재, Core TLS 또는 정책 오류는 우회하지 마세요. browser token이나 `SUPERVISOR_TOKEN` 값을 직접 출력하거나 URL/query에 붙이지 마세요.
5. browser process가 멈추거나 50 MiB output 한도에 걸렸다면 해당 Codex 세션을 끝내고 새 세션에서 재현합니다. `/run/codex-ha/playwright-output`의 민감한 screenshot은 보존하지 말고 필요한 범위에서 정리합니다.

Alpine Chromium crash, 빈 page, 인증 반복, `/api/websocket` 실패가 계속되면 App version, HAOS/Core version, console error와 token을 제거한 network status만 보존해 보고하세요. upstream Playwright가 Alpine/musl을 공식 browser 플랫폼으로 지원하지 않는다는 현재 검증 경계를 함께 고려해야 합니다.

### 사용자 config/AGENTS 갱신을 되돌려야 할 때

1. App **구성**에서 `codex_user_files_update_mode`를 `preserve`로 저장해 다음 App version의 자동 재적용부터 막습니다.
2. 실행 중인 Codex 세션을 종료하고 `/data/codex/backups/user-files` 아래 해당 refresh transaction을 찾습니다. directory 이름과 `metadata.json`만으로 version·scope·hash를 확인하고, 비밀이 있을 수 있는 `config.before` 내용을 화면이나 로그에 출력하지 마세요.
3. 복원할 target의 현재 파일과 backup hash/mode를 검토합니다. refresh 뒤 사용자가 다시 편집한 파일이 있다면 먼저 별도 root-only 사본을 만들고 무조건 덮어쓰지 않습니다.
4. 신뢰된 App terminal에서 필요한 `.before` 파일만 원래 target으로 복원하고 metadata의 원래 mode를 적용합니다. `AGENTS.override.md`, `auth.json`, session, SSH/browser identity 또는 `/config`를 backup directory에서 복원하려 하지 마세요. 이 기능은 그 파일들을 backup하거나 변경하지 않습니다.
5. 새 Codex 세션을 시작해 `codex mcp list`, 적용 지침과 필요한 model/provider 설정을 확인합니다.

transaction state/journal을 임의로 지우면 같은 version one-shot과 crash recovery 판단을 잃을 수 있으므로 삭제하지 마세요. backup 또는 metadata가 불완전하거나 target이 symlink/hardlink/non-regular이면 추측해서 복원하지 말고 App을 중지한 상태에서 진단 자료의 비밀을 제거해 보고하세요.

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

Browser token 노출이 의심되면 먼저 `ha-browser-auth-status`에서 현재 `source`가 `managed`인지 `manual`인지 기록한 뒤 실행 중인 Codex/browser 세션을 종료하고 **헤드리스 브라우저 자동 인증**을 OFF로 저장해 App을 재시작합니다. OFF status에는 source가 남지 않습니다. 이전 source가 `managed`였으면 `ha-browser-auth-remove`로 App이 관리하는 user와 token을 함께 제거하고, 제거가 정책 불일치로 거부되면 App을 중지한 채 Home Assistant 관리자 UI에서 해당 identity와 token을 직접 검토·폐기합니다. 이전 source가 수동 option이었으면 전용 사용자의 profile에서 해당 long-lived token을 삭제하고 `home_assistant_browser_token` option도 비웁니다. `8099`가 login page로 fail closed되는지 확인한 뒤 관리형 방식은 자동 인증을 다시 ON으로 하고 App을 재시작하며, 수동 방식은 새 token을 설정합니다. read-only token과 `/data/browser-auth` backup도 모든 entity state에 접근할 수 있는 민감자료로 취급하세요.

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
| 공개키 SSH와 mobile Remote 직접 연결의 Alpine/musl app server | **PASS — mobile Remote 직접 SSH 사용자 E2E 확인** |
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
| `0.2.1` 최소권한 local image와 내부 `8099` fixture | **PASS — desktop/mobile PNG, console/network, direct Core REST/WebSocket, source IP 일치, stale IP·상속 token 음성 테스트** |
| Public `0.2.2` 관리형 browser 인증 | **PASS — user/token 생성·재사용·회전·제거, crash/응답 유실/cleanup 실패 복구, 동시 실행 차단, Core/provider 장애·정책 변조 fail-closed** |
| Public `0.2.3` 기본 ON 자동 인증과 Codex 8099 routing | **PASS — option 누락/default ON, OFF/ON 보존, ON 삭제 거부·OFF 삭제, 수동 override와 model-visible instruction/tool 설명 확인** |
| Public `0.2.3` 선택형 Codex 사용자 파일 갱신 | **PASS — preserve, 선택 refresh, backup/recovery, 위험 파일 거부와 동일 version 재시작 멱등성은 자동 검증; 실제 HAOS 구성 UI·Supervisor 일반 update는 사용자 확인 PASS** |
| 모의 Supervisor/Core `8099` gateway | **PASS — token bootstrap, 인증 REST, frontend marker, WebSocket upgrade, loopback 외부 차단** |
| Public `0.1.3` → local `0.2.0` container update | **PASS — 동일 `/data`·`/config`, 설정·auth marker·지침·SSH identity 보존과 새 MCP 실행** |
| Public `0.2.0` GHCR publish, anonymous pull과 release-image full smoke | **PASS — linux/amd64, version/arch label, immutable digest, `latest` 부재** |
| Public `0.2.0` → local `0.2.1` container update | **PASS — `/data`·`/config`, auth/config/지침/SSH identity와 마스킹된 browser option 보존** |
| Public `0.2.1` → public `0.2.2` container update | **PASS — 동일 `/data`·`/config`, Codex auth/config/지침/SSH identity와 App option 보존, 새 managed-auth helper와 MCP 실행** |
| Public `0.2.2` → public `0.2.3` container update | **PASS — 기본 preserve, opt-in refresh_all, 동일 version 재시작 멱등성, image-managed 8099 instruction과 새 MCP 실행** |
| Public `0.2.3` → public `0.2.4` validation/evidence update | **PASS — 익명 linux/amd64 resolve·pull, version/arch/source label, retained refresh target의 새 version 1회 재적용과 same-version 멱등성, managed-auth·user-file·update/MCP smoke** |
| Public `0.2.4` → public `0.3.0` 검증 기반 메모리 update | **PASS — 익명 linux/amd64 resolve·pull, memory/privacy/MCP/persistence, full browser/gateway/ttyd/SSH, managed-auth, user-file와 update smoke; 실제 HAOS memory E2E는 NOT RUN** |
| Public `0.3.0` 실제 HAOS read-only memory 감사 | **FAIL — scheduler/MCP/SQLite/REST는 동작했지만 catalog bootstrap은 모두 `ha_unavailable`; restart/candidate/change/privacy는 NOT RUN** |
| Public `0.3.0` → public `0.3.1` memory refresh patch | **PASS — 익명 linux/amd64 resolve·pull, legal null config/installed `ws`/closed diagnostics, memory/full/managed-auth/user-file/update 공개 이미지 자동 회귀** |
| Public `0.3.1` 실제 HAOS/Core 2026.7.2 memory 실기 | **FAIL — 설치/연결/daemon·DB/privacy PASS, automation-related 2/30 `unknown_error`로 catalog/LKG/실제 조회 FAIL, Core restart PARTIAL, null-config NOT OBSERVED, candidate/change/App restart/update NOT RUN** |
| Public `0.3.1` → public `0.3.2` related 격리 patch | **PASS — 익명 linux/amd64 resolve·pull, official automation payload 유지, observed related `unknown_error`만 config-derived 관계/warning으로 격리, memory/full/managed-auth/user-file/update 공개 이미지 자동 회귀** |
| Public `0.3.2` 실제 HAOS/Core 2026.7.2 memory 재시험 | **PARTIAL(FAIL 0) — related `unknown_error` 2/30 격리, catalog/DB/CLI·MCP/privacy/candidate/restart 요청 후 fresh sync/App restart persistence PASS; runtime OCI digest NOT RUN, Core disconnect/reconnect·LKG stale/degraded·null-config NOT OBSERVED, 오류 주입·version-tagged update NOT RUN** |
| Public `0.3.2` → public `0.4.0` Playwright 승인 정책 | **PASS — 공개 Release, 익명 generic/per-arch resolve·pull, labels·`latest` 부재와 browser policy/full/memory/managed-auth/user-file/update 공개 이미지 smoke** |
| Public `0.4.0` 실제 HAOS `never` 정책 수용 | **PARTIAL — 실행한 14/16 도구 승인 0회와 desktop/mobile 자동 인증 dashboard PASS; select/close NOT TESTED, safe/always·global-never·금지 도구·UI/default·AppArmor 상태·identity 보존·live update NOT RUN** |
| Public `0.2.3` 실제 HAOS 일반 App update 후 Playwright MCP 노출 | **PASS — Home Assistant 구성 UI·Supervisor 일반 update 사용자 확인** |
| 실제 HAOS `8099` dashboard 인증·desktop/mobile·console·network/resource·WebSocket E2E | **PASS — AppArmor 활성 상태 사용자 확인** |

위 상태는 이 문서 작성 시점의 사실이며 최종 명령·결과는 저장소 `progress.md`가 기준입니다. 기존 `0.1.3` 범위의 amd64 runtime M1/M2와 public `0.2.0` browser renderer, `0.2.1` 최소권한 경로, `0.2.2` 관리형 인증, public `0.2.3` 자동화·user-file refresh, `0.2.4` validation/evidence, public `0.3.0`부터 `0.4.0`까지의 자동 회귀는 PASS입니다. 기존 설치의 Home Assistant 구성 UI/Supervisor 일반 업데이트와 AppArmor 활성 상태의 인증된 `8099` dashboard 경로는 public `0.2.3`에서 사용자 확인 PASS입니다. 현재 공개 사전 릴리스는 `0.4.0`이고 실제 0.3.0/0.3.1 memory catalog 실기는 FAIL했지만 public `0.3.2` 실기는 핵심 memory 경로 PASS와 증거 공백을 합쳐 PARTIAL(FAIL 0)입니다. Public `0.4.0` 실제 HAOS `never`는 검증된 14개 도구에서 PASS했지만 전체 browser 승인 행렬·전역 never 우선순위·잔여 도구·UI/default·AppArmor 상태·identity 보존·live update는 PARTIAL/NOT RUN이며, version-tagged live update와 실제 물리 장치 제어도 NOT RUN입니다. Home Assistant `stage`는 M3 평가 전까지 `experimental`을 유지합니다.
