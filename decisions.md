# decisions.md — Architecture Decision Records

## ADR-001 Home Assistant App으로 구현

- 상태: Accepted
- 결정: HACS integration이 아니라 Supervisor가 관리하는 Home Assistant App(구 Add-on) repository로 만든다.
- 이유: Codex CLI, ttyd, sshd, persistent `/data`, `/config` mount, Core/Supervisor API 권한이 필요하다.

## ADR-002 세 접근 방식을 동시에 제공

- 상태: Accepted
- 결정: Codex CLI, Ingress 웹 터미널, SSH/Remote SSH를 한 App에서 제공한다.
- 이유: 모바일/브라우저 즉시 접근과 Windows Codex Desktop의 편집 UX를 모두 확보한다.

## ADR-003 `/config` 전체 RW

- 상태: Accepted
- 결정: `homeassistant_config` 전체를 `/config`에 RW로 매핑한다.
- 이유: 대시보드뿐 아니라 자동화, scripts, packages, logs/DB 분석, 전체 운영을 맡기려는 제품 목표 때문이다.
- 결과: 설정 손상 위험을 Git/검사/backup 운영 규칙으로 관리한다.

## ADR-004 Core API + Supervisor manager

- 상태: Accepted
- 결정:

```yaml
homeassistant_api: true
hassio_api: true
hassio_role: manager
```

- 이유: 실제 기기 서비스 호출, 자동화 시험, 로그, 설정 검사, Core/App 운영이 필요하다.
- 제외: admin은 과도하며 보호 모드 등 무제한 Supervisor 권한은 제품 목표가 아니다.

## ADR-005 Raw token access 허용

- 상태: Accepted
- 결정: 웹 터미널과 SSH/Codex shell에서 `SUPERVISOR_TOKEN`을 사용할 수 있게 한다.
- 이유: 제한 프록시 없이 Codex가 전체 운영과 테스트를 직접 수행해야 한다.
- 결과: token redaction과 관리자 전용 접근을 강제한다.

## ADR-006 Host/Docker 특권은 주지 않음

- 상태: Accepted
- 결정: `docker_api`, `full_access`, `host_network`, admin 역할을 사용하지 않는다. 기본 AppArmor를 유지한다.
- 이유: Home Assistant 운영 기능에는 `/config`와 공식 API가 충분해야 하며, HAOS host 파괴 범위를 넓힐 필요가 없다.

## ADR-007 Web terminal은 ttyd + tmux

- 상태: Accepted
- 결정: Ingress terminal은 ttyd를 사용하고 tmux 세션에 attach한다.
- 이유: 구현이 단순하고 브라우저 연결이 끊겨도 Codex TUI를 유지할 수 있다.

## ADR-008 SSH port는 Network 설정

- 상태: Accepted
- 결정: 내부 port 22, 기본 host port 2223. 사용자는 App Network 설정에서 바꾼다.
- 이유: Supervisor의 `ports` mapping이 외부 포트 설정의 공식 위치다. JSON에 `ssh_port`를 중복 생성하지 않는다.

## ADR-009 SSH 공개키 전용

- 상태: Accepted
- 결정: 비밀번호 인증을 제공하지 않는다.
- 이유: 관리자 App에 LAN/원격 shell을 열므로 공개키가 적절한 기본값이다.

## ADR-010 Codex 인증은 `/data`

- 상태: Accepted
- 결정: `HOME=/data/home`, `CODEX_HOME=/data/codex`, file credential store를 사용한다.
- 이유: headless/container 환경에서 keyring보다 예측 가능하고 App update 후 로그인 유지가 필요하다.

## ADR-011 기본 Codex sandbox

- 상태: Provisional Accepted
- 결정: MVP 기본값은 `approval_policy=on-request`, `sandbox_mode=danger-full-access`다.
- 이유: 컨테이너 내부에서 `/config`와 API를 막힘없이 사용하고 HAOS의 nested sandbox 호환성 문제를 피한다.
- 검토 조건: `workspace-write` + network access가 실제 HAOS/Remote SSH에서 안정적으로 검증되면 더 제한적인 기본값을 재평가한다.

## ADR-012 앱 시작 정책

- 상태: Accepted
- 결정: `boot: manual` 기본.
- 이유: 상시 유지가 제품 목표가 아니며 필요할 때 시작한다. 사용자가 향후 UI에서 시작 정책을 조정할 여지는 남긴다.

## ADR-013 아키텍처 지원은 검증 기반

- 상태: Accepted
- 결정: M1은 amd64. aarch64는 CI와 HAOS 실기 후 `arch`에 추가한다.
- 이유: Codex binary 및 Remote SSH app-server의 플랫폼 호환성을 실제로 증명해야 한다.

## ADR-014 GitHub delivery

- 상태: Accepted
- 결정: Codex가 구현 후 branch commit, origin push, 가능하면 PR 생성까지 수행한다.
- 이유: 사용자 Windows/Codex 환경에 GitHub 연동이 되어 있으며 완결된 자동 개발 흐름이 목표다.

## ADR-015 2026.06 Home Assistant BuildKit 구조 사용

- 상태: Accepted
- 결정: `ghcr.io/home-assistant/base:3.24`와 S6 Overlay v3 native `s6-rc.d` 서비스 그래프를 사용한다. legacy `build.yaml`은 만들지 않으며 Dockerfile에 base image 기본값을 둔다.
- 이유: Supervisor 2026.04부터 `BUILD_FROM` 자동 주입과 legacy builder가 폐기됐고, 현재 공식 base는 S6 Overlay 3.2.3.0을 포함한다.

## ADR-016 Codex CLI 0.144.1 standalone musl artifact

- 상태: Accepted
- 결정: 공식 release `rust-v0.144.1`의 `codex-x86_64-unknown-linux-musl.tar.gz`를 SHA-256 `84091ae20c65fcc7d4120db97d1bd57d7ff8df9c7609fb781c78c2ebbd4f5a28`로 검증해 설치한다.
- 이유: amd64 Alpine base와 맞는 공식 standalone target이며 Node runtime 없이 버전과 공급망 입력을 재현 가능하게 고정할 수 있다.
- 제약: OpenAI가 명시한 Linux 지원 OS는 Ubuntu/Debian 중심이다. Alpine/HAOS와 Codex Desktop Remote SSH 호환성은 M2 실기 검증 전까지 완료로 표시하지 않는다.

## ADR-017 Ingress ACL reverse proxy

- 상태: Accepted
- 결정: Supervisor Ingress port 7681의 nginx가 `172.30.32.2`와 loopback만 허용하고, loopback port 7682의 ttyd로 WebSocket을 전달한다. ttyd는 tmux 공유 세션을 실행한다.
- 이유: `host_network` 없이 ttyd를 사용할 때 다른 내부 App이 인증 없이 터미널에 직접 접근하지 못하도록 공식 Ingress source ACL을 적용한다.

## ADR-018 개발 중 `image` 필드 유보

- 상태: Accepted
- 결정: private 저장소 MVP의 `config.yaml`에는 GHCR `image` 필드를 넣지 않고 Home Assistant Local Apps가 Dockerfile을 빌드하게 한다.
- 이유: private GHCR image를 Supervisor가 인증 없이 pull하는 공식 경로가 확인되지 않았다. 0.1.0 배포 전에 package visibility와 설치 경로를 결정하고 공식 builder workflow와 generic image name을 활성화한다.
