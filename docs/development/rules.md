# rules.md — 프로젝트 시스템 엔진

이 문서는 프로젝트의 최상위 개발 규칙이다. 모든 구현, 리뷰, 테스트, 문서, Git 작업에 적용한다.

## 1. 작업 원칙

### R-001 문서를 먼저 읽는다

코드 작업 전 `AGENTS.md`의 읽기 순서를 따른다. 문서와 코드가 불일치하면 코드를 무조건 기준으로 삼지 않는다. 의도된 동작을 확인하고 같은 변경에서 문서를 바로잡는다.

### R-002 `progress.md`를 실시간 기준으로 유지한다

작업 시작 시 Current Work를 작성하고, 완료 시 체크박스·검증 결과·남은 위험·다음 작업을 갱신한다. 오래된 계획을 방치하지 않는다.

### R-003 작은 수직 단위로 완성한다

한 번에 모든 기능을 흩어 만들지 않는다. 예: 컨테이너 부팅 → Codex 설치 → 웹 터미널 → SSH → API 래퍼 → CI 순서로, 각 단계가 독립적으로 시작·검증 가능해야 한다.

### R-004 사실과 추측을 구분한다

미검증 사항은 `가정`, `스파이크 필요`, `HAOS 실기 검증 필요`로 표시한다. 로그나 테스트 증거가 없으면 성공으로 간주하지 않는다.

## 2. 제품 불변조건

### R-101 핵심 기능 세 가지를 모두 제공한다

- Codex CLI
- Ingress 웹 터미널
- SSH 및 ChatGPT mobile Remote 직접 SSH

어느 하나를 제거하거나 별도 제품으로 분리하지 않는다.

### R-102 `/config` 전체를 RW로 제공한다

`homeassistant_config`를 컨테이너 `/config`에 `read_only: false`로 매핑한다. 경로별 읽기·쓰기 분리, SMB 배포 단계, 진단 전용 복제본은 도입하지 않는다.

### R-103 API는 전체 운영형으로 제공한다

다음을 사용한다.

```yaml
homeassistant_api: true
hassio_api: true
hassio_role: manager
```

Codex는 서비스 호출과 실제 기기 테스트를 할 수 있어야 한다. 원본 토큰을 숨기는 읽기 전용 프록시를 기본 구조로 도입하지 않는다.

### R-104 불필요한 호스트 권한은 주지 않는다

다음은 금지한다.

```yaml
hassio_role: admin
docker_api: true
full_access: true
host_network: true
apparmor: false
```

정말 필요하다는 재현 가능한 증거가 생기면 ADR을 새로 작성하고 사용자의 명시적 승인을 받은 뒤 변경한다.

### R-105 SSH 외부 포트는 Network 설정을 사용한다

컨테이너 포트는 `22/tcp`, 기본 호스트 포트는 `2223`으로 노출한다. 사용자는 Home Assistant App의 Network 설정에서 외부 포트를 바꾼다. 동일 목적의 `ssh_port` JSON 옵션을 중복 구현하지 않는다.

## 3. 보안 및 비밀정보

### R-201 비밀을 Git에 넣지 않는다

다음은 커밋 금지다.

- `/data/codex/auth.json`
- `SUPERVISOR_TOKEN` 또는 그 출력
- SSH 개인키
- 실제 Home Assistant `secrets.yaml`
- 실제 `/config/.storage` 덤프
- 실제 엔티티·사용자·내부 URL이 포함된 진단 번들

`.gitignore`, CI secret scan, 테스트 fixture의 가짜 값으로 이를 강제한다.

### R-202 로그에 토큰을 남기지 않는다

`set -x`를 런타임 초기화 스크립트에 사용하지 않는다. HTTP 래퍼는 Authorization 헤더를 출력하지 않는다. 오류 메시지에도 토큰을 포함하지 않는다.

### R-203 SSH는 공개키 전용이다

비밀번호 로그인은 구현하지 않는다. `authorized_keys`가 비어 있으면 웹 터미널은 시작하되 SSH 로그인은 비활성화하거나 명확한 경고와 함께 sshd를 시작하지 않는다.

### R-204 인증 파일 권한

Codex 인증 디렉터리와 SSH 키는 최소 권한으로 생성한다.

