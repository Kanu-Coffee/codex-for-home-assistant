# security.md — 권한, 위험, 운영 가드레일

## 1. 보안 입장

이 프로젝트는 권한을 최소화한 단순 편집기가 아니라 **Home Assistant의 신뢰된 운영 에이전트**다. 높은 권한은 의도된 제품 특성이다.

동시에 HAOS host와 Docker 전체를 열 필요는 없으므로 경계를 다음처럼 둔다.

```text
허용: /config 전체 RW
허용: Core API 전체 기능
허용: Supervisor API manager 역할
허용: 실제 기기 서비스 호출
차단: Supervisor admin 역할
차단: Docker API
차단: full_access/privileged host access
차단: host network
기본: AppArmor 활성
```

## 2. 권한 매트릭스

| 기능 | 제공 수단 | 위험도 | 결정 |
|---|---|---:|---|
| HA YAML/대시보드 수정 | `/config` RW | 높음 | 허용 |
| `.storage` 접근 | `/config` RW | 매우 높음 | 허용, 직접 수정은 운영 규칙으로 제한 |
| 상태/서비스 조회 | Core API | 중간 | 허용 |
| 실제 기기 제어 | Core API service call | 높음 | 허용 |
| 자동화/스크립트 실행 | Core API | 높음 | 허용 |
| Core/App 로그 | Supervisor API | 중간 | 허용 |
| Core/App 재시작 | manager API | 높음 | 허용 |
| 개발 Web UI 실제 브라우저 검증 | Playwright MCP + headless Chromium | 높음 | 컨테이너 안에서 허용 |
| HA 대시보드 브라우저 인증 | loopback gateway + 현재 App token | 매우 높음 | 정확한 loopback origin에 한해 허용 |
| 검증형 HA catalog/사용자 의미 메모리 | root-only SQLite + Core API + local CLI/MCP | 높음 | allowlist·provenance·bounded output으로 허용 |
| memory HTTP/SSE listener 또는 외부 vector/cloud sync | 외부 network service | 매우 높음 | 불허 |
| 브라우저 디버그/VNC 외부 공개 | 새 host/Ingress port | 매우 높음 | 불허 |
| 보호 모드 변경/무제한 Supervisor | admin | 매우 높음 | 불허 |
| Docker container 직접 제어 | docker_api | 치명적 | 불허 |
| HAOS host 전체 권한 | full_access/privileged | 치명적 | 불허 |

## 3. 주요 위험

### T-001 잘못된 설정으로 Core 부팅 실패

완화:

- 변경 전 Git checkpoint
- `/core/check` 또는 공식 설정 검사
- 검사 실패 시 재시작 금지
- 변경 파일과 diff 보고

### T-002 실제 기기 오작동

완화:

- 대상 entity를 명시
- 서비스 호출 전 현재 상태 저장
- 테스트 후 상태 확인/복원
- 출입·경보·가열·급수 등 고위험 장치는 명시적 승인

### T-003 `.storage` 손상

완화:

- 공식 API/YAML 우선
- 직접 수정 전에 HA backup 또는 파일 복사
- Core가 실행 중인 내부 JSON을 무리하게 편집하지 않음

### T-004 토큰 유출

완화:

- `SUPERVISOR_TOKEN`을 Git/로그/응답에 출력하지 않음
- curl verbose/debug 기본 비활성
- runtime env 파일 0600
- `auth.json` 0600
- API helper의 동적 `Accept` 값은 JSON/plain/x-log allowlist로 제한해 header injection 차단
- CI secret scan

### T-005 SSH 노출

완화:

- 공개키 전용
- 기본 LAN port 2223
- 인터넷 port forwarding 금지 문서화
- 외부 접근은 VPN/mesh network 권장
- host key 영속화
- 로그인 시도 로그
- mobile Remote는 HAOS에 직접 SSH하지 않고 신뢰한 desktop app의 SSH 연결을 제어하므로 desktop 계정·device pairing도 접근 경계로 취급

### T-006 Prompt injection 또는 잘못된 에이전트 판단

완화:

