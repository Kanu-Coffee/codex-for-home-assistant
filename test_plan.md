# test_plan.md — 검증 전략

> 실제 HAOS 사용자 실기 대상은 public `0.2.3`이며, 이 소스는 그 결과를 기록하는 런타임 기능 변경 없는 `0.2.4` validation/evidence 릴리스 후보이다.

## 1. 테스트 계층

### L1 정적 검사

모든 PR에서 실행한다.

- YAML parse 및 yamllint
- Markdown lint
- shellcheck
- Dockerfile lint
- App config 정책 검사
- registry image/tag publish workflow 정책 검사
- Playwright npm lock/version과 image-managed MCP config 검사
- browser tool allowlist 및 금지 도구 정책 검사
- renderer가 새 App port/Ingress/host privilege를 추가하지 않는지 검사
- secret scan
- 실행 파일 permission 검사

### L2 로컬 컨테이너 테스트

Supervisor가 없어도 검증 가능한 항목:

- image build
- Codex binary 실행
- init idempotency
- config rendering
- SSH config syntax
- ttyd/tmux process startup
- 실제 ttyd WebSocket resize와 동일 tmux pane 재접속
- helper argument validation
- API response media type 협상과 header injection 거부
- token redaction
- `/data` persistence fixture
- image의 `/etc/codex/config.toml`과 사용자 `/data/codex/config.toml` precedence, 기본 preserve 및 명시적 refresh
- pinned Playwright MCP stdio handshake, enforcement proxy와 Codex system config의 동일 allowlist 검사
- Alpine `chromium-headless-shell` headless launch
- desktop 1440x900, mobile 390x844 DOM viewport와 screenshot 이미지/종횡비
- console warning/error와 page error 수집
- 2xx/3xx/4xx/5xx/failed/static resource network 관찰
- mocked Core/Supervisor를 연결한 loopback gateway의 동적 frontend, 전체 Core API/WebSocket route와 HTTPS trust 설정
- fixture Supervisor token의 argv/log/MCP 응답/browser artifact 비노출과 `/run` 정리
- browser auto-auth option 누락/default ON 자동 생성, restart 재사용, OFF/ON identity 보존과 manual override 억제
- model-visible Codex developer instruction과 filtered navigation tool 설명의 `127.0.0.1:8099` 우선 route
- user-file refresh의 closed enum/default preserve, target별 App-version 1회, private byte-exact backup, journal recovery와 unsafe path/lock 거부
- pulled GHCR image의 labels/platform 및 full smoke

### L3 Supervisor/App 개발 환경

공식 local app devcontainer 또는 실제 HAOS에서 검증:

- App 인식/설치/시작
- `/config` mount
- Ingress/WebSocket
- options 적용
- Network port mapping
- `SUPERVISOR_TOKEN`
- Core/Supervisor API
- source-build App에서 public GHCR image App으로 일반 업데이트
- AppArmor 활성 상태에서 Playwright MCP와 Chromium 시작
- container loopback HA gateway, 실제 frontend resource와 Core API/WebSocket
- 일반 업데이트 후 `/etc` browser 기본값 갱신과 `/data` 사용자 config/auth 비변경

### L4 실제 사용자 HAOS E2E

- 장치 코드 인증
- Web UI Codex TUI
- SSH/Remote SSH
- 실제 안전한 엔티티 service call
- 자동화 Trace/log 분석
- Core check/restart
- App update persistence
- 실제 HA 대시보드 desktop/mobile 렌더링
- console/page error와 실패 resource 보고
- renderer 경로 전체의 Supervisor token 비노출

## 2. 자동 테스트 케이스

