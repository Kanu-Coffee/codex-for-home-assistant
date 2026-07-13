# Codex for Home Assistant 사용 설명서

> `0.1.0-dev`는 amd64 전용 실험 개발판입니다. `/config` 전체를 쓰고 Home Assistant Core API와 Supervisor `manager` API를 호출할 수 있는 강한 관리자 도구입니다. 인터넷에 SSH 포트를 직접 공개하지 마세요.

## 현재 제공 범위

- 컨테이너 안에 고정된 Codex CLI (`codex-cli 0.144.1`)
- Home Assistant Ingress 기반 웹 터미널 (`ttyd` + 공유 `tmux` 세션)
- 공개키 전용 OpenSSH와 Codex Desktop SSH 연결 기반
- Home Assistant 설정 전체를 `/config`에 read-write로 매핑
- Core REST API와 Supervisor `manager` API helper
- `/data`에 Codex 인증, 설정, SSH host key 영속화

다음 권한은 의도적으로 제공하지 않습니다: Supervisor `admin`, Docker API, Home Assistant App `full_access`, host network, AppArmor 비활성화.

`codex_sandbox_mode: danger-full-access`는 **이 App 컨테이너 안에서의 Codex 정책**입니다. Home Assistant의 `full_access: true`나 HAOS host 권한을 뜻하지 않습니다.

## 설치: public App 저장소

