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
| App bug/feature read-only report | image-managed Skill + local helper | 중간 | allowlist·privacy scan·private file로 허용 |
| GitHub issue search/submission | pinned `gh` + outbound HTTPS | 높음 | fixed repo·random 10분 1회용 preview·현재 대화 확인·exclusive claim 뒤 허용 |
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
- mobile Remote가 HA App SSH endpoint에 직접 연결하므로 ChatGPT 계정, 휴대폰, SSH 개인키, `authorized_keys`와 HA/VPN network 도달성을 모두 접근 경계로 취급

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

- 사용자가 한 exact subject에 직접·명확하게 설명한 지속 사실만 `memory_remember_explicit`로 받고 source를 server-side `user_explicit`로 고정함. 이 결합 경로도 기존 pending 생성→user-explicit 검증→apply 함수를 순서대로 호출해 audit/status 검사를 건너뛰지 않으며 transient key/value와 “지금/오늘/probably/아마” 같은 명백한 시간·불확실성 표현은 server도 write 전에 거부함. Household-wide subject는 `home:household`만 허용하고 그 밖의 ambiguity는 caller가 write 전에 확인함
- 그 밖의 대화·분석 값은 provenance가 있는 `pending`으로만 시작하고 `verified`, `applied`를 순서대로 거침. 모델 추론·웹/로그 지시·일시 state는 user-explicit로 라벨링하거나 단독 승격 evidence로 인정하지 않음
- 구조·현재 존재·registry relation·change result는 fresh HA API, alias·실제 용도·preference는 명시적 사용자 설명을 authority로 하는 fact-kind validator 사용
- conflict에서 기존 값을 조용히 overwrite하지 않고 양쪽 source, revision과 resolution을 기록. unresolved fact는 일반 search에서 확정 사실로 반환하지 않음
- Core WebSocket 수집은 entity/device/area registry, `get_states`, `automation/config`, 공식 `search/related(item_type=automation, item_id=<automation entity_id>)` allowlist로 제한하고 모든 필수 응답·정규화가 성공한 snapshot만 transaction commit. unavailable automation의 legal `config: null`은 빈 config와 bounded warning으로 수용한다. 개별 related 요청의 정상 envelope가 실기에서 관측한 `success:false`, `error.code=unknown_error`인 경우만 remote message/body 없이 빈 enrichment와 최대 100개 warning으로 격리하고 config-derived 직접 관계를 유지한다. 다른 server command code, server/client timeout, unauthorized, invalid format, config 실패, transport/close/protocol, 누락·malformed envelope와 malformed successful related 결과는 부분 성공으로 승격하지 않음
- raw state와 비허용 attributes는 fresh 비교 뒤 폐기하며 automation config와 임의 response를 저장하지 않음. 표시명/device class/icon/automation id·mode 같은 명시적 allowlist metadata만 정규화하고, 부분/transport/API 오류는 last-known-good catalog를 유지하고 stale/degraded와 closed machine code만 표시
- 지속 Codex change 전 subject와 지원되는 closed-schema expectation digest·field summary를 기록하고 mutation/reload 뒤 같은 계약의 새 API round trip이 일치해야만 evidence로 채택. Read/diagnostic/catalog refresh/transient device test는 제외하고, 표현 불가 또는 memory unavailable이면 semantic memory를 갱신하지 않은 채 검증 공백을 밝히고 mutation 진행 여부를 확인함. 생성 예정 subject도 계약에 넣을 수 있지만 `codex_change` relationship candidate는 동일 source·relation·target의 성공한 존재 predicate에만 연결함. 입력 expectation 값과 raw API state/attributes/config는 비교 뒤 폐기하고 expectation/predicate digest·field·result·time·revision만 남기며 cached row, 같은 subject의 무관한 check, HTTP 2xx와 config check만으로 memory를 갱신하지 않음
- HA catalog는 compensating rollback 대상이 아니며 언제나 fresh refresh로 수렴. memory rollback이 HA config, registry, automation이나 기기를 변경하지 않음