| ID | 테스트 | 기대 결과 |
|---|---|---|
| AT-001 | `config.yaml` parse | 오류 없음 |
| AT-002 | 금지 key 정책 | admin/docker_api/full_access/host_network/apparmor false 없음 |
| AT-003 | `/config` map | homeassistant_config RW path `/config` |
| AT-004 | API 권한 | homeassistant_api, hassio_api true / manager |
| AT-005 | Codex version | pin된 버전 출력 |
| AT-006 | init 두 번 실행 | 데이터 손실/중복 없음 |
| AT-007 | 기존 config.toml | 기본 `preserve`에서 사용자 값 보존 |
| AT-008 | authorized_keys 렌더링 | 정확한 줄/0600 |
| AT-009 | empty keys | SSH 로그인 비활성, Web service 정상 |
| AT-010 | host keys | 재시작 fixture에서 동일 fingerprint |
| AT-011 | `sshd -t` | 성공 |
| AT-012 | ttyd command | tmux wrapper 안전한 인수 사용 |
| AT-013 | auto-start false | shell 실행 |
| AT-014 | auto-start true | codex 1회 후 shell |
| AT-015 | API helper no token | stdout/stderr에 token 없음 |
| AT-016 | API 4xx/5xx | non-zero exit와 body 요약 |
| AT-017 | shellcheck | 오류 없음 |
| AT-018 | secret scan | 실제 credential 없음 |
| AT-019 | 실제 ttyd WebSocket shell | 101 handshake 후 `/config`, non-dumb TERM으로 명령 실행 |
| AT-020 | 기본 전역 `AGENTS.md` | 생성·0644, 핵심 안전 규칙 포함, 기본 `preserve` 재초기화 시 사용자 수정/override 보존 |
| AT-021 | API `Accept` 협상 | 기본 JSON, 로그 x-log, 비허용/CRLF 값 요청 전 거부 |
| AT-022 | ttyd resize/reconnect | resize 반영 후 WebSocket 재연결에도 session/pane/pid 동일 |
| AT-023 | registry release contract | generic image, numeric tag gate, version 일치, package write 권한 |
| AT-024 | Playwright 공급망 pin | lockfile에서 `@playwright/mcp` 0.0.78과 transitive Playwright 버전이 고정되고 runtime `latest`/`npx` 설치 없음 |
| AT-025 | system MCP config | `/etc/codex/config.toml`에 optional stdio Playwright server, timeout, tool allowlist가 있고 `/data`에 image 기본값을 복사하지 않음 |
| AT-026 | MCP handshake/tool 표면 | raw wrapper와 Codex system config가 동일 allowlist를 사용하고 임의 code 실행/file upload/unrestricted filesystem/codegen/단일 request 상세 도구가 노출·호출되지 않음 |
| AT-027 | headless Chromium smoke | `/usr/bin/chromium-headless-shell`로 local fixture navigation/snapshot/screenshot 성공 |
| AT-028 | desktop/mobile viewport | DOM에서 1440x900과 390x844를 각각 확인하고 screenshot 이미지와 종횡비 및 responsive breakpoint 일치. MCP가 큰 응답 이미지를 축소할 수 있으므로 desktop PNG의 전송 픽셀은 동일 종횡비로 판정 |
| AT-029 | console/network 관찰 | warning/error/page error와 2xx/3xx/4xx/5xx/failed/static resource 요청을 누락 없이 분류 |
| AT-030 | renderer 기본 output 격리 | init/start가 기존 기본 output을 삭제하고 `/run/codex-ha/playwright-output` mode 0700으로 재생성, 50 MiB 제한, `/data`에 profile/artifact 없음 |
| AT-031 | gateway와 token 비노출 | `127.0.0.1:8099`의 frontend/auth/API/WebSocket이 direct Core fixture로 성공, 검증된 read-only token만 정확한 local origin에 주입되고 Supervisor/browser token은 argv/log/MCP/console/network/artifact에 없음. token 부재·검증 실패 시 일반 login page 동작 |
| AT-032 | 권한/port 회귀 | renderer 추가 전후 `config.yaml`의 port/Ingress/role/AppArmor/privilege 계약이 동일 |
| AT-033 | 업데이트 config 보존 | option이 없거나 `preserve`인 image 교체에서 `/etc` browser 기본값만 갱신되고 marker를 넣은 `/data/codex/config.toml`, auth, SSH host key, 운영 지침은 byte-for-byte 보존 |
| AT-034 | transport/file enforcement | wrapper의 모든 command-line 인수와 proxy의 모든 tool `filename` 거부, `/config`·`/data` artifact 우회 없음 |
| AT-035 | browser user 최소권한 | browser token의 current user와 admin user list를 교차검증하고 active·local-only·non-system·non-admin·sole `system-read-only`일 때만 ready. system-users/admin/복수 group/비활성 token은 fail closed |
| AT-036 | source IP와 재사용 negative | Docker inspect App IP, `curl %{local_ip}`, Core가 관측한 peer가 일치. container 제거 뒤 다른 App이 같은 IP를 받을 수 있음을 재현하고 production 파일에 Docker CIDR·`trusted_networks`·synthetic XFF 설정이 없음을 확인 |
| AT-037 | managed browser auth lifecycle | provider preflight 후 exact local-only/read-only user, temporary login, LLAT 생성, password/OAuth cleanup, exact single token, restart reuse, revoke rotation과 policy-checked remove가 동작하고 비밀값을 출력하지 않음 |
| AT-038 | managed auth crash/concurrency/fail-closed | kernel lock 충돌, partial credential create, pending LLAT, provider/Core/DNS/TLS failure, ambiguous local-only rejection, policy/credential mutation과 current-token self-revoke connection close에서 journal/token을 고아화하지 않고 runtime만 비활성화 |
| AT-039 | browser 자동 인증 option | schema/default true, 누락 option도 ON, startup 자동 생성, restart 동일 identity 재사용, OFF에서 `/run` token 차단·`/data`/HA identity 보존·명시적 remove 허용, ON remove 거부, ON 재활성화, manual override ON 우선/OFF 억제 |
| AT-040 | Codex 기본 HA browser route | 기존 사용자 config/AGENTS를 보존한 update container의 `codex debug prompt-input`과 `browser_navigate` description이 image-managed Playwright와 `http://127.0.0.1:8099/`를 첫 경로로 지정하고 다른 browser skill/8123/external URL 선탐색을 금지 |
| AT-041 | HTTPS Core trust | Node HTTP/WebSocket과 nginx gateway가 image CA·SNI·`homeassistant` hostname을 검증하고 `proxy_ssl_verify off`가 없으며 invalid chain/hostname에서 fail closed |
| AT-042 | 선택형 user-file refresh | missing/default preserve, agents-only, all-target, 같은 version 1회, 다음 target만 후속 적용, private byte-exact backup과 config reset을 검증하고 auth/override/SSH/browser identity/`/config`는 보존 |
| AT-043 | user-file refresh 안전·복구 | symlink/hardlink/FIFO와 unsafe runtime lock을 mutation 전에 거부하고 hardlink 피해 파일 mode를 바꾸지 않으며, commit 전 journal은 rollback하고 commit 후 stale journal은 이후 사용자 편집을 보존한 채 정리 |

