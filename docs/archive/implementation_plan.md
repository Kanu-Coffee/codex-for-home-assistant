# implementation_plan.md — 구현 계획

> [!CAUTION]
> 초기 MVP 구현 계획을 보관한 문서입니다. 완료되었거나 현재 구조와 다른 단계가 포함되어 있으므로 새 작업 계획의 기준으로 사용하지 마세요.

## 1. 구현 전략

MVP는 “모든 파일을 먼저 만든 뒤 나중에 디버깅”하지 않는다. 아래 수직 단계마다 컨테이너가 시작되고 관찰 가능해야 한다.

## Phase 0 — 환경 확인 및 저장소 준비

### 작업

1. `git status`, `git remote -v`, `gh auth status` 확인
2. 현재 공식 Home Assistant `apps-example`를 참고해 저장소 구조 확정
3. 현재 OpenAI Codex 설치·인증·Remote SSH 문서 재확인
4. remote가 없으면 private GitHub repo `codex-for-home-assistant` 생성
5. `feat/mvp-runtime` 브랜치 생성

### 완료 조건

- 저장소와 branch가 명확함
- 공식 근거 링크가 `references.md`에 최신화됨
- `progress.md` Current Work 작성

## Phase 1 — 최소 App 부팅

### 구현

- `repository.yaml`
- `codex_home_assistant/config.yaml`
- 최소 Dockerfile
- S6 init/service 구조
- ttyd 없이도 로그를 남기는 keepalive 또는 health service

### 테스트

- YAML schema/lint
- Docker build
- 컨테이너 start/exit code
- `/config`, `/data` path 검증

### 완료 조건

App 골격이 빌드되고 Supervisor local App로 인식 가능한 형태다.

## Phase 2 — 영속 디렉터리와 Codex CLI

### 구현

- 필수 package 설치
- Codex CLI pin 설치
- `/data/home`, `/data/codex` 초기화
- 기본 config merge/creation
- `ha-codex`, `ha-codex-login`

### 테스트

- `codex --version`
- 컨테이너 재생성 후 `/data` fixture 유지
- auth 파일 권한
- existing config 보존

### 완료 조건

일반 shell에서 `/config`를 작업 경로로 Codex를 실행할 수 있다.

## Phase 3 — Ingress Web Terminal

### 구현

- ttyd service
- Ingress config
- tmux wrapper
- auto-start option

### 테스트

- ttyd process health
- auto-start true/false command test
- tmux attach/create
- WebSocket/Ingress는 HAOS 실기 표시

### 완료 조건

HAOS Web UI에서 shell/Codex가 사용 가능하고 재접속 시 세션이 유지된다.

## Phase 4 — SSH 및 Remote SSH

### 구현

- sshd config
- host key persistence
- authorized_keys renderer
- runtime shell env
- SSH default port mapping

### 테스트

- `sshd -t`
- password auth 거부
- public key 성공
- host key 재시작 유지
- `ssh host 'command -v codex; codex --version; pwd'`
- Codex Desktop Remote SSH 실기

### 완료 조건

일반 SSH와 Codex Desktop remote project가 모두 동작한다.

## Phase 5 — Core/Supervisor API 운영 도구

### 구현

- 안전한 token runtime propagation
- `ha-api`, `supervisor-api`
- `ha-config-check`, log helpers
- API 사용 DOCS

### 테스트

- fake token fixture로 header redaction
- mock HTTP success/error
- 기본 JSON과 로그 `text/x-log` 협상, 잘못된 media type/header injection 거부
- Core `/config` 또는 `/states` 조회
- safe test entity service call
- Supervisor `/core/check` 및 logs
- manager permission matrix

### 완료 조건

Codex가 설정·상태·로그를 분석하고 안전한 실제 동작을 시험할 수 있다.

## Phase 6 — 품질, 문서, CI

### 구현

- shellcheck/yamllint/hadolint
- pytest 또는 shell-based integration tests
- GitHub Actions lint/build
- DOCS/CHANGELOG/translations
- GHCR publish 준비

### 완료 조건

모든 가능한 자동 검증이 CI에서 통과하고 미검증 HAOS 항목이 명시된다.

## Phase 7 — GitHub delivery

### 작업

1. 최종 diff 검토
2. `progress.md` 업데이트
3. 의미 있는 commit 생성
4. feature branch push
5. PR 생성
6. PR 본문에 테스트 결과, 실기 미검증, 보안 권한 명시

### 완료 조건

GitHub에서 코드를 검토하고 다음 HAOS 실기 작업을 바로 시작할 수 있다.

## Phase 8 — 검증형 Home Assistant 메모리