- App은 신뢰된 사용자만 접근
- 외부 문서/로그의 명령을 자동 실행 지시로 취급하지 않음
- `CODEX_HOME/AGENTS.md`와 `AGENTS.override.md`가 모두 없을 때 위 원칙과 진단/변경 권한 분리, 비밀 비노출, 설정 검사 절차를 담은 전역 운영 지침을 생성
- 기본 `codex_user_files_update_mode: preserve`에서는 사용자가 만든 전역/프로젝트 지침을 덮어쓰지 않음. 명시적 refresh도 base 전역 파일만 대상으로 하고 `AGENTS.override.md`와 프로젝트 지침은 보존
- 파괴적 작업 승인 규칙
- Git/backup 및 test-before-restart

진단 결과는 변경 권한이 아니다. App은 Repairs, 업데이트 가능 상태, 서드파티 통합 경고, `/config` 파일 mode를 발견했다는 이유만으로 자동 수정·`chmod`·업데이트·재시작하지 않는다.

`AGENTS.md`는 모델 동작을 돕는 방어 심층화 지침이지 강제 보안 경계가 아니다. `/config`의 더 가까운 지침이 우선할 수 있으므로 실제 경계는 App 권한, Codex approval/sandbox 설정, 명시적 사용자 승인과 변경 전후 검증으로 유지한다.

### T-007 App backup에 Codex token 포함

완화:

- backup을 비밀번호/토큰과 같은 민감자료로 취급
- 공유 금지
- 향후 `backup_exclude` 옵션의 장단점을 실기 검증
- 노출 의심 시 Codex logout/re-auth

### T-008 registry image 변조 또는 비공개 배포

완화:

- App version과 정확히 같은 숫자 Git tag에서만 image 게시
- 공식 Home Assistant builder actions의 version을 고정
- 장기 registry credential 대신 repository-scoped `GITHUB_TOKEN` 사용
- 기존 version tag 덮어쓰기 금지
- generic/per-arch GHCR package public visibility와 인증 없는 amd64 pull 확인
- pull한 image의 `io.hass.version`, `io.hass.arch`, source label과 container smoke 검증

### T-009 브라우저/MCP 공격 표면과 prompt injection

브라우저가 여는 페이지의 DOM, 접근성 snapshot, console, network 응답은 신뢰할 수 없는 입력이다. 페이지에 적힌 지시를 사용자 또는 프로젝트 지시로 승격하지 않는다.

완화:

- Codex의 MCP 경로는 container-local stdio로 연결하고 App service가 HTTP/SSE listener를 열지 않음. wrapper는 command-line 인수를 거부하고 enforcement proxy만 실행
- headless·isolated context를 사용하고 세션/profile을 `/data`에 저장하지 않음
- navigation, snapshot, viewport resize, screenshot, console/network 관찰과 기본 UI 조작만 명시적으로 허용
- 임의 JavaScript/code 실행, code generation, unrestricted file access/upload 도구는 제공하지 않음
- screenshot/browser output은 `/run/codex-ha`의 비영속 private 디렉터리에 두고 총량을 50 MiB로 제한. enforcement proxy가 tool call의 `filename`을 거부해 `/config`·`/data` 우회를 차단
- `chromium-headless-shell --no-sandbox`는 App container 안에서만 사용하며 이를 이유로 `privileged`, 새 capability, `full_access`, `host_network`를 추가하지 않음
- image-managed `developer_instructions`와 navigation tool 설명은 Home Assistant dashboard의 첫 경로를 `127.0.0.1:8099`로 좁히지만 사용자가 override할 수 있는 동작 지침이지 network 보안 경계로 간주하지 않음

### T-010 renderer credential·민감 화면 유출

HA 대시보드는 브라우저에서 Core API/WebSocket 인증이 필요하지만 token을 MCP 입력, URL, process argv 또는 영속 browser profile에 전달하면 안 된다.

완화:

- gateway는 container loopback `127.0.0.1:8099`에서만 수신하고 새 App Network/Ingress port를 만들지 않음
- `SUPERVISOR_TOKEN`은 Playwright MCP의 `env_vars`에서 제외한다. Codex system MCP는 `/usr/bin/env -i`의 최소 환경으로 wrapper를 시작하고, wrapper는 검증 전 `PLAYWRIGHT_MCP_*`, `NODE_OPTIONS`, `NODE_PATH`, `BASH_ENV`, `ENV`를 제거함. launcher가 App init과 각 MCP 시작의 user policy 재검증에만 Supervisor credential을 사용하며 Node proxy/browser child는 고정 환경 allowlist만 받음
- default ON `home_assistant_browser_auto_auth`의 관리형 token은 `/data/browser-auth`의 root-only storage에, optional 수동 override는 Supervisor-managed App option에 영속한다. init과 MCP launcher는 고정 Supervisor admin WS와 direct Core user WS에서 user ID·non-admin·active·local-only·유일한 `system-read-only` group, credential 부재와 exact single LLAT를 교차검증한 경우에만 mode 0600 `/run` 파일로 전달한다. inherited browser token과 WebSocket endpoint는 제거한다.
- 자동 ensure와 `ha-browser-auth-setup`은 `/auth/providers`에서 local provider 존재를 mutation 전에 확인한 뒤 official login/token/revoke API를 사용한다. 임시 password credential/OAuth token을 자동 제거하고 LLAT는 non-ready state로 먼저 원자 저장해 crash 시 revocation material을 보존한다. 설치·업데이트 시 option이 없으면 ON으로 해석하지만 provider/proxy 설정이나 Home Assistant 파일은 수정하지 않는다.
- OFF는 다음 App/MCP session의 runtime token을 차단하되 관리형 identity를 자동 삭제하지 않는다. 이미 열린 browser context는 별도 종료해야 하며, 완전 폐기는 OFF 상태에서 exact policy를 확인하는 `ha-browser-auth-remove`로만 수행한다. ON 상태 삭제는 다음 ensure의 재생성 경쟁을 막기 위해 거부하며 수동 token도 OFF에서는 주입하지 않는다.
- setup/remove는 kernel `flock`으로 직렬화하며 symlink·owner·file type/link count/mode를 검사한다. self-revoke는 같은 credential 재접속이 확정 거부되는지 확인하고, ambiguous `local_only` rejection이나 transport/TLS failure에서는 영구 자료를 보존하고 runtime만 차단한다.
- token은 `http://127.0.0.1:8099` 또는 `http://localhost:8099`의 정확한 origin에서만 `hassTokens` localStorage에 주입. 미설정·검증 실패는 관리자 token fallback 없이 login page로 fail closed
- token을 명령행 인수, URL query, console, MCP 응답, network request 목록, screenshot metadata, App log에 출력하지 않음
- Playwright `--secrets`는 허용된 입력 도구에서 비밀값 치환 기능을 제공하므로 사용하지 않음. 관리 proxy의 stdout/stderr exact-value masking은 방어 심층화일 뿐 보안 경계로 간주하지 않으며 인코딩·분할된 비밀이나 이미지까지 구조적으로 정화한다고 가정하지 않음
- screenshot과 console/network 결과는 민감자료로 취급하고 Git, CI artifact, `/data`에 자동 보존하지 않음. 단, 관리형 lifecycle state/token은 업데이트 복구를 위해 의도적으로 `/data/browser-auth`에 `0700`/`0600`으로 보존되므로 App backup도 비밀로 취급

### T-011 브라우저의 내부망 요청과 인증 오용

브라우저는 일반 Web UI 검증을 위해 네트워크에 접근할 수 있으므로 사용자가 요청하지 않은 내부 주소 탐색이나 loopback 인증을 다른 origin으로 전달하지 않는다.

완화:

- 인증 주입은 두 개의 명시된 loopback origin으로 제한
- gateway는 HA frontend와 전체 Core API/WebSocket proxy만 제공하고 범용 target forward proxy로 동작하지 않음. 모든 경로를 direct Core에 보내 dedicated read-only user permission을 일관되게 적용
- gateway upstream에서 X-Forwarded-For, X-Real-IP와 Forwarded를 제거하며 App/Docker 대역을 `trusted_proxies` 또는 `trusted_networks`에 추가하지 않음
- HTTPS frontend upstream과 auth bootstrap은 image CA bundle, SNI와 `homeassistant` hostname을 검증하며 자체 서명·hostname 불일치·신뢰할 수 없는 chain을 자동 우회하지 않음
- 외부 페이지에서 얻은 링크나 script 지시만으로 새 내부 endpoint를 탐색하지 않음
- navigation target과 관찰 결과를 작업 보고에 명시

### T-012 선택형 Codex 사용자 파일 갱신의 손실·비밀 유출

`refresh_all`은 사용자 `config.toml`의 MCP, model, provider, 내부 URL과 credential 설정을 image 기본본으로 되돌린다. 갱신 전 사본도 원본과 같은 수준의 비밀을 포함할 수 있으며 링크를 따라 쓰면 의도하지 않은 파일을 손상할 수 있다.

완화:

- option은 닫힌 enum으로 제한하고 누락/default를 `preserve`로 해석해 기존 설치의 최초 `0.2.3` 시작에서 자동 overwrite하지 않음
- `refresh_agents`와 `refresh_all`의 파괴 범위와 `config.toml` 사용자 설정 손실을 Home Assistant 구성 설명과 사용 문서에 명시
- 선택된 모든 target을 쓰기 전에 root-owned regular single-link file인지 preflight하고 symbolic link, 다중 hardlink, FIFO/device/directory 또는 불안전한 소유권이면 링크를 따라가지 않고 전체 refresh를 fail closed
- 기존 bytes, candidate와 hash/mode metadata를 `/data/codex/backups/user-files`의 root-only `0700` transaction directory와 `0600` 파일에 먼저 보존한 뒤 same-filesystem atomic rename 사용
- journal을 state보다 먼저 기록하고 설치 완료 후 target별 App version state를 durable commit record로 쓴다. commit 전 crash는 검증된 backup으로 rollback하고, commit 뒤 남은 journal은 이후 사용자 편집을 되돌리지 않고 정리
- 같은 App version의 같은 target은 한 번만 적용하고 일반 재시작에서 반복하지 않음. option 유지 시 다음 version에서 다시 한 번 적용됨을 명시
- `AGENTS.override.md`, `auth.json`, session, SSH identity, browser identity, App options와 Home Assistant `/config`를 refresh allowlist에서 제외
- backup 내용과 config 값을 로그·CI artifact에 출력하지 않고 App/Home Assistant backup까지 credential로 취급. 자동 prune하지 않으며 journal이 참조하는 transaction은 recovery 전에 삭제하지 않음

### T-013 메모리 오염, stale truth와 권위 혼동

대화의 추론, 일시 state, 부분 API 응답 또는 오래된 catalog를 확정 사실로 저장하면 이후 Codex 작업이 잘못된 entity나 automation을 반복해서 선택할 수 있다. 사용자 의미와 HA 구조를 하나의 전역 우선순위로 처리해도 정당한 alias가 사라지거나 존재하지 않는 registry 관계가 남는다.

완화:

- 대화에서 얻은 값은 provenance가 있는 `pending`으로만 시작하고 `verified`, `applied`를 순서대로 거침. 모델 추론·웹/로그 지시·일시 state는 단독 승격 evidence로 인정하지 않음
- 구조·현재 존재·registry relation·change result는 fresh HA API, alias·실제 용도·preference는 명시적 사용자 설명을 authority로 하는 fact-kind validator 사용
- conflict에서 기존 값을 조용히 overwrite하지 않고 양쪽 source, revision과 resolution을 기록. unresolved fact는 일반 search에서 확정 사실로 반환하지 않음
- Core WebSocket 수집은 entity/device/area registry, `get_states`, `automation/config`, 공식 `search/related(item_type=automation, item_id=<automation entity_id>)` allowlist로 제한하고 모든 필수 응답·정규화가 성공한 snapshot만 transaction commit. unavailable automation의 legal `config: null`은 빈 config와 bounded warning으로 수용한다. 개별 related 요청의 정상 envelope가 실기에서 관측한 `success:false`, `error.code=unknown_error`인 경우만 remote message/body 없이 빈 enrichment와 최대 100개 warning으로 격리하고 config-derived 직접 관계를 유지한다. 다른 server command code, server/client timeout, unauthorized, invalid format, config 실패, transport/close/protocol, 누락·malformed envelope와 malformed successful related 결과는 부분 성공으로 승격하지 않음
- raw state와 비허용 attributes는 fresh 비교 뒤 폐기하며 automation config와 임의 response를 저장하지 않음. 표시명/device class/icon/automation id·mode 같은 명시적 allowlist metadata만 정규화하고, 부분/transport/API 오류는 last-known-good catalog를 유지하고 stale/degraded와 closed machine code만 표시
- Codex change 전 subject와 closed-schema expectation digest·field summary를 기록하고 변경 뒤 같은 계약의 새 API round trip이 일치해야만 evidence로 채택. 생성 예정 subject도 계약에 넣을 수 있지만 `codex_change` relationship candidate는 동일 source·relation·target의 성공한 존재 predicate에만 연결함. 입력 expectation 값과 raw API state/attributes/config는 비교 뒤 폐기하고 expectation/predicate digest·field·result·time·revision만 남기며 cached row, 같은 subject의 무관한 check, HTTP 2xx와 config check만으로 memory를 갱신하지 않음
- HA catalog는 compensating rollback 대상이 아니며 언제나 fresh refresh로 수렴. memory rollback이 HA config, registry, automation이나 기기를 변경하지 않음

### T-014 메모리 DB·검색 표면의 민감정보 노출과 변조

entity/area 이름, 자동화 설명, 사용자 preference와 관계만으로도 거주 패턴과 내부 구조가 드러날 수 있다. unsafe database link, SQL/FTS query injection, 무제한 MCP dump 또는 Supervisor token 상속은 메모리와 App credential을 함께 노출할 수 있다.

완화:

- `/data/codex-ha-memory`는 root-owned `0700`, database/WAL/SHM은 `0600`; open 전 owner, regular-file, link count와 mode를 검사하고 symlink/hardlink/non-regular/unsafe ownership에서 memory만 fail closed
- v1 schema initialization/version gating과 mutation은 prepared statement, foreign key, check constraint, transaction과 application current-row/status precondition을 사용. 지원되지 않는 schema는 자동 migration하지 않고 query 문자열을 SQL/FTS expression으로 직접 연결하지 않음
- type-specific candidate schema와 제한된 provenance/evidence label을 사용하고 raw state, timestamp, 비허용 attributes, automation config, API response, `/config` 원문, 대화 transcript, prompt, token/credential과 비허용 field를 database, FTS, audit payload와 App log에 저장하지 않음
- `ha-memoryd` refresh와 MCP/CLI fresh verify는 root-only `/run/codex-ha/runtime.env`의 Core credential을 고정 Supervisor WebSocket proxy 첫 auth frame에만 사용. `HA_WS_URL` 환경 override, Upgrade credential header와 direct-Core credential fallback을 금지하고 image-pinned `ws`의 timeout/payload/compression/TLS 경계를 사용함. token/auth frame을 DB, argv, stdout/stderr나 log에 쓰지 않으며 daemon은 captured CLI 원문을 폐기하고 allowlist reason만 기록함. MCP wrapper는 `env -i`에서 시작해 allowlist 환경만 child에 넘기고 credential을 tool input/output에 노출하지 않음
- 일반 search는 canonical/비충돌 applied 결과만 row/field/32 KiB 상한 안에서 반환. exact show/history/conflict는 별도 row/field 한도와 MCP 2 MiB hard ceiling을 사용하고 pending/evidence/conflict/audit는 명시적 도구로 분리해 전체 DB dump를 model context에 제공하지 않음
- 모든 semantic mutation에 history-preserving actor/source/before/after audit를 남기고 rollback은 current-row precondition을 확인하는 compensating event로 수행. 과거 감사 event를 삭제하지 않고 원 event에는 rollback linkage만 기록
- DB와 Home Assistant App backup을 민감자료로 취급하고 fixture/CI에는 가짜 entity·area·사용자 값만 사용. secret scan은 SQLite dump와 MCP output fixture도 검사
- 손상·schema mismatch·lock 충돌에서 database를 자동 삭제하거나 빈 DB로 교체하지 않고 memory tool 오류 또는 catalog의 `degraded`/`stale` 상태를 반환. memory service 실패는 Codex/Web/SSH/browser의 availability와 분리