## 3. HAOS 수동/E2E 시나리오

### E2E-001 설치 및 시작

1. repository 등록 또는 local App 설치
2. App 설치
3. 기본 옵션으로 시작
4. logs 확인

성공 기준:

- App가 running
- Web UI 버튼 표시
- SSH keys 미설정 경고 외 치명적 오류 없음

### E2E-002 웹 터미널 기본 모드

1. auto-start false
2. Web UI 열기
3. `pwd`, `command -v codex`, `echo $CODEX_HOME`, `echo $TERM`

성공 기준:

```text
/config
/usr/local/bin/codex
/data/codex
tmux-256color
```

### E2E-003 웹 터미널 자동 Codex

1. auto-start true
2. App 재시작 또는 새 tmux 세션
3. Web UI 열기
4. Codex TUI 확인
5. Codex 종료

성공 기준:

- Codex 자동 시작
- 종료 후 shell 복귀

### E2E-004 tmux 재접속

1. Web UI를 열고 별도 SSH에서 `session_id`, `pane_id`, `pane_pid`, client/pane 크기 기록
2. App을 재시작하지 않고 Web UI만 닫기
3. tmux session/pane process가 유지되는지 확인
4. Web UI를 다시 열어 같은 ID인지 비교
5. 브라우저 크기를 바꾸고 tmux client/pane 크기 변화 확인

성공 기준:

- 기존 session/pane/process와 화면 복원
- resize가 실제 tmux client에 반영

App 업데이트·재시작은 컨테이너 프로세스를 종료하므로 이 시나리오 사이에 실행하지 않는다.

### E2E-005 헤드리스 인증

1. `ha-codex-login`
2. 다른 브라우저에서 device code 완료
3. `codex login status`
4. App restart
5. status 재확인

