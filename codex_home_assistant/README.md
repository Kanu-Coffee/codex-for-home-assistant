# Codex for Home Assistant

Codex CLI, Home Assistant Ingress 웹 터미널, 공개키 SSH를 하나의 실험용 Home Assistant App에 제공합니다. Codex는 `/config` 전체를 read-write로 사용하고 Core API와 Supervisor `manager` API를 호출할 수 있습니다.

> 현재 버전은 `0.1.2-dev`, amd64 전용입니다. HAOS 설치·Web UI·인증된 Codex 실행과 일부 Supervisor 조회/검사는 확인됐고, 인증 영속성, Core 서비스 호출, Windows/Codex Desktop Remote SSH는 M2 실기 항목입니다.

로컬 M1에서는 amd64 image build, Codex archive SHA-256/버전, S6 init과 ttyd/nginx 기동, `/config` RW probe, 공개키 SSH와 비밀번호 거부, host key/config 재시작 영속성, API helper mock·token redaction, 전체 lint를 확인했습니다. 정확한 최신 결과는 저장소 `progress.md`를 기준으로 합니다.

## 설치

Home Assistant App Store의 **Repositories**에 다음 public URL을 추가하고 **Codex for Home Assistant**를 설치하세요.

```text
https://github.com/Kanu-Coffee/codex-for-home-assistant
```

registry `image`는 아직 없으므로 amd64 Home Assistant 장치가 Dockerfile을 소스 빌드합니다.

## 핵심 동작

- Web UI는 `/config`에서 시작하고 브라우저 재접속 시 같은 `tmux` 세션에 붙습니다.
- `web_terminal_auto_start_codex: true`이면 새 tmux 세션에서 Codex를 한 번 실행한 뒤 Bash로 돌아옵니다.
- SSH는 공개키 전용이며 App **Network**의 기본 호스트 포트는 `2223`입니다.
- `CODEX_HOME=/data/codex`; `ha-codex-login`은 device code 로그인을 시작합니다.
- 전역 `AGENTS.md`가 없을 때만 Home Assistant 운영 가드레일을 생성하며 사용자 파일은 보존합니다.
- `ha-api`, `supervisor-api`, `ha-config-check`, `ha-core-logs`, `ha-addon-logs`를 제공합니다.
- Supervisor `admin`, Docker API, App `full_access`, host network는 사용하지 않습니다.

설치, Windows SSH config, Codex Desktop 요구사항, 인증 파일 복사, API/서비스 호출 안전 절차와 복구 방법은 [DOCS.md](./DOCS.md)를 반드시 읽으세요.

## 보안 경고

이 App은 `secrets.yaml`, `.storage`, 데이터베이스를 포함한 `/config` 전체와 Home Assistant runtime API token에 접근합니다. TCP 2223을 인터넷으로 port-forward하지 말고 외부 접속은 제한된 VPN/mesh network를 사용하세요. Codex `auth.json`, `SUPERVISOR_TOKEN`, SSH 개인키를 Git·채팅·로그에 넣지 마세요.