Home Assistant의 공식 [App repository](https://developers.home-assistant.io/docs/apps/repository/) 방식으로 다음 public GitHub URL을 App Store에 추가합니다.

```text
https://github.com/Kanu-Coffee/codex-for-home-assistant
```

`config.yaml`에는 registry `image`가 없습니다. `image`는 선택 항목이며, 이 개발판은 저장소의 Dockerfile을 Supervisor가 amd64 장치에서 소스 빌드하도록 배포합니다. GHCR 이미지는 HAOS 실기 검증 뒤 별도 릴리스 단계에서 추가합니다.

요구사항:

- Home Assistant OS/Supervised와 Supervisor
- amd64 시스템
- 빌드 중 Home Assistant base image, Alpine 패키지, OpenAI Codex release를 받을 수 있는 인터넷 연결

설치 절차:

1. Home Assistant에서 **설정 → Apps → App store**를 엽니다.
2. 우측 상단 메뉴의 **Repositories**를 열고 위 GitHub URL을 붙여 넣어 추가합니다.
3. App Store를 새로고침하고 **Codex for Home Assistant**를 엽니다.
4. **Install**을 누릅니다. 첫 소스 빌드는 다운로드와 컴파일 때문에 오래 걸릴 수 있습니다.
5. 아래 옵션에 SSH 공개키를 추가하고 **Network**에서 `22/tcp`의 호스트 포트를 확인합니다.
6. App을 수동으로 시작합니다. 기본 `boot: manual`이므로 Home Assistant 부팅 시 자동 시작하지 않습니다.

목록에 보이지 않으면 장치가 amd64인지 확인하고 App Store를 새로고침하세요. 설치 실패 시 App/Supervisor 로그를 보존해 보고하되 token이나 `auth.json`은 공유하지 마세요.

## App 설정

| 옵션 | 기본값 | 의미 |
| --- | --- | --- |
| `authorized_keys` | `[]` | root SSH 로그인을 허용할 OpenSSH 공개키 목록. 비어 있거나 모두 잘못되면 SSH만 비활성화되고 Web UI는 유지됩니다. |
| `web_terminal_auto_start_codex` | `false` | 새 웹 `tmux` 세션을 만들 때 Codex를 한 번 실행합니다. Codex가 끝나면 Bash로 돌아옵니다. |
| `tmux_session_name` | `codex-ha` | 모든 Web UI 연결이 공유하는 세션 이름. 영문, 숫자, `.`, `_`, `-`만 허용됩니다. |
| `codex_approval_policy` | `on-request` | Codex 명령 승인 정책 (`untrusted`, `on-request`, `never`). |
| `codex_sandbox_mode` | `danger-full-access` | 컨테이너 내부 Codex 샌드박스 (`workspace-write`, `danger-full-access`). |
| `log_level` | `info` | ttyd 웹 터미널 로그 수준. `trace`/`debug`에서 상세 로그를 켭니다. |

공개키 설정 예시에서 `AAAA...` 부분을 자신의 **공개키** 한 줄로 교체합니다. 개인키는 절대 붙여 넣지 마세요.

```yaml
authorized_keys:
  - ssh-ed25519 AAAA... windows-pc
web_terminal_auto_start_codex: false
tmux_session_name: codex-ha
codex_approval_policy: on-request
codex_sandbox_mode: danger-full-access
log_level: info
```

`config.toml`은 `/data/codex/config.toml`에 처음 한 번만 생성되고 이후 사용자 설정을 덮어쓰지 않습니다. `codex` wrapper는 파일을 수정하지 않은 채 현재 `codex_approval_policy`와 `codex_sandbox_mode` App 옵션을 모든 CLI/Remote app-server 실행에 우선 적용합니다. 옵션을 바꾼 뒤 이미 실행 중인 Codex는 종료하고 새로 시작하세요. 그 밖의 Codex 설정은 `config.toml`에서 관리합니다.

## Web UI와 공유 tmux 세션

App을 시작한 뒤 **OPEN WEB UI**를 누릅니다. 셸의 시작 디렉터리는 `/config`이고 다음 값이 적용됩니다.

```text
HOME=/data/home
CODEX_HOME=/data/codex
PATH=/usr/local/bin:...
```

기본값 `web_terminal_auto_start_codex: false`에서는 Bash가 열립니다. 다음 명령으로 Codex를 시작합니다.

```bash
ha-codex
```

`true`이면 **새 tmux 세션이 만들어질 때만** Codex를 한 번 자동 실행하고, 종료 후 Bash로 돌아갑니다. 이미 존재하는 세션에 재접속할 때는 다시 실행하지 않습니다.

브라우저를 닫아도 tmux와 그 안의 Codex 작업은 App이 살아 있는 동안 계속됩니다. 같은 `tmux_session_name`을 사용하는 브라우저 탭과 사용자는 동일한 화면과 키 입력을 공유하므로 신뢰하는 관리자만 Web UI를 열어야 합니다. SSH 셸에서 같은 세션에 들어가려면 다음을 실행합니다.

```bash
tmux attach -t codex-ha
```

세션을 강제로 초기화하면 그 안의 Codex와 실행 중인 명령이 종료됩니다.

```bash
tmux kill-session -t codex-ha
```

사용자 지정 세션 이름을 썼다면 `codex-ha`를 그 이름으로 바꾸세요.

## Codex 로그인

### 권장: device code 인증 (OpenAI 문서상 beta)

OpenAI의 현재 headless 인증 권장 경로는 문서상 beta인 device code 방식입니다. 개인 계정의 ChatGPT 보안 설정 또는 workspace 관리자의 권한 설정에서 device code 로그인을 허용해야 할 수 있습니다.

```bash
ha-codex-login
```

표시된 URL을 신뢰하는 다른 브라우저에서 열고 일회용 코드를 입력합니다. 완료 후 확인합니다.

```bash
codex login status
```

인증은 `/data/codex/auth.json`에 저장되며 App 재시작 뒤에도 유지되도록 설계되었습니다. HAOS에서의 로그인과 업데이트 후 영속성은 아직 M2 실기 검증 항목입니다.

### 대안: 로컬 `auth.json` 복사

Device code 로그인이 불가능하면 브라우저가 있는 로컬 PC에서 `codex login`을 완료하고 파일 자격 증명을 복사할 수 있습니다. 로컬 Codex가 OS keyring을 사용하면 `~/.codex/auth.json`이 없을 수 있습니다. 그 경우 device code를 사용하거나, 로컬 Codex의 `cli_auth_credentials_store = "file"` 설정을 검토한 뒤 다시 로그인하세요.

Windows PowerShell에서 먼저 파일과 일반 SSH 연결을 확인합니다.

```powershell
Test-Path "$HOME\.codex\auth.json"
ssh codex-ha
```

그다음 App의 실제 `CODEX_HOME`으로 복사하고 권한을 고정합니다.

```powershell
scp "$HOME\.codex\auth.json" codex-ha:/data/codex/auth.json
ssh codex-ha "chmod 700 /data/codex && chmod 600 /data/codex/auth.json"
```

`auth.json`은 access token을 담은 평문 비밀 파일이므로 비밀번호처럼 취급합니다.

- Git, 이슈, 채팅, 로그에 넣지 않습니다.
- 다른 Home Assistant App이나 공유 폴더에 복사하지 않습니다.
- `/data/codex`는 `0700`, `auth.json`은 `0600`이어야 합니다.
- App backup에 포함될 수 있으므로 backup도 비밀 자료로 취급합니다.

표준 브라우저 callback 로그인이 필요하면 OpenAI 공식 문서의 SSH local forwarding (`localhost:1455`) 대안도 사용할 수 있지만, 먼저 device code를 권장합니다. 자세한 최신 절차는 [Codex authentication](https://developers.openai.com/codex/auth)을 확인하세요.

## 공개키 SSH

### 1. Windows 키 생성

이미 사용할 ed25519 키가 없다면 Windows PowerShell에서 생성합니다.

```powershell
ssh-keygen -t ed25519
Get-Content "$HOME\.ssh\id_ed25519.pub"
```

출력된 `ssh-ed25519 ...` 공개키 한 줄을 App의 `authorized_keys` 목록에 넣습니다. `id_ed25519` 개인키를 복사하거나 App 설정에 붙여 넣으면 안 됩니다. 옵션 저장 후 App을 재시작해야 키가 다시 렌더링됩니다.

### 2. Network 포트

App의 **Configuration → Network**에서 컨테이너 `22/tcp`의 호스트 포트를 설정합니다.

- 기본 호스트 포트: `2223`
- 비어 있음/비활성: 외부 SSH mapping 없음
- 내부 sshd 포트: 항상 `22`

`ssh_port` JSON 옵션은 없습니다. 포트를 바꾸면 아래 SSH config의 `Port`도 함께 바꿉니다.

### 3. Windows `~/.ssh/config`

Windows 파일 위치는 보통 `C:\Users\<사용자>\.ssh\config`입니다. Codex Desktop이 자동 발견할 수 있도록 wildcard가 아닌 **구체적인 Host 별칭**을 만듭니다.

```sshconfig
Host codex-ha
  HostName homeassistant.local
  User root
  Port 2223
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
```

먼저 일반 OpenSSH 연결을 확인합니다.

```powershell
ssh codex-ha
```

성공하면 `/config`에서 시작하며 `codex`, `ha-api`, `supervisor-api`가 PATH에 있어야 합니다.

```bash
pwd
command -v codex
codex --version
printf '%s\n' "$CODEX_HOME"
```

`authorized_keys`가 비어 있으면 sshd는 로그인 대기 상태로 열리지 않고 App 로그에 degraded 경고를 남깁니다. 비밀번호, keyboard-interactive 로그인은 항상 차단됩니다.

## Codex Desktop의 SSH host 연결

OpenAI의 현재 공식 문서는 이 기능을 ChatGPT desktop app의 Codex SSH 연결로 설명합니다. 이 문서에서는 프로젝트 명칭에 맞춰 Codex Desktop Remote SSH라고 부릅니다. 공식 [Remote connections](https://developers.openai.com/codex/remote-connections) 요구사항은 다음과 같습니다.

1. 데스크톱을 실행하는 PC의 `~/.ssh/config`에 pattern이 아닌 구체적인 Host 별칭이 있어야 합니다.
2. 같은 PC에서 `ssh codex-ha`가 먼저 성공해야 합니다.
3. 원격 사용자의 login shell PATH에서 `codex`를 찾을 수 있어야 합니다.
4. 원격 host의 Codex가 인증되어 있어야 합니다.
5. 데스크톱 App의 **Settings → Connections → SSH**에서 host를 추가/활성화하고 원격 프로젝트 폴더 `/config`를 선택합니다.

Codex Desktop은 SSH로 원격 login shell을 사용해 Codex app server를 시작합니다. 이 App은 `/usr/local/bin/codex`와 `/data/codex` 인증 저장소를 제공하지만, **Codex Desktop → HAOS App → Alpine/musl 조합에서 app server가 실제 시작되는지는 아직 검증하지 않았습니다.** 일반 SSH가 성공해도 Remote SSH 완료로 간주하지 마세요. 이는 M2 HAOS amd64 실기 테스트 항목입니다.

## `/config`와 API 권한

Codex와 root 셸은 `/config` 전체를 read-write로 사용합니다. 여기에는 다음과 같은 민감하거나 손상 위험이 큰 데이터가 포함될 수 있습니다.

- `configuration.yaml`, automations, scripts, dashboards, packages
- `secrets.yaml`
- `.storage`
- Recorder SQLite 데이터베이스
- custom components와 `www`

`.storage`는 가능하면 UI/공식 API를 통해 변경하고, SQLite는 분석 시 read-only 연결을 우선하세요. 비밀값이나 실제 entity/user/internal URL이 들어간 진단 결과를 채팅, Git, 로그에 복사하지 마세요.

셸에는 App 실행 중 `SUPERVISOR_TOKEN`이 전달됩니다. 이 토큰으로 Core API 전체와 Supervisor `manager` 역할 범위를 호출할 수 있습니다. `env`, `printenv`, `set`, `export -p`, `curl -v` 같은 명령으로 토큰을 화면·로그에 노출하지 마세요.

## helper 명령

| 명령 | 기능 |
| --- | --- |
| `ha-codex [ARGS...]` | `/config`에서 Codex 실행 |
| `ha-codex-login` | `codex login --device-auth` 실행 |
| `ha-api [--raw] METHOD /path [JSON_BODY\|-]` | Core REST proxy 호출 |
| `supervisor-api [--raw] METHOD /path [JSON_BODY\|-]` | Supervisor API 호출, 일반 JSON 응답의 `result` 누락/오류도 실패 처리 |
| `ha-config-check` | `POST /core/check` |
| `ha-core-logs` | Core 로그 원문 조회 |
| `ha-addon-logs ADDON_SLUG` | 지정 App 로그 원문 조회 |

요청 body는 유효한 JSON이어야 합니다. `-`를 쓰면 stdin에서 JSON을 읽습니다. HTTP 4xx/5xx와 전송 오류는 non-zero로 반환되며 Authorization header와 토큰은 출력하지 않도록 구현되어 있습니다. `supervisor-api` 일반 모드는 JSON envelope의 `result`가 없거나 `ok`가 아니어도 실패합니다. `--raw`는 Core/App 로그처럼 envelope가 아닌 원문 endpoint를 위한 예외입니다.

조회 예시:

```bash
ha-api GET /config
ha-api GET /states
ha-api GET /services
supervisor-api GET /core/info
supervisor-api GET /supervisor/info
ha-config-check
ha-core-logs
ha-addon-logs local_example
```

마지막 명령의 `local_example`은 실제 조회할 App slug로 바꾸세요. `manager`가 어떤 endpoint를 허용하는지는 Supervisor/버전에 따라 실제 HAOS에서 확인해야 합니다. 권한 거부가 나와도 `admin`으로 자동 승격하지 않습니다.

### Supervisor manager 실기 검증표

아래 표는 M2에서 실제 HAOS 버전·응답 코드와 함께 갱신해야 합니다. 로컬 Docker 성공으로 대체하지 않습니다.

| 기능 | Endpoint/helper | 0.1.0-dev 상태 |
| --- | --- | --- |
| Supervisor 정보 | `GET /supervisor/info` | NOT RUN — Supervisor 필요 |
| Core 정보 | `GET /core/info` | NOT RUN — Supervisor manager 필요 |
| Core 로그 | `ha-core-logs` (`GET /core/logs`) | NOT RUN — raw endpoint |
| 설정 검사 | `ha-config-check` (`POST /core/check`) | NOT RUN — 실제 `/config` 필요 |
| App 정보/로그 | `GET /addons/{slug}/info`, `ha-addon-logs` | NOT RUN — 실제 slug 필요 |
| 테스트 App 재시작 | `POST /addons/{slug}/restart` | NOT RUN — 명시적 테스트 대상 필요 |
| Core 재시작 | `POST /core/restart` | NOT RUN — 설정 검사 성공 및 명시적 승인 필요 |

### Core REST 직접 사용

helper가 필요를 충족하지 못할 때 App 내부에서 runtime 환경변수로 공식 REST endpoint를 호출할 수 있습니다. 토큰 값을 명령줄 인수나 shell history에 직접 붙여 넣지 마세요. 아래처럼 `0600` 임시 header 파일을 사용하고 반드시 지웁니다.

```bash
header_file=$(mktemp)
trap 'rm -f "$header_file"' EXIT
chmod 600 "$header_file"
printf 'Authorization: Bearer %s\n' "$SUPERVISOR_TOKEN" > "$header_file"
curl --fail --silent --show-error \
  --header "@${header_file}" \
  "${HA_URL}/states"
```

Base URL은 `http://supervisor/core/api`, Supervisor Base URL은 `http://supervisor`입니다.

### Core WebSocket

Core WebSocket endpoint는 다음과 같습니다.

```text
ws://supervisor/core/websocket
```

WebSocket client는 첫 인증 frame의 `access_token`을 실행 시점에 `SUPERVISOR_TOKEN` 환경변수에서 읽어 구성해야 합니다. 예를 들어 프로토콜상 첫 두 outbound message는 다음 형태입니다. `<runtime token>`을 실제 값으로 문서나 스크립트에 저장하지 마세요.

```json
{"type":"auth","access_token":"<runtime token>"}
{"id":1,"type":"get_states"}
```

이 MVP에는 전용 `ha-ws` helper나 범용 WebSocket CLI가 포함되지 않았습니다. 필요한 경우 token redaction을 지키는 코드/클라이언트를 사용하세요. Ingress WebSocket과 실제 Core WebSocket API는 M2 HAOS 실기 미검증입니다.

## 안전한 서비스 호출

서비스 호출은 실제 기기를 움직입니다. 사용자가 지정한 테스트용 조명/스위치처럼 영향이 낮은 entity만 대상으로 하고, 호출 전후 상태와 로그를 기록하세요. 아래는 단순 on/off entity의 최소 패턴이며 실제 테스트 entity로 바꾼 뒤 검토하고 실행합니다.

```bash
entity=light.codex_test
domain=${entity%%.*}
body=$(jq -cn --arg entity_id "$entity" '{entity_id:$entity_id}')
before=$(ha-api GET "/states/${entity}" | jq -r '.state')

ha-api POST "/services/${domain}/turn_on" "$body"
ha-api GET "/states/${entity}" | jq '{entity_id,state,last_changed}'

case "$before" in
  on)  ha-api POST "/services/${domain}/turn_on" "$body" ;;
  off) ha-api POST "/services/${domain}/turn_off" "$body" ;;
  *)   printf 'Automatic restore skipped for prior state: %s\n' "$before" >&2 ;;
esac
```

이 예시는 brightness, color, cover position 같은 attribute까지 복원하지 않습니다. 복합 entity는 원래 attribute와 서비스 의미를 따로 확인하세요.

다음 동작은 사용자의 현재 요청에 명시되어 있거나 실행 직전 명시적 승인이 없으면 수행하지 마세요.

- 도어록 해제, 차고문/대문 열기, 경보 해제
- 난방·급수·출입처럼 안전/재산에 영향을 주는 동작
- HAOS host 종료/재부팅
- backup 복원
- App 제거, OS 업데이트, 데이터베이스 삭제

설정을 바꾸기 전에는 가능한 경우 `/config` Git checkpoint 또는 Home Assistant backup을 만들고, diff를 검토한 뒤 `ha-config-check`가 성공한 경우에만 Core 재시작을 고려하세요.

## 외부 접속 보안

**공유기에서 TCP 2223을 인터넷으로 port-forward하지 마세요.** 공개키 인증만으로도 이 App의 `/config`와 runtime API token이 인터넷 공격면에 놓입니다.

- SSH는 신뢰하는 LAN에서만 사용합니다.
- 외부에서는 검증된 VPN 또는 신뢰하는 mesh VPN으로 먼저 내부망에 접속합니다.
- VPN에서도 source device와 사용자 접근을 제한합니다.
- 키를 분실하거나 PC가 침해되면 즉시 해당 공개키를 `authorized_keys`에서 제거하고 App을 재시작합니다.

Ingress 패널은 관리자 전용이지만, SSH Network mapping은 Home Assistant Frontend 인증과 별개의 네트워크 리스너입니다.

## 복구와 사고 대응

### 로그와 시작 실패

Home Assistant의 **설정 → Apps → Codex for Home Assistant → Log**에서 시작 단계와 degraded 이유를 확인합니다. `/config`가 없거나 쓰기 불가능하면 App은 의도적으로 시작에 실패합니다. 공개키가 없다는 경고만 있고 Web UI가 동작한다면 정상 degraded 상태입니다.

### 설정 손상

1. Codex 작업과 관련 자동화를 중지합니다.
2. Git diff/commit 또는 사전에 만든 파일 사본으로 변경을 되돌립니다.
3. `ha-config-check`를 실행합니다.
4. 필요한 경우에만 Home Assistant backup 복원을 검토합니다. 복원은 명시적 승인 대상입니다.

### Codex 로그인 폐기

노출이 의심되면:

1. App을 중지합니다.
2. Codex/ChatGPT 계정에서 관련 세션 또는 연결을 폐기하고 필요하면 logout합니다.
3. Web UI에서 안전하게 접근할 수 있게 App을 다시 시작한 뒤 `/data/codex/auth.json`을 삭제합니다.
4. 공유한 로그, Git history, backup의 노출 여부를 확인합니다.
5. 원인을 제거한 뒤 `ha-codex-login`으로 다시 인증합니다.

```bash
rm -f /data/codex/auth.json
```

`SUPERVISOR_TOKEN` 노출이 의심되면 App을 즉시 중지하고 노출 파일/로그 접근을 차단하세요. App 재시작 뒤 runtime token 상태를 확인하되, 회전을 가정하지 말고 Home Assistant 관리자 자격 증명과 관련 세션도 점검합니다.

### SSH host key 경고

SSH host private key는 `/data/ssh`에 `0600`으로 저장되므로 정상 App 재시작에서는 fingerprint가 유지되어야 합니다. Windows의 host key changed 경고를 무시하거나 즉시 삭제하지 말고 먼저 App Web UI/로그의 신뢰 경로에서 fingerprint를 확인합니다.

```bash
ssh-keygen -lf /data/ssh/ssh_host_ed25519_key.pub
```

App 재설치 등으로 key가 정말 바뀐 것을 확인한 경우에만 Windows의 이전 항목을 제거하고 다시 연결합니다.

```powershell
ssh-keygen -R "[homeassistant.local]:2223"
ssh codex-ha
```

HostName이나 포트를 바꿨다면 실제 값을 사용하세요. 예상하지 않은 변경이면 중간자 공격 또는 `/data` 유실 가능성을 먼저 조사합니다.

## 검증 상태

| 단계 | 상태 |
| --- | --- |
| M1 로컬 amd64 이미지 빌드, 공식 SHA-256 검증, `codex-cli 0.144.1` | **PASS** |
| S6 init, 공개키 미설정 시 SSH degraded, ttyd/nginx 서비스 기동 | **PASS (로컬 컨테이너)** |
| `/config` RW probe, Codex config/host key 생성과 권한, nginx/sshd 구문 | **PASS (로컬 컨테이너)** |
| loopback nginx → ttyd HTML 응답 | **PASS (로컬 컨테이너)** |
| 공개키 SSH/비밀번호 거부, host key/config 영속성, API helper mock·token redaction, 전체 lint | **PASS (로컬 컨테이너/Windows OpenSSH)** |
| 실제 HAOS amd64 Local App 설치/시작 | **M2 미검증** |
| Ingress 경로, resize, WebSocket, tmux 재접속 | **M2 미검증** |
| Device code 인증과 App 업데이트 후 인증 영속성 | **M2 미검증** |
| Network 2223 공개키 SSH, Windows OpenSSH | **M2 미검증** |
| Codex Desktop Remote SSH app server on Alpine/musl | **M2 미검증** |
| `/config` 실제 RW, Core API와 안전한 entity 서비스 호출 | **M2 미검증** |
| Supervisor `manager` endpoint와 Core/App 운영 | **M2 미검증** |

위 상태는 이 문서 작성 시점의 사실이며 최종 명령·결과는 저장소 `progress.md`가 기준입니다. 로컬 Docker 테스트는 Home Assistant Ingress, Supervisor가 주입하는 token, Network mapping, 실제 entity, App update 동작을 재현하지 못합니다. 위 M2 항목을 통과하기 전에는 `0.1.0` 또는 stable로 취급하지 마세요.