성공 기준: 재로그인 없이 인증 유지

### E2E-006 SSH

1. authorized_keys 설정
2. Network port 2223 확인
3. Windows에서 접속

```powershell
ssh -p 2223 root@<ha-host>
```

성공 기준:

- public key 성공
- password 로그인 실패
- `/config` 시작
- `codex --version` 성공

### E2E-007 Desktop SSH 프로젝트와 mobile Remote

1. Windows `~/.ssh/config` alias 생성
2. 일반 `ssh <alias>` 성공
3. Codex Desktop Connections에 host 추가
4. `/config` 선택
5. 파일 읽기/테스트 파일 생성/삭제
6. 선택적으로 mobile Remote에서 연결된 desktop host의 같은 SSH 프로젝트 작업 계속

성공 기준: remote app server가 시작되고 desktop 또는 mobile Remote를 통해 작업 완료

### E2E-008 Core API

```bash
ha-api GET /config
ha-api GET /states
```

성공 기준: 인증 오류 없이 JSON 반환, token 미출력

### E2E-009 안전한 기기 서비스 호출

대상은 사용자가 지정한 테스트용 조명/스위치로 한정한다.

1. before state 저장
2. service call
3. state change 확인
4. 원상 복구

성공 기준: 기대 상태와 로그 일치

### E2E-010 Supervisor manager

- Core info
- Core/App logs를 먼저 직접 `Accept: text/x-log`로 조회
- `ha-core-logs`, `ha-addon-logs` 결과를 직접 요청과 비교
- config check
- 테스트 App info/logs
- 허용되는 경우 테스트 App restart

성공 기준: manager 범위를 표로 기록. 거부된 endpoint는 admin 승격 없이 문서화.

### E2E-011 `/config` 변경 및 검사

1. 안전한 package/test file 생성
2. YAML parse
3. Home Assistant config check
4. 삭제/롤백

성공 기준: 실제 RW와 검사 흐름 확인

### E2E-012 업데이트 영속성

1. auth 상태와 host key fingerprint를 기록하고 `/data/codex/config.toml`에 식별 가능한 사용자 marker 추가
2. 기존 `/etc/codex/config.toml`의 browser 기본값과 App version 기록
3. 공개 `0.2.0`에서 `0.2.1` 후보 App image로 일반 update
4. 재시작
5. 새 image의 `/etc` Playwright 기본값, 사용자 marker, 인증/SSH known_hosts와 마스킹된 `home_assistant_browser_token` option 보존 확인

성공 기준: image-managed Playwright 기본값은 제공되며 사용자 config, 인증, host key, 운영 지침은 변경되지 않음

이 시나리오는 App 삭제나 `/data` 초기화 없이 일반 업데이트로 실행한다.

### E2E-013 Codex 운영 지침

1. App 업데이트/재시작 뒤 `/data/codex/AGENTS.md` 존재 확인
2. 새 Codex 세션에서 적용된 지침 요약 요청
3. 파일에 식별 가능한 사용자 문장을 추가하고 App 재시작
4. 사용자 문장 보존 확인

성공 기준: 기본 안전 지침이 새 세션에 적용되고 기존 `AGENTS.md` 또는 `AGENTS.override.md`를 덮어쓰지 않음

### E2E-014 public GHCR 업데이트

1. `0.2.0` generic manifest가 인증 없이 linux/amd64로 resolve되는지 확인
2. image labels, `codex --version`, pinned Playwright/Chromium을 검사하고 full container smoke 실행
3. App Store 저장소를 새로고침하고 기존 `0.1.3`을 일반 업데이트
4. Web UI, Codex 로그인, SSH host identity, `/data` 사용자 설정과 `/etc` Playwright system config 확인

성공 기준: 소스 빌드 없이 image를 받고 재로그인/known_hosts 변경 없이 주요 경로가 동작함. App 삭제나 `/data` reset은 하지 않음.

### E2E-015 개발 Web UI browser 검증