## 4. `manager` 선택 근거

`manager`는 CLI형 관리 App에 필요한 Supervisor 운영 권한을 제공하면서 `admin`보다 제한적이다. Core 기기 제어는 `homeassistant_api: true`로 별도 제공되므로 실제 서비스 호출을 위해 `admin`이 필요하지 않다.

manager가 특정 필요한 endpoint를 거부하면:

1. 정확한 endpoint와 HTTP 응답을 기록한다.
2. 대체 공식 경로를 찾는다.
3. 기능 영향도를 문서화한다.
4. 사용자의 명시적 승인 없이 admin으로 올리지 않는다.

## 5. Codex sandbox 해석

`codex_sandbox_mode: danger-full-access`는 Codex가 **컨테이너 안에서** App이 가진 권한을 사용할 수 있게 한다. Home Assistant App의 `full_access: true`와 동일하지 않다.

컨테이너 경계는 계속 다음을 막는다.

- Docker socket 접근
- host namespace 직접 제어
- 매핑하지 않은 host filesystem
- 부여하지 않은 Linux capabilities

다만 `/config`와 API는 의도적으로 강하게 열려 있으므로 App 자체를 관리자만 사용할 수 있어야 한다.

## 6. 보안 테스트

- 비밀번호 SSH 로그인 거부
- 잘못된 공개키 거부
- 빈 authorized_keys 시 로그인 불가
- `auth.json` 및 token이 `docker history`, App logs, CI artifacts에 없음
- API helper 오류 출력에 Authorization header 없음
- API helper가 허용하지 않은 media type과 CR/LF header injection을 요청 전에 거부
- Playwright MCP가 stdio로만 실행되고 외부 listener/새 App port를 만들지 않음
- 브라우저 도구 allowlist에 임의 code 실행, unrestricted file access/upload, codegen이 없음
- browser context가 isolated이고 profile, screenshot, trace, network 결과를 `/data`에 쓰지 않음
- fixture token이 process argv, App/MCP log, console/network 결과, screenshot metadata, `/run` 외 artifact에 없음
- loopback gateway가 container 외부에서 접근 불가하고 정확한 두 origin 외에는 token을 주입하지 않음
- browser credential이 active/local-only/non-system/non-admin이고 sole `system-read-only` group인지 검증하며 과권한 token을 거부
- 관리형 user가 credential-free이고 active refresh token이 expected client의 현재 LLAT 하나뿐인지 확인; provider 부재·동시 실행·partial credential create·hard-crash journal·token revoke 응답/connection-close race를 fixture로 검증
- option 누락/default ON 자동 생성, restart 동일 identity 재사용, OFF runtime 차단·persistent identity 보존·명시적 제거, ON 재활성화와 manual override ON/OFF를 fixture로 검증
- `codex debug prompt-input`과 filtered `browser_navigate` tool description에서 image-managed `127.0.0.1:8099` 우선 route를 확인하고 기존 사용자 config/AGENTS가 변경되지 않는지 update smoke로 검증
- user-file update option의 누락/default preserve, agents-only/all scope, target별 version one-shot, backup bytes·private mode, restart idempotency와 symlink/hardlink/non-regular fail-closed를 검증. refresh 대상 밖의 auth/session/SSH/browser identity/`/config`는 byte/fingerprint 수준으로 보존
- memory directory/database/WAL/SHM의 `0700`/`0600`, regular single-link/owner 검사, SQLite foreign key/check/transaction과 FTS5 가용성을 검증
- registry/get_states/`automation/config`·`search/related` fixture에서 allowlist field와 relation만 저장되고 raw state/비허용 attributes/config/response/conversation/secret이 DB·FTS·audit·log에 없음을 검사. exact automation item type/ID, active unavailable automation의 `config: null`, explicit related `unknown_error` 격리, config provenance와 실제 installed `ws` handshake를 포함함. Server `timeout`/`unauthorized`/`invalid_format`/`home_assistant_error`, client timeout, malformed envelope/result, close/protocol 실패는 계속 snapshot을 거부하는지 음성 검증
- pending→verified→applied 순서, HA canonical/user semantic authority, unresolved conflict 제외와 current-row/status precondition을 동적 검증
- post-change fresh API expectation 성공만 evidence로 인정하고 cached/2xx/config-check-only, timeout과 부분 실패에서는 applied memory가 불변인지 확인
- memory CLI/MCP search 결과의 row/field/32 KiB 한도, 다른 read의 별도 한도, pending/evidence/audit 분리, SQL/FTS metacharacter 처리와 전체 dump 부재를 검사
- history-preserving audit와 compensating rollback이 원 event/linkage를 보존하고 HA catalog/fixture Core를 변경하지 않는지 확인
- `ha-memoryd`/Core/DB 실패가 ttyd, SSH, Codex, ingress와 browser service를 중단시키지 않고 last-known-good의 `degraded`/`stale` 또는 tool unavailable 오류를 구분하는지 검사. token/auth/DNS/transport/protocol/command code는 보존하되 remote message와 credential은 daemon log/status에 남지 않고 환경 endpoint redirection도 무시하는지 확인
- 기존 사용자 AGENTS/config preserve update에서도 image-managed `ha_memory` MCP와 developer instruction이 존재하고 사용자 파일 bytes는 바뀌지 않는지 확인
- gateway의 `/auth/`, `/api/`, `/api/websocket`이 Supervisor proxy가 아니라 direct Core로 전달되고 forwarding identity header를 제거하는지 확인
- 현재 App socket IP와 Core가 관측한 source IP가 같아도 Docker IP 재사용 negative test 때문에 이를 persistent `trusted_networks` 신원으로 저장하지 않음
- nginx gateway와 Node HTTP/WebSocket bootstrap 모두 CA/hostname TLS 검증을 켜고 `proxy_ssl_verify off`가 없는지 확인
- Playwright 추가 후에도 `privileged`, `full_access`, `host_network`, 추가 Linux capability, AppArmor 비활성화가 없음
- 패널 `panel_admin: true`
- `hassio_role`이 manager인지 검사
- 금지 config key가 없는지 정책 테스트
- 실제 고위험 service call은 테스트 fixture/mock로 검증

