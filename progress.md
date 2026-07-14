# progress.md — 현재 상태와 할 일

> 이 파일은 프로젝트 상태의 유일한 기준이다. 에이전트는 모든 작업의 시작과 끝에 갱신한다.

## Project Status

- 상태: **amd64 MVP/M2 PASS / 0.2.0 브라우저 렌더러 local candidate PASS / HAOS 실기 대기**
- 현재 마일스톤: **Playwright 기반 Codex 브라우저 도구와 HA 대시보드 렌더 경로 전달**
- 마지막 문서 기준일: **2026-07-14**
- 저장소: public `Kanu-Coffee/codex-for-home-assistant`, default branch `main`

## 완료된 결정

- [x] Home Assistant App(구 Add-on) 형태로 개발
- [x] Codex CLI + Ingress 웹 터미널 + SSH/Remote SSH 동시 제공
- [x] `/config` 전체 RW 매핑
- [x] `homeassistant_api: true`
- [x] `hassio_api: true`, `hassio_role: manager`
- [x] 실제 서비스 호출 및 기기 테스트 허용
- [x] `admin`, Docker API, host network, full access는 사용하지 않음
- [x] Codex/SSH 인증 데이터를 `/data`에 영속화
- [x] SSH 외부 포트는 App Network 설정에서 변경
- [x] 문서 주도 개발 파일 세트 작성

## Current Work

### 2026-07-14 — Playwright Headless Chromium 브라우저 도구

- 목표: Codex가 자신이 만든 Web UI와 Home Assistant 대시보드를 실제 브라우저로 열고 데스크톱/모바일 화면, 스크린샷, 콘솔 오류, 네트워크·리소스 상태를 직접 검사할 수 있게 한다.
- 구현 방향: App 이미지에 버전 고정한 Microsoft Playwright MCP와 Alpine `chromium-headless-shell`을 포함하고, `/etc/codex/config.toml` 시스템 계층에서 공식 STDIO MCP로 노출한다. `/data/codex/config.toml`은 수정하지 않아 기존 사용자 설정과 인증을 보존한다.
- 보안 경계: 외부 포트와 host 권한을 추가하지 않고 브라우저는 headless/isolated/no-sandbox로 컨테이너 안에서만 실행한다. 위험한 임의 코드·파일 업로드 도구는 노출하지 않고, runtime Supervisor token은 임시 0600 secrets 파일로 마스킹한다.
- HA 렌더 경로: loopback 전용 gateway가 Home Assistant frontend와 공식 Core API/WebSocket proxy를 결합하고, 현재 App token을 브라우저 localStorage에만 주입한다. token 원문은 MCP 응답·App 로그·artifact에 남기지 않는다.
- 호환성 결정: Playwright의 공식 Linux 배포 대상은 Ubuntu/Debian이지만 기존 Home Assistant Alpine runtime의 회귀 폭을 줄이기 위해 시스템 Chromium 조합을 사용한다. 최종 local image는 `@playwright/mcp 0.0.78`, lockfile의 `playwright-core 1.62.0-alpha-1783623505000`, Alpine Chromium Headless Shell 150 조합으로 실제 MCP smoke를 통과했다. 이 결과와 HAOS/AppArmor 실기는 분리해 기록한다.
- 보안 보강: 고정 stdio proxy가 raw `tools/list`와 `tools/call` 양쪽에서 Codex system config와 같은 allowlist를 강제한다. 임의 code/file upload/단일 network 상세 도구와 모든 `filename` 인수를 거부하고 wrapper의 CLI 인수도 차단한다. browser 파일은 `/run`에만 두고 init 때 지운다.
- local gateway 증거: 모의 Supervisor/Core를 전용 Docker network에 연결해 Core info, localStorage token bootstrap, 인증된 `/api/config`, frontend marker, `/api/websocket` 101 upgrade와 `8099`의 loopback 외부 접근 차단을 확인했다.
- local update 증거: public `0.1.3` image의 container만 candidate로 교체하고 같은 named `/data`·`/config` volume을 사용해 사용자 Codex config, valid auth marker, 운영 지침, Home Assistant config marker와 SSH host fingerprint가 보존되며 새 Playwright MCP smoke가 동작함을 확인했다.
- [x] image-managed Playwright MCP, Chromium, Codex system config와 HA loopback gateway를 구현한다.
- [x] 모바일/데스크톱 DOM·PNG, console/page error, 2xx/3xx/4xx/5xx/transport failure를 확인하는 실제 MCP 회귀 테스트를 추가한다.
- [x] App 업데이트 비파괴 계약, 보안 문서, 사용자 사용법과 changelog를 갱신한다.
- [x] amd64 image build와 최종 full Docker smoke를 통과한다.
- [x] Linux unit/policy test와 YAML/Shell/Dockerfile/Markdown/GitHub Actions lint를 통과한다.
- [ ] 기능 브랜치에 커밋·push한 뒤 PR/CI 결과를 기록한다.
- [ ] 실제 HAOS에서 일반 업데이트 후 인증된 대시보드와 AppArmor Chromium 실행을 확인한다.

