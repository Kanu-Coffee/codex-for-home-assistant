# architecture.md — 시스템 아키텍처

## 1. 컨텍스트

```text
Windows Codex Desktop ───── SSH ───────────────┐
Windows Terminal ────────── SSH ───────────────┤
Home Assistant Frontend ─── Ingress/WebSocket ─┤
                                               ▼
                              Codex for Home Assistant App
                              ├─ Codex CLI
                              ├─ ttyd
                              ├─ tmux
                              ├─ OpenSSH server
                              ├─ Git/YAML/API tools
                              ├─ /data   (persistent)
                              └─ /config (HA config RW)
                                      │
                  ┌───────────────────┴──────────────────┐
                  ▼                                      ▼
       Home Assistant Core API                Supervisor API
       http://supervisor/core/api/             http://supervisor/
       ws://supervisor/core/websocket          manager role
```

## 2. 신뢰 모델

이 App은 신뢰된 관리자 도구다.

- Codex shell은 `/config` 전체를 읽고 쓴다.
- shell은 `SUPERVISOR_TOKEN`을 이용해 Core 및 Supervisor API를 호출한다.
- Codex는 실제 기기를 작동시킬 수 있다.
- 컨테이너 밖의 Docker socket, host network, privileged hardware는 주지 않는다.

즉, Home Assistant 영역에서는 강한 권한을 주되 HAOS host/Docker 영역까지 무제한으로 확장하지 않는다.

## 3. 런타임 컴포넌트

### 3.1 Init 단계

컨테이너 시작 시 한 번 실행한다.

1. `/data` 디렉터리 생성 및 권한 설정
2. Codex 기본 config 생성(기존 파일 보존)
3. SSH host key 생성 또는 기존 key 로드
4. App 옵션에서 `authorized_keys` 렌더링
5. 공통 runtime environment 파일 생성
6. `/config` 존재 및 RW 여부 검사
7. `sshd -t`, `nginx -t`, 옵션 형식 검사
8. S6가 ttyd, Ingress proxy, sshd 서비스를 시작

### 3.2 ttyd 서비스

- Ingress port `7681`: nginx가 Supervisor gateway `172.30.32.2`와 loopback만 허용
- ttyd port `7682`: loopback에만 bind하고 nginx가 WebSocket reverse proxy
- 두 포트 모두 `ports`에 넣지 않아 외부 포트 미노출
- 실행 대상: `web-terminal-entrypoint`
- S6 `with-contenv`가 ttyd의 연결별 TERM을 제거하므로 entrypoint가 외부 `TERM=xterm-256color`를 복원
- entrypoint는 tmux 세션에 attach/create
- tmux 내부 session shell은 일반 Bash shebang으로 tmux의 `TERM=tmux-256color`를 보존
- tmux working directory: `/config`
- auto-start 옵션에 따라 Codex를 한 번 실행

### 3.3 sshd 서비스

- 내부 port: 22
- 공개키 전용
- root 또는 `/config`를 확실히 쓸 수 있는 전용 운영 사용자 사용
- MVP 권장: 컨테이너 root login을 공개키로만 허용하되 App 경계 밖 권한은 부여하지 않음
- host keys와 authorized_keys는 `/data/ssh`
- login shell에서 `/config`로 이동
- non-interactive SSH는 root의 Bash `BASH_ENV`로 동일 runtime environment와 `/config` 시작 경로 적용

전용 non-root 사용자를 선택하려면 `/config`의 host 권한을 바꾸지 않고 RW를 보장하는 방법을 먼저 증명해야 한다. 검증 없이 host-mounted `/config`에 `chown -R`하지 않는다.

### 3.4 Codex CLI

- command wrapper: `/usr/local/bin/codex`
- pinned binary: `/usr/local/libexec/codex-real`
- `HOME=/data/home`
- `CODEX_HOME=/data/codex`
- working directory: `/config`
- machine-local config: `/data/codex/config.toml`

기본 config 초안:

```toml
approval_policy = "on-request"
sandbox_mode = "danger-full-access"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
```

기존 `config.toml`이 있으면 전체 덮어쓰지 않는다. 누락된 필수 키만 안전하게 초기화하거나 샘플을 별도 제공한다.
wrapper는 현재 App의 approval/sandbox 옵션을 `-c` override로 주입해 파일을 덮어쓰지 않고 웹·SSH·Remote app-server에 같은 정책을 적용한다.

## 4. 영속 데이터

```text
/data/
├─ home/
│  └─ 사용자 shell 관련 영속 파일
├─ codex/
│  ├─ auth.json          # 비밀, 0600
│  ├─ config.toml
│  └─ sessions/...
├─ ssh/
│  ├─ authorized_keys   # 0600
│  ├─ ssh_host_*_key    # 0600
│  └─ *.pub             # 0644
└─ tmux/
```