### T-014 메모리 DB·검색 표면의 민감정보 노출과 변조

entity/area 이름, 자동화 설명, 사용자 preference와 관계만으로도 거주 패턴과 내부 구조가 드러날 수 있다. unsafe database link, SQL/FTS query injection, 무제한 MCP dump 또는 Supervisor token 상속은 메모리와 App credential을 함께 노출할 수 있다.

완화:

- `/data/codex-ha-memory`는 root-owned `0700`, database/WAL/SHM은 `0600`; open 전 owner, regular-file, link count와 mode를 검사하고 symlink/hardlink/non-regular/unsafe ownership에서 memory만 fail closed
- v1 schema initialization/version gating과 mutation은 prepared statement, foreign key, check constraint, transaction과 application current-row/status precondition을 사용. 지원되지 않는 schema는 자동 migration하지 않고 query 문자열을 SQL/FTS expression으로 직접 연결하지 않음
- type-specific candidate schema와 제한된 provenance/evidence label을 사용하고 raw state, timestamp, 비허용 attributes, automation config, API response, `/config` 원문, 대화 transcript, prompt, token/credential과 비허용 field를 database, FTS, audit payload와 App log에 저장하지 않음. Entity별 memory/candidate/catalog data도 AGENTS 계열 파일에 쓰지 않도록 model-visible system/default 지침에 고정함
- `ha-memoryd` refresh와 MCP/CLI fresh verify는 root-only `/run/codex-ha/runtime.env`의 Core credential을 고정 Supervisor WebSocket proxy 첫 auth frame에만 사용. `HA_WS_URL` 환경 override, Upgrade credential header와 direct-Core credential fallback을 금지하고 image-pinned `ws`의 timeout/payload/compression/TLS 경계를 사용함. token/auth frame을 DB, argv, stdout/stderr나 log에 쓰지 않으며 daemon은 captured CLI 원문을 폐기하고 allowlist reason만 기록함. MCP wrapper는 `env -i`에서 시작해 allowlist 환경만 child에 넘기고 credential을 tool input/output에 노출하지 않음
- 일반 search는 canonical/비충돌 applied 결과만 row/field/32 KiB 상한 안에서 반환. Exact show/history/conflict는 별도 row/field 한도와 MCP 2 MiB hard ceiling을 사용하고 candidate follow-up도 exact subject/status와 최대 20건으로 제한해 전체 DB dump를 model context에 제공하지 않음
- 모든 semantic mutation에 history-preserving actor/source/before/after audit를 남기고 rollback은 current-row precondition을 확인하는 compensating event로 수행. 과거 감사 event를 삭제하지 않고 원 event에는 rollback linkage만 기록
- DB와 Home Assistant App backup을 민감자료로 취급하고 fixture/CI에는 가짜 entity·area·사용자 값만 사용. secret scan은 SQLite dump와 MCP output fixture도 검사
- 손상·schema mismatch·lock 충돌에서 database를 자동 삭제하거나 빈 DB로 교체하지 않고 memory tool 오류 또는 catalog의 `degraded`/`stale` 상태를 반환. memory service 실패는 Codex/Web/SSH/browser의 availability와 분리

### T-015 브라우저 full-auto 설정의 과도한 신뢰

Playwright 승인창을 줄이는 옵션을 browser 권한 경계나 Home Assistant 변경 승인으로 오해하면 page prompt injection 또는 잘못된 agent 판단이 UI 조작으로 이어질 수 있다. top-level Codex `never`와 browser `always`를 함께 설정했을 때 후자가 팝업을 강제한다고 오해할 위험도 있다.

완화:

- 신규·누락값은 `safe`로 두고 탐색·snapshot·screenshot·console/network 같은 11개 동작만 approve하며 click/form/key/select/type 5개는 prompt로 명시
- full-auto `never`도 enforcement proxy의 현재 16개 allowlist에만 적용하고 code evaluation, arbitrary file upload/output와 상세 request 도구는 계속 차단
- server default를 `prompt`로 두어 미래 도구가 검토 없이 자동 승인되지 않게 하고 helper/system config/proxy 집합을 contract test로 고정
- `codex_approval_policy=never`가 full-write profile에서 MCP prompt를 전역 자동 승인할 수 있어 browser safe/always보다 우선할 수 있음을 UI·문서에 명시
- MCP popup 생략은 현재 사용자 요청의 범위 확장이 아니며 실제 Home Assistant 변경·고위험 장치 규칙과 변경 후 검증 지침을 계속 적용
- App option은 wrapper의 CLI config로 적용하고 사용자 `config.toml`, `AGENTS.md`, browser credential을 덮어쓰지 않음. invalid enum/type은 fail closed

자동 검증 상태: 동일 merge SHA의 main CI [`29408206017`](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29408206017)과 tag Builder [`29408467932`](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29408467932), 정확한 public `0.4.0` image의 browser approval policy/full browser·gateway·Core WebSocket·ttyd·SSH/public `0.3.2` → `0.4.0` update smoke는 **PASS**다. 후속 실제 HAOS `never` mode에서는 14개 허용 도구가 MCP 승인 요청 0회로 PASS했고 desktop/mobile 자동 인증 dashboard와 비파괴 입력 경로가 동작했다. `select_option`과 `close`는 NOT TESTED이며 `safe`/`always`, `codex_approval_policy=never` precedence, 금지 도구, Configuration UI/default, AppArmor 활성 여부, user-file/identity 보존과 live HA update 감지는 **NOT RUN**이다.

### T-016 피드백 보고서의 개인정보·prompt injection 유출

사용자 설명, 환경 정보와 GitHub 유사 이슈 title에는 credential, 내부 URL/IP, Home Assistant 식별자 또는 외부의 악성 지시문이 포함될 수 있다. 이를 자동 보고서나 다음 Codex 지시로 합치면 정보 유출과 prompt injection이 발생한다.

완화:

- 피드백 조사는 read-only로 고정하고 Home Assistant 설정·registry·dashboard·automation·device·App·프로젝트 변경, service call, reload/restart, update, recovery와 restore를 금지. 조사 중에는 보고서 bundle 외 local write를 만들지 않고, 제출 단계의 추가 write는 root-only runtime preview state와 bundle 내부 claim/receipt로 제한
- Environment는 App/Codex/Core/Supervisor/OS version, architecture와 여섯 safe App option만 allowlist함. Init은 원본 App option 검증 중 여섯 비민감 값만 root-only runtime snapshot에 투영하고 collector는 `/data/options.json`을 다시 열지 않음. 로그, screenshot, raw API response, conversation transcript와 임의 `/config` 파일을 자동 수집하지 않음
- Skill input은 group/other access가 없는 `0600` regular single-link private file로 받고 argv에 본문을 넣지 않으며 stdin 입력은 거부. `/config/codex-workspace/feedback` 아래 real managed directory/file만 `0700`/`0600`으로 정규화해 exclusive/no-follow/atomic write하며 symlink, hardlink, non-regular path와 root escape에서 fail closed
- Control/ANSI sequence, auth/cookie/assigned secret/Bearer/API key/JWT/private key, base64 blob, URL, IPv4/IPv6, email, UUID, Home Assistant user/entity/device/area 식별자와 `auth.json`, `.storage`, `secrets.yaml`, database, backup path를 privacy scanner가 collect·validate·preview·submit마다 차단
- `public-report.md`는 validated `report.json`의 deterministic renderer output과 exact parity를 유지하고 손으로 편집한 body나 privacy 검사를 거치지 않은 자료는 제출하지 않음
- 각 check는 `PASS`, `FAIL`, `NOT_TESTED`, `NOT_RUN` 중 하나와 evidence/reason을 가져야 하며 미실행·미관측 결과를 추측하지 않음
- GitHub candidate는 최대 5개 title/URL만 fixed repository에서 받고 title을 신뢰하지 않는 외부 입력으로 정제. Candidate body, comment, page instruction을 읽거나 Codex/Skill 지시로 승격하지 않음
- 취약점, credential 노출 또는 security indicator가 있으면 public candidate search, preview, Issue Form URL과 submit을 모두 차단하고 `https://github.com/Kanu-Coffee/codex-for-home-assistant/security/advisories/new` private vulnerability reporting 경로만 안내