### 2026-07-13 — 0.1.3 amd64 GHCR non-dev 릴리스와 HACS 검토

- 사용자 최종 실기 증거: HAOS에서 auto-start 양 모드, device-code 로그인, App 재시작 뒤 인증 유지, SSH host identity 동일성을 확인했다. `persistent_notification` 생성·dismiss Core service call은 각각 rc 0이었고 임시 알림 정리도 성공했다.
- 완료 경계: 위 결과로 제품 명세의 M1/M2 필수 실기 수용 기준은 충족한다. Supervisor/Core/App start/stop/restart 실동작은 운영 중단 위험 때문에 자동 실행하지 않으며 manager info/log/config-check와 범용 POST helper 검증 범위로 남긴다.
- 릴리스 버전: Supervisor와 같은 AwesomeVersion 25.8.0에서 `0.1.3-dev < 0.1.3`을 재현했으므로 `0.1.3`을 첫 non-dev version으로 사용한다. Home Assistant `stage: experimental`, `arch: [amd64]`는 유지하고 `0.1.4`는 필요 시 복구 릴리스용으로 남긴다.
- 배포 전환: 공식 Home Assistant builder action으로 amd64 per-arch image와 generic GHCR manifest를 게시하고 `config.yaml`은 `ghcr.io/kanu-coffee/codex-for-home-assistant`를 사용한다.
- 데이터 전환: App runtime과 `/data` 형식은 바꾸지 않는다. 기존 App을 삭제하거나 reset하지 않고 일반 업데이트로 검증한다. registry 문제가 생기면 더 높은 patch version에서 `image`를 제거해 소스 빌드로 되돌린다.
- HACS 판정: HACS는 Supervisor App 유형을 지원하지 않으므로 HACS manifest나 잘못된 repository type을 추가하지 않는다. 공식 App repository URL과 My Home Assistant 원클릭 등록 링크를 제공한다.
- [x] 사용자 실기 PASS를 Verification/M2와 사용자 문서에 반영했다.
- [x] 0.1.3 version, generic GHCR image, 공식 builder workflows와 계약 테스트를 구현했다. PR 빌드는 read-only이고 numeric version tag만 package write/OIDC 권한으로 게시한다.
- [x] 로컬 amd64 image build/full smoke, Linux pytest 31개, ShellCheck/Hadolint/YAML/Markdown/actionlint와 Git diff 검사를 통과했다. image의 `io.hass.version=0.1.3`, `io.hass.arch=amd64` label도 확인했다.
- [x] PR [#10](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/10)의 CI run `29244843174` 3개 job과 builder PR run `29244843342`의 metadata/prepare/amd64 build를 통과했다. merge commit은 `014de31`이고 main CI run `29244989052` 3개 job도 통과했다.
- [x] tag `0.1.3`의 builder run `29245085795`로 amd64 image와 generic manifest를 게시했다. 빈 Docker 인증 설정에서 generic/per-arch를 모두 조회하고 generic image를 pull했으며 manifest digest `sha256:298add07ce5d1d5fd68b867fc7b9a0c4b03e3f909d2b887c680d24ddbbd75615`, `linux/amd64`, App version/arch/source label, mutable `latest` 부재와 pulled-image full smoke를 확인했다.
- [x] public `main` 병합, annotated `0.1.3` tag와 GitHub [prerelease](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases/tag/0.1.3)를 완료했다.
- [ ] 사용자 HAOS에서 App Store repository를 새로고침하고 기존 `0.1.3-dev`를 `0.1.3`으로 일반 업데이트한 뒤 Web UI, Codex 인증 유지와 SSH host identity를 확인한다. App 삭제, `/data` reset, 재로그인은 요구하지 않는다.

### 2026-07-13 — 0.1.3-dev 최종 HAOS 회귀·완료 판정

- 목표: 새 HAOS 보고서와 기존 사용자 E2E 증거를 합쳐 로그 helper, Web UI 재접속, 인증·SSH 경로의 회귀 여부를 판정하고 amd64 MVP와 정식 릴리스의 남은 조건을 분리한다.
- 실기 결과: `0.1.3-dev`/amd64 보고서는 PASS 16, FAIL 0이다. Core/App 직접 로그 요청과 `ha-core-logs`/`ha-addon-logs self`가 모두 rc 0/nonempty였고, 재접속 뒤 App helper도 stderr 없이 성공했다. raw 로그나 진단 원문은 저장소에 포함하지 않는다.
- Web UI 결과: 다른 브라우저/환경으로 다시 열었을 때 이전 대화와 터미널이 복구됐고 resize와 `clear` 오류 부재를 확인했다. 사전 session ID가 없어 HAOS의 동일 ID 기계 비교는 미실행이지만, 실제 ttyd 로컬 smoke가 동일 session/pane/pid를 별도로 검증한다.
- 합산 증거: 보고서 한 회차에서 미실행한 외부 SSH/Remote와 로그인 영속성은 사용자의 기존 mobile Remote → desktop SSH project → HAOS `/config` E2E 및 삭제 없는 연속 업데이트 뒤 인증 유지 결과로 이미 PASS다.
- 완료 판정: 새 런타임 결함은 없으며 현재 주 사용 경로는 **실사용 가능한 beta/MVP candidate**다. 그러나 저장소의 M1/M2 수용 기준상 HAOS auto-start 양 모드, device-auth·재시작 영속성, 안전한 Core POST service call이 미검증이므로 프로젝트 완료로 표시하지 않는다. 첫 non-dev 릴리스에는 인증/host identity 재시작 확인과 tag/GHCR 배포도 필요하다. Home Assistant `stage`는 M3 평가 전까지 `experimental`을 유지한다. 위험한 Core/App lifecycle 실동작은 구현 결함 증거가 없으므로 자동 실행하지 않는다.
- 데이터 전환: 이번 변경은 실기 증거와 프로젝트 상태 문서만 갱신한다. App 업데이트도 기능 반영 목적으로 필요하지 않으며 `/data` 초기화나 App 삭제·재설치는 하지 않는다. 영속성 후속 시험도 일반 App 재시작/업데이트로 수행한다.
- [x] 보고서의 PASS/FAIL/UNVERIFIED를 기존 실기·자동 검증 증거와 대조한다.
- [x] 실제 결함과 시험 절차상 미확정을 분리하고 MVP/릴리스 완료 여부를 판정한다.
- [x] `progress.md`, README, App DOCS/CHANGELOG의 실기 상태와 남은 릴리스 게이트를 실제 결과에 맞춘다.
- [x] Linux pytest 30개, manifest/secret policy, Markdown 20개와 `git diff --check`를 통과했다. App runtime은 바꾸지 않아 로컬 image rebuild를 생략하고 원격 CI의 amd64 build/smoke를 병합 게이트로 사용한다.
- [x] commit `3598798`을 `agent/live-regression-completion`에 push하고 PR [#9](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/9)을 생성했다. 최초 head CI run `29242099208`의 App linter, amd64 build/smoke, lint/unit 3개 job이 통과했다. 이 기록은 같은 PR의 public `main` 병합으로 전달하며 최종 merge/main CI는 작업 결과에서 별도로 확인한다.

### 2026-07-13 — 0.1.3-dev 라이브 회귀 수정·로고·M2 증거 반영

- 사용자 실기 증거: `0.1.2-dev` Ingress Web UI와 인증된 Codex 실행, Codex 모바일 앱의 공개키 Remote SSH 접속이 정상 동작했다. App을 삭제하지 않고 업데이트해 온 환경에서도 기존 영구 데이터와 인증 상태가 유지됐다.
- 라이브 보고서 증거: `/config` RW와 정리, Core REST 조회, Supervisor manager 조회·config-check, 직접 로그 API, SSH 공개키 전용 설정, 기본 전역 `AGENTS.md`의 비파괴 영속화는 통과했다. `ha-core-logs`와 `ha-addon-logs`만 JSON 전용 `Accept` 헤더 때문에 실패했다.
- 시험 해석: 보고서의 tmux 재접속 항목은 기존 Ingress 세션을 먼저 만든 시험이 아니어서 회귀 증거로 사용하지 않는다. 사용자 Web UI 성공은 확인됐지만 브라우저 종료 후 동일 세션 재접속은 별도 실기 항목으로 남긴다.
- 데이터 전환: 아래 변경은 이미지 계층의 헬퍼·표시 자산·문서만 바꾸며 `/data`를 초기화하거나 덮어쓰지 않는다. 일반 App 업데이트로 시험하고, 완전 삭제·재설치는 요구하지 않는다.
- [x] 로그 API가 `text/x-log`를 협상하도록 공용 API 클라이언트와 두 로그 헬퍼를 수정하고 회귀 테스트를 추가했다. media type allowlist가 CR/LF header injection도 요청 전에 거부한다.
- [x] 제공된 원본을 왜곡 없이 투명 RGBA `icon.png` 128x128과 `logo.png` 250x250으로 변환하고 README 표시·자산 계약 테스트를 추가했다.
- [x] 실제 ttyd WebSocket에서 resize와 연결 종료/재접속 뒤 동일 tmux session/pane/pid를 확인했다. 이는 같은 App 실행 중 보장이며 업데이트를 넘는 영속성 주장이 아니다.
- [x] 버전을 `0.1.3-dev`로 올리고 README, changelog, 설계·보안·테스트·운영 문서를 실제 실기 증거에 맞췄으며 `MANIFEST.md` 문서 checksum을 현재 내용으로 재생성했다.
- [x] amd64 이미지 build/full smoke, Linux 30 tests, ShellCheck/Hadolint/YAML/Markdown/App lint, secret scan과 Git diff를 검증했다.
- [x] commits `2b145e4`, `d93889d`를 `fix/live-log-logo`에 push했다. PR [#7](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/7)의 push/PR CI 6개 job이 통과했고 merge commit `e1de443`으로 public `main`에 병합했다. final main CI run `29237205318`의 3개 job도 통과했다.

### 2026-07-13 — HAOS 실기 진단 검토와 Codex 운영 가드레일

- 사용자 실기 증거: `0.1.1-dev` Web UI에서 Codex 인증·실행과 시스템 진단이 성공했다. 진단 중 실제 `/config` 파일 생성, Supervisor API의 Core/Supervisor/host/OS 정보·로그 조회, `POST /core/check` HTTP 200/`result: ok`를 확인했다.
- 범위 결정: 사용자 자동화 Repairs, 서드파티 통합/앱 경고, Core 업데이트, `/config` 인증성 파일 권한은 실제 HA 구성과 운영 판단 영역이므로 App 소스에서 자동 변경하지 않는다.
- [x] 진단 보고서를 제품·보안·테스트 계약과 대조하고 프로젝트 항목과 사용자 HA 항목을 분리한다.
- [x] 기존 사용자 설정을 보존하면서 전역 `AGENTS.md`와 override가 모두 없을 때 Home Assistant 운영 안전 지침을 생성한다.
- [x] 생성·0644·기본본 일치, 기존 base/override/빈 파일/dangling symlink의 내용·mode 보존 회귀 테스트와 운영 문서를 추가한다.
- [x] `0.1.2-dev` amd64 build와 full Docker smoke, ttyd WebSocket, ShellCheck, Hadolint, YAML/Markdown lint를 로컬 검증했다.
- [x] PR [#5](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/5)의 push/PR CI 6개 job을 통과하고 merge commit `7105bcd`로 public `main`에 병합했다. final main CI run `29225737374`도 3개 job이 통과했다.
- 다음: 사용자가 App Store 저장소를 새로고침해 `0.1.2-dev`로 업데이트하고 새 Codex 세션에서 기본 운영 지침 적용을 읽기 전용으로 확인한다.

### 2026-07-13 — HAOS Ingress terminal TERM 회귀 수정

- HAOS 실기 결과: public repository 설치와 App 시작은 성공했다. Ingress는 `/` 200, `/token` 200, `/ws` 101까지 성공했지만 ttyd child에서 `open terminal failed: terminal does not support clear`가 발생해 Web UI가 재연결 상태가 됐다.
- 로컬 재현: S6로 부팅한 amd64 이미지의 실제 ttyd WebSocket을 Chrome으로 열어 같은 오류를 재현했다. ttyd는 `TERM=xterm-256color`를 주지만 `/command/with-contenv`가 child 환경에서 `TERM`을 제거하는 것이 원인이다.
- [x] HAOS 로그의 Ingress/nginx/WebSocket 성공과 ttyd/tmux 실패 경계를 확인한다.
- [x] S6 + ttyd + Chrome에서 같은 오류를 재현하고 TERM 전달 손실을 증명한다.
- [x] web entrypoint에서 `TERM=xterm-256color`를 복원하고 tmux 내부 TERM을 보존한다.
- [x] 실제 ttyd WebSocket shell 회귀 테스트를 Docker smoke에 추가했다.
- [x] `0.1.1-dev` amd64 build, 25 unit/policy tests, full smoke, Chrome 렌더·명령 입력을 검증했다.
- [x] changelog, 사용 설명서, 아키텍처, 테스트 계획을 실제 결과에 맞췄다.
- [x] PR [#3](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/3)의 CI를 통과하고 merge commit `b9e2808`로 public `main`에 병합했다. main CI run `29222324024`도 통과했다.
- 후속 실기: 사용자가 `0.1.1-dev` Web UI와 인증된 Codex 실행을 확인했다. resize와 브라우저 종료 후 tmux reattach는 계속 미검증이다.

### 2026-07-13 — public App Store 설치 전달

- 목표: Home Assistant 웹의 App Store에서 GitHub 저장소 URL을 추가해 `codex_home_assistant`를 바로 설치할 수 있도록 public `main`에 배포한다.
- [x] 공식 App repository 구조와 `image` 선택 항목·Dockerfile 소스 빌드 방식을 재확인했다.
- [x] public 저장소 URL 설치 안내와 지속적인 `main` 병합 규칙을 문서에 반영했다.
- [x] 저장소 visibility를 public으로 전환했다.
- [x] PR #1을 ready로 바꾸고 merge commit `ce06435`로 `main`에 병합했다.
- [x] public `main`의 `repository.yaml`, App `config.yaml`, Dockerfile을 인증 없이 조회했다.
- [x] `main` GitHub Actions run `29220740986` PASS — 최초 amd64 build의 Alpine CDN TLS 오류는 failed job 재실행에서 해소됐고 build/smoke가 통과했다.

### 2026-07-13 — amd64 MVP 런타임 구현 및 GitHub 전달

- 결과: Home Assistant base `3.24`, S6 v3, Codex CLI `0.144.1`, nginx Ingress ACL, loopback ttyd, 공유 tmux, 공개키 sshd, `/config` RW, Core/Supervisor helper를 구현했다. Codex/App/SSH 데이터는 `/data`, runtime token 환경은 `/run`에 둔다.
- 보안 결과: manager/Core API 권한은 유지하고 `admin`, `docker_api`, `full_access`, `host_network`, `apparmor: false`는 사용하지 않았다. SSH 비밀번호·keyboard-interactive·reverse forwarding·agent forwarding은 차단했다.
- 배포 결과: private GitHub 저장소의 `feat/mvp-runtime`에 구현 커밋 `95bc564`를 push하고 draft PR [#1](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/1)을 생성했다. `actions/setup-python`의 cache dependency 경로 누락은 `a09301a`에서 수정했으며 해당 head의 push/PR CI 6개 job이 모두 통과했다. private GHCR pull 문제 때문에 개발판 `image` 필드는 유보하고 Local Apps source build를 문서화했다.

### Verification

- [x] `0.2.0` amd64 local image build: PASS — Home Assistant base 3.24, `@playwright/mcp 0.0.78`, Playwright core `1.62.0-alpha-1783623505000`, Chromium Headless Shell 150, Node 24.17.0, Codex CLI 0.144.1, image label version/arch 일치. local Docker image size는 533,346,012 bytes다.
- [x] 최종 full Docker smoke: PASS — Codex system MCP discovery, proxy 제한, desktop 1440x900/mobile 390x844 DOM·PNG, console/uncaught page error, 200/302/404/500/transport failure, 모의 HA gateway 인증 REST/frontend/WebSocket/loopback 격리, output cleanup과 기존 ttyd/SSH/영속성 회귀를 확인했다.
- [x] public `0.1.3` → local `0.2.0` update smoke: PASS — 같은 `/data`·`/config`에서 user config, valid auth marker, AGENTS, HA config marker와 SSH host fingerprint 보존 후 새 Playwright MCP smoke 통과.
- [x] Linux Python 3.13 `pytest`: PASS — 39 passed, 0 skipped. browser supply-chain/config/proxy/gateway/update 계약, 기존 App/API/runtime/manifest/secret regression을 포함한다.
- [x] `yamllint`, ShellCheck 0.11.0, Hadolint 2.14.0, markdownlint-cli2 0.23.0, actionlint 1.7.7, Node/Bash syntax와 `git diff --check`: PASS.
- [ ] 실제 HAOS/AppArmor의 Chromium 시작, 실제 dashboard 인증/resource/WebSocket과 Supervisor/App Store 일반 update: NOT RUN — local Docker 결과로 대체하지 않는다.
- [x] `docker buildx build --platform linux/amd64 --load --tag codex-ha:0.1.3-dev ...`: PASS — base `3.24`, 공식 Codex SHA-256, `codex-cli 0.144.1`, image label `0.1.3-dev`.
- [x] Linux `python -m pytest -ra`: PASS — 30 passed, 0 skipped; 문서 manifest, 자산 계약, S6/runtime, API JSON/x-log 협상·header injection 거부, token redaction, secret scan.
- [x] `tests/docker-smoke.sh codex-ha:0.1.3-dev`: PASS — S6, `/config` RW, permissions, nginx/ttyd, 동일 tmux session/pane/pid 재접속과 96x32 resize, auto-start false/true, Codex 후 Bash 복귀, 공개키 SSH, 비밀번호 거부, UTF-8 env, host-key/config 영속성, invalid/no-key degraded recovery.
- [x] `shellcheck` 0.11.0: PASS — runtime/test shell scripts, warning 이상 없음.
- [x] `hadolint` 2.14.0, `yamllint`, `markdownlint-cli2` 0.23.0: PASS.
- [x] Home Assistant App linter 2.21.0: PASS — `0.1.3-dev` config와 icon/logo 포함.
- [x] `git diff --check`: PASS.
- [x] Windows OpenSSH → local Docker sshd: PASS — `/config`, `/data/codex`, `codex --version`, `codex app-server --help`, fake token presence without output.
- [x] GitHub Actions push/PR CI at `a09301a`: PASS — unit/lint, Home Assistant App config, amd64 build/smoke 각 2회, 총 6 jobs.
- [x] Public repository/main delivery: PASS — visibility PUBLIC, PR #1 MERGED, anonymous repository/App source reads, final main CI.
- [x] Local Ingress terminal regression: PASS — actual ttyd WebSocket handshake and command returned `/config`, `TERM=tmux-256color`; Chrome rendered the shell with no console warning/error.
- [x] HAOS App repository install/start: PASS — public 저장소 설치와 App/S6 서비스 시작 로그 확인.
- [x] Ingress TERM fix delivery: PASS — PR #3 merge commit `b9e2808`, final public `main` CI run `29222324024`의 3개 job 통과.
- [x] Persistent safety guidance delivery: PASS — PR #5 merge commit `7105bcd`, final public `main` CI run `29225737374`의 lint/unit, App config, amd64 build/smoke 통과.
- [x] 실제 Ingress/WebSocket shell과 인증된 Codex 실행: PASS — 사용자 `0.1.1-dev` Web UI 실기 확인.
- [x] 실제 HAOS UI resize/browser tmux reattach: PASS — 다른 브라우저/환경에서 이전 터미널·대화 복구와 resize를 사용자 확인했고 detached `codex-ha` session을 사후 확인했다. 동일 ID 기계 비교는 로컬 실제 WebSocket smoke가 보완한다.
- [x] 실제 HAOS auto-start false/true: PASS — 두 옵션의 의도된 shell/Codex 시작 동작을 사용자 확인.
- [x] App update Codex 인증 영속성: PASS — App 삭제 없이 연속 업데이트한 환경에서 로그인 상태와 인증된 Codex 실행 유지.
- [x] device code 로그인과 App 재시작 인증 영속성: PASS — 사용자 실기 확인.
- [x] Home Assistant Network 공개키 SSH와 remote app server: PASS — 사용자 mobile Remote → 연결된 desktop SSH project → HAOS `/config` E2E 확인.
- [x] 실제 `/config` write/rollback, Core REST 조회, Supervisor 조회/direct log/config-check: PASS — `/config` 임시 변경 정리, `/config`·`/states`·`/services`, Core/App direct logs, self/info, `/core/check` 확인.
- [x] `0.1.3-dev`의 `ha-core-logs`/`ha-addon-logs`: PASS — 사용자 별도 결과와 보고서에서 모두 rc 0/nonempty이며 direct `text/x-log` 요청과 helper 사이의 불일치나 negotiation 오류 없음.
- [x] 실제 Core service call: PASS — 임시 persistent notification 생성·dismiss 각각 rc 0, 정리 확인.
- [ ] Supervisor/Core/App start/stop/restart: NOT RUN — manager helper와 info/log/config-check는 PASS이나 운영 중단 동작은 명시적 유지보수 승인 없이는 실행하지 않는다.
- [x] 실제 HAOS의 기본 전역 `AGENTS.md`: PASS — 0644, 이미지 기본본과 byte 동일, 사용자 override 비파괴 정책 확인.
- [x] SSH host key 업데이트/재시작 전후 동일성: PASS — 사용자 실기 확인.
- Known issues: 공식 명시 Linux 지원은 Ubuntu/Debian 중심이지만 amd64 Alpine/musl remote app server는 사용자 E2E에서 동작했다. aarch64, 향후 Codex 버전 변경과 HAOS lifecycle 영향은 별도 검증 대상이다.

## M1 — 동작 가능한 amd64 MVP

### 1. 저장소 및 기본 골격

- [x] 기존 Git 상태와 remote 확인
- [x] remote가 없으면 private GitHub repo `codex-for-home-assistant` 생성
- [x] 현재 공식 `home-assistant/apps-example` 구조 확인
- [x] `repository.yaml`, App 폴더, `config.yaml`, `Dockerfile`, `rootfs`, 문서 골격 생성
- [x] `.gitignore`, `.editorconfig`, lint 설정 추가

### 2. 컨테이너 런타임

- [x] 최신 Home Assistant base image 선택 및 근거 기록
- [x] `bash`, `curl`, `git`, `jq`, `yq`, `yamllint`, `openssh`, `ttyd`, `tmux`, `sqlite`, `ripgrep` 설치
- [x] S6 서비스/초기화 구조 구현
- [x] `/data/home`, `/data/codex`, `/data/ssh`, `/data/tmux` 초기화
- [x] 민감 파일 권한 검증

### 3. Codex CLI

- [x] amd64에서 재현 가능한 설치 방식 선택
- [x] Codex 버전 pin 및 checksum 검증
- [x] `/usr/local/bin/codex` PATH 보장
- [x] `CODEX_HOME=/data/codex` 적용
- [x] 기본 `config.toml`을 비파괴 방식으로 생성
- [x] `ha-codex`, `ha-codex-login` 구현
- [x] `codex --version` 컨테이너 테스트

### 4. 웹 터미널

- [x] `ingress: true`, `ingress_stream: true` 구성
- [x] ttyd가 Ingress 하위 경로에서 정상 동작하도록 구현 (실제 HAOS Ingress는 M2)
- [x] tmux 세션 자동 생성/재접속 구현 (browser reattach는 M2)
- [x] `/config` 시작 경로 확인
- [x] `web_terminal_auto_start_codex=false` 동작 검증
- [x] `web_terminal_auto_start_codex=true` 동작 검증
- [x] Codex 종료 후 셸 복귀 검증

### 5. SSH 및 Remote SSH

- [x] 공개키 전용 sshd 설정
- [x] SSH host key를 `/data/ssh`에 영속화
- [x] `authorized_keys` 옵션 반영 및 권한 검증
- [x] 키가 없을 때 안전한 degraded 동작
- [x] 기본 host port `2223` 노출
- [x] login shell에서 `codex`, `CODEX_HOME`, `/config` 확인
- [x] Windows OpenSSH 접속 검증 (local Docker port; HA Network는 M2)
- [x] Desktop SSH remote app-server bootstrap 검증 — mobile Remote 경유 사용자 E2E

### 6. Home Assistant API 운영 기능

- [x] `SUPERVISOR_TOKEN`을 웹/SSH 셸에서 안전하게 사용할 수 있도록 런타임 환경 구성
- [x] `ha-api` 래퍼 구현
- [x] `supervisor-api` 래퍼 구현
- [x] `ha-config-check` 구현
- [x] Core 로그 조회 helper 구현
- [x] App 로그 조회 helper 구현
- [x] REST/WebSocket 사용 예시 문서화
- [x] manager 역할 endpoint 검증표 작성 및 정보/direct log/config-check HAOS 실기 확인

### 7. 품질 및 문서

- [x] `shellcheck`, `yamllint`, Docker lint 적용
- [x] 단위/컨테이너 smoke test 추가
- [x] 실제 토큰이 출력되지 않는지 테스트
- [x] `DOCS.md`, `CHANGELOG.md`, `README.md` 작성
- [x] 한국어/영어 옵션 번역 추가
- [x] 위험 경고와 복구 절차 문서화

### 8. CI, GitHub, 배포

- [x] GitHub Actions lint workflow
- [x] GitHub Actions amd64 build workflow
- [x] GHCR publish 구조 — tag-gated official builder, generic/per-arch public packages, overwrite guard
- [x] App `image` 필드 적용 시점 결정 — 첫 non-dev/public GHCR pull 경로 확정 뒤 적용
- [x] 기능 브랜치 커밋/push — `95bc564`, `feat/mvp-runtime`
- [x] draft PR 생성 및 검증 결과 기록 — [#1](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/1)
- [x] public 저장소 전환과 PR #1 `main` 병합 — `ce06435`

## M2 — HAOS 실기 검증 및 첫 non-dev 릴리스

- [x] public App repository 설치와 App 시작
- [x] Ingress 웹 터미널과 인증된 Codex 실행
- [x] auto-start false/true 동작
- [x] 장치 코드 로그인 방식 확인
- [x] App 업데이트 후 Codex 인증 유지
- [x] SSH/Remote SSH 테스트 — mobile Remote 경유 desktop SSH project
- [x] `/config` 파일 수정·롤백 테스트
- [x] Core API 상태·서비스 목록 조회
- [x] 안전한 Core service call — 임시 persistent notification 생성·dismiss와 정리
- [x] Supervisor 정보·로그와 Core 설정 검사
- [ ] Supervisor/Core/App start/stop/restart 테스트
- [x] 브라우저 끊김 후 tmux 기능적 재접속과 resize
- [x] App 업데이트/재시작 후 host key fingerprint 유지
- [x] `0.1.2-dev` 기본 전역 운영 지침 생성·기본본 일치·사용자 override 보존
- [x] `0.1.3-dev` Core/App 로그 helper HAOS 회귀 확인
- [x] 첫 non-dev release/tag/GHCR publish — `0.1.3`, public anonymous linux/amd64 pull/full smoke PASS
- [ ] 기존 `0.1.3-dev` HAOS 설치의 `0.1.3` 일반 업데이트 경로 — 사용자 확인 대기, 삭제/reset 불필요

## M3 — aarch64 및 안정화

- [ ] Codex CLI aarch64 바이너리/런타임 검증
- [ ] multi-arch CI
- [ ] aarch64 HAOS 실기 테스트
- [ ] `arch`에 aarch64 추가
- [ ] 설치·복구 UX 개선
- [ ] stage를 experimental에서 stable로 바꿀 조건 평가

## Open Questions / Required Spikes

| ID | 질문 | 현재 처리 |
|---|---|---|
| Q-001 | Codex standalone 바이너리가 선택한 Alpine/base image의 amd64 및 aarch64에서 안정적인가? | amd64 CLI/app-server help 로컬 PASS; aarch64는 M3 |
| Q-002 | ttyd의 Ingress base path/WebSocket 처리가 추가 플래그 없이 가능한가? | nginx/ttyd 로컬 PASS; 실제 Supervisor Ingress는 M2 |
| Q-003 | Codex `workspace-write` sandbox가 HAOS App 컨테이너에서 정상 작동하는가? | MVP는 container 내부 `danger-full-access`; 이후 비교 테스트 |
| Q-004 | `manager` 역할에서 필요한 Supervisor 엔드포인트가 모두 허용되는가? | endpoint별 통합 테스트로 확인; admin 자동 승격 금지 |
| Q-005 | 실제 사용자 HAOS 아키텍처는 무엇인가? | 최초 MVP는 amd64; 확인·검증 후 aarch64 추가 |
| Q-006 | Desktop SSH project가 Alpine/musl 원격 app-server를 정상 시작하는가? | 사용자 mobile Remote 경유 E2E PASS; Codex/아키텍처 변경 시 재검증 |

## 최근 완료 기록

### 2026-07-13 — HAOS 진단 검토와 비파괴 Codex 운영 가드레일

- 진단 분류: 사용자 자동화 Repairs, 서드파티 통합/앱 경고, Core 업데이트, `/config` 파일 mode는 App 런타임 결함이 아니며 진단만으로 자동 수정하지 않기로 했다. 실환경 보고서 원문과 식별정보는 저장소에 포함하지 않았다.
- 실기 증거: `0.1.1-dev` Web UI와 인증된 Codex 실행, 실제 `/config` write, Supervisor Core/Supervisor/host/OS info·logs와 `/core/check`를 확인했다. Core REST service call, 운영 restart, 인증 영속성은 완료로 표시하지 않았다.
- 개선: 두 전역 지침 파일이 모두 없을 때만 `/data/codex/AGENTS.md`를 생성하고 기존 base/override/빈 파일/symlink의 내용과 mode를 보존한다. 진단과 변경 권한 분리, 비밀 비노출, `.storage`/DB 보호, config check, 고위험 승인 규칙을 담았다.
- 검증: `0.1.2-dev` amd64 build/full smoke, 실제 ttyd WebSocket, 기존 지침 보존 fixture, Linux 26 tests, ShellCheck/Hadolint/YAML/Markdown/App lint PASS.
- 배포: PR [#5](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/5)을 merge commit `7105bcd`로 public `main`에 병합했고 final main CI run `29225737374`가 통과했다.
- 남음: 실제 HAOS에서 `0.1.2-dev`로 업데이트한 뒤 새 Codex 세션이 기본 전역 지침을 읽는지 확인한다.

### 2026-07-13 — Ingress terminal TERM 수정 배포

- HAOS 증거: repository 설치/App 시작과 Ingress `/` 200, `/token` 200, `/ws` 101은 성공했다. tmux는 `terminal does not support clear`로 실패했다.
- 원인: ttyd의 연결별 `TERM=xterm-256color`가 S6 `with-contenv`에서 제거됐다.
- 수정: web entrypoint의 외부 TERM 복원, tmux pane TERM 보존, App `0.1.1-dev` version bump, rootfs LF 강제.
- 로컬 검증: 실패 재현 후 actual WebSocket shell `/config:tmux-256color`, Chrome 입력·출력, amd64 build/full smoke PASS.
- 배포: PR [#3](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/3)을 merge commit `b9e2808`로 public `main`에 병합했고, final main CI run `29222324024`가 통과했다.
- 후속: 사용자가 `0.1.1-dev` Web UI와 인증된 Codex 실행을 확인했다. resize/tmux reattach는 미검증이다.

### 2026-07-13 — public App repository main 배포

- 결과: 저장소를 public으로 전환하고 PR #1을 `main`에 병합해 Home Assistant App Store에 `https://github.com/Kanu-Coffee/codex-for-home-assistant`를 추가할 수 있게 했다.
- 배포 검증: public GitHub 페이지와 raw `repository.yaml`, App `config.yaml`, Dockerfile을 인증 없이 조회했다.
- 자동 검증: merge commit `ce06435`의 main CI에서 App config, lint/unit, amd64 build/smoke가 모두 PASS했다. 최초 build attempt의 Alpine CDN TLS 오류는 재실행에서 정상 통과했다.
- 미검증: 실제 HAOS 설치·시작, Ingress, device auth, Network SSH, Codex Desktop Remote SSH, 실제 Core/Supervisor 호출은 사용자의 M2 테스트 결과를 기다린다.
- 다음: 사용자가 amd64 HAOS App Store에서 public 저장소를 추가하고 설치·사용한 뒤 오류와 수정사항을 전달한다.

### 2026-07-13 — amd64 local MVP

- 결과: 설치 가능한 Local App source, Codex CLI, Ingress terminal runtime, 공개키 SSH, API helper, CI와 운영 문서를 구현했다.
- 로컬 검증: amd64 build, 24 unit/policy tests, full Docker smoke, App/shell/YAML/Markdown/Docker lint와 secret scan 통과.
- 미검증: 실제 HAOS Ingress, device auth/update persistence, Home Assistant Network 2223, Codex Desktop Remote SSH, 실제 Core/Supervisor manager API.
- 전달: 구현 커밋 `95bc564`, 전달 기록 `29c67b5`, CI 수정 `a09301a`를 private origin에 push하고 draft PR #1을 생성했다. `a09301a`의 원격 CI 6 jobs는 모두 PASS했다.
- 다음: HAOS amd64에서 M2 E2E를 수행하고 검증된 결과만 PR에 반영한다.

### 2026-07-12 — DDD baseline

- 목표: 합의된 요구사항을 구현 가능한 문서 세트로 정리
- 결과: `rules.md`, `progress.md`, 제품/아키텍처/보안/테스트/Git 문서 작성
- 검증: 문서 파일 생성 및 ZIP 무결성 검사 예정
- 다음: `master_prompt.md`로 M1 구현 시작
