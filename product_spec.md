# product_spec.md — 제품 요구사항

## 1. 제품 정의

`Codex for Home Assistant`는 HAOS의 Supervisor가 관리하는 Home Assistant App이다. 사용자는 Home Assistant 안의 웹 터미널, 일반 SSH 또는 Windows Codex Desktop Remote SSH를 통해 동일한 Codex 환경에 접근한다.

Codex는 Home Assistant 설정과 런타임을 관찰·수정·시험하는 신뢰된 운영 에이전트로 사용된다.

## 2. 목표

- 대시보드, 자동화, 스크립트, 테마, 패키지 등 `/config` 전체를 Codex가 직접 관리한다.
- 엔티티·기기·구역·통계·Trace·로그를 분석한다.
- 실제 서비스 호출로 조명·스위치 등 기기를 시험한다.
- 설정 변경 후 검사, 재로드/재시작, 재시험을 한 작업 흐름에서 수행한다.
- 별도 SMB, 외부 Ubuntu 중계 서버, 별도 진단 프록시 없이 HAOS 내부에서 완결한다.

## 3. 주요 사용자 시나리오

### US-001 웹에서 즉시 Codex 사용

사용자는 Home Assistant의 App 화면에서 Web UI를 열고 일반 셸 또는 자동 실행된 Codex TUI를 사용한다.

### US-002 Windows 터미널에서 SSH 사용

사용자는 공개키로 App에 SSH 접속하고 `/config`에서 `codex`, Git, YAML 검사, API helper를 사용한다.

### US-003 Codex Desktop Remote SSH 사용

Windows Codex Desktop은 SSH host를 발견하고 원격 `/config` 프로젝트를 열어 파일 수정, 명령 실행, 테스트를 수행한다.

### US-004 자동화 오류 진단

Codex는 자동화 YAML, 현재 상태, 과거 이력, Trace, Core/App 로그를 함께 분석하고 원인을 수정한다.

### US-005 실제 기기 검증

Codex는 대상 엔티티의 현재 상태를 기록하고 서비스를 호출한 뒤 상태·로그·Trace를 재확인한다. 안전한 경우 원래 상태로 복원한다.

### US-006 Home Assistant 운영

Codex는 설정 검사, Core 로그 조회, App 로그 조회, Core/App 재시작 등 `manager` 역할 범위의 운영 작업을 수행한다.

## 4. 기능 요구사항

### FR-001 Codex CLI

- 컨테이너에 공식 Codex CLI를 포함한다.
- `codex`가 웹 터미널 및 SSH login shell의 PATH에서 동작한다.
- 기본 작업 디렉터리는 `/config`다.
- 버전은 App 이미지에 pin한다.

### FR-002 Codex 인증 영속화

- `CODEX_HOME=/data/codex`를 사용한다.
- `auth.json`, `config.toml`, 세션 데이터가 App 재시작/업데이트 후 유지된다.
- `ha-codex-login` 장치 코드 로그인 명령을 제공한다.
- 인증 파일은 로그와 Git에 노출하지 않는다.

### FR-003 Ingress 웹 터미널

- Home Assistant Ingress를 사용한다.
- 외부 웹 터미널 포트를 노출하지 않는다.
- WebSocket 스트리밍과 터미널 크기 변경을 지원한다.
- tmux로 브라우저 재접속 시 세션을 복구한다.

### FR-004 웹 터미널 Codex 자동 실행

App 옵션:

```yaml
web_terminal_auto_start_codex: false
```

- `false`: 일반 login shell 표시
- `true`: Codex를 한 번 실행, 종료 후 일반 shell로 복귀

### FR-005 SSH

- OpenSSH server를 제공한다.
- 공개키 인증만 허용한다.
- 컨테이너 포트 `22/tcp`, 기본 host port `2223`을 사용한다.
- host port는 Home Assistant App의 Network 설정에서 변경 가능하다.
- SSH host keys는 `/data`에 영속화한다.

### FR-006 Remote SSH

- Windows Codex Desktop이 원격 host로 연결할 수 있어야 한다.
- login shell에서 `codex`가 PATH에 있어야 한다.
- 원격 Codex 인증이 완료되어 있어야 한다.
- `/config`를 원격 프로젝트로 열 수 있어야 한다.

### FR-007 `/config` 전체 관리