### T-017 GitHub credential·무단 외부 제출·공급망 위험

GitHub login은 `/data`에 평문 credential을 남길 수 있고 Home Assistant App backup에 포함될 수 있다. 상속 PAT, 변조된 `gh`, 오래된 confirmation 또는 임의 repository가 사용되면 계정·저장소에 승인되지 않은 외부 변경이 생길 수 있다.

완화:

- 공식 GitHub CLI `2.93.0` linux amd64 archive만 image build에서 SHA-256 `02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0`로 검증하고 runtime download, `latest`와 임의 executable을 사용하지 않음
- `GH_CONFIG_DIR=/data/github-cli`와 하위 directory를 root-owned `0700`, regular single-link file을 `0600`으로 유지. Symlink/non-directory/non-root-owned root path는 자동 chown하거나 따라가지 않고 login/direct submission만 비활성화하며 safe real path의 private mode만 정규화
- Login/logout은 명시적 사용자 요청에서만 실행하고 browser/device login 전에 App backup이 평문 GitHub credential을 포함할 수 있다는 위험을 별도로 확인. PAT/token을 App option, prompt, argv 또는 report로 요청하지 않음
- Helper가 `HOME`, locale, fixed `PATH`, `GH_CONFIG_DIR`, `NO_COLOR`만 가진 clean child environment를 만들고 `GH_TOKEN`, `GITHUB_TOKEN`, `SUPERVISOR_TOKEN`, `NODE_OPTIONS`, `BASH_ENV`, `ENV` 등 상속 credential/injection을 제거
- Repository는 `Kanu-Coffee/codex-for-home-assistant`, label은 `bug`/`enhancement`로 고정하고 성공 URL도 같은 repository issue path인지 확인
- 유사 이슈 후보와 exact repo/title/label/body path를 먼저 표시. Candidate 검색이 성공한 경우에만 repo/title/label/full body에 결합한 cryptographically random token을 root-only runtime state에 저장. Token은 10분 만료·1회용이며 현재 사용자 turn의 별도·명확한 confirmation이 모두 있어야 제출. 최초 요청·이전 대화 confirmation을 재사용하지 않고 wrong/expired/used token이나 실패한 확인 뒤에는 fresh preview를 요구
- Candidate 검색과 confirmed submit 직전 remote exact report ID 중복 검색을 fail closed로 처리. 검색 실패·malformed 결과에서는 create하지 않고 Web Form fallback을 제공
- Confirmed submit도 privacy/render/auth를 재검사하고 exclusive `.submission.lock`을 얻은 뒤 validated Markdown을 메모리에서 `--body-file -` stdin으로 전달. Payload 변경, 이미 존재하는 receipt/report ID, fixed repo 밖 URL을 거부하고 concurrent submit은 claim으로 직렬화
- 성공 URL 검증과 receipt write 뒤에만 claim을 제거. `gh` 실패, 예상 밖 URL 또는 receipt write 실패는 외부 side effect가 불확실하므로 hidden `.submission.lock`을 보존해 direct retry를 차단
- 미인증·검색 불가·실패에서 자동 retry/token fallback을 하지 않고 report를 보존. 긴 body를 URL에 넣지 않는 Issue Form을 제공하며, 외부 결과가 불확실하면 기존 이슈를 먼저 확인한 뒤 browser 최종 제출은 사용자가 수행
- Feedback MCP/API/App route/service/webhook/Action/telemetry/upload endpoint를 만들지 않아 별도 inbound 공격면과 무인 제출 경로를 추가하지 않음

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
- direct explicit remember의 source 고정, 세 audit transition, idempotent already-applied와 반복 unresolved conflict dedupe, transient/uncertain/canonical rejection을 검증하고, 별도 candidate의 pending→verified→applied 순서, HA canonical/user semantic authority, unresolved conflict 제외와 current-row/status precondition도 동적 검증
- post-change fresh API expectation 성공만 evidence로 인정하고 cached/2xx/config-check-only, timeout과 부분 실패에서는 applied memory가 불변인지 확인
- memory CLI/MCP search 결과의 row/field/32 KiB 한도, exact-subject candidate list 20건 한도, reject audit, 다른 read의 별도 한도, pending/evidence/audit 분리, SQL/FTS metacharacter 처리와 전체 dump 부재를 검사
- history-preserving audit와 compensating rollback이 원 event/linkage를 보존하고 HA catalog/fixture Core를 변경하지 않는지 확인
- `ha-memoryd`/Core/DB 실패가 ttyd, SSH, Codex, ingress와 browser service를 중단시키지 않고 last-known-good의 `degraded`/`stale` 또는 tool unavailable 오류를 구분하는지 검사. token/auth/DNS/transport/protocol/command code는 보존하되 remote message와 credential은 daemon log/status에 남지 않고 환경 endpoint redirection도 무시하는지 확인
- 빈 store에서 daemon run이 수동 refresh 없이 첫 catalog를 생성하는지 확인하고, container replacement 뒤 새 MCP process가 MCP-applied fact를 회상하는지 검사한다. 기존 사용자 AGENTS/config preserve update에서도 image-managed `ha_memory` MCP와 developer instruction이 bounded search·explicit remember와 CLI fallback·persistent change verification·unsupported automation logic 경계·AGENTS data 비누적 규칙을 model input에 제공하면서 사용자 파일 bytes는 바뀌지 않는지 확인
- `$ha-feedback` Skill의 explicit/natural-language routing, bug/feature schema, exact status/overall 계산과 deterministic JSON/Markdown parity를 fixture로 검사
- malicious feedback fixture의 secret, URL/IP, HA identifier, sensitive path, control/ANSI sequence가 collect/validate/preview/submit 전에 fail closed되고 logs/screenshots/raw responses가 report에 자동 포함되지 않는지 검사
- Feedback input/report/GitHub config path의 0700/0600, regular single-link/owner/type/mode와 root containment를 검사하고 symlink/hardlink/FIFO/unsafe ownership에서 대상 변경 없이 실패하는지 확인
- Fake `gh` 환경에서 미인증, login backup-risk 거부, candidate title 정제, candidate/remote duplicate 검색 fail-closed, preview-only, random·10분 만료·1회용 token, wrong/stale/changed token 거부, 현재 turn confirmation, 동시 submit, 성공, external-result-uncertain lock, duplicate receipt와 fixed repository/label/`--body-file -` stdin을 동적 검증
- GitHub CLI `2.93.0` archive checksum pin, `/data/github-cli` update persistence, clean child environment의 `GH_TOKEN`/`GITHUB_TOKEN`/`SUPERVISOR_TOKEN` 제거와 App backup 평문 credential 경고를 검사
- Security indicator가 public search/preview/url/submit을 차단하고 private vulnerability route만 반환하는지, 미인증/검색 불가/실패 폴백 URL에 긴 body나 secret이 없고 자동 retry하지 않는지 검사. 외부 write의 실패·모호한 출력·receipt 실패 뒤 direct retry가 `.submission.lock`으로 차단되는지 확인
- Feedback 경로에 MCP/API/App route/service/hook/Action/telemetry/upload가 없고 조사 중 Home Assistant mutation/service/restart/update/recovery helper가 호출되지 않는지 정적·동적 검사
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

