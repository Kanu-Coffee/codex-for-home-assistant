<p align="right">
  <strong>한국어</strong> · <a href="DOCS.en.md">English</a>
</p>

# Codex for Home Assistant 사용 설명서

이 문서는 Home Assistant OS 사용자가 앱을 설치하고, Web UI·SSH·모바일 Remote에서 Codex를 사용하며, 안전하게 대시보드·자동화·엔티티와 설정 오류를 다루는 방법을 설명합니다.

현재 문서는 앱 버전 `0.6.0`을 기준으로 합니다.

> [!WARNING]
> 이 앱은 `/config` 전체를 읽고 쓸 수 있고 Home Assistant Core 및 Supervisor `manager` API를 사용할 수 있습니다. 신뢰하는 관리자만 사용하고, 변경 전 backup과 diff를 확인하세요. TCP `2223`을 인터넷에 직접 port-forward하지 마세요.

## 시작하기 전에

### 지원 환경

- Home Assistant OS 또는 Supervisor가 있는 설치 환경
- **amd64** 장치
- 앱 이미지와 Codex 인증에 필요한 인터넷 연결
- Codex를 사용할 수 있는 OpenAI/ChatGPT 계정

현재 앱은 `stage: experimental`, `boot: manual`입니다. aarch64 장치와 HACS 설치는 지원하지 않습니다.

### 이 앱이 제공하는 것

- Home Assistant Ingress 안에서 열리는 Web 터미널
- `/config`에서 실행되는 Codex CLI
- Core REST API와 Supervisor `manager` API helper
- ChatGPT 모바일 Remote가 앱 내장 Codex에 직접 연결할 수 있는 공개키 전용 SSH
- 대시보드·웹 UI를 실제 Headless Chromium으로 확인하는 Playwright 도구
- HA 구조와 사용자가 명시한 지속 정보를 보존하는 프로젝트 자체 `ha_memory`

Web UI는 별도 채팅형 화면이 아니라 `ttyd`와 공유 `tmux` 세션으로 구성된 터미널입니다. 대시보드·자동화 생성도 전용 마법사가 아니라 Codex가 `/config`, API와 브라우저 검증을 조합해 수행합니다.

## 설치

### 앱 저장소 추가