`/data`는 Supervisor가 App 데이터로 영속화한다. `auth.json`이 App backup에 포함될 가능성이 있으므로 backup은 비밀정보로 취급한다.

## 5. Home Assistant 설정 데이터

```text
/config/
├─ configuration.yaml
├─ automations.yaml
├─ scripts.yaml
├─ scenes.yaml
├─ dashboards/
├─ packages/
├─ custom_components/
├─ www/
├─ .storage/
├─ home-assistant_v2.db  # 기본 Recorder SQLite인 경우
└─ secrets.yaml
```

Codex는 전체를 관리할 수 있다. 다만 운영 규칙상:

- `.storage`는 직접 수정보다 공식 API/UI/YAML을 우선한다.
- SQLite DB는 분석 시 read-only 연결을 우선한다.
- `secrets.yaml` 내용과 토큰을 응답/로그에 복사하지 않는다.

## 6. API 경로

### Core REST

```text
Base: http://supervisor/core/api/
Authorization: Bearer ${SUPERVISOR_TOKEN}
```

### Core WebSocket

```text
ws://supervisor/core/websocket
```

### Supervisor

```text
Base: http://supervisor/
Authorization: Bearer ${SUPERVISOR_TOKEN}
Role: manager
```

## 7. API helper 설계

### `ha-api`

```bash
ha-api GET /states
ha-api POST /services/light/turn_on '{"entity_id":"light.test"}'
```

요구사항:

- method allowlist가 아니라 사용자가 요청한 전체 Core API를 전달
- JSON body validation
- HTTP status 보존
- Authorization header 미출력
- pretty JSON 출력, `--raw` 선택 가능

### `supervisor-api`

```bash
supervisor-api GET /core/info
supervisor-api POST /core/check '{}'
```

manager 권한 거부는 정확히 표시하고 admin으로 자동 재시도하지 않는다.

### 진단 helper

- `ha-config-check`: `/core/check` 호출 및 결과 대기
- `ha-core-logs`: Core log endpoint 조회
- `ha-addon-logs <slug>`: 대상 App 로그 조회

엔드포인트 이름은 구현 시점의 공식 Supervisor API를 다시 확인한다.

## 8. 실제 기기 테스트 흐름

```text
1. 대상 entity와 기대 동작 확인
2. 현재 state/attributes 저장
3. 관련 automation trace/log 수집
4. service call 실행
5. 상태 변경 및 로그 확인
6. 실패 원인 분석
7. 안전하면 원래 상태 복원
8. 수행 내역 보고
```

도어록·경보·출입 장치 등 고위험 엔티티는 명시적 승인 규칙을 따른다.

## 9. Web Terminal 세션 흐름

```text
Ingress connection
  → ttyd
  → web-terminal-entrypoint
  → outer TERM=xterm-256color 복원
  → tmux new-session -A -s <name> -c /config
  → pane TERM=tmux-256color 보존
  → auto-start=false: login shell
  → auto-start=true: codex -C /config; then login shell
```

복수 브라우저가 동일 세션에 붙을 수 있는지, 각 연결별 별도 세션이 나은지는 MVP에서는 단일 공유 세션으로 시작하고 실제 UX를 평가한다.

## 10. SSH/Remote SSH 흐름

```text
Codex Desktop
  → ~/.ssh/config alias
  → App host:2223
  → public key auth
  → login shell loads runtime env
  → command -v codex
  → Codex remote app-server bootstrap
  → remote project /config
```

SSH host key가 재시작마다 바뀌면 Remote SSH가 깨지므로 `/data` 영속화는 필수다.

## 11. 실패 모드

| 실패 | 기대 동작 |
|---|---|
| authorized_keys 비어 있음 | Web UI는 정상, SSH는 비활성/경고 |
| Codex 미인증 | shell은 정상, `ha-codex-login` 안내 |
| Codex 다운로드/실행 실패 | build 또는 startup 실패를 명확히 표시 |
| `/config` RW 아님 | 치명적 startup 오류 |
| Core/Supervisor API 일시 실패 | shell 유지, helper가 오류 반환 |
| ttyd 실패 | App unhealthy 또는 명확한 service error |
| sshd 실패 | Web UI는 가능, SSH degraded 로그 |
| 브라우저 연결 끊김 | tmux/Codex 세션 유지 |

## 12. 아키텍처 제약

- App 하나에서 기능을 제공한다.
- 별도 sidecar/proxy/container를 요구하지 않는다.
- 외부 SMB/SSH relay를 요구하지 않는다.
- Ingress를 위해 host network를 사용하지 않는다.
- App 소스 저장소와 실제 HA `/config` 저장소는 별개일 수 있다.