### GitHub CLI credential 또는 피드백 보고서 노출 의심

1. Direct submission을 중지하고 `ha-feedback github logout`으로 persisted `github.com` login을 제거한다.
2. GitHub account의 authorized OAuth application/session을 점검하고 필요하면 revoke한다.
3. `/data/github-cli`와 이를 포함할 수 있는 Home Assistant App backup의 접근·공유 범위를 회수한다.
4. 노출된 report가 있다면 issue/body와 local bundle에서 credential, 내부 URL/IP, HA identifier와 민감 path 포함 여부를 확인하고 공개 이슈는 maintainer와 함께 비공개 전환·삭제·정제한다.
5. 취약점 가능성이 있으면 공개 issue를 추가하지 않고 private vulnerability reporting으로 이동한다.
6. Privacy/fake-`gh`/path regression을 통과하기 전 direct submission을 다시 사용하지 않는다.

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

Public `0.4.0`의 정확한 공개 image 자동 회귀와 후속 실제 HAOS `never` mode 14/16 도구·승인 0회·desktop/mobile 인증 dashboard는 PASS했다. 그러나 전체 Configuration UI popup 행렬, top-level `codex_approval_policy=never` precedence, `select_option`/`close`, 금지 도구, AppArmor 활성 여부, user-file/identity 보존과 live HA update 감지는 **NOT TESTED/NOT RUN**이다. 따라서 위 public `0.2.3` 사용자 확인 PASS를 새 AppArmor 증거로 승격하거나 부분 `never` 결과를 전체 `0.4.0` 실기 PASS로 확대하지 않는다.