[![Home Assistant에 앱 저장소 추가](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKanu-Coffee%2Fcodex-for-home-assistant)

버튼을 사용할 수 없다면 다음 URL을 복사합니다.

```text
https://github.com/Kanu-Coffee/codex-for-home-assistant
```

1. Home Assistant에서 **설정 → Apps → App store**를 엽니다.
2. 우측 상단 메뉴의 **Repositories**에 위 URL을 추가합니다.
3. App store를 새로고침하고 **Codex for Home Assistant**를 선택합니다.
4. **Install**을 누릅니다. 공개 GHCR의 미리 빌드된 amd64 이미지를 사용하므로 HA 장치에서 소스를 빌드하지 않습니다.
5. 처음에는 기본 설정을 유지한 채 앱을 시작합니다.

앱이 목록에 보이지 않으면 장치 아키텍처가 amd64인지 확인하세요. 설치 실패 시 App/Supervisor 로그를 보존하되 token, 내부 URL과 개인 정보를 공유하지 마세요.

## 첫 실행

### 1. Web UI 열기

앱을 시작한 뒤 **OPEN WEB UI**를 누릅니다. 셸은 `/config`에서 시작합니다.

기본값 `web_terminal_auto_start_codex: false`에서는 Bash가 먼저 열립니다. 브라우저를 닫아도 앱이 실행 중이면 같은 `tmux` 세션이 유지되며, 다음 접속에서 이어집니다. 여러 브라우저 탭은 같은 화면과 입력을 공유하므로 신뢰하는 관리자만 사용하세요.

### 2. Codex 로그인

처음 한 번 다음 명령을 실행합니다.

```bash
ha-codex-login
```

표시된 URL을 신뢰하는 브라우저에서 열고 일회용 코드를 입력합니다. OpenAI 문서에서 headless 환경의 device code 인증은 beta로 안내되며, 계정 또는 workspace 정책에서 허용해야 할 수 있습니다.

로그인 상태를 확인합니다.

```bash
codex login status
```

인증은 `/data/codex`에 저장되어 일반 앱 재시작·업데이트 동안 유지됩니다. `auth.json`은 access token을 포함할 수 있으므로 출력하거나 Git, 이슈, 채팅에 공유하지 마세요.

### 3. Codex 시작

```bash
ha-codex
```

첫 요청은 다음처럼 읽기 전용으로 시작하세요.

```text
현재 Home Assistant 구성을 읽기 전용으로 살펴봐 줘.
대시보드, 자동화, 엔티티와 최근 오류를 요약하고 개선 후보를 제안해 줘.
아직 파일, registry와 기기 상태는 수정하지 마.
```

## 앱 설정

처음에는 기본값을 권장합니다. 설정을 바꾼 뒤에는 앱을 재시작하고, Codex 관련 정책이나 MCP 도구가 바뀌었다면 실행 중인 Codex를 종료한 뒤 새 세션을 시작하세요.

| 설정 | 기본값 | 허용값·의미 | 주의 |
| --- | --- | --- | --- |
| `authorized_keys` | `[]` | SSH를 허용할 OpenSSH 공개키 목록 | 비어 있으면 SSH만 비활성화되고 Web UI는 유지됩니다. 개인키를 넣지 마세요. |
| `web_terminal_auto_start_codex` | `false` | 새 `tmux` 세션에서 Codex를 한 번 자동 시작 | 기존 세션에는 소급되지 않습니다. Codex 종료 후 Bash로 돌아옵니다. |
| `tmux_session_name` | `codex-ha` | 영문, 숫자, `.`, `_`, `-`로 된 1~64자 세션 이름 | 바꾼 뒤 새 세션을 사용합니다. |
| `codex_approval_policy` | `on-request` | `untrusted`, `on-request`, `never` | `never`는 광범위한 자동 승인을 뜻하므로 신뢰하는 작업에서만 사용하세요. |
| `codex_sandbox_mode` | `danger-full-access` | `workspace-write`, `danger-full-access` | 앱 컨테이너 내부 정책입니다. 그러나 `/config`가 RW이므로 실제 HA 설정에 영향을 줄 수 있습니다. |
| `browser_approval_policy` | `safe` | `safe`, `never`, `always` | `safe`는 조회·캡처를 자동 승인하고 클릭·입력은 확인합니다. |
| `codex_user_files_update_mode` | `preserve` | `preserve`, `refresh_agents`, `refresh_all` | 일회성 refresh 뒤 `preserve`로 되돌리세요. `refresh_all`은 사용자 Codex 설정을 초기화할 수 있습니다. |
| `home_assistant_browser_auto_auth` | `true` | Headless browser용 전용 local-only read-only HA 사용자 자동 관리 | 끄거나 켠 뒤 앱과 browser 세션을 다시 시작하세요. |
| `home_assistant_browser_token` | 없음 | 선택형 수동 long-lived token override | 고급 복구용입니다. 자동 인증이 ON일 때만 관리형 token보다 우선하며, local-only, non-admin, `system-read-only` 단일 그룹 사용자만 허용됩니다. |
| `log_level` | `info` | `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal` | `trace`/`debug`는 진단 때만 사용하고 공유 전 로그를 검토하세요. |
| Network `22/tcp` | `2223` | 외부 SSH host port | JSON의 `ssh_port` 옵션이 아닙니다. 비활성화하면 SSH listener를 노출하지 않습니다. |

권장 시작 설정은 다음과 같습니다.

```yaml
authorized_keys: []
web_terminal_auto_start_codex: false
tmux_session_name: codex-ha
codex_approval_policy: on-request
codex_sandbox_mode: danger-full-access
browser_approval_policy: safe
codex_user_files_update_mode: preserve
home_assistant_browser_auto_auth: true
log_level: info
```

### Browser 승인 정책

| 값 | 동작 |
| --- | --- |
| `safe` | 탐색, snapshot, screenshot, console/network 확인은 자동 승인하고 click, form, key, select, type은 확인합니다. |
| `never` | 현재 허용된 Playwright 도구의 개별 승인창을 생략합니다. 금지된 code 실행과 임의 file upload가 열리지는 않습니다. |
| `always` | 허용된 Playwright 도구마다 확인합니다. |

상위 `codex_approval_policy: never`는 Codex 전체 full-auto 정책이므로 `browser_approval_policy: safe` 또는 `always`의 확인보다 우선할 수 있습니다. 브라우저 정책만으로 보안 경계를 대신하지 마세요.

### Codex 사용자 파일 갱신

| 값 | 동작 |
| --- | --- |
| `preserve` | 기존 `/data/codex/config.toml`과 base `AGENTS.md`를 보존합니다. 기본값입니다. |
| `refresh_agents` | 현재 앱 버전에서 base `AGENTS.md`만 한 번 새 기본본으로 바꿉니다. |
| `refresh_all` | base `AGENTS.md`와 사용자 `config.toml`을 현재 앱 기본값으로 한 번 초기화합니다. |

`refresh_all`은 사용자가 추가한 model, provider, MCP와 기타 설정을 제거할 수 있습니다. 원본은 `/data/codex/backups/user-files` 아래 root-only backup에 저장되지만 이 backup 자체도 credential과 내부 endpoint를 포함할 수 있는 민감자료입니다. 작업을 확인한 뒤 mode를 `preserve`로 되돌리지 않으면 다음 앱 버전에서 선택한 갱신이 다시 한 번 실행됩니다.

## 접속 방법

### Home Assistant Web UI와 모바일

가장 간단한 방법입니다.

1. Home Assistant 모바일 앱 또는 모바일 브라우저로 HA에 로그인합니다.
2. **설정 → Apps → Codex for Home Assistant → OPEN WEB UI**를 엽니다.
3. 작은 화면에서는 가로 모드나 외부 키보드가 편리할 수 있습니다.

Ingress는 Home Assistant 인증 안에서 열리며 별도 Web UI 포트를 공유기에 노출할 필요가 없습니다. Web UI는 터미널이므로 독립적인 모바일 채팅 앱과 같은 화면은 아닙니다.

### 공개키 SSH

SSH는 선택 사항입니다. 사용하지 않으면 `authorized_keys`를 비워 두고 Network port도 비활성화할 수 있습니다.

1. 접속할 SSH client용 Ed25519 키가 없다면 생성합니다. 아래 명령은 PC에서 일반 SSH를 함께 점검할 때의 예입니다.

   ```powershell
   ssh-keygen -t ed25519
   Get-Content "$HOME\.ssh\id_ed25519.pub"
   ```

2. 출력된 `ssh-ed25519 ...` **공개키 한 줄**을 `authorized_keys`에 추가하고 앱을 재시작합니다. 개인키는 실제 접속 client에만 보관하고 문서, 로그, 이슈에 붙여 넣지 마세요.
3. App **Network**에서 `22/tcp`의 host port를 확인합니다. 기본값은 `2223`입니다.
4. PC의 `~/.ssh/config`에 구체적인 host alias를 추가합니다.

   ```sshconfig
   Host codex-ha
     HostName homeassistant.local
     User root
     Port 2223
     IdentityFile ~/.ssh/id_ed25519
     IdentitiesOnly yes
   ```

5. 일반 SSH가 먼저 성공하는지 확인합니다.

   ```powershell
   ssh codex-ha
   ```

비밀번호와 keyboard-interactive 로그인은 차단됩니다. 외부에서 접근하려면 SSH 포트 자체를 공개하지 말고 신뢰하는 VPN 또는 mesh VPN으로 먼저 내부망에 접속하세요.

### ChatGPT 모바일 Remote

ChatGPT 모바일 Remote는 HA 앱의 공개키 SSH endpoint에 직접 연결합니다. HA 앱 이미지에 Codex CLI와 Remote용 app-server가 모두 포함되어 있으므로 별도의 Mac/Windows 데스크톱 앱이나 중계 호스트가 필요하지 않습니다.

```text
ChatGPT 모바일 Remote
  → 공개키 SSH (HA host:2223, root)
  → HA 앱의 내장 Codex app-server
  → /config 원격 프로젝트
```

1. Web UI에서 `ha-codex-login`을 완료하고 `codex login status`가 로그인 상태를 표시하는지 확인합니다.
2. 모바일 Remote가 사용할 키의 **공개키만** `authorized_keys`에 추가한 뒤 앱을 재시작합니다.
3. App **Network**에서 `22/tcp`의 host port를 확인합니다. 기본값은 `2223`입니다.
4. ChatGPT 모바일 Remote에서 SSH 연결을 추가할 때 다음 값을 사용합니다.

   | 항목 | 값 |
   | --- | --- |
   | Host | 휴대폰에서 도달 가능한 HA hostname 또는 IP |
   | Port | App Network에 표시된 host port, 기본 `2223` |
   | User | `root` |
   | Authentication | `authorized_keys`의 공개키와 짝이 맞는 개인키 |
   | Project path | `/config` |

5. 연결하면 모바일 Remote가 SSH login shell의 `codex`를 사용해 앱 내부 app-server를 시작하고 `/config`에서 Codex 작업을 엽니다.

일반 SSH client로 접속하면 자동으로 Codex 화면이 열리는 것이 아니라 `/config`의 Bash shell이 열립니다. 이 경우 `ha-codex` 또는 `codex`를 직접 실행하세요. 모바일 Remote는 원격 app-server를 자동으로 bootstrap하므로 Codex 작업 화면으로 바로 이어집니다. Web UI의 공유 `tmux`와 모바일 Remote 세션은 기본적으로 서로 다른 세션입니다.

모바일에서는 새 작업 시작, 기존 작업 계속, 후속 지시, 승인, diff·test·terminal 결과 확인이 가능합니다. HA 앱은 실행 중이어야 하고 휴대폰에서 SSH host port에 도달할 수 있어야 합니다. 외부에서는 SSH port를 인터넷에 직접 공개하지 말고 신뢰하는 VPN 또는 mesh VPN을 사용하세요. Remote의 메뉴 이름과 제공 여부는 ChatGPT 앱 버전, 플랜, 지역과 workspace 정책에 따라 달라질 수 있습니다.

## 대표 사용 시나리오

### Bubble Card 모바일 대시보드

Bubble Card는 이 앱에 포함되지 않습니다. 먼저 설치 여부와 기존 dashboard 저장 방식을 확인하도록 요청하세요.

```text
Bubble Card가 이미 설치되어 있는지와 현재 dashboard 저장 방식을 확인해 줘.
기존 dashboard는 보존하고 자주 쓰는 조명, 공조, 보안 상태를 모은
모바일 1열 초안을 만들어 줘. 먼저 변경 파일과 diff만 보여 줘.
승인 후 적용하고 1440x900과 390x844에서 화면, console, network 오류를 확인해 줘.
```

YAML mode dashboard와 storage mode dashboard는 변경 방법이 다릅니다. `.storage`를 직접 편집하기보다 지원되는 UI/API 경로를 우선하고, 실제 저장 방식을 확인하지 않은 채 수정하지 마세요.

### 생활 패턴 기반 자동화

```text
평일 07:00 기상, 08:10 외출, 19:00 귀가 패턴이 있어.
현재 presence, 조명, 온도, 문 센서와 기존 자동화를 읽기 전용으로 조사해 줘.
새 자동화 5개를 효과, trigger/condition, 오작동 방지책, 필요한 entity와 함께 제안해 줘.
겹치는 기존 자동화도 표시하고 아직 적용하지 마.
```

제안을 검토한 뒤 한 번에 하나씩 구현하도록 요청하세요. 적용 뒤 YAML 구문뿐 아니라 실제 reload와 fresh 상태를 확인해야 합니다.

### 엔티티 정리

```text
대시보드, 자동화, 스크립트와 template에서 참조되지 않는 entity 후보를 찾아 줘.
disabled, unavailable, 이름 중복과 오래된 device 연결도 구분해 줘.
각 후보의 참조 위치와 제거 위험을 표로 보여 주고 registry는 수정하지 마.
```

“사용되지 않음”은 완전한 삭제 근거가 아닙니다. integration이 동적으로 사용하거나 외부 앱이 참조할 수 있으므로, 삭제·disable·rename은 별도 승인으로 분리하세요.

### 설정 오류 진단

```text
최근 Home Assistant 오류를 읽기 전용으로 진단해 줘.
ha-config-check, Core/App 로그와 관련 YAML을 확인하고
원인 후보를 증거 순서로 정리해 줘. 가장 작은 수정안을 제시하되 아직 적용하지 마.
```

더 많은 예시는 [프롬프트 모음](../docs/examples.ko.md)을 확인하세요.

## Headless browser로 화면 검증

새 Codex 세션은 image-managed Playwright 도구를 자동으로 사용합니다. 별도 browser package나 MCP를 설치할 필요가 없습니다.

- Home Assistant dashboard는 Codex 내부의 `http://127.0.0.1:8099` gateway를 사용합니다.
- 이 주소는 외부 PC browser나 Ingress에서 여는 URL이 아닙니다.
- 기본 viewport는 `1440x900`이며 `390x844`로 바꾸어 모바일 layout을 비교할 수 있습니다.
- screenshot, console warning/error와 network request 상태를 함께 확인합니다.

```text
현재 Home Assistant dashboard를 실제 browser로 열어 줘.
1440x900과 390x844에서 screenshot, console error/warning,
실패한 network request와 잘린 카드·겹친 버튼을 확인해 줘.
화면을 바꾸는 click이나 입력은 하지 마.
```

자동 인증은 기본 ON이며 앱이 전용 local-only, non-admin, `system-read-only` 사용자를 생성하거나 재사용합니다. 이 사용자는 설정을 쓰지는 못하지만 모든 entity state를 볼 수 있습니다. screenshot, snapshot, console/network 결과에는 위치, entity, 내부 URL과 사용자 정보가 보일 수 있으므로 공개 전에 검토하세요.

## 검증형 Home Assistant 메모리

`ha_memory`는 이 프로젝트가 구현한 로컬 SQLite/MCP 기능이며 OpenAI Codex의 Memories와 다릅니다.

### 무엇을 기억하나요?

- Core API로 확인한 area, device, entity와 automation 구조
- 사용자가 명확히 설명한 지속적인 별칭, 실제 용도, 선호, note와 비정형 관계
- 후보, 검증, 적용, 충돌과 rollback의 감사 이력

다음 내용은 저장하지 않습니다.

- raw 대화
- 현재·과거 state와 timestamp
- automation action/template 원문
- 전체 API 응답과 로그·웹 페이지
- token, password와 Authorization header

### 어떻게 동작하나요?

1. 새 HA 요청에서 현재 질문과 관련된 작은 memory 결과만 검색합니다.
2. 사용자가 한 정확한 대상의 지속 정보를 명확히 말하면 같은 요청에서 후보 → 검증 → 적용을 시도합니다.
3. 모호한 정보는 저장하지 않고 확인 질문을 합니다.
4. HA 구조는 fresh Core API를 우선합니다.
5. 기존 정보와 충돌하면 조용히 덮어쓰지 않고 conflict로 남깁니다.

```text
light.kitchen_main은 우리 집에서 "준비등"이라고 부르고,
아침 식사 준비할 때 쓰는 조명이야. 이건 앞으로도 기억해 줘.
```

상태를 확인하는 관리자 명령은 다음과 같습니다.

```bash
ha-memory status
ha-memory search "준비등"
ha-memory show entity:light.kitchen_main
ha-memory conflicts --status open
```

`empty`, `degraded`, `stale`이면 memory DB를 삭제하지 마세요. 처음 학습 중이거나 Core 연결이 일시적으로 실패한 상태일 수 있으며 마지막 성공 snapshot을 보존합니다.

이 기능은 모델 자체가 스스로 학습하거나 승인 없이 집을 운영한다는 뜻이 아닙니다. 현재 `0.6.0`은 experimental이며 실제 HAOS의 자연어 기억→새 작업 회상 전체 흐름에는 아직 공개 검증 공백이 있습니다.

## 앱 버그·기능 제안 보고서

`0.6.0`부터 image-managed `$ha-feedback` Skill이 앱 자체의 버그와 기능 제안을 읽기 전용으로 조사하고 정제된 보고서를 만듭니다.

```text
$ha-feedback bug <관찰한 증상>
$ha-feedback feature <개선 요청>
```

- `bug`는 앱 범위 확인 → 환경 수집 → 안전한 재현·진단 → 기대/실제 비교 → 원인 후보와 미검증 범위 순서로 작성합니다.
- `feature`는 현재 기능·문서 → 기존 해결법·유사 이슈 → 사용자 문제·대안 → 수용 기준·검증 계획 순서로 작성합니다.
- 이 흐름은 Home Assistant 설정 수정, 서비스 호출, reload/restart, 업데이트, 복구 또는 복원을 실행하지 않습니다.
- 로그와 screenshot은 기본 보고서에서 제외됩니다. 짧은 로그도 정제된 정확한 문구를 별도 preview하고 사용자가 확인한 뒤에만 포함합니다. Screenshot이나 다른 파일은 자동 업로드하지 않으며, 필요하면 사용자가 Web Form에서 직접 다시 검토해 첨부합니다.
- 보안 취약점 가능성이 있으면 공개 이슈 검색·미리보기·제출을 중단하고 [비공개 취약점 제보](https://github.com/Kanu-Coffee/codex-for-home-assistant/security/advisories/new)를 사용합니다.

보고서는 다음 private bundle에 저장됩니다.

```text
/config/codex-workspace/feedback/<UTC>-<kind>-<report-id>/
├── report.json
├── public-report.md
└── submission.json  # 직접 제출 성공 뒤에만 생성
```

디렉터리는 `0700`, 파일은 `0600`입니다. `public-report.md`도 자동 검사 결과일 뿐이므로 공개 전 사람이 전체 본문을 다시 확인해야 합니다. 외부 이슈 생성 결과가 불확실한 경우에는 성공 영수증 대신 hidden `.submission.lock`이 남아 같은 report의 직접 재시도를 차단할 수 있습니다.

GitHub 대상은 `Kanu-Coffee/codex-for-home-assistant`로 고정됩니다. 로그인은 선택 사항입니다.

```bash
ha-feedback github status
ha-feedback github login
ha-feedback github logout
```

로그인 전 `/data/github-cli`에 저장되는 GitHub 자격증명이 Home Assistant App backup에 포함될 수 있다는 경고를 확인하세요. Skill은 기존 이슈 후보와 정확한 저장소·제목·본문을 먼저 보여 주고, 그 미리보기에 대한 암호학적으로 임의 생성한 10분 만료·1회용 token과 현재 대화의 별도 확인을 받은 뒤에만 직접 제출합니다. 잘못되거나 만료되거나 이미 사용된 token 또는 실패한 확인 뒤에는 새 preview가 필요합니다. 후보 또는 제출 직전 report ID 중복 검색이 불가능하면 이슈를 만들지 않고, 미인증 또는 실패 시 긴 본문을 URL에 넣지 않는 Issue Form과 보존된 `public-report.md`를 사용합니다. Confirmed submit은 검증한 본문을 `gh issue create --body-file -`의 stdin으로 전달합니다. PAT나 token 값을 앱 설정에 입력하지 마세요.

## 안전한 변경 절차

권장 순서는 다음과 같습니다.

```mermaid
flowchart LR
    A["읽기 전용 조사"] --> B["계획·영향·backup"]
    B --> C["diff 검토와 승인"]
    C --> D["작은 변경"]
    D --> E["구문·reload·fresh API 검증"]
    E --> F["화면·로그 확인"]
```

1. 먼저 읽기 전용 조사를 요청합니다.
2. Home Assistant backup 또는 `/config` Git checkpoint를 준비합니다.
3. 변경할 파일, entity, 서비스와 예상 diff를 확인합니다.
4. 한 번에 작은 범위만 적용합니다.
5. `ha-config-check`와 필요한 reload 뒤 fresh 상태를 확인합니다.
6. dashboard는 desktop/mobile browser로 다시 확인합니다.

다음 작업은 현재 요청에 명시되어 있거나 실행 직전 별도 승인을 받은 경우에만 수행하세요.

- 도어록 해제, 차고문·대문 열기, 경보 해제
- 난방, 급수, 출입처럼 안전·재산에 영향을 주는 동작
- HAOS host 종료·재부팅
- backup 복원
- 앱 제거, OS 업데이트, database 삭제

`.storage`는 가능한 경우 Home Assistant UI/API로 변경하고, Recorder DB는 직접 쓰지 마세요. `SUPERVISOR_TOKEN`, `auth.json`, SSH private key, `secrets.yaml`과 browser token을 출력하거나 공유하지 마세요.

## 업데이트

1. 가능하면 Home Assistant backup을 만들고 진행 중인 Codex 작업을 마칩니다.
2. App store 저장소를 새로고침하고 일반 **Update**를 사용합니다.
3. 앱을 완전 삭제하거나 `/data`를 초기화하지 마세요.
4. 업데이트 후 앱을 시작하고 기존 Codex 세션을 종료한 뒤 새 세션을 엽니다.
5. `codex login status`, 필요한 MCP와 주요 설정을 확인합니다.

일반 업데이트는 `/data`의 Codex 인증·설정, SSH host key, 검증형 memory와 선택형 `/data/github-cli` 로그인을 보존하도록 설계되어 있습니다. `codex_user_files_update_mode: preserve`가 기본값입니다. `refresh_agents` 또는 `refresh_all`을 유지한 채 다음 버전으로 올리면 선택한 파일이 새 버전에서 한 번 다시 갱신되므로, 일회성 갱신 뒤에는 `preserve`로 되돌리세요.

업데이트 중 Web UI/tmux와 SSH 연결이 잠시 끊기는 것은 정상입니다.

## 주요 helper 명령

| 명령 | 기능 |
| --- | --- |
| `ha-codex` | `/config`에서 Codex 시작 |
| `ha-codex-login` | device code 로그인 시작 |
| `ha-config-check` | Home Assistant 설정 검사 |
| `ha-api` | Core REST API 호출 |
| `supervisor-api` | Supervisor API 호출 |
| `ha-core-logs` | Core 로그 조회 |
| `ha-addon-logs SLUG` | 지정 앱 로그 조회 |
| `ha-memory status` | 검증형 memory 상태 확인 |
| `ha-memory search QUERY` | 관련 HA 구조와 적용된 memory 검색 |
| `ha-feedback collect bug\|feature --input FILE` | private JSON에서 정제된 피드백 보고서 생성 |
| `ha-feedback validate REPORT` | schema·privacy·render 일치 검사 |
| `ha-feedback render REPORT` | 검증된 JSON에서 공개 Markdown 재생성 |
| `ha-feedback github status\|login\|logout` | 선택형 GitHub CLI 인증 관리 |
| `ha-feedback github url REPORT` | 짧게 prefill된 Issue Form 폴백 표시 |
| `ha-feedback github submit REPORT` | 후보와 정확한 payload preview; 10분 1회용 확인 token이 있을 때만 직접 제출 |
| `ha-browser-auth-status` | Headless browser 인증 상태 확인 |
| `ha-browser-network-info` | 내부 dashboard gateway 연결 정보 확인 |

helper는 token을 자동으로 붙이지만, `env`, `printenv`, `set`, `export -p`, `curl -v`로 runtime token을 노출하지 마세요.

## 문제 해결

### 앱이 시작되지 않음

- App 로그에서 첫 fatal error를 확인합니다.
- `/config`가 없거나 쓰기 불가능하면 앱은 의도적으로 시작하지 않습니다.
- 공개키가 없다는 경고만 있고 Web UI가 동작하면 정상입니다. SSH만 비활성화된 상태입니다.

### Web UI가 재연결 화면에 머묾

- 앱이 실행 중인지 확인하고 App 로그에서 nginx/ttyd 오류를 봅니다.
- 여러 탭이 같은 tmux에 붙어 있는지 확인합니다.
- 세션을 초기화하면 실행 중인 Codex와 명령이 종료됩니다. 정말 필요한 경우에만 실행합니다.

  ```bash
  tmux kill-session -t codex-ha
  ```

### Codex 로그인 실패

- `codex login status`를 확인합니다.
- 계정 또는 workspace에서 device code 로그인이 허용되는지 확인합니다.
- 앱의 `auth.json` 내용을 출력하지 마세요.
- 최신 공식 절차는 [Codex authentication](https://developers.openai.com/codex/auth)을 확인하세요.

### SSH 연결 실패

- `authorized_keys`에 public key 한 줄이 정확히 저장됐는지 확인합니다.
- App Network의 host port와 `~/.ssh/config`의 `Port`가 같은지 확인합니다.
- 먼저 `ssh -v codex-ha`의 host, port, 선택된 key만 확인하고 공유 전 개인 경로·주소를 가립니다.
- host key changed 경고를 무시하거나 즉시 삭제하지 말고 App Web UI의 신뢰된 경로에서 fingerprint를 확인합니다.

### Dashboard browser가 로그인 화면만 표시

```bash
ha-browser-auth-status
ha-browser-network-info
```

- `home_assistant_browser_auto_auth`가 ON인지 확인합니다.
- 앱과 기존 Codex/browser 세션을 다시 시작합니다.
- 계속 실패할 때만 `ha-browser-auth-setup`으로 정제된 오류를 확인합니다.
- `trusted_networks`, `trusted_proxies`, `.storage`를 우회책으로 자동 수정하지 마세요.

### Memory가 `empty`, `degraded`, `stale`

```bash
ha-memory status
```

Core가 준비될 시간을 두고 다시 확인합니다. DB/WAL을 직접 삭제·수정하지 마세요. App version, Core version, 상태의 closed error code만 수집하고 raw token/API 응답은 공유하지 않습니다.

### 피드백 GitHub 직접 제출이 되지 않음

- `ha-feedback github status`가 미인증이면 `ha-feedback github login`을 명시적으로 실행하거나 Issue Form 폴백을 사용합니다.
- 인증, 후보·중복 검색 또는 네트워크 실패 뒤 helper는 자동 재시도하지 않습니다. 기존 `public-report.md`를 보존하므로 본문을 다시 검토한 뒤 Web Form에 붙여 넣을 수 있습니다.
- `gh`가 이슈를 만들었을 가능성이 있으나 결과 URL 또는 `submission.json`을 확정하지 못하면 hidden `.submission.lock`이 남고 같은 report의 직접 재시도가 차단됩니다. Lock을 삭제하지 말고 먼저 고정 저장소에서 같은 report ID를 검색한 뒤 Web Form 폴백을 사용하세요.
- `GH_TOKEN`이나 `GITHUB_TOKEN` 환경변수로 우회하지 말고, token 값을 출력하거나 보고서에 넣지 마세요.

### 설정을 잘못 바꿈

1. 관련 Codex 작업과 자동화를 중지합니다.
2. Git diff 또는 backup으로 변경을 되돌립니다.
3. `ha-config-check`를 실행합니다.
4. backup 전체 복원은 영향 범위를 확인하고 별도 승인 후 수행합니다.

## 자동 browser 사용자 제거와 앱 삭제

앱이 만든 Headless browser identity를 더 이상 사용하지 않으려면:

1. `home_assistant_browser_auto_auth`를 OFF로 저장합니다.
2. 앱과 기존 browser/Codex 세션을 재시작합니다.
3. 상태를 확인한 뒤 제거합니다.

   ```bash
   ha-browser-auth-status
   ha-browser-auth-remove
   ```

4. 제거가 완료된 뒤 필요하면 앱을 중지하고 삭제합니다.

앱 삭제 전에는 필요한 `/data`의 Codex 설정·인증, memory와 SSH identity를 어떻게 처리할지 결정하세요. backup에는 credential과 민감한 Home Assistant 맥락이 포함될 수 있습니다.

## 제한사항과 지원

- amd64 전용, `stage: experimental`, 기본 `boot: manual`입니다.
- Bubble Card와 다른 custom card를 포함하거나 자동 설치하지 않습니다.
- 별도 채팅형 Web UI가 아닌 터미널 UI입니다.
- 자동화·dashboard 결과는 환경과 요청에 따라 달라지며 사람의 검토가 필요합니다.
- 실제 HAOS의 `0.6.0` 자연어 memory 폐루프에는 공개 검증 공백이 있습니다.
- 실제 GitHub 이슈 직접 생성은 별도 명시 승인 없이는 자동 검증에서 실행하지 않습니다.
- Supervisor endpoint와 OpenAI Remote 제공 여부는 Home Assistant/OpenAI 버전·정책에 따라 달라질 수 있습니다.

지원 요청 전 [SUPPORT.md](../SUPPORT.md)에 따라 token, 내부 URL, entity·사용자 정보를 제거하세요. 일반 문제는 [GitHub Issues](https://github.com/Kanu-Coffee/codex-for-home-assistant/issues), 보안 취약점은 [SECURITY.md](../.github/SECURITY.md)의 비공개 경로를 사용하세요.

프로젝트는 비공식 커뮤니티 프로젝트이며 OpenAI 또는 Home Assistant/Nabu Casa와 제휴하거나 보증받은 제품이 아닙니다. 소스는 [Apache License 2.0](../LICENSE)으로 배포됩니다.