1. App 안에서 외부에서 접근 가능한 local test Web UI 또는 사용자가 지정한 개발 Web UI를 연다.
2. desktop 1440x900에서 navigation, accessibility snapshot과 screenshot을 수집한다.
3. mobile 390x844로 resize하고 responsive layout과 screenshot 크기를 확인한다.
4. 의도한 warning/error fixture와 2xx/3xx/4xx/5xx/failed resource를 발생시킨다.
5. console/page error, request URL·method·status·failure와 screenshot을 보고한다.

성공 기준:

- 두 viewport에서 실제 Chromium 렌더링이 완료되고 핵심 요소가 보임
- console/page 오류와 실패 resource가 fixture 기대값과 일치
- 브라우저가 멈췄다는 이유만으로 `networkidle`을 성공 조건으로 사용하지 않고 명시한 UI 상태로 완료 판단
- proxy가 `filename`을 거부하고 output과 browser profile이 `/data`에 남지 않음

### E2E-016 실제 HA 대시보드 browser 검증

1. AppArmor를 활성 상태로 유지하고 App을 시작한다.
2. `ha-browser-network-info`의 Supervisor self IP와 socket source IP가 같음을 확인하되 이 `/32`를 Home Assistant 설정에 추가하지 않는다.
3. 기본 ON `home_assistant_browser_auto_auth` 상태로 App을 설치·시작하고 terminal 명령 없이 `ha-browser-auth-status`가 `source: managed`, ready, active·local-only·sole `system-read-only`, credential-free 상태인지 확인한다. 사용자가 token을 수동 복사하지 않는다.
4. 새 Codex 세션에 dashboard 검토만 요청하고, model-visible system instruction과 Playwright tool 설명에 따라 다른 browser skill 탐색 없이 새 외부 port 없는 container 내부 `http://127.0.0.1:8099`를 첫 URL로 열어 raw token URL이나 password 입력 없이 HA frontend가 로드되는지 확인한다.
5. desktop 1440x900과 mobile 390x844에서 사용자가 지정한 dashboard/view를 연다.
6. direct Core API와 WebSocket 연결, 정적 resource, 한글/emoji font, console/page error를 확인한다. HTTPS frontend이면 CA chain과 `homeassistant` hostname 검증이 켜지고 invalid certificate를 우회하지 않는지 확인한다.
7. process list, App/MCP log, network/console 보고와 screenshot metadata에서 Supervisor token과 browser token 문자열을 검색한다.
8. image와 process argument에 Playwright `--secrets`가 없고 hostile `PLAYWRIGHT_MCP_*`, `NODE_OPTIONS`, `NODE_PATH`가 무시되며 token reflection fixture의 MCP text가 관리 proxy에서 exact-value redaction되는지 확인한다.
9. 자동 인증을 OFF로 저장하고 App과 기존 Codex/MCP session을 재시작해 status `disabled`, `/run` token 부재와 login page를 확인하되 `/data`와 Home Assistant identity가 보존되는지 확인한다. 이 상태에서도 `ha-browser-auth-remove`가 명시적 완전 삭제를 수행하는지 별도로 확인한다.
10. 자동 인증을 다시 ON으로 저장하고 App을 재시작해 같은 managed user/token이 재활성화되는지 확인한다. 수동 `home_assistant_browser_token`은 ON에서만 우선하고 OFF에서는 주입되지 않으며 invalid manual token이 managed identity로 fallback하지 않는지 확인한다.
11. App update/recreate 뒤 기존 사용자 Codex config/AGENTS, managed identity, SSH identity가 보존되고 image-managed developer instruction과 navigation tool 설명만 새 8099 기본 방침으로 갱신되는지 확인한다.

성공 기준:

- frontend, auth, API, WebSocket이 same-origin direct Core gateway 계약과 전용 read-only user permission으로 동작
- 두 viewport에서 dashboard가 실제 entity 상태와 함께 렌더링됨
- Supervisor/browser token이 URL, argv, 로그, MCP 응답 또는 artifact에 없음
- 입력 도구의 secret-name 치환 경로가 없고 proxy의 exact token text redaction이 동작
- `configuration.yaml`, `auth_providers`, `trusted_networks`, `trusted_proxies`, `.storage`가 App에 의해 바뀌지 않음
- Network/Ingress/privilege/AppArmor 설정을 완화하지 않음