## 7. 사고 대응

### Codex 인증 노출 의심

1. App 중지
2. Codex 계정에서 세션/연결 해제 또는 logout
3. `/data/codex/auth.json` 삭제
4. App 재시작 및 재인증
5. Git/로그/backup 공유 여부 확인

### Supervisor token 노출 의심

1. App 즉시 중지/재시작하여 runtime token 회전 여부 확인
2. 노출된 로그/파일 삭제 및 접근 차단
3. Home Assistant 관리자 세션과 관련 credentials 점검
4. 원인 수정 전 App 재사용 금지

### Dedicated browser token 노출 의심

1. 현재 `ha-browser-auth-status` source를 기록하고 자동 인증을 OFF로 저장한 뒤 App과 기존 browser session을 재시작
2. 이전 source가 관리형이면 App terminal에서 `ha-browser-auth-remove`를 실행하고, 실패하거나 수동 token이면 Home Assistant profile에서 해당 long-lived token/user를 즉시 revoke하며 App의 수동 `home_assistant_browser_token` option도 비움
3. `ha-browser-auth-status`가 fail closed이고 `/run/codex-ha/home-assistant-browser.token`이 없는지 확인
4. screenshot, snapshot, console/network 결과와 App backup의 접근 범위를 확인
5. 필요하면 자동 인증을 ON으로 전환해 새 관리형 identity를 만들거나 exact read-only/local-only 수동 token만 다시 설정

