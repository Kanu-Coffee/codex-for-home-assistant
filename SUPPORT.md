# Support

[한국어](#한국어) · [English](#english)

## 한국어

일반 사용 문의와 재현 가능한 버그는 [GitHub Issues](https://github.com/Kanu-Coffee/codex-for-home-assistant/issues)를 이용해 주세요. 보안 취약점, 인증 우회, token 노출은 공개 이슈가 아니라 [보안 정책](.github/SECURITY.md)의 비공개 경로로 제보해야 합니다.

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

Before opening an issue, check the latest release and changelog, restart without deleting the app or `/data`, start a fresh Codex session, review the troubleshooting guide, and redact all evidence.

Include the app, Home Assistant Core and OS versions; amd64 device and installation type; affected access path; reproduction steps; expected and actual behavior; relevant helper exit status; a short redacted log excerpt; and recently changed option names. Omit secret option values.

Never include Supervisor or browser tokens, Codex `auth.json`, SSH private keys, `secrets.yaml`, `.storage`, databases, backups, private URLs, IP addresses, usernames, or identifying Home Assistant entity and household data.

This is a community-maintained experimental project. Response time and recovery for every environment cannot be guaranteed.
