# progress.md — 현재 상태와 할 일

> 이 파일은 프로젝트 상태의 유일한 기준이다. 에이전트는 모든 작업의 시작과 끝에 갱신한다.

## Project Status

- 상태: **M1 public App repository merged and ready for HAOS install / M2 HAOS validation pending**
- 현재 마일스톤: **M1 — 동작 가능한 amd64 MVP**
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

- [x] `docker build --platform linux/amd64 ...`: PASS — base `3.24`, 공식 Codex SHA-256, `codex-cli 0.144.1`.
- [x] Linux `python -m pytest -ra`: PASS — 24 tests; manifest/policy, S6/runtime, API error/result/token redaction, secret scan.
- [x] `tests/docker-smoke.sh codex-ha:mvp`: PASS — S6, `/config` RW, permissions, nginx/ttyd, auto-start false/true, Codex 후 Bash 복귀, 공개키 SSH, 비밀번호 거부, UTF-8 env, host-key/config 영속성, invalid/no-key degraded recovery.
- [x] `shellcheck` 0.11.0: PASS — runtime/test shell scripts, warning 이상 없음.
- [x] `hadolint` 2.14.0, `yamllint`, `markdownlint-cli2` 0.23.0: PASS.
- [x] Home Assistant App linter 2.21.0: PASS.
- [x] `git diff --check`: PASS.
- [x] Windows OpenSSH → local Docker sshd: PASS — `/config`, `/data/codex`, `codex --version`, `codex app-server --help`, fake token presence without output.
- [x] GitHub Actions push/PR CI at `a09301a`: PASS — unit/lint, Home Assistant App config, amd64 build/smoke 각 2회, 총 6 jobs.
- [x] Public repository/main delivery: PASS — visibility PUBLIC, PR #1 MERGED, anonymous repository/App source reads, final main CI.
- [ ] HAOS App repository install/start: NOT RUN — HAOS/Supervisor 환경 없음.
- [ ] 실제 Ingress/WebSocket/resize/browser tmux reattach: NOT RUN — HAOS 필요.
- [ ] 실제 device auth 및 App update 인증 영속성: NOT RUN — 사용자 인증/HAOS 필요.
- [ ] Home Assistant Network 2223 및 Codex Desktop Remote SSH: NOT RUN — HAOS/desktop E2E 필요.
- [ ] 실제 Core API/service call 및 Supervisor manager endpoint: NOT RUN — 실제 HA/안전한 테스트 entity 필요.
- Known issues: Alpine/musl은 Codex release target과 로컬 CLI/app-server help가 동작하지만 OpenAI의 명시 지원 OS 목록은 Ubuntu/Debian 중심이다. Remote SSH 완료로 간주하지 않는다.

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
- [ ] Codex Desktop Remote SSH bootstrap 검증

### 6. Home Assistant API 운영 기능

- [x] `SUPERVISOR_TOKEN`을 웹/SSH 셸에서 안전하게 사용할 수 있도록 런타임 환경 구성
- [x] `ha-api` 래퍼 구현
- [x] `supervisor-api` 래퍼 구현
- [x] `ha-config-check` 구현
- [x] Core 로그 조회 helper 구현
- [x] App 로그 조회 helper 구현
- [x] REST/WebSocket 사용 예시 문서화
- [x] manager 역할 endpoint 검증표 작성 (실제 결과는 모두 M2 NOT RUN)

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

- [ ] 로컬 App 설치
- [ ] Ingress 웹 터미널 테스트
- [ ] 장치 코드 로그인 및 인증 재시작 유지
- [ ] SSH/Remote SSH 테스트
- [ ] `/config` 파일 수정·롤백 테스트
- [ ] Core API 상태 조회 및 안전한 테스트 엔티티 서비스 호출
- [ ] Supervisor 로그·설정 검사·Core 재시작 테스트
- [ ] 브라우저 끊김 후 tmux 재접속
- [ ] App 업데이트 후 host key와 Codex 인증 유지
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
| Q-006 | Codex Desktop Remote SSH가 Alpine/musl 원격에서 요구하는 app-server를 정상 시작하는가? | CLI `app-server --help`만 PASS; Desktop E2E는 M2 |

## 최근 완료 기록

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