브라우저 renderer 경로에서 노출이 의심되면 MCP/App을 먼저 중지하고 App container 재생성 뒤 `/run/codex-ha/playwright-output`, 임시 browser token과 browser context가 폐기됐는지 확인한다. 저장하거나 공유한 screenshot·console/network 자료도 credential과 동일하게 회수·삭제한다.

### 설정 손상

1. App 또는 Codex 작업 중지
2. Git diff/commit으로 롤백
3. 설정 검사
4. 필요 시 Home Assistant backup 복원
5. 회귀 테스트 추가

### 메모리 오염·손상 또는 노출 의심

1. 새 memory mutation과 MCP session을 중지하되 Web/SSH 등 기존 복구 표면은 유지한다.
2. `ha-memory status`, database owner/type/link/mode, SQLite integrity와 최근 audit/conflict를 민감값을 출력하지 않는 방식으로 확인한다.
3. HA-derived catalog 오류는 과거 snapshot rollback 대신 Core를 정상화한 뒤 allowlist fresh refresh로 교정한다.
4. semantic memory 오류는 current row/status와 후속 dependency를 확인하고 compensating rollback을 실행한다. 원 audit event와 conflict는 삭제하지 않는다.
5. DB나 backup이 노출됐다면 entity/area/preference 정보를 민감자료로 간주해 공유 artifact 접근을 회수하고, token/secret 저장 가능성이 발견되면 관련 credential도 회전한다.
6. unsafe link/schema 손상은 자동 초기화하지 않는다. 필요하면 보호된 forensic copy와 사용자의 명시적 승인 뒤 새 DB를 bootstrap하고 복구 가능한 verified semantic event만 재적용한다.
7. 원인과 회귀 fixture를 추가한 뒤 bounded search와 non-fatal service 회귀를 다시 검증한다.

## 8. 실기 검증 경계

Alpine의 system `chromium-headless-shell` 조합은 upstream Playwright의 공식 Ubuntu/Debian browser bundle 대상과 다르다. 로컬 container fixture 통과만으로 HAOS 지원을 확정하지 않는다. Public `0.2.3`의 실제 HAOS에서 AppArmor 활성 상태의 browser 시작, loopback gateway, dashboard resource/WebSocket과 desktop/mobile 화면·console·network 경로가 동작했다고 사용자가 확인해 이 실기 항목은 **PASS**로 기록한다. 이는 upstream Alpine 지원 계약이나 모든 장치 보장을 뜻하지 않으며 Chromium·Playwright package revision이 바뀌면 재검증한다. token 원문 비노출은 자동 fixture/redaction smoke 증거와 계속 함께 판단한다.

검증형 메모리는 fixture의 SQLite/FTS5, state machine, allowlist와 failure injection이 통과해도 실제 HAOS의 Core WebSocket command 가용성, registry/automation 규모, Core restart 재연결, App update persistence와 S6 lifecycle을 완료로 간주하지 않는다. Public 0.3.0의 read-only HAOS 감사에서는 첫 catalog bootstrap이 FAIL했다. 정확한 public 0.3.1 image 자동 회귀는 PASS했지만 후속 실제 HAOS/Core `2026.7.2` 실기에서 `automation/config` 30건은 성공하고 automation-related 30건 중 2건이 Core `unknown_error`를 반환해 catalog bootstrap은 **FAIL**했다. 설치 무결성·Core 연결·daemon/DB·privacy는 PASS, Core restart의 daemon 생존·재연결은 PASS지만 fresh catalog 복구는 FAIL이라 PARTIAL, null-config는 NOT OBSERVED, candidate/change/App restart/update는 NOT RUN이다. Local 0.3.2 automatic image regression은 PASS했지만 실제 HAOS 재시험과 별도 기록하며, 실제 entity·area·automation 이름이나 memory DB를 저장소 증거로 커밋하지 않는다.