검증형 메모리는 fixture의 SQLite/FTS5, state machine, allowlist와 failure injection이 통과해도 실제 HAOS의 Core WebSocket command 가용성, registry/automation 규모, Core restart 재연결, App update persistence와 S6 lifecycle을 완료로 간주하지 않는다. Public 0.3.0의 read-only HAOS 감사에서는 첫 catalog bootstrap이 FAIL했다. 정확한 public 0.3.1 image 자동 회귀는 PASS했지만 후속 실제 HAOS/Core `2026.7.2` 실기에서 `automation/config` 30건은 성공하고 automation-related 30건 중 2건이 Core `unknown_error`를 반환해 catalog bootstrap은 **FAIL**했다. Public `0.3.2` 재시험에서는 동일 2/30 오류가 config와 직접 관계를 보존한 bounded warning으로 격리됐고 catalog/DB/CLI·MCP/privacy/candidate/restart 요청 후 fresh sync/App restart persistence가 PASS했다. Actual runtime OCI digest는 Supervisor App info가 제공하지 않아 NOT RUN이고, probe에 Core 단절이나 failed refresh가 없어 disconnect/reconnect와 순간 LKG `stale/degraded`는 NOT OBSERVED이며, null-config도 NOT OBSERVED, 오류 주입과 version-tagged update는 NOT RUN이므로 최종 판정은 **PARTIAL(FAIL 0)**이다. 이 증거 공백을 해소하려고 `docker_api`, host access나 운영 장애 주입을 도입하지 않으며 실제 entity·area·automation 이름이나 memory DB를 저장소 증거로 커밋하지 않는다.

검증형 App 피드백 `0.6.0`은 local fixture/fake `gh`/container/update 검증과 실제 HAOS report 생성·fallback 검증을 구분한다. 실제 GitHub issue creation은 공개 repository에 지속적인 외부 변경을 남기므로 별도 승인 전까지 **NOT RUN**이며, 이를 preview·fake `gh` 성공으로 PASS 처리하지 않는다.
