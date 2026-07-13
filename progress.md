# progress.md — 현재 상태와 할 일

> 이 파일은 프로젝트 상태의 유일한 기준이다. 에이전트는 모든 작업의 시작과 끝에 갱신한다.

## Project Status

- 상태: **M2 HAOS Web UI/Codex/Core/Supervisor/Remote SSH PASS / 0.1.3-dev 로그 helper 실기 재검증 대기**
- 현재 마일스톤: **M2 — HAOS 실기 검증 및 0.1.0**
- 마지막 문서 기준일: **2026-07-13**
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

### 2026-07-13 — 0.1.3-dev 라이브 회귀 수정·로고·M2 증거 반영

- 사용자 실기 증거: `0.1.2-dev` Ingress Web UI와 인증된 Codex 실행, Codex 모바일 앱의 공개키 Remote SSH 접속이 정상 동작했다. App을 삭제하지 않고 업데이트해 온 환경에서도 기존 영구 데이터와 인증 상태가 유지됐다.
- 라이브 보고서 증거: `/config` RW와 정리, Core REST 조회, Supervisor manager 조회·config-check, 직접 로그 API, SSH 공개키 전용 설정, 기본 전역 `AGENTS.md`의 비파괴 영속화는 통과했다. `ha-core-logs`와 `ha-addon-logs`만 JSON 전용 `Accept` 헤더 때문에 실패했다.
- 시험 해석: 보고서의 tmux 재접속 항목은 기존 Ingress 세션을 먼저 만든 시험이 아니어서 회귀 증거로 사용하지 않는다. 사용자 Web UI 성공은 확인됐지만 브라우저 종료 후 동일 세션 재접속은 별도 실기 항목으로 남긴다.
- 데이터 전환: 아래 변경은 이미지 계층의 헬퍼·표시 자산·문서만 바꾸며 `/data`를 초기화하거나 덮어쓰지 않는다. 일반 App 업데이트로 시험하고, 완전 삭제·재설치는 요구하지 않는다.
- [x] 로그 API가 `text/x-log`를 협상하도록 공용 API 클라이언트와 두 로그 헬퍼를 수정하고 회귀 테스트를 추가했다. media type allowlist가 CR/LF header injection도 요청 전에 거부한다.
- [x] 제공된 원본을 왜곡 없이 투명 RGBA `icon.png` 128x128과 `logo.png` 250x250으로 변환하고 README 표시·자산 계약 테스트를 추가했다.
- [x] 실제 ttyd WebSocket에서 resize와 연결 종료/재접속 뒤 동일 tmux session/pane/pid를 확인했다. 이는 같은 App 실행 중 보장이며 업데이트를 넘는 영속성 주장이 아니다.
- [x] 버전을 `0.1.3-dev`로 올리고 README, changelog, 설계·보안·테스트·운영 문서를 실제 실기 증거에 맞췄으며 `MANIFEST.md` 문서 checksum을 현재 내용으로 재생성했다.
- [x] amd64 이미지 build/full smoke, Linux 29 tests, ShellCheck/Hadolint/YAML/Markdown/App lint, secret scan과 Git diff를 검증했다.
- [ ] commit `2b145e4`를 `fix/live-log-logo`에 push하고 draft PR [#7](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/7)을 생성했다. CI 확인 후 public `main`에 병합해 HA App Store 업데이트 경로에 전달한다.

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

- [x] `docker buildx build --platform linux/amd64 --load --tag codex-ha:0.1.3-dev ...`: PASS — base `3.24`, 공식 Codex SHA-256, `codex-cli 0.144.1`, image label `0.1.3-dev`.
- [x] Linux `python -m pytest -ra`: PASS — 29 passed, 0 skipped; 자산 계약, S6/runtime, API JSON/x-log 협상·header injection 거부, token redaction, secret scan.
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
- [ ] 실제 HAOS UI resize/browser tmux reattach: NOT RUN — 로컬 실제 WebSocket은 PASS, 유효한 Web UI baseline으로 사용자 재검증 필요.
- [x] App update Codex 인증 영속성: PASS — App 삭제 없이 연속 업데이트한 환경에서 로그인 상태와 인증된 Codex 실행 유지.
- [ ] device code 로그인 방식 자체: NOT RUN — 현재 인증의 최초 로그인 방식 증거 없음.
- [x] Home Assistant Network 공개키 SSH와 remote app server: PASS — 사용자 mobile Remote → 연결된 desktop SSH project → HAOS `/config` E2E 확인.
- [x] 실제 `/config` write/rollback, Core REST 조회, Supervisor 조회/direct log/config-check: PASS — `/config` 임시 변경 정리, `/config`·`/states`·`/services`, Core/App direct logs, self/info, `/core/check` 확인.
- [ ] `0.1.3-dev`의 `ha-core-logs`/`ha-addon-logs`: NOT RUN — 원인 수정과 Linux/mock 검증 PASS, HAOS 일반 업데이트 뒤 재검증 필요.
- [ ] 실제 Core service call 및 Supervisor start/stop/restart: NOT RUN — 안전한 테스트 entity와 명시적 운영 시험 필요.
- [x] 실제 HAOS의 기본 전역 `AGENTS.md`: PASS — 0644, 이미지 기본본과 byte 동일, 사용자 override 비파괴 정책 확인.
- [ ] SSH host key 업데이트 전후 fingerprint 동일성: NOT RUN — 파일/키 존재와 로컬 persistence는 PASS이나 HAOS 전후 fingerprint 미기록.
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
- [ ] GHCR publish 구조
- [x] App `image` 필드 적용 시점 결정 — 0.1.0/공개 pull 경로 확정 뒤 적용
- [x] 기능 브랜치 커밋/push — `95bc564`, `feat/mvp-runtime`
- [x] draft PR 생성 및 검증 결과 기록 — [#1](https://github.com/Kanu-Coffee/codex-for-home-assistant/pull/1)
- [x] public 저장소 전환과 PR #1 `main` 병합 — `ce06435`

## M2 — HAOS 실기 검증 및 0.1.0

- [x] public App repository 설치와 App 시작
- [x] Ingress 웹 터미널과 인증된 Codex 실행
- [ ] 장치 코드 로그인 방식 확인
- [x] App 업데이트 후 Codex 인증 유지
- [x] SSH/Remote SSH 테스트 — mobile Remote 경유 desktop SSH project
- [x] `/config` 파일 수정·롤백 테스트
- [x] Core API 상태·서비스 목록 조회
- [ ] 안전한 테스트 엔티티 서비스 호출
- [x] Supervisor 정보·로그와 Core 설정 검사
- [ ] Supervisor/Core/App start/stop/restart 테스트
- [ ] 브라우저 끊김 후 tmux 재접속
- [ ] App 업데이트 후 host key fingerprint 유지
- [x] `0.1.2-dev` 기본 전역 운영 지침 생성·기본본 일치·사용자 override 보존
- [ ] `0.1.3-dev` Core/App 로그 helper HAOS 회귀 확인
- [ ] 0.1.0 release/tag/GHCR publish

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
