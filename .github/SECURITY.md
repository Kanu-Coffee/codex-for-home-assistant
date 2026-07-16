# Security policy

[한국어](#한국어) · [English](#english)

## 한국어

Codex for Home Assistant는 `/config` read-write, Home Assistant Core API와 Supervisor `manager` 권한을 사용하는 관리자 도구입니다. 취약점은 일반 버그와 분리해 비공개로 제보해 주세요.

### 지원 범위

보안 수정은 원칙적으로 [가장 최근 공개 릴리스](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases)를 대상으로 합니다. 이 프로젝트는 현재 `stage: experimental`, amd64 전용입니다. 이전 버전에서 문제가 발생했다면 최신 릴리스에서도 재현되는지 비밀정보 없이 확인해 주세요.

### 비공개 제보

가능하면 GitHub의 [비공개 취약점 제보](https://github.com/Kanu-Coffee/codex-for-home-assistant/security/advisories/new)를 사용하세요. 해당 기능이 보이지 않으면 공개 이슈에 취약점 상세나 재현 코드를 올리지 말고, 민감정보 없는 최소 내용으로 private contact가 필요하다고 알려 주세요.

다음을 포함하면 확인에 도움이 됩니다.

- 영향을 받는 앱 버전, Home Assistant Core/OS 버전과 amd64 장치 유형
- 공격 전제조건과 영향 범위
- 최소 재현 단계
- 예상 동작과 실제 동작
- 비밀정보를 제거한 로그 또는 screenshot
- 가능하면 완화 방법

다음을 보내지 마세요.

- `SUPERVISOR_TOKEN`, Codex `auth.json`, browser token
- SSH private key, `secrets.yaml`, `.storage` 원본
- 실제 사용자명, 내부/외부 URL, IP, entity·device·area 이름
- 공개 dashboard screenshot이나 Home Assistant backup

### 긴급 완화

credential 노출이나 원격 접근 문제가 의심되면 먼저 앱을 중지하고 SSH port mapping을 비활성화하세요. 관련 공개키와 Codex/ChatGPT 세션을 폐기하고, 자동 browser identity를 사용했다면 사용자 가이드의 제거 절차를 따르세요. 노출된 secret을 로그나 이슈에 다시 붙여 넣지 마세요.

### 보안 경계

- `codex_sandbox_mode: danger-full-access`는 앱 컨테이너 내부 정책이지만 `/config`는 read-write입니다.
- 앱은 Supervisor `admin`, Docker API, Home Assistant `full_access`, host network를 사용하지 않습니다.
- SSH는 공개키 전용이며 인터넷 직접 노출을 지원되는 배포 방식으로 간주하지 않습니다.
- Headless browser의 관리형 HA 사용자는 local-only, non-admin, `system-read-only`이지만 모든 entity state를 볼 수 있습니다.
- prompt 지침과 승인은 방어 심층화 수단이지 완전한 보안 경계가 아닙니다.

상세 threat model은 [개발 보안 문서](../docs/development/security.md)를 확인하세요.

## English

Codex for Home Assistant is an administrative tool with read-write access to `/config`, the Home Assistant Core API, and the Supervisor `manager` role. Please report vulnerabilities privately and separately from ordinary bugs.

Security fixes normally target the [latest public release](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases). The project is currently experimental and amd64-only.

Use [GitHub private vulnerability reporting](https://github.com/Kanu-Coffee/codex-for-home-assistant/security/advisories/new) when available. If it is unavailable, do not publish exploit details or secrets in an issue; open a minimal, non-sensitive request for a private contact channel.

Include affected versions, prerequisites, impact, minimal reproduction steps, expected versus actual behavior, and redacted evidence. Never send Supervisor or browser tokens, Codex `auth.json`, SSH private keys, `secrets.yaml`, `.storage`, Home Assistant backups, private URLs, or identifying entity and user data.

If credential exposure or unintended remote access is suspected, stop the app, disable the SSH port mapping, revoke affected keys and sessions, and follow the browser-identity removal procedure in the [user guide](../codex_home_assistant/DOCS.en.md). Do not paste the exposed secret into another report.
