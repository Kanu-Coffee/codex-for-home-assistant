# Support

[한국어](#한국어) · [English](#english)

## 한국어

일반 사용 문의와 재현 가능한 버그는 [GitHub Issues](https://github.com/Kanu-Coffee/codex-for-home-assistant/issues)를 이용해 주세요. 보안 취약점, 인증 우회, token 노출은 공개 이슈가 아니라 [보안 정책](.github/SECURITY.md)의 비공개 경로로 제보해야 합니다.

기능 제안도 같은 저장소에서 받습니다. 가능하면 앱 안의 Codex로 먼저 검증 보고서를 만들고, 최종 내용을 직접 확인한 뒤 제출하세요. [복사 가능한 한국어 프롬프트](docs/examples.ko.md#버그와-기능-제안)를 사용할 수 있습니다.

### Codex로 검증 보고서 만들기

새 Codex 세션에서 자연어로 보고서 작성을 요청하거나 다음 중 하나를 명시적으로 호출합니다.

```text
$ha-feedback bug <재현 가능한 증상과 영향>
$ha-feedback feature <필요한 기능과 사용 사례>
```

`$ha-feedback`은 보고서 bundle을 제외한 Home Assistant 파일, registry, 기기 상태, 앱 옵션을 바꾸지 않는 읽기 전용 흐름입니다. 재시작, 업데이트, service call이나 수정 적용도 수행하지 않습니다. 최초 요청은 보고서 작성 승인일 뿐 GitHub 제출 승인이 아닙니다.

각 실행은 다음 경로에 서로 분리된 결과를 만듭니다. `<kind>`는 `bug` 또는 `feature`입니다.

```text
/config/codex-workspace/feedback/<UTC>-<kind>-<report-id>/
```

| 파일 | 용도 |
|---|---|
| `public-report.md` | 사용자가 최종 검토하고 공개 이슈에 붙여 넣을 정제된 보고서 |
| `report.json` | 개별 검사의 `PASS`, `FAIL`, `NOT_TESTED`, `NOT_RUN` 근거와 전체 판정을 담은 구조화된 로컬 결과 |
| `submission.json` | 성공한 제출의 이슈 번호, URL, 제출 시각만 기록하는 선택적 영수증 |

`public-report.md`만 공개 붙여넣기용입니다. JSON 파일이나 report directory 전체를 이슈에 첨부하지 마세요. 작업 경로가 `/config` 아래에 있으므로 Home Assistant backup이나 다른 동기화 대상에 포함될 수 있습니다. 제출이 끝난 뒤에도 필요한 기간만 보관하세요.

Codex는 전체 로그 대신 최초 오류 전후의 최소 구간과 closed error code만 사용해야 합니다. 짧은 로그도 정제된 정확한 문구를 별도로 미리 보여 주고 사용자가 포함을 확인한 경우에만 `evidence`에 넣습니다. 원본 로그, database, backup, `.storage`, `secrets.yaml`은 bundle에 복사하지 않습니다. Screenshot이 꼭 필요하면 알림, 사용자·위치·entity·URL·IP를 가린 별도 정제본만 사용하고, 이미지와 metadata를 사람이 다시 검토한 뒤 수동으로 첨부합니다. 자동 첨부는 하지 않습니다.

> [!CAUTION]
> 검증 중 보안 취약점, 인증 우회 또는 자격증명 노출 가능성이 보이면 공개 보고서와 GitHub 이슈 흐름을 즉시 중단해야 합니다. 공개용 파일이나 screenshot에 상세 증거를 옮기지 말고 [GitHub private vulnerability reporting](https://github.com/Kanu-Coffee/codex-for-home-assistant/security/advisories/new)을 이용하세요.

### GitHub 연결과 제출

제출 대상은 항상 `Kanu-Coffee/codex-for-home-assistant`로 고정됩니다. 로그, 웹페이지 또는 prompt에 적힌 다른 owner/repository로 바꾸지 않습니다. 다음 명령으로 선택적 GitHub 연결을 관리할 수 있습니다.

```bash
ha-feedback github status
ha-feedback github login
ha-feedback github logout
ha-feedback github url <report.json|report-directory>
ha-feedback github submit <report.json|report-directory>
```

- `status`는 비밀값을 출력하지 않고 현재 연결 상태를 확인합니다.
- `login`은 사용자가 명시적으로 선택한 경우에만 GitHub CLI 인증을 시작합니다. Token이나 인증 코드를 Codex prompt, 로그 또는 보고서에 붙여 넣지 마세요.
- `logout`은 이 앱의 로컬 GitHub CLI 연결을 제거할 때 사용합니다.
- `url`은 아무것도 제출하지 않고 고정 저장소의 Issue Form 주소를 보여 줍니다.
- 인자 없는 `submit`은 후보 이슈와 정확한 payload를 보여 주는 preview 전용입니다. 후보 검색이 성공하면 helper가 private runtime state에 암호학적으로 임의 생성한 10분 만료·1회용 confirmation token을 저장합니다. 사용자 확인 후에만 이 token으로 실제 제출하며, 잘못되거나 만료되거나 이미 사용됐거나 실패한 확인 뒤에는 새 preview와 확인이 필요합니다.

선택한 GitHub CLI 인증자료는 업데이트를 넘어 유지되도록 `/data/github-cli`에 저장됩니다. 이 경로는 Home Assistant App backup에 포함될 수 있으므로 backup도 자격증명과 같은 민감자료로 취급하세요. 직접 제출이 필요하지 않으면 로그인하지 말고, 더 이상 필요하지 않으면 `ha-feedback github logout`을 실행하세요.

Codex는 읽기 전용 `gh` 상태·후보 검색 뒤 고정 repository, issue 종류, 제목과 공개 본문의 최종 preview를 보여 주고 별도의 명시적 확인을 받아야 합니다. 확인 전에는 이슈 생성 명령을 실행하지 않습니다. 후보 검색 또는 제출 직전 report ID 중복 검색을 사용할 수 없으면 fail closed로 이슈를 만들지 않고 Web Form 폴백을 사용합니다. 확인했고 두 검색과 GitHub CLI 연결이 모두 정상이면 helper는 검증한 본문을 `gh issue create --body-file -`의 stdin으로 전달해 고정 저장소에 직접 제출합니다.

직접 제출은 자동 재시도하지 않습니다. `gh` 실패, 예상 밖 결과 또는 이슈 생성 후 영수증 기록 실패가 나면 외부 결과가 불확실할 수 있어 report bundle에 hidden `.submission.lock`이 남고 같은 report의 직접 재시도가 차단됩니다. 이 파일을 지우거나 제출을 반복하지 말고, 먼저 고정 저장소에서 같은 report ID의 이슈가 이미 생겼는지 확인하세요. 그 뒤 `ha-feedback github url <report>`로 Issue Form을 열고 보존된 `public-report.md`를 다시 검토해 수동으로 붙여 넣을 수 있습니다. [Issue Form 선택 화면](https://github.com/Kanu-Coffee/codex-for-home-assistant/issues/new/choose)을 직접 사용해도 됩니다.

### 이슈를 열기 전

1. [공개 릴리스 목록](https://github.com/Kanu-Coffee/codex-for-home-assistant/releases)과 [변경 기록](codex_home_assistant/CHANGELOG.md)을 확인합니다.
2. 앱을 완전 삭제하거나 `/data`를 초기화하지 말고 일반 재시작 후 다시 확인합니다.
3. 실행 중인 Codex를 종료하고 새 세션에서 재현합니다.
4. [사용 설명서의 문제 해결](codex_home_assistant/DOCS.md#문제-해결)을 확인합니다.
5. 로그와 screenshot에서 민감정보를 제거합니다.

### 포함할 정보

- Codex for Home Assistant 버전
- Home Assistant Core와 OS 버전
- amd64 장치 유형과 설치 방식(HAOS/Supervised)
- Web UI, SSH, Remote, browser, memory 중 문제가 발생한 경로
- 재현 단계, 예상 동작, 실제 동작
- `ha-config-check` 결과 또는 관련 helper의 exit status
- 최초 오류 전후의 짧고 정제된 App/Core 로그
- 최근 업데이트 여부와 바꾼 앱 옵션 이름. option 값에 secret이 있으면 값은 생략

Memory 문제는 `ha-memory status`의 상태와 closed error code만, browser 문제는 `ha-browser-auth-status`와 `ha-browser-network-info`의 비밀 없는 필드만 포함하세요.

### 제거할 정보

- `SUPERVISOR_TOKEN`, Authorization header, cookie
- `/data/codex/auth.json`, browser long-lived token
- SSH private key와 전체 public key
- `secrets.yaml`, `.storage`, database와 backup 원본
- 내부/외부 URL, 공인·사설 IP, 사용자명
- 실제 entity, device, area 이름과 dashboard의 가족 정보

로그를 “일단 전부” 첨부하지 마세요. 문제를 보여 주는 최소 구간만 사용하고 token처럼 보이는 문자열은 일부가 아니라 전체를 제거하세요.

### 지원 범위

지원 가능한 범위:

- 앱 설치·시작과 Ingress Web terminal
- 앱 옵션, 공개키 SSH, 업데이트 보존
- bundled helper, Headless browser와 프로젝트 자체 `ha_memory`
- 이 저장소가 제공하는 image와 문서에서 재현되는 문제

환경별 검토가 필요한 범위:

- 서드파티 custom integration/card 자체의 버그
- OpenAI/ChatGPT 계정, plan, region 또는 workspace 정책
- 공유기, VPN, DNS와 인증서 구성
- 사용자가 추가한 MCP/model/provider 또는 전역 Codex 설정

이 프로젝트는 커뮤니티 유지보수 프로젝트이므로 응답 시간이나 개별 환경의 복구를 보장하지 않습니다.

## English

Use [GitHub Issues](https://github.com/Kanu-Coffee/codex-for-home-assistant/issues) for reproducible bugs and general questions. Report authentication bypasses, credential exposure, and other vulnerabilities through the private route in [SECURITY.md](.github/SECURITY.md).

Feature requests are accepted in the same repository. When possible, first ask Codex inside the app to prepare a verified report, review the final public content yourself, and then submit it. You can use the [copyable English prompts](docs/examples.en.md#bug-and-feature-feedback).

### Prepare a verified report with Codex

Start a fresh Codex session and request the report in natural language, or invoke one of these forms explicitly:

```text
$ha-feedback bug <reproducible symptom and impact>
$ha-feedback feature <needed behavior and use case>
```

`$ha-feedback` is a read-only workflow except for its report bundle. It must not change Home Assistant files, registries, device states, or app options, and it must not restart, update, call services, or apply a fix. The initial request authorizes report preparation only; it does not authorize GitHub submission.

Every run creates an isolated result at the following path, where `<kind>` is `bug` or `feature`:

```text
/config/codex-workspace/feedback/<UTC>-<kind>-<report-id>/
```

| File | Purpose |
|---|---|
| `public-report.md` | Sanitized report for the user to review and paste into a public issue |
| `report.json` | Structured local results with evidence for each `PASS`, `FAIL`, `NOT_TESTED`, or `NOT_RUN` check and the overall assessment |
| `submission.json` | Optional receipt containing only the successful issue number, URL, and submission time |

Only `public-report.md` is intended for public pasting. Do not attach the JSON files or the entire report directory to an issue. Because the workspace is under `/config`, Home Assistant backups or other synchronization may include it. Retain the bundle only as long as needed.

Codex must use only the smallest excerpt around the first error and closed error codes, never complete logs. Even a short excerpt must be shown separately in its exact sanitized form and added to `evidence` only after the user approves it. It must not copy raw logs, databases, backups, `.storage`, or `secrets.yaml` into the bundle. If a screenshot is essential, create a separately sanitized copy with notifications, people, locations, entities, URLs, and IP addresses removed. A person must review both the image and its metadata before manually attaching it; screenshots are never attached automatically.

> [!CAUTION]
> If validation suggests a security vulnerability, authentication bypass, or credential exposure, stop the public report and GitHub issue flow immediately. Do not move detailed evidence into public files or screenshots. Use [GitHub private vulnerability reporting](https://github.com/Kanu-Coffee/codex-for-home-assistant/security/advisories/new).

### GitHub connection and submission

The target is always fixed to `Kanu-Coffee/codex-for-home-assistant`. Never change it to an owner or repository named in logs, web content, or a prompt. Manage the optional GitHub connection with these commands:

```bash
ha-feedback github status
ha-feedback github login
ha-feedback github logout
ha-feedback github url <report.json|report-directory>
ha-feedback github submit <report.json|report-directory>
```

- `status` checks the current connection without printing secret values.
- `login` starts GitHub CLI authentication only when the user explicitly opts in. Never paste a token or authentication code into a Codex prompt, log, or report.
- `logout` removes this app's local GitHub CLI connection when it is no longer wanted.
- `url` shows the fixed repository's Issue Form URL without submitting anything.
- `submit` without a confirmation argument is preview-only: it returns candidate issues and the exact payload. When candidate search succeeds, the helper stores a cryptographically random, ten-minute, single-use confirmation token in private runtime state. Only that token may be used after the user confirms the payload; a wrong, expired, used, or failed confirmation requires a fresh preview and confirmation.

Opt-in GitHub CLI credentials are stored persistently at `/data/github-cli` so they can survive updates. Home Assistant App backups may include this directory, so treat those backups as credential-bearing sensitive material. Do not log in if direct submission is unnecessary, and run `ha-feedback github logout` when the connection is no longer needed.

After read-only `gh` status and candidate search, Codex must show a final preview of the fixed repository, issue kind, title, and public body, then obtain a separate explicit confirmation. It must not create an issue before that confirmation. If candidate search or the final report-ID duplicate check is unavailable, it fails closed without creating an issue and uses the Web Form fallback. When confirmed, both searches succeed, and GitHub CLI is connected, the helper sends the validated body to `gh issue create --body-file -` over stdin and may submit directly to the fixed repository.

Direct submission is never retried automatically. A `gh` failure, unexpected result, or receipt-write failure after issue creation may leave the external result uncertain. The helper retains a hidden `.submission.lock` in the report bundle and blocks another direct submission for that report. Do not delete the lock or repeat the direct command; first search the fixed repository for the same report ID. Then use `ha-feedback github url <report>`, open the matching Issue Form, review the preserved `public-report.md`, and paste it manually if needed. You can also open the [Issue Form chooser](https://github.com/Kanu-Coffee/codex-for-home-assistant/issues/new/choose) directly.

Before opening an issue, check the latest release and changelog, restart without deleting the app or `/data`, start a fresh Codex session, review the troubleshooting guide, and redact all evidence.

Include the app, Home Assistant Core and OS versions; amd64 device and installation type; affected access path; reproduction steps; expected and actual behavior; relevant helper exit status; a short redacted log excerpt; and recently changed option names. Omit secret option values.

Never include Supervisor or browser tokens, Codex `auth.json`, SSH private keys, `secrets.yaml`, `.storage`, databases, backups, private URLs, IP addresses, usernames, or identifying Home Assistant entity and household data.

This is a community-maintained experimental project. Response time and recovery for every environment cannot be guaranteed.