실행 결과: AppArmor를 활성 상태로 유지한 실제 HAOS에서 인증된 `8099` dashboard의 desktop/mobile 렌더링, console, network/정적 resource와 Core WebSocket 경로는 **PASS — public `0.2.3` 사용자 확인**이다. 상세 실행 로그와 HAOS 버전은 제공되지 않았다. 따라서 위 단계 중 token 문자열 음성 검색, hostile 환경변수, OFF/ON·완전 삭제 lifecycle의 모든 세부 음성 항목까지 실제 HAOS에서 재현했다고 확대하지 않으며, 해당 항목은 기존 자동 fixture 증거와 구분한다.

### E2E-017 Home Assistant 구성의 선택형 사용자 파일 갱신

1. 공개 `0.2.2`의 user `config.toml`, base `AGENTS.md`, `AGENTS.override.md`, auth와 SSH fingerprint에 서로 다른 marker를 기록한다.
2. App을 `0.2.3`으로 일반 업데이트하고 첫 시작에서 기존 파일과 identity가 모두 보존되며 user-file backup/state가 생기지 않았는지 확인한다.
3. App **구성**에서 `refresh_agents`를 선택하고 저장·재시작해 base `AGENTS.md`만 image 기본본이 되고 이전 bytes가 root-only backup에 있는지 확인한다.
4. 같은 version에서 사용자 문장을 다시 추가하고 재시작해 반복 덮어쓰지 않는지 확인한다.
5. `refresh_all`로 바꾸고 저장·재시작해 이미 처리한 agents는 유지되고 config만 현재 App option 기반 기본본이 되며 별도 private backup/state가 생기는지 확인한다.
6. `auth.json`, session, `AGENTS.override.md`, SSH/browser identity, App options와 Home Assistant `/config` marker가 유지되는지 확인한다.
7. 일회성 갱신이면 `preserve`로 되돌린다. refresh mode를 유지하는 시험은 다음 App version에서 해당 target이 한 번 다시 적용된다는 파괴 범위를 먼저 승인받고 수행한다.

성공 기준: CLI option 없이 HA 웹 구성만으로 선택한 범위가 target별/version별 한 번 적용되고, 기본 업데이트와 비대상 자료는 보존되며 backup과 로그에 대한 비밀 취급 경고가 실제 동작과 일치한다.

실행 결과: Home Assistant 구성 UI와 Supervisor 일반 App update 경로는 **PASS — public `0.2.3` 사용자 확인**이다. 상세 로그와 HAOS 버전은 제공되지 않았으므로 위 단계의 target별 byte/backup/state 세부 단언은 자동 회귀 증거와 구분한다. `0.2.4` 업데이트 전 `refresh_agents` 또는 `refresh_all`이 계속 선택돼 있다면 선택 target이 새 App version에서 한 번 다시 갱신된다. 재적용을 원하지 않는 경우 업데이트 전 `preserve`로 저장한다.

## 4. 회귀 테스트 우선순위

P0:

- App 부팅 불가
- Web UI 접속 불가
- SSH/Remote SSH 불가
- Codex auth 유실
- `/config` 손상
- token 로그 노출
- loopback gateway 외부 노출 또는 renderer token/artifact 유출
- browser 추가로 AppArmor/port/privilege 경계 약화
- 기본 업데이트의 사용자 config/AGENTS 손상 또는 refresh 대상 밖 identity/`/config` 변경

P1:

- auto-start 옵션 오동작
- tmux 재접속 실패
- manager API helper 실패
- 기본 `preserve`에서 사용자 `AGENTS.md` 덮어쓰기 또는 선택 refresh의 반복 적용
- 한글/resize 문제
- Playwright MCP/Chromium 시작 실패
- desktop/mobile layout, console 또는 resource 오류 수집 실패

P2:

- 문서/번역/UX 개선

## 5. 테스트 결과 기록 형식

`progress.md`에 다음을 남긴다.

```markdown
### Verification
- [x] <command/test>: PASS — <evidence>
- [ ] <HAOS-only test>: NOT RUN — <reason>
- [x] Secret scan: PASS
- Known issues:
```

가능한 경우 CI 링크와 HAOS 버전, App 버전, 아키텍처를 기록한다. 사용자가 상세 환경이나 로그를 제공하지 않으면 이를 추정하지 않고 미제공으로 기록한다.