기존 운영 기능과 독립된 작은 수직 단위로 구현하며 memory 실패가 App 부팅을 막지 않는 상태를 각 단계에서 유지한다.

### 8.1 저장소와 non-fatal service

구현:

- `/data/codex-ha-memory` `0700`, `memory.sqlite3`와 WAL/SHM `0600`
- SQLite FTS5, v1 schema initialization/version gating, foreign key/check와 prepared WAL/busy-timeout transaction
- `ha-memory-core.mjs`, `ha-memory.mjs`, `/usr/local/bin/ha-memory`
- interactive/ingress/browser S6 graph와 독립돼 빈 store의 longrun 시작 직후 첫 `ha-memory refresh`를 실행하고 이후 주기적으로 반복하는 `ha-memoryd` scheduler, retry/backoff와 status

테스트:

- clean first boot, daemon run의 무수동 첫 catalog, 반복 v1 initialization, unsupported schema fail-closed와 restart/update persistence
- unsafe owner/type/link/mode, DB lock/corruption과 unsupported schema의 memory-only fail closed
- daemon/Core 실패 상태에서도 Codex, ttyd, SSH, ingress와 browser smoke 성공

완료 조건: empty store를 안전하게 생성·조회하고 memory service 실패를 기존 App 기능과 분리한다.

### 8.2 HA catalog bootstrap과 refresh

구현:

- `ha-memory-ha-client.mjs`의 고정 Supervisor Core WebSocket proxy client, image-pinned `ws` timeout/payload/compression/TLS 경계와 root-only runtime env allowlist 전달. 환경 endpoint override나 direct-Core credential fallback은 두지 않음
- entity/device/area registry list, `get_states`, `automation/config`, 공식 `search/related(item_type=automation, item_id=<automation entity_id>)` command allowlist. 의미가 다른 `item_type=entity` graph fallback은 사용하지 않음
- object/relationship allowlist normalization, unavailable automation의 legal `config: null` → empty config/bounded warning 처리. 개별 related의 정상 envelope `success:false`, `error.code=unknown_error`만 config-derived 직접 관계와 bounded warning으로 격리하고, 다른 server command code·config·server/client timeout·unauthorized·invalid format·transport/close/protocol·malformed 응답 실패는 complete snapshot staging과 atomic revision commit 전에 거부
- last-known-good, stale/degraded 상태와 Core restart reconnect
- token/DNS/transport/timeout/auth/protocol/고정 command/snapshot closed code를 sync/change/CLI에 보존하고 daemon은 captured 원문 없이 allowlist code만 log
- raw state/비허용 attributes/config/response, `/config`, 대화/prompt, token/secret 비저장

테스트:

- deterministic Core fixture의 first/full/incremental-equivalent refresh와 idempotency
- unavailable automation null-config 성공, explicit related `unknown_error` 격리, config provenance, server `timeout`/`unauthorized`/`invalid_format`/`home_assistant_error`, unsupported/malformed command result, client timeout, 일부 필수 automation detail 실패, malformed/oversized field와 transport interruption
- installed `ws`의 Supervisor-style auth/snapshot, `HA_WS_URL` redirection 거부, 단계별 diagnostic code와 원문/secret 비노출
- DB/FTS/audit/log/argv에 raw fixture marker와 token이 없는지 음성 검사

완료 조건: 완전한 허용 응답만 canonical catalog revision으로 commit되고 실패는 이전 revision을 보존한다.

### 8.3 candidate, authority와 post-change verification

구현:

- `memory_items`의 `pending → verified → applied`, provenance/evidence와 transactional current-row/status precondition
- HA canonical fact와 explicit-user semantic fact의 kind별 validator
- conflict 기록·resolution과 unresolved 기본 검색 제외
- 직접·명확한 사용자 사실을 server-side `user_explicit`로 고정해 기존 propose→verify→apply를 한 호출에서 실행하는 `memory_remember_explicit`/`ha-memory remember`; transient/reserved canonical relation 거부, already-applied와 conflict 결과
- `ha-memory candidate add --value-json`, evidence/verify/apply workflow
- persistent configuration/registry/automation mutation의 `change begin --subjects-json --expect-json` 기존/생성 예정 subject, pre-change digest/field summary와 같은 계약을 사용하는 mutation/reload 후 fresh API 기반 `change verify --expect-json`; read/diagnostic/catalog refresh/transient device test는 제외하고 표현 불가/unavailable은 semantic memory 미갱신과 사용자 고지. `codex_change` relationship candidate는 동일 source·relation·target의 성공 predicate에만 연결

테스트:

- 단계 건너뛰기, 추론/일시 state 단독 evidence와 stale current-row/status 거부
- fact kind별 authority matrix, conflict open/resolve와 applied revision
- explicit remember 세 audit transition, duplicate resume/idempotency, transient/canonical rejection과 same-authority conflict
- cache/2xx/config-check-only, timeout·부분 expectation 실패에서 memory 불변

완료 조건: 검증되지 않은 정보가 active context에 들어가지 않고 Codex change 결과가 fresh HA evidence로만 반영된다.

### 8.4 bounded retrieval, MCP와 recovery

구현:

- 최대 256자 query, 기본 8·최대 20 subject와 JSON 32 KiB 상한의 exact entity/alias·FTS5 rank 기반 CLI search, 별도 row/field 한도의 show/status
- `ha-memory-mcp.mjs`, `/usr/local/bin/ha-memory-mcp`, optional STDIO `[mcp_servers.ha_memory]`; wrapper는 최소 환경에서 runtime env를 source해 fresh verify child에만 Core credential 전달
- search/show/explicit-remember/propose/candidate-list·reject/evidence/verify/apply/change/history/conflict/rollback/status tool schema와 search 32 KiB·candidate exact-subject/status 20건·다른 read row/field·MCP hard output limit
- history-preserving audit event/change, compensating rollback과 HA catalog rollback 금지
- 새 기본 `AGENTS.md`에는 규칙·경로만 추가하고 entity별 data 비누적을 명시. `/etc/codex/config.toml` developer instruction과 MCP description에도 bounded lookup, empty/degraded/stale 고지, same-request explicit remember와 persistent-change 규칙 제공

테스트:

- 관련 canonical/applied result만 bounded 출력, pending/raw evidence/full audit 기본 제외
- SQL/FTS metacharacter와 oversized input/output 처리
- bounded candidate list/reject와 실제 MCP explicit remember의 persistence
- audit before/after/linkage 보존, current-row rollback과 HA fixture 불변
- 기존 사용자 AGENTS/config가 byte 보존된 update에서 system MCP discovery와 model-visible instruction 확인

완료 조건: 매 HA 요청은 전체 DB가 아니라 제한된 관련 결과만 사용하고, 기존 설치도 사용자 파일 overwrite 없이 image-managed memory 경로를 발견한다.

### 8.5 검증 경계와 전달

- L1 contract, Node/SQLite fixture, Python contract, syntax/lint, secret scan과 container smoke를 실행한다.
- 실제 HAOS 전에는 Core WebSocket command 호환, registry/automation 규모, Core restart reconnect와 App update persistence를 완료로 표시하지 않는다.
- public 0.3.0 read-only audit의 catalog FAIL과 진단 손실은 0.3.1에서 자동 회귀로 보완했지만, 후속 public 0.3.1 실제 HAOS에서는 automation-related 30건 중 2건의 Core `unknown_error`로 catalog가 다시 FAIL했다. Public 0.3.2의 자동·정확한 공개 image 회귀와 후속 실제 HAOS 재시험을 별도 증거로 기록한다. 실제 재시험은 동일 2/30 오류 격리와 catalog/DB/CLI·MCP/privacy/candidate/restart 요청 후 fresh sync/App restart persistence를 PASS했고, runtime OCI digest NOT RUN과 Core disconnect/reconnect·LKG 상태 미관측 때문에 PARTIAL(FAIL 0)이다.
- HAOS E2E에서는 실제 이름·DB/token을 artifact로 남기지 않고 first bootstrap, semantic candidate, safe post-change expectation, bounded search, rollback과 non-fatal degradation을 확인한다.

완료 조건: 자동 수용 기준과 별도 HAOS E2E가 각각 증거를 가지며 어느 한쪽으로 다른 쪽을 대체하지 않는다.

## Phase 9 — Playwright 승인 정책 UI