- 디렉터리: `0700`
- `auth.json`, `authorized_keys`, SSH host private keys: `0600`
- 공개 host key: `0644`

### R-205 고위험 실제 동작

기기 제어 권한은 제공하지만 다음 작업은 사용자의 현재 요청에 명시되어 있거나 실행 직전 상호작용 승인이 있어야 한다.

- 도어록 해제, 차고문/대문 열기, 경보 해제
- 호스트 종료/재부팅
- 전체 또는 부분 백업 복원
- App 제거, OS 업데이트, 데이터베이스 삭제

일반 조명·스위치·테스트용 엔티티는 범위를 명확히 하고 실행 전후 상태를 기록해 자동 검증할 수 있다.

## 4. 코드 규칙

### R-301 셸 스크립트

- Bash 스크립트는 `#!/usr/bin/with-contenv bashio` 또는 선택한 베이스 이미지의 공식 패턴을 따른다.
- 일반 Bash는 `set -Eeuo pipefail`를 사용한다.
- 변수는 항상 인용한다.
- JSON 파싱은 `jq`/`bashio`를 사용하고 정규식으로 파싱하지 않는다.
- `shellcheck`를 통과한다. 예외는 근거 주석과 함께 최소화한다.

### R-302 Dockerfile

- Codex CLI 및 시스템 패키지 버전을 가능한 범위에서 고정한다.
- 다운로드 바이너리는 아키텍처를 명시하고 체크섬을 검증한다.
- 빌드 중 민감값을 ARG/ENV로 넣지 않는다.
- 이미지 레이어에 임시 인증 파일을 남기지 않는다.
- `hadolint` 또는 동등 검사 결과를 기록한다.

### R-303 Home Assistant App 계약

- `config.yaml`은 최신 공식 스키마를 따른다.
- `repository.yaml`, `DOCS.md`, `CHANGELOG.md`, 번역 파일을 제공한다.
- `config.yaml`에 나열하는 아키텍처는 실제 CI와 실기 검증을 통과한 것만 포함한다.
- 과거 `build.yaml` 관행을 복사하지 말고 현재 공식 builder 방식을 확인한다.

### R-304 오류 처리

- 한 서비스가 실패했다고 무조건 컨테이너 전체를 조용히 종료하지 않는다.
- 치명적 초기화 실패는 명확한 로그와 비정상 종료 코드로 실패한다.
- SSH 키 미설정처럼 웹 터미널만으로 복구 가능한 조건은 degraded 상태로 동작할 수 있다.
- API 응답의 HTTP 상태와 Supervisor의 `result` 필드를 모두 검사한다.

### R-305 사용자 경험

- 웹 터미널은 `/config`에서 시작한다.
- `web_terminal_auto_start_codex=false`이면 로그인 셸을 보여준다.
- `true`이면 Codex를 한 번 실행하고 종료 후 일반 셸로 돌아온다.
- 브라우저 재접속 시 동일 tmux 세션에 붙는다.
- SSH login shell에서 `codex`가 PATH에 있고 `CODEX_HOME`이 일관되어야 한다.

## 5. Codex 런타임 규칙

### R-401 인증은 `/data`에 영속화한다

권장값:

```text
HOME=/data/home
CODEX_HOME=/data/codex
```

`cli_auth_credentials_store = "file"`을 기본으로 생성한다. 일반 업데이트와 기본
`preserve` 정책은 기존 사용자 설정을 덮어쓰지 않는다. 사용자가 Home Assistant
구성에서 명시적으로 user-file refresh를 선택한 경우에만 root-only backup과
target별 version 1회 기록을 만든 뒤 허용된 파일을 기본본으로 교체한다.

### R-402 헤드리스 로그인 경로를 제공한다

`ha-codex-login`은 `codex login --device-auth`를 실행한다. 장치 코드 로그인이 불가능할 때 로컬 `auth.json` 복사 또는 SSH callback forwarding 절차를 문서화한다.

### R-403 Codex 버전은 이미지 버전과 함께 관리한다

런타임 자동 업데이트로 재현성을 깨지 않는다. `check_for_update_on_startup=false`를 기본으로 두고 App 릴리스에서 Codex 버전을 올린다.

