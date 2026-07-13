# progress.md — 현재 상태와 할 일

> 이 파일은 프로젝트 상태의 유일한 기준이다. 에이전트는 모든 작업의 시작과 끝에 갱신한다.

## Project Status

- 상태: **Specification complete / Implementation not started**
- 현재 마일스톤: **M1 — 동작 가능한 amd64 MVP**
- 마지막 문서 기준일: **2026-07-12**
- 권장 저장소: `codex-for-home-assistant` (초기에는 private)

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

### 2026-07-13 — amd64 MVP 런타임 구현 및 GitHub 전달

- 목표: Codex CLI, Ingress ttyd+tmux, 공개키 SSH/Remote SSH 기반, `/config` RW, Core/Supervisor manager API helper를 포함하는 설치 가능한 amd64 Home Assistant App MVP를 구현한다.
- 변경 예정 파일: 저장소/App 골격(`repository.yaml`, `codex_home_assistant/**`), 런타임 스크립트와 S6 서비스, 테스트와 lint/build workflow, 사용자·보안·운영 문서, `references.md`, `progress.md`.
- 검증 계획: YAML/Markdown/정책/비밀 검사, shellcheck, hadolint, 단위 테스트, Docker amd64 build, 컨테이너 smoke, `codex --version`, `sshd -t`, ttyd/tmux 및 SSH/API helper 동작을 로컬에서 검증하고 결과를 명령과 함께 기록한다.
- 현재 위험/가정: 이 작업 환경에는 HAOS/Supervisor 및 실제 Home Assistant 엔티티가 없을 수 있다. Ingress/WebSocket, Supervisor token/manager endpoint, 실제 서비스 호출, App 업데이트 영속성, Windows Codex Desktop Remote SSH는 로컬 검증으로 완료 처리하지 않고 M2 실기 항목으로 남긴다. 공식 문서와 현재 release artifact를 확인한 뒤 base image·Codex pin을 결정한다.
- Git 계획: 새 저장소이므로 baseline을 보존해 Git을 초기화하고 `feat/mvp-runtime`에서 작업한다. `origin`이 없으면 인증된 `Kanu-Coffee` 계정에 private `codex-for-home-assistant`를 만들고 검증 후 push와 draft PR을 시도한다.

## M1 — 동작 가능한 amd64 MVP

### 1. 저장소 및 기본 골격

- [ ] 기존 Git 상태와 remote 확인
- [ ] remote가 없으면 private GitHub repo `codex-for-home-assistant` 생성
- [ ] 현재 공식 `home-assistant/apps-example` 구조 확인
- [ ] `repository.yaml`, App 폴더, `config.yaml`, `Dockerfile`, `rootfs`, 문서 골격 생성
- [ ] `.gitignore`, `.editorconfig`, lint 설정 추가

### 2. 컨테이너 런타임

- [ ] 최신 Home Assistant base image 선택 및 근거 기록
- [ ] `bash`, `curl`, `git`, `jq`, `yq`, `yamllint`, `openssh`, `ttyd`, `tmux`, `sqlite`, `ripgrep` 설치
- [ ] S6 서비스/초기화 구조 구현
- [ ] `/data/home`, `/data/codex`, `/data/ssh`, `/data/tmux` 초기화
- [ ] 민감 파일 권한 검증

### 3. Codex CLI

- [ ] amd64에서 재현 가능한 설치 방식 선택
- [ ] Codex 버전 pin 및 checksum 검증
- [ ] `/usr/local/bin/codex` PATH 보장
- [ ] `CODEX_HOME=/data/codex` 적용
- [ ] 기본 `config.toml`을 비파괴 방식으로 생성
- [ ] `ha-codex`, `ha-codex-login` 구현
- [ ] `codex --version` 컨테이너 테스트

### 4. 웹 터미널

- [ ] `ingress: true`, `ingress_stream: true` 구성
- [ ] ttyd가 Ingress 하위 경로에서 정상 동작하도록 구현
- [ ] tmux 세션 자동 생성/재접속
- [ ] `/config` 시작 경로 확인
- [ ] `web_terminal_auto_start_codex=false` 동작 검증
- [ ] `web_terminal_auto_start_codex=true` 동작 검증
- [ ] Codex 종료 후 셸 복귀 검증

### 5. SSH 및 Remote SSH

- [ ] 공개키 전용 sshd 설정
- [ ] SSH host key를 `/data/ssh`에 영속화
- [ ] `authorized_keys` 옵션 반영 및 권한 검증
- [ ] 키가 없을 때 안전한 degraded 동작
- [ ] 기본 host port `2223` 노출
- [ ] login shell에서 `codex`, `CODEX_HOME`, `/config` 확인
- [ ] Windows OpenSSH 접속 검증
- [ ] Codex Desktop Remote SSH bootstrap 검증

### 6. Home Assistant API 운영 기능

- [ ] `SUPERVISOR_TOKEN`을 웹/SSH 셸에서 안전하게 사용할 수 있도록 런타임 환경 구성
- [ ] `ha-api` 래퍼 구현
- [ ] `supervisor-api` 래퍼 구현
- [ ] `ha-config-check` 구현
- [ ] Core 로그 조회 helper 구현
- [ ] App 로그 조회 helper 구현
- [ ] REST/WebSocket 사용 예시 문서화
- [ ] manager 역할에서 실제 허용되는 엔드포인트 검증표 작성

### 7. 품질 및 문서

- [ ] `shellcheck`, `yamllint`, Docker lint 적용
- [ ] 단위/컨테이너 smoke test 추가
- [ ] 실제 토큰이 출력되지 않는지 테스트
- [ ] `DOCS.md`, `CHANGELOG.md`, `README.md` 작성
- [ ] 한국어/영어 옵션 번역 추가
- [ ] 위험 경고와 복구 절차 문서화

### 8. CI, GitHub, 배포

- [ ] GitHub Actions lint workflow
- [ ] GitHub Actions amd64 build workflow
- [ ] GHCR publish 구조
- [ ] App `image` 필드 적용 시점 결정
- [ ] 기능 브랜치 커밋/push
- [ ] PR 생성 및 검증 결과 기록

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
| Q-001 | Codex standalone 바이너리가 선택한 Alpine/base image의 amd64 및 aarch64에서 안정적인가? | M1에서 컨테이너 실행 검증 |
| Q-002 | ttyd의 Ingress base path/WebSocket 처리가 추가 플래그 없이 가능한가? | 공식 App 예제 및 app-ssh 구현 참고 후 실기 검증 |
| Q-003 | Codex `workspace-write` sandbox가 HAOS App 컨테이너에서 정상 작동하는가? | MVP는 container 내부 `danger-full-access`; 이후 비교 테스트 |
| Q-004 | `manager` 역할에서 필요한 Supervisor 엔드포인트가 모두 허용되는가? | endpoint별 통합 테스트로 확인; admin 자동 승격 금지 |
| Q-005 | 실제 사용자 HAOS 아키텍처는 무엇인가? | 최초 MVP는 amd64; 확인·검증 후 aarch64 추가 |
| Q-006 | Codex Desktop Remote SSH가 Alpine/musl 원격에서 요구하는 app-server를 정상 시작하는가? | M1 핵심 스파이크 |

## 최근 완료 기록

### 2026-07-12 — DDD baseline

- 목표: 합의된 요구사항을 구현 가능한 문서 세트로 정리
- 결과: `rules.md`, `progress.md`, 제품/아키텍처/보안/테스트/Git 문서 작성
- 검증: 문서 파일 생성 및 ZIP 무결성 검사 예정
- 다음: `master_prompt.md`로 M1 구현 시작