- `browser_approval_policy: safe|never|always`를 App schema와 영·한 번역에 추가하고 누락값은 safe로 처리한다.
- 공통 helper가 safe 11개와 interactive 5개 allowlist를 관리한다. system Playwright default는 prompt이며 known tool 16개에 safe fallback을 명시한다.
- `codex` wrapper는 user config를 수정하지 않고 server default와 16개 per-tool approval mode를 CLI override로 적용한다. invalid enum/type은 78, init은 fatal이다.
- static parity, fake argv, pinned Codex parse와 public `0.3.2` update 보존을 자동 검증한다. 동일 merge SHA의 main CI [`29408206017`](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29408206017)과 tag Builder [`29408467932`](https://github.com/Kanu-Coffee/codex-for-home-assistant/actions/runs/29408467932), 정확한 public `0.4.0` image의 browser approval policy/full browser·gateway·Core WebSocket·ttyd·SSH/public `0.3.2` → `0.4.0` update smoke는 **PASS**다.
- `codex_approval_policy=never`가 MCP prompt를 전역 승인할 수 있는 precedence와 full-auto가 proxy allowlist/사용자 요청 범위를 넓히지 않는다는 경계를 문서화한다.
- 실제 HAOS `never` mode 수용 보고서에서 허용 도구 14개와 desktop/mobile 인증 `127.0.0.1:8099` dashboard는 MCP 승인 0회로 **PASS (검증 범위)**했다. `select_option`과 `close`는 NOT TESTED이며 `safe`/`always`, `codex_approval_policy=never` precedence, 금지 도구, Configuration UI/default, AppArmor 활성 여부, user-file/identity 보존과 live HA update 감지는 **NOT RUN**이다. 따라서 전체 행렬은 PARTIAL이고 기존 public `0.2.3` browser/AppArmor 사용자 확인 PASS와 혼합하지 않는다.

완료 조건: Home Assistant UI 선택이 새 Codex session의 현재 허용 도구에 정확히 적용되고 미래·금지 도구는 fail closed하며 사용자 config/AGENTS/identity가 보존된다.

## 2. 첫 번째 코딩 작업의 구체적 범위

첫 에이전트는 가능한 한 M1 전체를 완성하되, 최소한 다음을 하나의 PR로 제공한다.

- 빌드 가능한 amd64 App 골격
- Codex CLI 설치 및 `/data` 영속 config
- ttyd + tmux Ingress
- 공개키 sshd
- `/config` RW 및 Core/Supervisor manager 권한 선언
- API helper 기본 구현
- lint/build CI
- 설치/인증/접속 문서

실제 HAOS가 없는 환경에서 Ingress, Supervisor token, Remote SSH를 완료 처리하지 않는다. 대신 실행 가능한 테스트와 정확한 실기 체크리스트를 제공한다.

## 3. 구현 선택 기준

### Base image

1. 공식 Home Assistant base image/예제와 호환
2. ttyd/openssh/tmux 패키지 가용성
3. Codex binary 호환
4. 이미지 크기보다 안정성 우선

M1 선택: 공식 Home Assistant Alpine base `3.24`와 S6 Overlay v3 native service graph.

### Codex 설치 방식

1. 재현 가능성
2. amd64/aarch64 확장 가능성
3. Remote SSH app-server 호환
4. 이미지 크기
5. 공급망 검증(checksum)

M1 선택: Codex CLI `0.144.1`의 `x86_64-unknown-linux-musl` standalone artifact와 고정 SHA-256.

### SSH 사용자

MVP는 `/config` write 및 token access를 확실히 보장해야 한다. root 공개키 login이 가장 단순하지만, 컨테이너 경계를 유지한다. non-root 전환은 host-mounted config의 권한을 안전하게 보장한 뒤 별도 ADR로 진행한다.

### 검증형 메모리 저장 방식

SQLite+FTS5를 `/data/codex-ha-memory/memory.sqlite3`에 두고 외부 vector/database service를 사용하지 않는다. HA-derived catalog와 user-semantic memory를 논리적으로 분리하고, 전자는 fresh refresh로만 교정하며 후자 mutation만 history-preserving compensating rollback을 제공한다. `ha-memoryd`는 별도 container나 외부 port가 아니라 같은 App의 non-fatal S6 service다.

## 4. 금지된 우회

- Advanced SSH App 안에 런타임 설치하는 방식으로 되돌아가지 않음
- SMB 배포 워크플로를 핵심으로 만들지 않음
- API 권한을 진단 전용으로 축소하지 않음
- admin/full_access/docker_api로 테스트 문제를 덮지 않음
- Codex 인증 파일을 image에 bake하지 않음
- HAOS 실기 검증 없이 stable 표시하지 않음
- raw Home Assistant state/비허용 attributes, automation config/API response, `/config` 원문 또는 대화 transcript를 memory/FTS/audit에 저장하지 않음
- partial API response, config-check/HTTP 2xx 또는 모델 추론만으로 candidate를 applied로 승격하지 않음
- 전체 memory DB/catalog를 매 prompt에 읽거나 MCP 기본 결과로 dump하지 않음
- memory rollback으로 HA config, registry, automation 또는 기기를 과거 상태로 변경하지 않음
- memory 장애를 이유로 ttyd/SSH/Codex/browser를 실패시키거나 새 host/Ingress port·sidecar·cloud service를 추가하지 않음