### R-404 권한 정책

사용자가 요청한 운영형 기능을 위해 컨테이너 내부에서 Codex가 `/config`와 내부 API에 접근할 수 있어야 한다. 기본 초안은 다음이다.

```toml
approval_policy = "on-request"
sandbox_mode = "danger-full-access"
```

여기서 `danger-full-access`는 **App 컨테이너 내부 Codex 샌드박스 기준**이다. Home Assistant App 자체에는 `full_access: true`를 주지 않는다. 실제로 `workspace-write + network_access`가 HAOS 컨테이너 안에서 안정적으로 동작하면 ADR을 갱신해 더 제한적인 기본값으로 바꿀 수 있다.

## 6. 테스트 규칙

### R-501 변경마다 최소 검증을 수행한다

- Markdown/YAML 형식 검사
- `shellcheck`
- Docker build 또는 빌드 불가 사유 기록
- `sshd -t`
- Codex 바이너리 `--version`
- 시작 스크립트 단위 테스트
- 비밀값 포함 여부 검사

### R-502 실기 검증과 로컬 검증을 구분한다

Home Assistant Ingress, Supervisor token, 실제 서비스 호출, App 재시작, Remote SSH는 HAOS/Supervisor 환경에서만 완료 처리한다. Docker 단독 테스트만으로 실기 검증을 대체하지 않는다.

### R-503 회귀 증거를 남긴다

실패를 수정할 때 가능한 경우 회귀 테스트를 추가한다. 재현이 HAOS에만 가능한 경우 `test_plan.md`의 수동 시나리오와 결과를 갱신한다.

## 7. Git 및 GitHub 규칙

### R-601 작업 전 상태 확인

```bash
git status --short
git remote -v
gh auth status
```

기존 변경을 덮어쓰거나 임의로 삭제하지 않는다.

### R-602 브랜치와 커밋

- 기능 브랜치 사용: 예 `feat/mvp-runtime`
- 의미 있는 단위로 커밋
- Conventional Commits 권장
- force push 금지
- 생성물·인증·실제 HA 설정 커밋 금지

### R-603 외부 Git 작업은 승인 범위에서 수행

커밋, push, PR, merge와 release는 사용자가 요청하거나 명시적으로 승인한 범위에서만 수행한다. 로컬 변경 작업은 검증된 diff를 준비한 상태로 완료할 수 있으며, 외부 작업을 수행할 때는 검증 결과와 미검증 항목을 commit/PR 본문에 적는다. Force push는 별도의 명시적 승인 없이 사용하지 않는다.

### R-604 remote가 없을 때

기존 저장소와 remote가 있으면 그대로 사용한다. Remote가 없더라도 사용자가 새 저장소 생성을 명시적으로 요청하기 전에는 private/public 저장소를 임의로 만들지 않는다. 이 프로젝트의 공식 remote는 public `Kanu-Coffee/codex-for-home-assistant`이지만, 연결·변경·push도 현재 요청 범위 안에서만 수행한다.

### R-605 HAOS 설치 테스트 전달

사용자가 Home Assistant 웹에서 설치할 **공개 배포**까지 명시적으로 요청하면 기능 브랜치나 draft PR만으로 완료 처리하지 않는다. 별도 승인 범위에서 자동 CI, 미검증 항목, main merge, public 저장소의 `repository.yaml`과 App source 접근, versioned image와 App Store 노출을 확인한다. 로컬 구현·문서 작업 요청을 자동으로 public 배포 승인으로 확대하지 않는다.

## 8. 완료 정의

작업은 다음을 모두 만족해야 완료다.

1. 요구사항을 충족하는 코드 또는 문서가 존재한다.
2. 가능한 자동 테스트를 실행했다.
3. HAOS 전용 미검증 항목을 숨기지 않았다.
4. `progress.md`가 실제 상태와 일치한다.
5. 관련 문서와 changelog가 갱신됐다.
6. Git diff를 검토했다.
7. 요청된 경우에만 커밋·push·PR을 완료하고 결과를 기록했다.
8. 공개 HAOS 설치 전달이 요청된 경우에만 public 저장소, `main` merge와 배포 표면을 확인했다.