다음 매핑을 사용한다.

```yaml
map:
  - type: homeassistant_config
    path: /config
    read_only: false
```

하위 폴더를 별도 제한하지 않는다.

### FR-008 Home Assistant Core API

```yaml
homeassistant_api: true
```

Codex는 다음을 할 수 있어야 한다.

- 현재 상태 및 서비스 조회
- REST/WebSocket API 사용
- 서비스 호출 및 실제 기기 테스트
- 자동화/스크립트 실행
- 이력·통계·Trace 조회가 가능한 공식 API 사용

### FR-009 Supervisor API

```yaml
hassio_api: true
hassio_role: manager
```

Codex는 manager 역할이 허용하는 범위에서 다음을 수행한다.

- Core/Supervisor/App 로그 조회
- 설정 검사
- Core 및 App 정보/상태 조회
- Core/App 시작·중지·재시작 등 운영

실제 허용 범위는 통합 테스트로 확인하며, 실패했다고 자동으로 `admin`으로 올리지 않는다.

### FR-010 API helper 명령

최소 명령:

```text
ha-codex
ha-codex-login
ha-api
supervisor-api
ha-config-check
ha-core-logs
ha-addon-logs
```

helper는 토큰을 출력하지 않고 HTTP 오류를 명확히 반환한다.

### FR-011 App 설정

최소 JSON 옵션:

- `authorized_keys`
- `web_terminal_auto_start_codex`
- `tmux_session_name`
- `codex_approval_policy`
- `codex_sandbox_mode`
- `log_level`

SSH 외부 포트는 JSON 옵션이 아니라 Network 설정이다.

### FR-012 Git 도구

컨테이너에서 Git을 사용할 수 있어야 한다. 실제 Home Assistant `/config`의 Git 관리 여부는 사용자가 결정하며, App 소스 저장소와 HA 설정 저장소를 혼동하지 않는다.

## 5. 비기능 요구사항

### NFR-001 재현성

Codex CLI, base image, 주요 패키지는 버전 또는 digest로 추적 가능해야 한다.

### NFR-002 복구 가능성

App 재설치 전까지 `/data` 인증과 SSH host key가 유지된다. 설정 변경은 Git checkpoint 및 Home Assistant 설정 검사 절차를 권장한다.

### NFR-003 보안 기본값

- Ingress 관리자 전용
- SSH 공개키 전용
- 기본 AppArmor 활성
- `manager` 역할
- Docker/host privileged 권한 없음

### NFR-004 관찰 가능성

시작 단계, Codex 버전, 웹 터미널/SSH 상태, degraded 이유를 토큰 없이 App 로그에 기록한다.

### NFR-005 플랫폼

- M1: amd64만 실제 지원 표시
- M3: aarch64 검증 후 추가

## 6. 비목표

MVP에서는 다음을 만들지 않는다.

- 별도 GUI 관리 콘솔
- Codex 대화 기록 전용 웹 앱
- 읽기 전용 API 프록시
- 세밀한 AppArmor 경로 제한
- Docker socket 관리
- HAOS host shell 제공
- 비밀번호 SSH 로그인
- 멀티 사용자/역할 분리
- 자동 Bubble Card 생성 전용 마법사
- Codex API key를 GitHub Actions에 자동 복제

## 7. MVP 수용 기준

아래가 모두 충족되어야 M1/M2 완료다.

1. App이 HAOS amd64에 설치·시작된다.
2. Web UI에서 ttyd가 열리고 `/config` shell을 제공한다.
3. auto-start 옵션이 false/true 모두 정확히 동작한다.
4. 웹 연결을 끊었다 다시 열어도 tmux 세션이 복구된다.
5. `codex login --device-auth` 후 인증이 App 재시작 뒤에도 남는다.
6. 공개키 SSH가 기본 host port 2223에서 동작한다.
7. Windows Codex Desktop이 SSH host와 `/config` 프로젝트를 연다.
8. Codex가 `/config` 테스트 파일을 생성·수정·삭제할 수 있다.
9. Core API로 상태 조회와 안전한 서비스 호출을 성공한다.
10. Supervisor manager API로 로그 조회 및 설정 검사를 성공한다.
11. `admin`, Docker API, full access, host network 없이 위 기능이 동작한다.
12. CI build/lint가 통과하고 GitHub에 코드와 문서가 push된다.
